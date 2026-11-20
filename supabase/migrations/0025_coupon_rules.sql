-- 0025: auto-earned member-card coupons (Point 2026-11-20). Spec: docs/superpowers/specs/2026-11-20-coupon-rules-design.md
-- Templates (CRM › Coupon rules) say what a coupon is; rules (CRM › Criteria) say who earns it and when.
-- The Mac pushes 14 days of in-store bills (crm.pos_bills / pos_bill_lines) and the menu (crm.pos_menu)
-- through crm-points-sync, which then runs crm.apply_coupon_rules(). Earn only when nothing is applied to the
-- bill; 1 coupon per full-price unit; LINE members only; silent (no LINE message); never combined with promotions.
create table if not exists crm.coupon_templates (
  id               bigint generated always as identity primary key,
  title            text not null check (char_length(title) between 2 and 40),
  detail           text check (detail is null or char_length(detail) <= 100),
  start_after_days int not null default 1 check (start_after_days between 0 and 30),
  valid_days       int not null default 7 check (valid_days between 1 and 90),
  ers_hint         text check (ers_hint is null or char_length(ers_hint) <= 60),   -- what the cashier keys in ERS
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create table if not exists crm.member_groups (
  id         bigint generated always as identity primary key,
  name       text not null unique check (char_length(name) between 2 and 60),
  kind       text not null default 'list' check (kind in ('list')),   -- criteria-based groups later
  created_at timestamptz not null default now()
);
create table if not exists crm.member_group_members (
  group_id     bigint not null references crm.member_groups(id) on delete cascade,
  line_user_id text not null references crm.line_members(line_user_id) on delete cascade,
  added_at     timestamptz not null default now(),
  primary key (group_id, line_user_id)
);
create table if not exists crm.coupon_rules (
  id          bigint generated always as identity primary key,
  name        text not null check (char_length(name) between 2 and 60),
  template_id bigint not null references crm.coupon_templates(id),
  group_id    bigint references crm.member_groups(id),     -- null = all LINE members
  branch_ids  int[],                                       -- null/empty = all branches
  days        int[],                                       -- ISO weekdays 1-7; null/empty = every day
  t_from      time,
  t_to        time,                                        -- exclusive; both null = all day
  categories  text[] not null check (cardinality(categories) > 0),
  item_ids    bigint[],                                    -- null/empty = every item in the categories
  active      boolean not null default false,
  armed_at    timestamptz,                                 -- bills opened before this never count
  ends_on     date,                                        -- last bill date, optional
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint coupon_rules_time check ((t_from is null) = (t_to is null) and (t_from is null or t_from < t_to)),
  constraint coupon_rules_armed check (not active or armed_at is not null)
);
create table if not exists crm.pos_bills (
  order_id      text primary key,          -- backbone order_id = branchid-saleid
  phone         text not null,
  bill_no       text,
  branch_id     int not null,
  opened_at     timestamptz not null,
  business_date date not null,
  voids_earning boolean not null,          -- promotion, discount, price override, bill discount or points redemption
  synced_at     timestamptz not null default now()
);
create table if not exists crm.pos_bill_lines (
  line_id    text primary key,             -- backbone line_id = branchid-saleitemid
  order_id   text not null references crm.pos_bills(order_id) on delete cascade,
  item_id    bigint,
  name       text,
  category   text,                         -- backbone tree_category
  qty        numeric not null,
  full_price boolean not null              -- initprice > 0 and extendedprice >= initprice × qty
);
create index if not exists pos_bills_phone on crm.pos_bills (phone);
create index if not exists pos_bill_lines_order on crm.pos_bill_lines (order_id);
create table if not exists crm.pos_menu (
  item_id   bigint primary key,
  item_code text,
  name      text,
  category  text
);
alter table crm.coupons
  add column if not exists template_id bigint references crm.coupon_templates(id),
  add column if not exists rule_id     bigint references crm.coupon_rules(id),
  add column if not exists source_line text,
  add column if not exists unit_no     int,
  add column if not exists detail      text;
create unique index if not exists coupons_rule_unit on crm.coupons (rule_id, source_line, unit_no) where rule_id is not null;
alter table crm.coupon_templates     enable row level security;
alter table crm.member_groups        enable row level security;
alter table crm.member_group_members enable row level security;
alter table crm.coupon_rules         enable row level security;
alter table crm.pos_bills            enable row level security;
alter table crm.pos_bill_lines       enable row level security;
alter table crm.pos_menu             enable row level security;

-- which (member, bill line, units) a rule matches; p_preview ignores active/armed_at (CRM "ลองนับ")
create or replace function crm.rule_hits(p_rule_id bigint, p_preview boolean default false)
returns table (line_user_id text, line_id text, units int, business_date date)
language sql stable as $$
  select m.line_user_id, l.line_id, floor(l.qty)::int, b.business_date
  from crm.coupon_rules r
  join crm.pos_bills b on not b.voids_earning
    and (p_preview or b.opened_at >= r.armed_at)
    and (r.ends_on is null or b.business_date <= r.ends_on)
    and (coalesce(cardinality(r.branch_ids), 0) = 0 or b.branch_id = any(r.branch_ids))
    and (coalesce(cardinality(r.days), 0) = 0 or extract(isodow from b.opened_at at time zone 'Asia/Bangkok')::int = any(r.days))
    and (r.t_from is null or ((b.opened_at at time zone 'Asia/Bangkok')::time >= r.t_from
                              and (b.opened_at at time zone 'Asia/Bangkok')::time < r.t_to))
  join crm.line_members m on m.phone = b.phone and m.blocked_at is null
  join crm.pos_bill_lines l on l.order_id = b.order_id and l.full_price and l.qty >= 1
    and l.category = any(r.categories)
    and (coalesce(cardinality(r.item_ids), 0) = 0 or l.item_id = any(r.item_ids))
  where r.id = p_rule_id and (p_preview or r.active)
    and (r.group_id is null or exists (select 1 from crm.member_group_members g
                                       where g.group_id = r.group_id and g.line_user_id = m.line_user_id))
$$;

-- issue every coupon the active rules have earned; safe to run any number of times
create or replace function crm.apply_coupon_rules() returns int language plpgsql as $$
declare n int; d date := (now() at time zone 'Asia/Bangkok')::date;
begin
  insert into crm.coupons (line_user_id, kind, title, detail, valid_from, valid_to, template_id, rule_id, source_line, unit_no)
  select h.line_user_id, 'rule:' || r.id || ':' || h.line_id || ':' || u, t.title, t.detail,
         greatest(h.business_date + t.start_after_days, d),
         greatest(h.business_date + t.start_after_days, d) + t.valid_days - 1,
         t.id, r.id, h.line_id, u
  from crm.coupon_rules r
  join crm.coupon_templates t on t.id = r.template_id and t.active
  cross join lateral crm.rule_hits(r.id, false) h
  cross join lateral generate_series(1, h.units) u
  where r.active
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
