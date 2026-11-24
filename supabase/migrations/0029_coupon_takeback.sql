-- 0029 — take back earned coupons when their bill is voided (Point 2026-11-24).
-- The Mac push (tools/crm_points_push.py) sends `voided` = {orders: voided member bills of the last 21 days,
-- lines: every line of those bills + single lines voided off bills that stay live}. crm-points-sync v11 calls
-- crm.take_back_voided() before apply_coupon_rules(). Only UNUSED rule coupons go; used ones stay as history.
-- Each removed coupon is copied to crm.coupon_takebacks first, so a take-back can always be traced / restored.
-- keep_on_void = true exempts a coupon (Point kept his 23 Nov test coupons on the card, 2026-11-24).

alter table crm.coupons add column if not exists keep_on_void boolean not null default false;

create table if not exists crm.coupon_takebacks (
  id           bigserial primary key,
  coupon_id    bigint not null,
  line_user_id text not null,
  kind         text not null,
  title        text,
  template_id  bigint,
  rule_id      bigint,
  source_line  text,
  unit_no      int,
  valid_from   date,
  valid_to     date,
  issued_at    timestamptz,
  taken_at     timestamptz not null default now(),
  reason       text not null default 'bill voided'
);
create index if not exists coupon_takebacks_user on crm.coupon_takebacks (line_user_id, taken_at desc);
alter table crm.coupon_takebacks enable row level security;   -- service role only, like the other crm tables

create or replace function crm.take_back_voided(p_orders text[], p_lines text[])
returns integer language plpgsql as $$
declare n int;
begin
  with gone as (
    delete from crm.coupons c
    where c.rule_id is not null and c.redeemed_at is null and not c.keep_on_void
      and (c.source_line = any (select 'bill:' || o from unnest(coalesce(p_orders, '{}')) o)
           or c.source_line = any (coalesce(p_lines, '{}')))
    returning c.*
  )
  insert into crm.coupon_takebacks (coupon_id, line_user_id, kind, title, template_id, rule_id, source_line, unit_no,
                                    valid_from, valid_to, issued_at)
  select id, line_user_id, kind, title, template_id, rule_id, source_line, unit_no, valid_from, valid_to, issued_at from gone;
  get diagnostics n = row_count;
  return n;
end $$;
