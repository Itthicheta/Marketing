-- 0014: CRM admin area on the sales site (Point 2026-11-18: "a CRM tab at the same layer as sales and
-- marketing — do all the config, see all the results and insights"). The sales site (Cloudflare Pages
-- mamapook-sales, whole site behind login) calls Edge Function crm-admin through its own Pages Function
-- /api/crm, which adds header x-admin-key (Pages secret CRM_ADMIN_KEY). crm-admin compares
-- sha256(x-admin-key) with crm.settings.admin_key_sha256 — the raw key lives only in the Pages secret and
-- the Mac .env (CRM_ADMIN_KEY). Every change made from the page is logged here with the login name.
create table if not exists crm.admin_log (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  actor   text not null,           -- sales-site login name
  op      text not null,           -- set_setting, promo_save, reward_save, change_phone, coupon_send, ...
  detail  jsonb
);
create table if not exists crm.coupon_sends (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  actor         text not null,
  title         text not null,
  audience      text not null,     -- friends | members | branch:<id> | user:<line id>
  recipients    int not null,
  coupon_id     text,
  valid_from    timestamptz,
  valid_to      timestamptz,
  quota_before  int,
  quota_after   int,
  error         text
);
alter table crm.admin_log    enable row level security;
alter table crm.coupon_sends enable row level security;
insert into crm.settings (key, value) values ('admin_key_sha256', null) on conflict (key) do nothing;
