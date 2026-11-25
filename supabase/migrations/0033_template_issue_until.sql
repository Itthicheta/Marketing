-- 0033 (Point 2026-11-25): last day a coupon can be EARNED, set on the coupon itself (edit form "รับคูปองได้ถึงวันที่").
-- Bills with business_date after issue_until earn nothing from any of the coupon's rules; coupons already on cards stay
-- usable until their own valid_to. null = no end. (Each rule also keeps its own ends_on; both apply.)
alter table crm.coupon_templates add column if not exists issue_until date;

create or replace function crm.apply_coupon_rules()
 returns integer language plpgsql as $function$
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
  where r.active and (t.issue_until is null or h.business_date <= t.issue_until)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $function$;
