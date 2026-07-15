-- 0007: set-menu recommendation engine, suggestion/insight layer,
--       and group A+B analytics (payday/holiday effects, hour x DOW,
--       Pareto, peak saturation, voids/discounts, ramp curve, payment mix,
--       price-change impact, set components/cannibalization, competitor prices)

-- ------------------------------------------------------------ new columns
alter table raw.pos_bills add column if not exists payment_method text;   -- cash / qr / card / foreign_card ...
alter table raw.pos_bills add column if not exists is_voided boolean not null default false;
alter table core.fact_bill add column if not exists payment_method text;

-- load_pos v2: skip voided bills, carry payment method
create or replace function core.load_pos(p_from date, p_to date)
returns int language plpgsql as $$
declare v_count int;
begin
  delete from core.fact_bill where date_key between p_from and p_to;

  insert into core.fact_bill (source_bill_id, branch_code, channel_code, bill_ts,
                              date_key, hour_of_day, net_amount, discount, payment_method)
  select b.source_bill_id, b.branch_code, b.channel_code, b.bill_ts,
         b.bill_ts::date, extract(hour from b.bill_ts)::int, b.net_amount, b.discount, b.payment_method
  from raw.pos_bills b
  where b.bill_ts::date between p_from and p_to
    and not b.is_voided;

  insert into core.fact_bill_line (bill_id, sku, item_name_raw, noodle_code, qty, net_amount)
  select fb.bill_id, m.sku, l.item_name_raw, mm.noodle_code, l.qty, l.net_amount
  from raw.pos_bill_lines l
  join core.fact_bill fb
    on fb.source_bill_id = l.source_bill_id and fb.branch_code = l.branch_code
  left join core.map_item_name m  on m.item_name_raw = l.item_name_raw
  left join core.map_modifier  mm on mm.modifier_raw = l.modifier_raw
  where fb.date_key between p_from and p_to;
  get diagnostics v_count = row_count;

  perform core.rebuild_bill_stats(p_from, p_to);
  return v_count;
end $$;

-- ------------------------------------------------------------ new tables
-- Price-change log (group B #8): every change gets automatic before/after measurement
create table core.price_change (
  id         bigint generated always as identity primary key,
  sku        text not null references core.dim_menu_item,
  changed_on date not null,
  old_price  numeric(10,2),
  new_price  numeric(10,2) not null,
  note       text
);

-- Set composition: which items a Set bundles (needed for cannibalization)
create table core.set_component (
  set_sku       text not null references core.dim_menu_item,
  component_sku text not null references core.dim_menu_item,
  qty           numeric(6,2) not null default 1,
  primary key (set_sku, component_sku)
);

-- Competitor delivery-menu prices (group B #9), scraped snapshots
create table raw.competitor_menu_items (
  id            bigint generated always as identity primary key,
  competitor_code text,
  platform      text not null,
  snapshot_date date not null,
  item_name     text not null,
  price         numeric(10,2),
  category_hint text,
  payload       jsonb,
  ingested_at   timestamptz not null default now()
);

-- ============================================================ GROUP A VIEWS

-- A1. Payday effect: actual vs baseline on payday-window days, per branch
create or replace view marts.v_payday_effect as
select v.branch_code,
       count(*) as payday_days,
       round(avg(v.sales), 0) as avg_payday_sales,
       round(avg(v.baseline_sales), 0) as avg_baseline,
       round(100.0 * (avg(v.sales) - avg(v.baseline_sales)) / nullif(avg(v.baseline_sales),0), 1) as lift_pct
from marts.v_sales_vs_baseline v
join core.dim_date d on d.date_key = v.date_key
where d.is_payday_window and v.baseline_sales is not null
group by v.branch_code;

-- A1b. Holiday effect per holiday name
create or replace view marts.v_holiday_effect as
select d.holiday_name, v.branch_code,
       count(*) as observed_days,
       round(avg(v.sales), 0) as avg_holiday_sales,
       round(avg(v.baseline_sales), 0) as avg_baseline,
       round(100.0 * (avg(v.sales) - avg(v.baseline_sales)) / nullif(avg(v.baseline_sales),0), 1) as lift_pct
from marts.v_sales_vs_baseline v
join core.dim_date d on d.date_key = v.date_key
where d.is_holiday and v.baseline_sales is not null
group by d.holiday_name, v.branch_code;

-- A2. Hour x day-of-week grid per branch (finer than weekday/weekend)
create or replace view marts.v_hour_dow as
with base as (
  select fb.branch_code, d.day_of_week, d.day_name, fb.hour_of_day,
         sum(fb.net_amount) as sales,
         count(*) as bills,
         count(distinct fb.date_key) as open_days
  from core.fact_bill fb
  join core.dim_date d on d.date_key = fb.date_key
  group by 1,2,3,4
)
select *,
       round(sales / nullif(open_days,0), 0) as sales_per_day,
       round(100.0 * sales / nullif(sum(sales) over (partition by branch_code, day_of_week),0), 2) as pct_of_dow
from base;

-- A3. Pareto / ABC classification of menu items
create or replace view marts.v_pareto as
with item_sales as (
  select mi.sku, mi.name_normalized, mi.category_code, sum(l.net_amount) as sales, sum(l.qty) as units
  from core.fact_bill_line l
  join core.dim_menu_item mi on mi.sku = l.sku
  group by 1,2,3
),
ranked as (
  select *,
         rank() over (order by sales desc) as sales_rank,
         round(100.0 * sales / nullif(sum(sales) over (),0), 2) as pct_of_sales,
         round(100.0 * sum(sales) over (order by sales desc rows unbounded preceding)
               / nullif(sum(sales) over (),0), 2) as cumulative_pct
  from item_sales
)
select *,
       case when cumulative_pct <= 80 then 'A'
            when cumulative_pct <= 95 then 'B'
            else 'C' end as abc_class
from ranked;

-- A4. Peak saturation: how often each branch-hour runs near its own capacity
create or replace view marts.v_peak_saturation as
with hourly as (
  select fb.branch_code, fb.date_key, d.day_type, fb.hour_of_day, count(*) as bills
  from core.fact_bill fb
  join core.dim_date d on d.date_key = fb.date_key
  group by 1,2,3,4
),
stats as (
  select branch_code, day_type, hour_of_day,
         round(avg(bills), 1) as avg_bills,
         percentile_cont(0.95) within group (order by bills) as p95_bills,
         count(*) as days_observed
  from hourly group by 1,2,3
)
select s.*,
       (select count(*) from hourly h
        where h.branch_code = s.branch_code and h.day_type = s.day_type
          and h.hour_of_day = s.hour_of_day and h.bills >= 0.85 * s.p95_bills) as days_near_capacity,
       round(100.0 * (select count(*) from hourly h
        where h.branch_code = s.branch_code and h.day_type = s.day_type
          and h.hour_of_day = s.hour_of_day and h.bills >= 0.85 * s.p95_bills)
        / nullif(s.days_observed, 0), 1) as pct_days_near_capacity
from stats s;

-- A5. Voids & discount hygiene per branch x month
create or replace view marts.v_void_discount_trend as
with voids as (
  select date_trunc('month', bill_ts)::date as month_start, branch_code,
         count(*) filter (where is_voided) as voided_bills,
         count(*) as raw_bills
  from raw.pos_bills group by 1,2
),
disc as (
  select date_trunc('month', date_key)::date as month_start, branch_code,
         sum(discount) as total_discount, sum(net_amount) as net_sales,
         count(*) filter (where discount > 0) as discounted_bills, count(*) as bills
  from core.fact_bill group by 1,2
)
select coalesce(v.month_start, d.month_start) as month_start,
       coalesce(v.branch_code, d.branch_code) as branch_code,
       v.voided_bills, v.raw_bills,
       round(100.0 * v.voided_bills / nullif(v.raw_bills,0), 2) as void_rate_pct,
       d.total_discount, d.net_sales,
       round(100.0 * d.total_discount / nullif(d.net_sales + d.total_discount,0), 2) as discount_depth_pct,
       round(100.0 * d.discounted_bills / nullif(d.bills,0), 2) as discounted_bills_pct
from voids v full join disc d using (month_start, branch_code);

-- A6. New-branch ramp curve: weekly sales by weeks-since-open
create or replace view marts.v_ramp_curve as
select fb.branch_code,
       floor((fb.date_key - b.open_date) / 7)::int as week_no,
       min(fb.date_key) as week_start,
       sum(fb.net_amount) as sales,
       count(*) as bills
from core.fact_bill fb
join core.dim_branch b on b.branch_code = fb.branch_code
where b.open_date is not null and fb.date_key >= b.open_date
group by 1,2;

-- A7. Payment-method mix (tourist/local proxy at mall branches)
create or replace view marts.v_payment_mix as
select date_trunc('month', date_key)::date as month_start, branch_code,
       coalesce(payment_method, 'unknown') as payment_method,
       count(*) as bills, sum(net_amount) as sales,
       round(100.0 * count(*) / nullif(sum(count(*)) over (partition by date_trunc('month', date_key)::date, branch_code),0), 1) as pct_of_bills
from core.fact_bill
group by 1,2,3;

-- ============================================================ GROUP B VIEWS

-- B8. Price-change impact: qty/day 28d before vs after each change
create or replace view marts.v_price_change_impact as
with daily as (
  select l.sku, fb.date_key, sum(l.qty) as units, sum(l.net_amount) as sales
  from core.fact_bill_line l join core.fact_bill fb on fb.bill_id = l.bill_id
  where l.sku is not null group by 1,2
)
select pc.id as change_id, pc.sku, mi.name_normalized, pc.changed_on, pc.old_price, pc.new_price,
       round(100.0 * (pc.new_price - pc.old_price) / nullif(pc.old_price,0), 1) as price_change_pct,
       round(avg(d.units) filter (where d.date_key between pc.changed_on - 28 and pc.changed_on - 1), 2) as units_per_day_before,
       round(avg(d.units) filter (where d.date_key between pc.changed_on and pc.changed_on + 27), 2) as units_per_day_after,
       round(100.0 * (avg(d.units) filter (where d.date_key between pc.changed_on and pc.changed_on + 27)
                    - avg(d.units) filter (where d.date_key between pc.changed_on - 28 and pc.changed_on - 1))
             / nullif(avg(d.units) filter (where d.date_key between pc.changed_on - 28 and pc.changed_on - 1), 0), 1) as qty_change_pct
from core.price_change pc
join core.dim_menu_item mi on mi.sku = pc.sku
left join daily d on d.sku = pc.sku
group by pc.id, pc.sku, mi.name_normalized, pc.changed_on, pc.old_price, pc.new_price;

-- B9. Competitor price positioning: median menu price vs listing rating
create or replace view marts.v_price_position as
with comp_price as (
  select competitor_code, percentile_cont(0.5) within group (order by price) as median_price
  from raw.competitor_menu_items
  where snapshot_date = (select max(snapshot_date) from raw.competitor_menu_items)
  group by competitor_code
),
comp_rating as (
  select competitor_code, avg(avg_rating) as rating
  from core.fact_listing_snapshot
  where is_competitor and snapshot_date >= current_date - 30
  group by competitor_code
),
own as (
  select 'MamaPook' as name, percentile_cont(0.5) within group (order by price) as median_price
  from core.dim_menu_item where price is not null and active
)
select c.competitor_name as name, round(cp.median_price::numeric, 0) as median_price,
       round(cr.rating::numeric, 2) as rating, true as is_competitor
from comp_price cp
join core.dim_competitor c on c.competitor_code = cp.competitor_code
left join comp_rating cr on cr.competitor_code = cp.competitor_code
union all
select o.name, round(o.median_price::numeric, 0),
       (select round(avg(avg_rating)::numeric, 2) from core.fact_listing_snapshot
         where not is_competitor and snapshot_date >= current_date - 30),
       false
from own o where o.median_price is not null;

-- B10. Set cannibalization: component à-la-carte volume before vs after set launch
create or replace view marts.v_set_cannibalization as
with launches as (
  select sc.set_sku, min(fb.date_key) as launch_date
  from core.set_component sc
  join core.fact_bill_line l on l.sku = sc.set_sku
  join core.fact_bill fb on fb.bill_id = l.bill_id
  group by sc.set_sku
),
comp_daily as (
  select sc.set_sku, l.sku as component_sku, fb.date_key, sum(l.qty) as units
  from core.set_component sc
  join core.fact_bill_line l on l.sku = sc.component_sku
  join core.fact_bill fb on fb.bill_id = l.bill_id
  group by 1,2,3
),
set_daily as (
  select l.sku as set_sku, fb.date_key, sum(l.qty) as set_units
  from core.fact_bill_line l join core.fact_bill fb on fb.bill_id = l.bill_id
  group by 1,2
)
select lc.set_sku, mi.name_normalized as set_name, lc.launch_date,
       round(avg(sd.set_units) filter (where sd.date_key >= lc.launch_date), 2) as set_units_per_day,
       cd.component_sku,
       round(avg(cd.units) filter (where cd.date_key between lc.launch_date - 28 and lc.launch_date - 1), 2) as comp_units_before,
       round(avg(cd.units) filter (where cd.date_key >= lc.launch_date), 2) as comp_units_after
from launches lc
join core.dim_menu_item mi on mi.sku = lc.set_sku
left join comp_daily cd on cd.set_sku = lc.set_sku
left join set_daily sd on sd.set_sku = lc.set_sku
group by lc.set_sku, mi.name_normalized, lc.launch_date, cd.component_sku;

-- ============================================ SET-MENU RECOMMENDATION ENGINE

-- Item-pair affinity over the last 90 days of data (anchor date = max data date,
-- so backfilled history works). Sets excluded.
create or replace view marts.v_item_affinity as
with maxd as (select max(date_key) as d from core.fact_bill),
bs as (
  select distinct fb.bill_id, l.sku
  from core.fact_bill fb
  join core.fact_bill_line l on l.bill_id = fb.bill_id
  join core.dim_menu_item mi on mi.sku = l.sku
  where l.sku is not null and not mi.is_set
    and fb.date_key > (select d from maxd) - 90
),
tot as (select count(distinct bill_id)::numeric as n from bs),
per as (select sku, count(*)::numeric as n_sku from bs group by 1),
pairs as (
  select a.sku as sku_a, b.sku as sku_b, count(*)::numeric as n_both
  from bs a join bs b on a.bill_id = b.bill_id and a.sku < b.sku
  group by 1,2
)
select p.sku_a, p.sku_b,
       ma.name_normalized as name_a, mb.name_normalized as name_b,
       ma.category_code as cat_a, mb.category_code as cat_b,
       p.n_both::int as bills_together,
       round(100.0 * p.n_both / t.n, 2) as support_pct,
       round(p.n_both / pa.n_sku, 3) as confidence_a_to_b,
       round(p.n_both * t.n / (pa.n_sku * pb.n_sku), 2) as lift
from pairs p
cross join tot t
join per pa on pa.sku = p.sku_a
join per pb on pb.sku = p.sku_b
join core.dim_menu_item ma on ma.sku = p.sku_a
join core.dim_menu_item mb on mb.sku = p.sku_b
where p.n_both >= 20;

-- Ranked set candidates.
-- Logic: anchor = top-10 main dish by units; companion = add-on item with the
-- best lift x support to the anchor; price = 12% off the a-la-carte sum,
-- rounded to a ...5/...0 charm price; margin check when costs exist; target =
-- the channel with the lowest add-on attachment (the measured gap).
create or replace view marts.v_set_candidates as
with maxd as (select max(date_key) as d from core.fact_bill),
item_units as (
  select l.sku, sum(l.qty) as units
  from core.fact_bill_line l
  join core.fact_bill fb on fb.bill_id = l.bill_id
  where fb.date_key > (select d from maxd) - 90 and l.sku is not null
  group by 1
),
anchors as (
  select mi.sku, mi.name_normalized, iu.units,
         rank() over (order by iu.units desc) as traffic_rank
  from item_units iu
  join core.dim_menu_item mi on mi.sku = iu.sku
  join core.dim_category c on c.category_code = mi.category_code
  where c.is_main_dish
  order by iu.units desc limit 10
),
chan_gap as (           -- channel with the biggest attachment gap = target
  select fb.channel_code,
         round(100.0 * count(*) filter (where fb.has_addon) / nullif(count(*),0), 1) as pct_with_addon,
         count(*) as bills
  from core.fact_bill fb
  where fb.date_key > (select d from maxd) - 90
  group by 1
),
target as (select channel_code, pct_with_addon from chan_gap order by pct_with_addon asc limit 1),
cands as (
  select a.sku as anchor_sku, a.name_normalized as anchor_name, a.units as anchor_units, a.traffic_rank,
         case when af.sku_a = a.sku then af.sku_b else af.sku_a end as companion_sku,
         case when af.sku_a = a.sku then af.name_b else af.name_a end as companion_name,
         af.lift, af.support_pct, af.bills_together
  from anchors a
  join marts.v_item_affinity af
    on (af.sku_a = a.sku or af.sku_b = a.sku)
  join core.dim_menu_item cm
    on cm.sku = case when af.sku_a = a.sku then af.sku_b else af.sku_a end
  join core.dim_category cc on cc.category_code = cm.category_code
  where cc.is_addon                                   -- companion must be an add-on item
)
select c.*,
       am.price as anchor_price, cm.price as companion_price,
       (select floor((am.price + cm.price) * 0.88 / 5) * 5) as suggested_price,
       case when am.unit_cost is not null and cm.unit_cost is not null
            then round(100.0 * (am.unit_cost + cm.unit_cost)
                 / nullif(floor((am.price + cm.price) * 0.88 / 5) * 5, 0), 1) end as food_cost_pct,
       t.channel_code as target_channel, t.pct_with_addon as target_attachment_pct,
       round((c.lift * ln(1 + c.bills_together) * (11 - c.traffic_rank))::numeric, 1) as score,
       format('%s bills already pair these (lift %s). Target %s where only %s%% of bills have add-ons.',
              c.bills_together, c.lift, t.channel_code, t.pct_with_addon) as rationale
from cands c
join core.dim_menu_item am on am.sku = c.anchor_sku
join core.dim_menu_item cm on cm.sku = c.companion_sku
cross join target t
where c.lift >= 1.1
order by score desc;

-- ============================================ SUGGESTION / INSIGHT LAYER

create table ops.insights (
  id           bigint generated always as identity primary key,
  rule_key     text not null,
  status       text not null check (status in ('bad','good','amplify')),
  entity_key   text not null default '',
  title        text not null,
  detail       text,
  action       text not null,
  metrics      jsonb,
  period_start date not null,
  period_end   date not null,
  created_at   timestamptz not null default now(),
  acknowledged boolean not null default false,
  unique (rule_key, entity_key, period_start)
);

create or replace function ops.generate_insights()
returns int language plpgsql as $$
declare
  v_max date; v_from date; v_count int := 0; r record;
begin
  select max(date_key) into v_max from core.fact_bill;
  if v_max is null then return 0; end if;      -- no data yet
  v_from := v_max - 6;                          -- rolling 7-day period

  -- BAD: branch below baseline on >= 3 of last 7 days
  for r in
    select branch_code, count(*) as bad_days, round(avg(pct_vs_baseline),1) as avg_pct
    from marts.v_sales_vs_baseline
    where date_key between v_from and v_max and pct_vs_baseline < -15
    group by 1 having count(*) >= 3
  loop
    insert into ops.insights (rule_key, status, entity_key, title, detail, action, metrics, period_start, period_end)
    values ('sales_slump', 'bad', r.branch_code,
      r.branch_code || ' sales below baseline ' || r.bad_days || ' of last 7 days',
      'Average ' || r.avg_pct || '% vs 4-week same-weekday baseline.',
      'Check operations first (staffing, stockouts, platform downtime). If ops is clean, run a traffic promo in the branch''s strongest daypart and review nearby competitor promos.',
      jsonb_build_object('bad_days', r.bad_days, 'avg_pct', r.avg_pct), v_from, v_max)
    on conflict do nothing;
    v_count := v_count + 1;
  end loop;

  -- GOOD: branch above baseline on >= 3 of last 7 days
  for r in
    select branch_code, count(*) as good_days, round(avg(pct_vs_baseline),1) as avg_pct
    from marts.v_sales_vs_baseline
    where date_key between v_from and v_max and pct_vs_baseline > 20
    group by 1 having count(*) >= 3
  loop
    insert into ops.insights (rule_key, status, entity_key, title, detail, action, metrics, period_start, period_end)
    values ('sales_surge', 'good', r.branch_code,
      r.branch_code || ' running +' || r.avg_pct || '% vs baseline',
      r.good_days || ' strong days in the last 7.',
      'Identify the driver (campaign overlay, holiday, competitor closure, viral post) and repeat it deliberately. Verify stock and staffing can hold the new level.',
      jsonb_build_object('good_days', r.good_days, 'avg_pct', r.avg_pct), v_from, v_max)
    on conflict do nothing;
    v_count := v_count + 1;
  end loop;

  -- BAD: attachment falling — channel last 28d vs prior 28d down > 3pts
  for r in
    with cur as (
      select channel_code, 100.0 * count(*) filter (where has_addon) / nullif(count(*),0) as pct
      from core.fact_bill where date_key > v_max - 28 group by 1),
    prev as (
      select channel_code, 100.0 * count(*) filter (where has_addon) / nullif(count(*),0) as pct
      from core.fact_bill where date_key between v_max - 55 and v_max - 28 group by 1)
    select c.channel_code, round(c.pct,1) as cur_pct, round(p.pct,1) as prev_pct
    from cur c join prev p using (channel_code)
    where p.pct - c.pct > 3
  loop
    insert into ops.insights (rule_key, status, entity_key, title, detail, action, metrics, period_start, period_end)
    values ('attachment_drop', 'bad', r.channel_code,
      r.channel_code || ' add-on attachment dropped to ' || r.cur_pct || '%',
      'Down from ' || r.prev_pct || '% in the prior 4 weeks.',
      'Dine-in: re-brief staff upsell script. Delivery/Take Away: check that add-on options and set menus are still visible and in stock on the storefront.',
      jsonb_build_object('cur_pct', r.cur_pct, 'prev_pct', r.prev_pct), v_from, v_max)
    on conflict do nothing;
    v_count := v_count + 1;
  end loop;

  -- AMPLIFY: biggest attachment gap → launch top set candidate
  for r in
    select sc.target_channel, sc.anchor_name, sc.companion_name, sc.suggested_price, sc.rationale
    from marts.v_set_candidates sc limit 1
  loop
    insert into ops.insights (rule_key, status, entity_key, title, detail, action, metrics, period_start, period_end)
    values ('set_opportunity', 'amplify', r.target_channel,
      'Set candidate: ' || r.anchor_name || ' + ' || r.companion_name,
      r.rationale,
      'Launch as a set at ฿' || r.suggested_price || ' on ' || r.target_channel ||
      '. Register it in plan_campaign so uplift and cannibalization are measured automatically.',
      null, v_from, v_max)
    on conflict do nothing;
    v_count := v_count + 1;
  end loop;

  -- AMPLIFY: rising item (units +20% vs prior 28d, min volume) → feature in content
  for r in
    with cur as (select l.sku, sum(l.qty) as units from core.fact_bill_line l
      join core.fact_bill fb on fb.bill_id = l.bill_id
      where fb.date_key > v_max - 28 and l.sku is not null group by 1),
    prev as (select l.sku, sum(l.qty) as units from core.fact_bill_line l
      join core.fact_bill fb on fb.bill_id = l.bill_id
      where fb.date_key between v_max - 55 and v_max - 28 and l.sku is not null group by 1)
    select c.sku, mi.name_normalized, c.units as cur_units, p.units as prev_units
    from cur c join prev p using (sku)
    join core.dim_menu_item mi on mi.sku = c.sku
    where c.units > p.units * 1.2 and c.units >= 100 and not mi.is_set
    order by c.units desc limit 3
  loop
    insert into ops.insights (rule_key, status, entity_key, title, detail, action, metrics, period_start, period_end)
    values ('rising_item', 'amplify', r.sku,
      r.name_normalized || ' is trending: ' || r.cur_units || ' units (was ' || r.prev_units || ')',
      'Up ' || round(100.0 * (r.cur_units - r.prev_units) / nullif(r.prev_units,0)) || '% vs the prior 4 weeks.',
      'Feature it in the next content batch (Menu Appetite Appeal pillar) and pin it higher on the delivery storefront while demand is hot.',
      jsonb_build_object('cur_units', r.cur_units, 'prev_units', r.prev_units), v_from, v_max)
    on conflict do nothing;
    v_count := v_count + 1;
  end loop;

  -- BAD: C-class items dragging the delivery menu (deck p.58 curation rule)
  for r in
    select count(*) as n_items from marts.v_pareto where abc_class = 'C'
  loop
    if r.n_items >= 15 then
      insert into ops.insights (rule_key, status, entity_key, title, detail, action, metrics, period_start, period_end)
      values ('menu_tail', 'bad', 'menu',
        r.n_items || ' menu items produce the last 5% of sales',
        'Long tail confirmed by Pareto analysis.',
        'Apply the agency''s curation rule: remove or fold the weakest items into variants on the delivery storefront; keep them dine-in only if they matter operationally.',
        jsonb_build_object('c_items', r.n_items), v_from, v_max)
      on conflict do nothing;
      v_count := v_count + 1;
    end if;
  end loop;

  -- AMPLIFY: strong payday lift → schedule promos on payday windows
  for r in
    select branch_code, lift_pct from marts.v_payday_effect
    where lift_pct > 15 and payday_days >= 6
  loop
    insert into ops.insights (rule_key, status, entity_key, title, detail, action, metrics, period_start, period_end)
    values ('payday_pattern', 'amplify', r.branch_code,
      r.branch_code || ' payday lift is ' || r.lift_pct || '%',
      'Sales on payday windows (1st/15th/month-end) consistently beat baseline.',
      'Time premium sets and content pushes to payday windows; avoid discounting on those days (demand comes anyway) and discount mid-cycle instead.',
      jsonb_build_object('lift_pct', r.lift_pct), v_from, v_max)
    on conflict do nothing;
    v_count := v_count + 1;
  end loop;

  -- AMPLIFY: saturated lunch peak → shift demand, don't stoke it
  for r in
    select branch_code, hour_of_day, pct_days_near_capacity
    from marts.v_peak_saturation
    where day_type = 'weekday' and pct_days_near_capacity >= 60 and days_observed >= 20
      and hour_of_day between 11 and 13
  loop
    insert into ops.insights (rule_key, status, entity_key, title, detail, action, metrics, period_start, period_end)
    values ('peak_saturated', 'amplify', r.branch_code || ':' || r.hour_of_day,
      r.branch_code || ' ' || r.hour_of_day || ':00 runs near capacity ' || r.pct_days_near_capacity || '% of weekdays',
      'Lunch demand exceeds throughput — promos in this window waste budget.',
      'Shift, don''t stoke: pre-order/Grab-and-go for 11:30, "happy hour" pricing 13:30-16:00, and route ad spend to off-peak windows at this branch.',
      jsonb_build_object('pct_days', r.pct_days_near_capacity), v_from, v_max)
    on conflict do nothing;
    v_count := v_count + 1;
  end loop;

  -- BAD: negative review theme spiking (2x prior month)
  for r in
    with cur as (select branch_code, theme, count(*) n from marts.v_review_themes
      where month_start = date_trunc('month', v_max)::date group by 1,2),
    prev as (select branch_code, theme, count(*) n from marts.v_review_themes
      where month_start = (date_trunc('month', v_max) - interval '1 month')::date group by 1,2)
    select c.branch_code, c.theme, c.n as cur_n, coalesce(p.n,0) as prev_n
    from cur c left join prev p using (branch_code, theme)
    where c.n >= 3 and c.n > 2 * coalesce(p.n, 0)
  loop
    insert into ops.insights (rule_key, status, entity_key, title, detail, action, metrics, period_start, period_end)
    values ('review_theme_spike', 'bad', coalesce(r.branch_code,'all') || ':' || r.theme,
      'Review theme "' || r.theme || '" spiking' || coalesce(' at ' || r.branch_code, ''),
      r.cur_n || ' mentions this month vs ' || r.prev_n || ' last month.',
      'Route to operations with the review texts attached; reply to the reviews; re-check in 2 weeks whether mentions decline.',
      jsonb_build_object('cur', r.cur_n, 'prev', r.prev_n), v_from, v_max)
    on conflict do nothing;
    v_count := v_count + 1;
  end loop;

  return v_count;
end $$;

-- Surface for the dashboard
create or replace view marts.v_insights as
select id, rule_key, status, entity_key, title, detail, action, metrics,
       period_start, period_end, created_at, acknowledged
from ops.insights
order by created_at desc, status;

-- Schedule (run after data loads; harmless when empty):
--   select cron.schedule('marketing-insights', '15 2 * * *', $$select ops.generate_insights()$$);
