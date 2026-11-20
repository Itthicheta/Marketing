-- 0026: earning rules by bill amount + "more than one coupon per bill" (Point 2026-11-20).
-- A rule has ticked condition types: product (categories, optional items) and/or bill amount (min_spend, the bill
-- total incl. VAT). Both ticked = the bill must meet both. multi = false: 1 coupon per bill. multi = true: 1 per
-- qualifying dish (product rules) or 1 per every full min_spend (amount-only rules).
alter table crm.pos_bills add column if not exists total numeric;
alter table crm.coupon_rules
  add column if not exists min_spend numeric check (min_spend is null or min_spend > 0),
  add column if not exists multi boolean not null default true;
alter table crm.coupon_rules alter column categories drop not null;
alter table crm.coupon_rules drop constraint if exists coupon_rules_categories_check;
alter table crm.coupon_rules drop constraint if exists coupon_rules_condition;
alter table crm.coupon_rules add constraint coupon_rules_condition
  check (coalesce(cardinality(categories), 0) > 0 or min_spend is not null);

-- line_id = the bill line for per-dish coupons, 'bill:<order_id>' for per-bill ones
create or replace function crm.rule_hits(p_rule_id bigint, p_preview boolean default false)
returns table (line_user_id text, line_id text, units int, business_date date)
language sql stable as $$
  with b as (
    select m.line_user_id, b.order_id, b.business_date, b.total, r.multi, r.min_spend, r.categories, r.item_ids
    from crm.coupon_rules r
    join crm.pos_bills b on not b.voids_earning
      and (p_preview or b.opened_at >= r.armed_at)
      and (r.ends_on is null or b.business_date <= r.ends_on)
      and (coalesce(cardinality(r.branch_ids), 0) = 0 or b.branch_id = any(r.branch_ids))
      and (coalesce(cardinality(r.days), 0) = 0 or extract(isodow from b.opened_at at time zone 'Asia/Bangkok')::int = any(r.days))
      and (r.t_from is null or ((b.opened_at at time zone 'Asia/Bangkok')::time >= r.t_from
                                and (b.opened_at at time zone 'Asia/Bangkok')::time < r.t_to))
      and (r.min_spend is null or coalesce(b.total, 0) >= r.min_spend)
    join crm.line_members m on m.phone = b.phone and m.blocked_at is null
    where r.id = p_rule_id and (p_preview or r.active)
      and (r.group_id is null or exists (select 1 from crm.member_group_members g
                                         where g.group_id = r.group_id and g.line_user_id = m.line_user_id))
  ), l as (
    select b.*, l.line_id, floor(l.qty)::int u
    from b join crm.pos_bill_lines l on l.order_id = b.order_id and l.full_price and l.qty >= 1
      and l.category = any(b.categories)
      and (coalesce(cardinality(b.item_ids), 0) = 0 or l.item_id = any(b.item_ids))
    where coalesce(cardinality(b.categories), 0) > 0
  )
  select l.line_user_id, l.line_id, l.u, l.business_date from l where l.multi
  union all
  select distinct on (l.order_id) l.line_user_id, 'bill:' || l.order_id, 1, l.business_date from l where not l.multi
  union all
  select b.line_user_id, 'bill:' || b.order_id, case when b.multi then floor(b.total / b.min_spend)::int else 1 end, b.business_date
  from b where coalesce(cardinality(b.categories), 0) = 0 and b.min_spend is not null
$$;
