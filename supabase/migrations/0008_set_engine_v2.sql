-- 0008: set-menu engine v2 — margin-aware, incremental-GP framework (docs/05)
--   * v_set_candidates: adds candidate class (attachment/revival), P/E populations,
--     per-attacher gain, break-even adoption, projected incremental GP
--   * v_set_pnl: realized before/after gross-profit verdict per launched set
--   * set_verdict insight rule; cron consolidated into ops.run_insights()

drop view if exists marts.v_set_candidates;   -- column list changes in v2
create view marts.v_set_candidates as
with maxd as (select max(date_key) as d from core.fact_bill),
bs as (                                            -- distinct bill x item, 90d, Sets excluded
  select distinct fb.bill_id, l.sku
  from core.fact_bill fb
  join core.fact_bill_line l on l.bill_id = fb.bill_id
  join core.dim_menu_item mi on mi.sku = l.sku
  where l.sku is not null and not mi.is_set
    and fb.date_key > (select d from maxd) - 90
),
tot as (select count(distinct bill_id)::numeric as n from bs),
item_bills as (select sku, count(*)::numeric as n_sku from bs group by 1),
median_units as (select percentile_cont(0.5) within group (order by n_sku) as med from item_bills),
anchors as (                                       -- Step 2: top-10 main dishes by traffic
  select mi.sku, mi.name_normalized, ib.n_sku,
         rank() over (order by ib.n_sku desc) as traffic_rank
  from item_bills ib
  join core.dim_menu_item mi on mi.sku = ib.sku
  join core.dim_category c on c.category_code = mi.category_code
  where c.is_main_dish
  order by ib.n_sku desc limit 10
),
pairs as (
  select a.sku as sku_a, b.sku as sku_b, count(*)::numeric as n_ab
  from bs a join bs b on a.bill_id = b.bill_id and a.sku < b.sku
  group by 1,2 having count(*) >= 20               -- Step 1: min shared bills
),
chan_gap as (
  select fb.channel_code,
         round(100.0 * count(*) filter (where fb.has_addon) / nullif(count(*),0), 1) as pct_with_addon
  from core.fact_bill fb
  where fb.date_key > (select d from maxd) - 90
  group by 1
),
target as (select channel_code, pct_with_addon from chan_gap order by pct_with_addon asc limit 1),
cand as (
  select an.sku as anchor_sku, an.name_normalized as anchor_name, an.traffic_rank,
         an.n_sku as anchor_bills,
         case when p.sku_a = an.sku then p.sku_b else p.sku_a end as companion_sku,
         p.n_ab
  from anchors an
  join pairs p on (p.sku_a = an.sku or p.sku_b = an.sku)
),
enriched as (
  select c.*,
         cm.name_normalized as companion_name,
         cm.price as companion_price, cm.unit_cost as companion_cost,
         am.price as anchor_price,   am.unit_cost as anchor_cost,
         cc.is_addon as companion_is_addon,
         case when cm.price is not null and cm.unit_cost is not null
              then round(100.0 * (cm.price - cm.unit_cost) / nullif(cm.price,0), 1) end as companion_margin_pct,
         ib.n_sku as companion_bills,
         -- Step 1 statistics
         round(c.n_ab * t.n / (c.anchor_bills * ib.n_sku), 2) as lift,
         round(100.0 * c.n_ab / t.n, 2) as support_pct,
         -- Step 5 populations
         (c.anchor_bills - c.n_ab)::int as potential_attachers,   -- P: anchor without companion
         c.n_ab::int as existing_pairers                          -- E: cannibalization exposure
  from cand c
  cross join tot t
  join core.dim_menu_item cm on cm.sku = c.companion_sku
  join core.dim_menu_item am on am.sku = c.anchor_sku
  join core.dim_category cc on cc.category_code = cm.category_code
  join item_bills ib on ib.sku = c.companion_sku
),
classed as (
  select e.*,
         case
           when e.companion_is_addon then 'attachment'
           -- Revival bundle: slow item (below median traffic) that earns its seat:
           -- margin >= 55% AND shows real affinity despite low volume (visibility signature)
           when e.companion_bills < (select med from median_units)
                and e.companion_margin_pct >= 55 and e.lift >= 1.3 then 'revival'
         end as candidate_class
  from enriched e
), priced as (
  select c.*,
         (c.anchor_price + c.companion_price) as list_sum,
         floor((c.anchor_price + c.companion_price) * 0.88 / 5) * 5 as suggested_price
  from classed c
  where c.candidate_class is not null and c.lift >= 1.1
)
select p.anchor_sku, p.anchor_name, p.companion_sku, p.companion_name, p.candidate_class,
       p.lift, p.support_pct, p.n_ab::int as bills_together,
       p.potential_attachers, p.existing_pairers,
       p.anchor_price, p.companion_price, p.list_sum, p.suggested_price,
       (p.list_sum - p.suggested_price) as discount,
       -- Step 4: margin math (null until cost file loads)
       case when p.anchor_cost is not null and p.companion_cost is not null
            then round(100.0 * (p.anchor_cost + p.companion_cost) / nullif(p.suggested_price,0), 1) end as food_cost_pct,
       case when p.anchor_cost is not null and p.companion_cost is not null
            then (p.anchor_cost + p.companion_cost) / nullif(p.suggested_price,0) > 0.45 else false end as fails_margin_guard,
       -- Step 5: incremental-GP framework
       case when p.companion_cost is not null
            then p.suggested_price - p.anchor_price - p.companion_cost end as gain_per_attacher,
       case when p.companion_cost is not null and (p.suggested_price - p.anchor_price - p.companion_cost) > 0
            then round(100.0 * p.existing_pairers * (p.list_sum - p.suggested_price)
                 / nullif(p.potential_attachers * (p.suggested_price - p.anchor_price - p.companion_cost), 0), 1)
            end as breakeven_adoption_pct,
       case when p.companion_cost is not null
            then round(0.10 * p.potential_attachers * (p.suggested_price - p.anchor_price - p.companion_cost)
                 - p.existing_pairers * (p.list_sum - p.suggested_price), 0)
            end as projected_gp_at_10pct_adoption,
       t.channel_code as target_channel, t.pct_with_addon as target_attachment_pct,
       round((p.lift * ln(1 + p.n_ab) * (11 - p.traffic_rank))::numeric, 1) as behavior_score,
       format('%s bills already pair these (lift %s). %s potential attachers vs %s existing pairers on %s.',
              p.n_ab::int, p.lift, p.potential_attachers, p.existing_pairers, t.channel_code) as rationale
from priced p
cross join target t
order by projected_gp_at_10pct_adoption desc nulls last, behavior_score desc;

-- Step 7: realized verdict — family GP/day (anchor + companion + set) after vs before launch
create or replace view marts.v_set_pnl as
with launches as (
  select sc.set_sku, min(fb.date_key) as launch_date
  from core.set_component sc
  join core.fact_bill_line l on l.sku = sc.set_sku
  join core.fact_bill fb on fb.bill_id = l.bill_id
  group by sc.set_sku
),
family as (  -- the set itself + its components sold standalone
  select set_sku, component_sku as member_sku from core.set_component
  union select set_sku, set_sku from core.set_component
),
daily_gp as (
  select f.set_sku, fb.date_key,
         sum(l.net_amount - coalesce(l.qty * mi.unit_cost, 0)) as gp
  from family f
  join core.fact_bill_line l on l.sku = f.member_sku
  join core.fact_bill fb on fb.bill_id = l.bill_id
  join core.dim_menu_item mi on mi.sku = l.sku
  group by 1,2
)
select lc.set_sku, mi.name_normalized as set_name, lc.launch_date,
       (select max(date_key) from core.fact_bill) - lc.launch_date as days_live,
       round(avg(d.gp) filter (where d.date_key between lc.launch_date - 28 and lc.launch_date - 1), 0) as family_gp_per_day_before,
       round(avg(d.gp) filter (where d.date_key >= lc.launch_date), 0) as family_gp_per_day_after,
       round(avg(d.gp) filter (where d.date_key >= lc.launch_date)
           - avg(d.gp) filter (where d.date_key between lc.launch_date - 28 and lc.launch_date - 1), 0) as delta_gp_per_day
from launches lc
join core.dim_menu_item mi on mi.sku = lc.set_sku
left join daily_gp d on d.set_sku = lc.set_sku
group by lc.set_sku, mi.name_normalized, lc.launch_date;

-- Set-verdict insight rule (docs/06 rule #11)
create or replace function ops.check_set_verdicts()
returns int language plpgsql as $$
declare v_count int := 0; v_max date; r record;
begin
  select max(date_key) into v_max from core.fact_bill;
  if v_max is null then return 0; end if;
  for r in
    select * from marts.v_set_pnl
    where days_live >= 28 and delta_gp_per_day is not null
  loop
    if r.delta_gp_per_day >= 0 then
      insert into ops.insights (rule_key, status, entity_key, title, detail, action, metrics, period_start, period_end)
      values ('set_verdict', 'good', r.set_sku,
        r.set_name || ' is net-positive: +฿' || r.delta_gp_per_day || ' gross profit/day',
        'Family gross profit (set + components) after launch vs the 28 days before.',
        'Scale it: push on the target channel, feature in content, consider extending to other branches/channels.',
        jsonb_build_object('delta_gp_per_day', r.delta_gp_per_day, 'days_live', r.days_live),
        r.launch_date, v_max)
      on conflict do nothing;
    else
      insert into ops.insights (rule_key, status, entity_key, title, detail, action, metrics, period_start, period_end)
      values ('set_verdict', 'bad', r.set_sku,
        r.set_name || ' is net-negative: ฿' || r.delta_gp_per_day || ' gross profit/day',
        'Cannibalization is outweighing incremental attach — the discount leaks to customers who paid full price before.',
        'Reprice (shrink the discount), swap the companion for a higher-margin one, or kill the set. Re-check verdict 28 days after any change.',
        jsonb_build_object('delta_gp_per_day', r.delta_gp_per_day, 'days_live', r.days_live),
        r.launch_date, v_max)
      on conflict do nothing;
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- One entry point for the nightly cron
create or replace function ops.run_insights()
returns int language plpgsql as $$
declare a int; b int;
begin
  a := ops.generate_insights();
  b := ops.check_set_verdicts();
  return a + b;
end $$;

-- Reschedule the nightly job to the consolidated entry point
--   select cron.schedule('marketing-insights', '15 2 * * *', $$select ops.run_insights()$$);
