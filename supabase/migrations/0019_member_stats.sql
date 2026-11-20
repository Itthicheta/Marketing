-- 0019 — per-member visit stats and ERS promotion uses, computed from ERS bills on the Mac
-- (tools/crm_points_push.py) and pushed with the points by crm-points-sync (Point 2026-11-20:
-- the CRM Members table shows visits, people per visit, spend, add-on / drink attach, day-clock slots,
-- coupons and promotions per member). Both tables are replaced on every sync. In-store bills only
-- (dine-in + take-away); delivery bills sit on 3 platform customers in ERS, not on people.
create table if not exists crm.pos_member_stats (
  phone          text primary key,
  visits         int not null,            -- in-store bills
  days           int not null,            -- distinct business dates (for the gap between visits)
  first_visit    date,
  last_visit     date,
  bowls          numeric not null,        -- main + set units = people (1 bowl = 1 person)
  spend_thb      numeric not null,        -- bill totals inc VAT
  addon_units    numeric not null,        -- side + topping + dessert units
  drink_units    numeric not null,        -- beverage units
  weekend_visits int not null,            -- Sat / Sun (by arrival time)
  slots          int[] not null,          -- visits per day-clock slot, in MK_DAY.bands order (7)
  synced_at      timestamptz not null default now()
);
create table if not exists crm.pos_promo_uses (
  phone      text not null,
  sold_at    timestamptz not null,
  branch_id  int,
  promo_id   int,
  promo_name text,
  items      numeric
);
create index if not exists pos_promo_uses_phone on crm.pos_promo_uses (phone);
alter table crm.pos_member_stats enable row level security;
alter table crm.pos_promo_uses enable row level security;
