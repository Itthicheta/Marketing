-- 0024 — one row per in-store visit for the member detail card (Point 2026-11-20). Replaced on every sync
-- by crm-points-sync from tools/crm_points_push.py; read by crm-admin op member_visits.
create table if not exists crm.pos_member_visits (
  phone     text not null,
  bill_no   text,
  at        timestamptz not null,   -- bill opened (arrival)
  branch_id int,
  channel   text,                   -- dine_in | take_away
  bowls     numeric,                -- main + set units
  pax       numeric,                -- guests keyed by staff
  spend     numeric,                -- bill total inc VAT
  addon     numeric,                -- side + topping + dessert units
  drinks    numeric,                -- beverage units
  items     text,                   -- what was ordered, "name ×qty, …" (max 400 chars)
  promos    text                    -- ERS promotions on the bill
);
create index if not exists pos_member_visits_phone on crm.pos_member_visits (phone, at desc);
alter table crm.pos_member_visits enable row level security;
