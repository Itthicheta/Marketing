-- 0030 — when a member-card coupon may be USED (Point 2026-11-24, after-2PM coupon "usable after 14:00, every day").
-- use_from / use_to = Bangkok time of day (null = no limit on that side; use_to is exclusive), use_days = ISO weekdays
-- 1=Mon..7=Sun (null = every day). Set per coupon in CRM › Coupon rules; line-webhook v15 shows it on the card and
-- refuses "ใช้สิทธิ์" outside it. Earning hours stay on the rule (coupon_rules.t_from / t_to = bill opening time).
alter table crm.coupon_templates
  add column if not exists use_from time,
  add column if not exists use_to   time,
  add column if not exists use_days smallint[];
alter table crm.coupon_templates drop constraint if exists coupon_templates_use_window;
alter table crm.coupon_templates add constraint coupon_templates_use_window check (
  (use_from is null or use_to is null or use_from < use_to)
  and (use_days is null or (cardinality(use_days) between 1 and 6 and use_days <@ '{1,2,3,4,5,6,7}'::smallint[])));
