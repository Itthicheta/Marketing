-- 0004: marts — metric views, one per dashboard component.
-- Naming: marts.v_<subject>. Deck page references in comments.
-- The dashboard reads ONLY this schema.

-- Helper: main-dish-count bucket 0,1,...,10,'11+' (deck p.19/24/33)
create or replace function marts.basket_bucket(n int)
returns text language sql immutable as
$$ select case when n >= 11 then '11+' else coalesce(n,0)::text end $$;

-- ---------------------------------------------------------------------
-- p.4: monthly sales / transactions / ABS by branch
create or replace view marts.v_monthly_by_branch as
select date_trunc('month', date_key)::date as month_start,
       branch_code,
       sum(net_amount)                       as sales,
       count(*)                              as transactions,
       round(sum(net_amount) / nullif(count(*),0), 2) as abs_thb,
       round(sum(net_amount) / nullif(count(distinct date_key),0), 2) as avg_sales_per_day  -- p.53
from core.fact_bill
group by 1, 2;

-- p.5-8: branch x channel matrix (sales, transactions, ABS, contribution %)
create or replace view marts.v_branch_channel as
with base as (
  select date_trunc('month', date_key)::date as month_start,
         branch_code, channel_code,
         sum(net_amount) as sales, count(*) as transactions
  from core.fact_bill
  group by 1,2,3
)
select *,
       round(sales / nullif(transactions,0), 2) as abs_thb,
       round(100.0 * sales / nullif(sum(sales) over (partition by month_start, branch_code),0), 2) as sales_pct_of_branch,
       round(100.0 * transactions / nullif(sum(transactions) over (partition by month_start, branch_code),0), 2) as txn_pct_of_branch
from base;

-- p.9-10, 29-30: daypart profiles — hour contribution % and ABS,
-- by branch x channel x day type. Column-normalized within series.
create or replace view marts.v_daypart as
with base as (
  select fb.branch_code, fb.channel_code, d.day_type, fb.hour_of_day,
         sum(fb.net_amount) as sales, count(*) as bills
  from core.fact_bill fb
  join core.dim_date d on d.date_key = fb.date_key
  group by 1,2,3,4
)
select *,
       round(sales / nullif(bills,0), 2) as abs_thb,
       round(100.0 * sales / nullif(sum(sales) over (partition by branch_code, channel_code, day_type),0), 2) as sales_contribution_pct
from base;

-- p.13/16, 31-32: category share by channel and by branch, x day type
create or replace view marts.v_category_mix as
with base as (
  select fb.branch_code, fb.channel_code, d.day_type,
         coalesce(mi.category_code, 'unmapped') as category_code,
         sum(l.net_amount) as sales, sum(l.qty) as units
  from core.fact_bill_line l
  join core.fact_bill fb on fb.bill_id = l.bill_id
  join core.dim_date d on d.date_key = fb.date_key
  left join core.dim_menu_item mi on mi.sku = l.sku
  group by 1,2,3,4
)
select *,
       round(100.0 * sales / nullif(sum(sales) over (partition by channel_code, day_type),0), 2) as pct_of_channel,
       round(100.0 * sales / nullif(sum(sales) over (partition by branch_code, day_type),0), 2)  as pct_of_branch
from base;

-- p.14: menu item ranking with per-channel share (normalized names)
create or replace view marts.v_menu_ranking as
with base as (
  select coalesce(mi.sku,'unmapped') as sku,
         coalesce(mi.name_normalized, l.item_name_raw) as item_name,
         mi.category_code, fb.channel_code,
         sum(l.net_amount) as sales, sum(l.qty) as units
  from core.fact_bill_line l
  join core.fact_bill fb on fb.bill_id = l.bill_id
  left join core.dim_menu_item mi on mi.sku = l.sku
  group by 1,2,3,4
)
select *,
       round(100.0 * sales / nullif(sum(sales) over (partition by channel_code),0), 2) as pct_of_channel,
       rank() over (partition by channel_code order by sales desc) as rank_in_channel,
       rank() over (order by sales desc) as rank_overall
from base;

-- p.15/17: noodle-type preference mix by channel and branch
create or replace view marts.v_noodle_mix as
with base as (
  select fb.branch_code, fb.channel_code, nt.noodle_code, nt.name_en,
         sum(l.qty) as units
  from core.fact_bill_line l
  join core.fact_bill fb on fb.bill_id = l.bill_id
  join core.dim_noodle_type nt on nt.noodle_code = l.noodle_code
  group by 1,2,3,4
)
select *,
       round(100.0 * units / nullif(sum(units) over (partition by channel_code),0), 2) as pct_of_channel,
       round(100.0 * units / nullif(sum(units) over (partition by branch_code),0), 2)  as pct_of_branch
from base;

-- p.19/33: distribution of bills by main-dish count; p.19 combo patterns
create or replace view marts.v_basket_distribution as
with base as (
  select fb.branch_code, fb.channel_code, d.day_type,
         marts.basket_bucket(fb.main_dish_qty) as basket_bucket,
         count(*) as bills, sum(fb.net_amount) as sales
  from core.fact_bill fb
  join core.dim_date d on d.date_key = fb.date_key
  group by 1,2,3,4
)
select *,
       round(100.0 * bills / nullif(sum(bills) over (partition by branch_code, day_type),0), 2) as pct_of_branch_bills
from base;

create or replace view marts.v_combo_patterns as
select marts.basket_bucket(main_dish_qty) as basket_bucket,
       combo_pattern,
       count(*) as bills,
       round(100.0 * count(*) / nullif(sum(count(*)) over (partition by marts.basket_bucket(main_dish_qty)),0), 2) as pct_within_bucket,
       rank() over (partition by marts.basket_bucket(main_dish_qty) order by count(*) desc) as rank_in_bucket
from core.fact_bill
where main_dish_qty > 0
group by 1, 2;

-- p.20-23, 25: add-on attachment by basket group x channel / branch.
-- Definitions per deck p.21: pct_with_addon uses ALL bills as denominator;
-- addon_per_bill uses bills WITH add-on. Set items already excluded in addon_units.
create or replace view marts.v_addon_attachment as
select fb.branch_code, fb.channel_code,
       marts.basket_bucket(fb.main_dish_qty) as basket_bucket,
       count(*) as bills,
       round(100.0 * count(*) filter (where fb.has_addon) / nullif(count(*),0), 2) as pct_with_addon,
       round(sum(fb.addon_units)::numeric / nullif(count(*) filter (where fb.has_addon),0), 2) as addon_per_bill,
       round(sum(fb.addon_units)::numeric / nullif(sum(fb.main_dish_qty),0), 2) as addon_per_main_dish
from core.fact_bill fb
group by 1,2,3;

-- p.20/26: add-on units per bill split by subcategory
create or replace view marts.v_addon_by_subcategory as
with addon_lines as (
  select fb.branch_code, fb.channel_code,
         marts.basket_bucket(fb.main_dish_qty) as basket_bucket,
         mi.addon_subcategory, sum(l.qty) as units
  from core.fact_bill_line l
  join core.fact_bill fb on fb.bill_id = l.bill_id
  join core.dim_menu_item mi on mi.sku = l.sku
  join core.dim_category c on c.category_code = mi.category_code
  where c.is_addon and not mi.is_set and mi.addon_subcategory is not null
  group by 1,2,3,4
),
bills_with_addon as (
  select branch_code, channel_code,
         marts.basket_bucket(main_dish_qty) as basket_bucket,
         count(*) filter (where has_addon) as bills_with_addon
  from core.fact_bill group by 1,2,3
)
select a.*, b.bills_with_addon,
       round(a.units::numeric / nullif(b.bills_with_addon,0), 2) as units_per_bill_with_addon
from addon_lines a
join bills_with_addon b using (branch_code, channel_code, basket_bucket);

-- p.24: ABS by basket group x branch (+ ABS per main dish, % of sales)
create or replace view marts.v_abs_by_basket as
select branch_code,
       marts.basket_bucket(main_dish_qty) as basket_bucket,
       count(*) as bills,
       round(avg(net_amount), 2) as abs_thb,
       round(avg(net_amount / nullif(main_dish_qty,0)), 2) as abs_per_main_dish,
       round(100.0 * sum(net_amount) / nullif(sum(sum(net_amount)) over (partition by branch_code),0), 2) as pct_of_branch_sales
from core.fact_bill
group by 1,2;

-- p.28: weekday vs weekend — sales/day, orders/day, ABS by branch
create or replace view marts.v_weekday_weekend as
select fb.branch_code, d.day_type,
       round(sum(fb.net_amount) / nullif(count(distinct fb.date_key),0), 2) as sales_per_day,
       round(count(*)::numeric / nullif(count(distinct fb.date_key),0), 2)  as orders_per_day,
       round(sum(fb.net_amount) / nullif(count(*),0), 2)                    as abs_thb
from core.fact_bill fb
join core.dim_date d on d.date_key = fb.date_key
group by 1,2;

-- ---------------------------------------------------------------------
-- p.53/56: marketing spend, budget vs actual, ROI
create or replace view marts.v_marketing_monthly as
with spend as (
  select date_trunc('month', spend_date)::date as month_start,
         cost_type_code, sum(amount) as actual_spend
  from core.fact_marketing_spend group by 1,2
),
sales as (
  select date_trunc('month', date_key)::date as month_start, sum(net_amount) as sales
  from core.fact_bill group by 1
)
select coalesce(sp.month_start, pb.month_start) as month_start,
       coalesce(sp.cost_type_code, pb.cost_type_code) as cost_type_code,
       sp.actual_spend,
       pb.planned_amount,
       round(100.0 * sp.actual_spend / nullif(pb.planned_amount,0), 1) as pct_of_budget,
       s.sales as month_sales,
       round(s.sales / nullif(sum(sp.actual_spend) over (partition by sp.month_start),0), 2) as roi_month  -- p.53: sales / total spend
from spend sp
full join core.plan_budget pb
  on pb.month_start = sp.month_start and pb.cost_type_code = sp.cost_type_code
left join sales s on s.month_start = coalesce(sp.month_start, pb.month_start);

-- p.59: CPO by campaign / audience / day
create or replace view marts.v_cpo as
select perf_date, platform_code, campaign_id, audience_group,
       sum(spend) as spend,
       sum(attributed_orders) as orders,
       round(sum(spend) / nullif(sum(attributed_orders),0), 2) as cpo,
       round(sum(attributed_sales) / nullif(sum(spend),0), 2)  as roas
from core.fact_ad_performance
group by 1,2,3,4;

-- ---------------------------------------------------------------------
-- Baseline: trailing 4-week same-weekday average per branch (holiday-aware).
-- Powers anomaly alerts and campaign uplift.
create or replace view marts.v_daily_sales as
select fb.date_key, fb.branch_code,
       sum(fb.net_amount) as sales, count(*) as bills,
       d.day_of_week, d.day_type, d.is_holiday
from core.fact_bill fb
join core.dim_date d on d.date_key = fb.date_key
group by fb.date_key, fb.branch_code, d.day_of_week, d.day_type, d.is_holiday;

create or replace view marts.v_sales_vs_baseline as
select cur.date_key, cur.branch_code, cur.sales,
       base.baseline_sales,
       round(100.0 * (cur.sales - base.baseline_sales) / nullif(base.baseline_sales,0), 1) as pct_vs_baseline
from marts.v_daily_sales cur
cross join lateral (
  select avg(prev.sales) as baseline_sales
  from marts.v_daily_sales prev
  where prev.branch_code = cur.branch_code
    and prev.day_of_week = cur.day_of_week
    and prev.date_key between cur.date_key - 28 and cur.date_key - 1
    and prev.is_holiday = cur.is_holiday
) base;

-- Campaign uplift: actual vs baseline during campaign window (metric #24)
create or replace view marts.v_campaign_uplift as
select c.campaign_id, c.name, c.start_date, c.end_date,
       sum(v.sales) as actual_sales,
       sum(v.baseline_sales) as baseline_sales,
       round(sum(v.sales) - sum(v.baseline_sales), 2) as uplift_thb,
       round(100.0 * (sum(v.sales) - sum(v.baseline_sales)) / nullif(sum(v.baseline_sales),0), 1) as uplift_pct
from core.plan_campaign c
join marts.v_sales_vs_baseline v
  on v.date_key between c.start_date and coalesce(c.end_date, current_date)
 and (cardinality(c.branch_codes) = 0 or v.branch_code = any(c.branch_codes))
group by 1,2,3,4;

-- ---------------------------------------------------------------------
-- Social & content
create or replace view marts.v_social_growth as
select platform_code, account_handle, is_competitor, snapshot_date, followers,
       followers - lag(followers) over (partition by platform_code, account_handle order by snapshot_date) as follower_change
from core.fact_social_snapshot;

create or replace view marts.v_post_performance as
select post_key, platform_code, account_handle, is_competitor, date_key, post_type,
       pillar_code, focus_skus, caption, url,
       reach, views, likes, comments, shares, saves,
       (coalesce(likes,0) + coalesce(comments,0) + coalesce(shares,0) + coalesce(saves,0)) as engagements,
       round(100.0 * (coalesce(likes,0) + coalesce(comments,0) + coalesce(shares,0) + coalesce(saves,0))
             / nullif(reach, 0), 2) as engagement_rate_pct
from core.fact_social_post;

-- Content -> sales link (metric #27): item sales 7 days after post vs 7 days before
create or replace view marts.v_content_sales_impact as
with post_items as (
  select p.post_key, p.platform_code, p.date_key as post_date, unnest(p.focus_skus) as sku
  from core.fact_social_post p
  where p.is_competitor = false and cardinality(p.focus_skus) > 0 and p.date_key is not null
),
item_daily as (
  select fb.date_key, l.sku, sum(l.net_amount) as sales
  from core.fact_bill_line l join core.fact_bill fb on fb.bill_id = l.bill_id
  where l.sku is not null
  group by 1,2
)
select pi.post_key, pi.platform_code, pi.post_date, pi.sku,
       sum(d.sales) filter (where d.date_key between pi.post_date and pi.post_date + 6)     as sales_7d_after,
       sum(d.sales) filter (where d.date_key between pi.post_date - 7 and pi.post_date - 1) as sales_7d_before,
       round(100.0 * (sum(d.sales) filter (where d.date_key between pi.post_date and pi.post_date + 6)
                    - sum(d.sales) filter (where d.date_key between pi.post_date - 7 and pi.post_date - 1))
             / nullif(sum(d.sales) filter (where d.date_key between pi.post_date - 7 and pi.post_date - 1), 0), 1) as lift_pct
from post_items pi
left join item_daily d on d.sku = pi.sku
group by 1,2,3,4;

-- ---------------------------------------------------------------------
-- Reputation
create or replace view marts.v_ratings_trend as
select platform_code, branch_code, is_competitor, competitor_code, snapshot_date,
       avg_rating, rating_count,
       avg_rating - lag(avg_rating) over (partition by platform_code, coalesce(branch_code, competitor_code) order by snapshot_date) as rating_change
from core.fact_listing_snapshot;

create or replace view marts.v_review_themes as
select date_trunc('month', date_key)::date as month_start,
       branch_code, platform_code, unnest(themes) as theme,
       count(*) as reviews, round(avg(rating), 2) as avg_rating
from core.fact_review
where is_competitor = false
group by 1,2,3,4;

-- ---------------------------------------------------------------------
-- Menu engineering (needs unit_cost from menu master): popularity x margin
create or replace view marts.v_menu_engineering as
with item_perf as (
  select mi.sku, mi.name_normalized, mi.category_code,
         sum(l.qty) as units, sum(l.net_amount) as sales,
         case when mi.unit_cost is not null
              then round(sum(l.net_amount) - sum(l.qty) * mi.unit_cost, 2) end as gross_margin,
         case when mi.unit_cost is not null and sum(l.net_amount) > 0
              then round(100.0 * (sum(l.net_amount) - sum(l.qty) * mi.unit_cost) / sum(l.net_amount), 1) end as margin_pct
  from core.fact_bill_line l
  join core.dim_menu_item mi on mi.sku = l.sku
  where not mi.is_set
  group by 1,2,3
)
select *,
       units  > avg(units)  over () as high_popularity,
       margin_pct > avg(margin_pct) over () as high_margin,
       case when units > avg(units) over () and coalesce(margin_pct > avg(margin_pct) over (), false) then 'star'
            when units > avg(units) over ()  then 'plowhorse'
            when coalesce(margin_pct > avg(margin_pct) over (), false) then 'puzzle'
            else 'dog' end as menu_class
from item_perf;

-- Data health: unmapped POS item names to resolve in core.map_item_name
create or replace view marts.v_unmapped_items as
select l.item_name_raw, count(*) as line_count, sum(l.net_amount) as sales
from core.fact_bill_line l
where l.sku is null
group by 1 order by sales desc;
