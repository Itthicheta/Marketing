-- 0037 (Point 2026-11-26): batches can be deleted. A batch none of whose codes reached ERS (and none shown) is removed
-- outright by crm-admin; otherwise it is CANCELLED (cancelled_at): its unshown codes are never handed out again and,
-- while they are still active + unused in ERS, the CRM tells Point to switch them off there.
alter table crm.code_batches add column if not exists cancelled_at timestamptz;
alter table crm.code_batches add column if not exists cancelled_by text;

drop view if exists crm.coupon_code_state;
create view crm.coupon_code_state with (security_invoker = true) as
select c.code, c.template_id, c.batch_id, c.created_at, c.coupon_id, c.shown_at, t.ers_series_id,
       e.card_id, e.series_id ers_series_seen, e.active ers_active, e.used ers_used, e.used_at, e.used_branch_id, e.used_order_id, e.used_bill_no,
       (e.card_id is not null and e.series_id = t.ers_series_id) matched,          -- found in ERS, in the coupon's series
       case when c.shown_at is null and e.used then 'fraud'                         -- used in ERS, never shown in LINE
            when b.cancelled_at is not null and c.shown_at is null then 'cancelled'
            when e.card_id is null then 'pending'                                   -- not (yet) in ERS
            when e.series_id is distinct from t.ers_series_id then 'wrong_series'
            when c.shown_at is null and not coalesce(e.active, false) then 'off'
            when c.shown_at is null then 'ready'
            when e.used then 'used'
            else 'shown' end state
from crm.coupon_codes c
join crm.code_batches b on b.id = c.batch_id
left join crm.coupon_templates t on t.id = c.template_id
left join lateral (select * from crm.ers_coupon_cards x where x.number = c.code order by (x.series_id = t.ers_series_id) desc, x.card_id limit 1) e on true;

create or replace function crm.redeem_with_code(p_coupon bigint, p_user text)
returns table (code text, used_at timestamptz, valid_to date) language plpgsql as $$
declare d date := (now() at time zone 'Asia/Bangkok')::date; cp record; k text;
begin
  select c.id, c.template_id, c.valid_to into cp from crm.coupons c
   where c.id = p_coupon and c.line_user_id = p_user and c.redeemed_at is null and d between c.valid_from and c.valid_to
   for update;
  if not found then raise exception 'code:gone'; end if;
  select cc.code into k from crm.coupon_codes cc
    join crm.code_batches b on b.id = cc.batch_id and b.cancelled_at is null
    join crm.coupon_templates t on t.id = cc.template_id
    join crm.ers_coupon_cards e on e.number = cc.code and e.series_id = t.ers_series_id and e.active and not e.used
   where cc.template_id = cp.template_id and cc.shown_at is null and cc.coupon_id is null
   order by cc.created_at, cc.code limit 1 for update of cc skip locked;
  if k is null then raise exception 'code:empty'; end if;
  update crm.coupons set redeemed_at = now() where id = cp.id;
  update crm.coupon_codes set coupon_id = cp.id, shown_at = now() where coupon_codes.code = k;
  return query select k, now(), cp.valid_to;
end $$;
revoke all on function crm.redeem_with_code(bigint, text) from public, anon, authenticated;
