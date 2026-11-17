-- 0010: list behind the COUPONS menu button (Point 2026-11-17).
-- One row per LINE built-in coupon campaign (created in the OA Manager). The webhook replies to the
-- "คูปองของฉัน" tap with the rows whose dates include today, each with an open button (the coupon's
-- share URL). LINE itself enforces 1-use-per-person and records usage.
create table if not exists crm.line_coupon_list (
  id          bigint generated always as identity primary key,
  title       text not null,          -- shown to the customer, e.g. ส่วนลด 20 บาท สำหรับสมาชิก
  url         text not null,          -- coupon share URL from the OA Manager coupon page
  image_url   text,                   -- optional picture for the box (https)
  valid_from  date not null,
  valid_to    date not null,
  sort        int not null default 100,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
alter table crm.line_coupon_list enable row level security;
