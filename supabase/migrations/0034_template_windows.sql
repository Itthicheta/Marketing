-- 0034 (Point 2026-11-26): coupon windows on the coupon itself.
--   issue_from .. issue_until = the dates a bill can EARN the coupon (both optional; issue_until came in 0033).
--   Use period = EITHER "valid for N days" (valid_days, counted from bill day + start_after_days, as before)
--             OR "valid until" a fixed date (use_until; when set it wins over valid_days).
-- A bill whose coupon would start after use_until earns nothing (it could never be used).
alter table crm.coupon_templates add column if not exists issue_from date;
alter table crm.coupon_templates add column if not exists use_until date;

create or replace function crm.apply_coupon_rules()
 returns integer language plpgsql as $function$
declare n int; d date := (now() at time zone 'Asia/Bangkok')::date;
begin
  insert into crm.coupons (line_user_id, kind, title, detail, valid_from, valid_to, template_id, rule_id, source_line, unit_no)
  select h.line_user_id, 'rule:' || r.id || ':' || h.line_id || ':' || u, t.title, t.detail,
         greatest(h.business_date + t.start_after_days, d),
         coalesce(t.use_until, greatest(h.business_date + t.start_after_days, d) + t.valid_days - 1),
         t.id, r.id, h.line_id, u
  from crm.coupon_rules r
  join crm.coupon_templates t on t.id = r.template_id and t.active
  cross join lateral crm.rule_hits(r.id, false) h
  cross join lateral generate_series(1, h.units) u
  where r.active
    and (t.issue_from is null or h.business_date >= t.issue_from)
    and (t.issue_until is null or h.business_date <= t.issue_until)
    and (t.use_until is null or greatest(h.business_date + t.start_after_days, d) <= t.use_until)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $function$;
