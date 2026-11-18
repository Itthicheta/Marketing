-- 0012: points + rewards on the member card, PROMOTIONS button, sign-up form (Point 2026-11-18).
-- Decisions (docs/07): ERS is the only points system; the card shows the ERS balance (refreshed
-- ~30 min by the Mac pipeline, tools/crm_points_push.py → Edge Function crm-points-sync) and a
-- view-only reward ladder; all redemption at the cashier in ERS; points expire after 3 months (ERS).
-- Second menu button = PROMOTIONS from crm.promotions (open to everyone; branch column for later).
-- Sign-up = a form opened from the chat through a one-time link (crm.signup_tokens); fields name,
-- birthday, branch, phone, consent. SMS one-time code comes later.

-- member profile from the sign-up form
alter table crm.line_members
  add column if not exists full_name       text,
  add column if not exists birthday        date,
  add column if not exists branch_id       int,
  add column if not exists consent_at      timestamptz,
  add column if not exists consent_version text,
  add column if not exists signup_source   text;      -- 'chat' (typed phone, before the form) | 'form'
update crm.line_members set signup_source = 'chat' where phone is not null and signup_source is null;

-- ERS points balance per phone (all ERS members with a phone; replaced on every sync)
create table if not exists crm.pos_points (
  phone         text primary key,
  points        numeric not null,
  as_of         timestamptz not null,    -- time of the bill or customer snapshot the balance comes from
  last_bill_at  timestamptz,             -- latest bill of any kind for this customer
  last_branch_id int,
  synced_at     timestamptz not null default now()
);

-- ERS redeemable items (pos_m_items.isredeempoint), replaced on every sync
create table if not exists crm.pos_rewards (
  item_code  text primary key,
  ers_name   text not null,
  points     numeric not null,
  synced_at  timestamptz not null default now()
);
-- optional customer-facing name / picture per ERS reward item (edited by hand)
create table if not exists crm.reward_display (
  item_code    text primary key,
  display_name text,
  image_url    text,
  hidden       boolean not null default false
);

-- ERS branches shown in the sign-up form (synced)
create table if not exists crm.branches (
  branch_id  int primary key,
  name       text not null,              -- short name, e.g. Park Silom
  active     boolean not null default true,
  sort       int not null default 100
);

-- PROMOTIONS button (open to everyone; branch_id null = all branches)
create table if not exists crm.promotions (
  id          bigint generated always as identity primary key,
  title       text not null,
  body        text,                      -- one or two short lines
  image_url   text,                      -- public https picture (storage bucket line-promos)
  valid_from  date not null,
  valid_to    date not null,
  branch_id   int,                       -- null = all branches (per-branch later)
  sort        int not null default 100,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- one-time links that open the sign-up form for a known LINE user
create table if not exists crm.signup_tokens (
  token         text primary key,
  line_user_id  text not null references crm.line_members(line_user_id),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '7 days',
  used_at       timestamptz
);
create index if not exists signup_tokens_user on crm.signup_tokens (line_user_id);

insert into crm.settings (key, value) values
  ('points_sync_key', null),                 -- shared with the Mac pipeline (.env MARKETING_POINTS_KEY)
  ('signup_form_url', null),                 -- the form page, e.g. https://<worker>/register.html
  ('privacy_version', 'draft-2026-11-18'),   -- shown with the consent box; bump when the wording changes
  ('points_expiry_note', 'แต้มมีอายุ 3 เดือน'),
  ('signup_push', 'on')                      -- after the form: push the confirmation + card (1 message each)
on conflict (key) do nothing;
-- the COUPONS button now opens PROMOTIONS (same OA Manager action id until Point edits the button)
insert into crm.settings (key, value)
  select 'menu_action_promotions', value from crm.settings where key = 'menu_action_coupons'
on conflict (key) do nothing;

alter table crm.pos_points     enable row level security;
alter table crm.pos_rewards    enable row level security;
alter table crm.reward_display enable row level security;
alter table crm.branches       enable row level security;
alter table crm.promotions     enable row level security;
alter table crm.signup_tokens  enable row level security;
