-- 0009: LINE member link (LINE Member Link Playbook, step 7; Point 2026-11-17).
-- Decisions 2026-11-17: OA @mamapook · this Marketing project · pilot Park Silom
-- (location 'silom') · sign-up reward = free เก๊กฮวย on the NEXT visit, valid from
-- the day after sign-up for 14 days, redeemed by the cashier tapping "ใช้สิทธิ์" on
-- the member card (then adding the POS coupon to the bill for the discount).
-- One row per LINE friend; the phone number is the link to the POS member key.
-- Rules: one LINE account holds one number, one number belongs to one LINE
-- account (unique index). Number changes are done by staff and logged in
-- crm.phone_changes (CRM amendment: LINE userId is the master, phone is the link).
-- Every inbound LINE event is kept in raw.line_events (LINE never re-sends a text).
-- Edge Functions connect with SUPABASE_DB_URL (owner role), so RLS with no
-- policies = nobody else can read phone numbers.
create schema if not exists crm;

create table if not exists crm.line_members (
  line_user_id  text primary key,
  display_name  text,
  phone         text,
  added_at      timestamptz not null default now(),
  linked_at     timestamptz,
  blocked_at    timestamptz,         -- null = currently a friend
  updated_at    timestamptz not null default now(),
  constraint line_members_phone_format check (phone is null or phone ~ '^0[689][0-9]{8}$')
);
create unique index if not exists line_members_phone_uq on crm.line_members (phone) where phone is not null;

create table if not exists crm.phone_changes (
  id            bigint generated always as identity primary key,
  line_user_id  text not null references crm.line_members(line_user_id),
  old_phone     text,
  new_phone     text,
  changed_at    timestamptz not null default now(),
  changed_by    text not null,       -- staff name
  note          text
);

-- coupons shown on the member card; one sign-up coupon per LINE account
create table if not exists crm.coupons (
  id            bigint generated always as identity primary key,
  line_user_id  text not null references crm.line_members(line_user_id),
  kind          text not null,       -- 'signup'
  title         text not null,       -- e.g. เก๊กฮวยฟรี 1 แก้ว (copied from settings at issue time)
  valid_from    date not null,
  valid_to      date not null,
  issued_at     timestamptz not null default now(),
  redeemed_at   timestamptz,
  unique (line_user_id, kind)
);

-- runtime settings the scripts read (no redeploy needed to change them)
create table if not exists crm.settings (
  key         text primary key,
  value       text,
  updated_at  timestamptz not null default now()
);
insert into crm.settings (key, value) values
  ('brand_name', 'Mama Pook'),
  ('reward_text', 'เก๊กฮวยฟรี 1 แก้ว'),
  ('reward_days', '14'),              -- coupon valid from the day after sign-up for N days
  ('liff_id', null),                  -- from step 11 (not secret)
  ('richmenu_register', null),        -- written by line-menu-setup (step 14)
  ('richmenu_member', null),
  ('setup_key', null)                 -- one-time key that arms line-menu-setup; cleared after use
on conflict (key) do nothing;

create index if not exists line_events_user_ts on raw.line_events (line_user_id, event_ts);

alter table crm.line_members  enable row level security;
alter table crm.phone_changes enable row level security;
alter table crm.settings      enable row level security;
alter table crm.coupons       enable row level security;
revoke all on schema crm from anon, authenticated;

-- Staff helper: change a member's number with an audit row.
create or replace function crm.change_phone(p_line_user_id text, p_new_phone text, p_staff text, p_note text default null)
returns void language plpgsql as $$
declare v_old text;
begin
  select phone into v_old from crm.line_members where line_user_id = p_line_user_id for update;
  if not found then raise exception 'no such LINE member %', p_line_user_id; end if;
  update crm.line_members set phone = p_new_phone, updated_at = now() where line_user_id = p_line_user_id;
  insert into crm.phone_changes (line_user_id, old_phone, new_phone, changed_by, note)
  values (p_line_user_id, v_old, p_new_phone, p_staff, p_note);
end $$;
revoke all on function crm.change_phone(text, text, text, text) from public, anon, authenticated;
