-- 0020 — promotional LINE coupon sends keep what the coupon said (Point 2026-11-20: reward + usage
-- conditions configurable in the Send coupon tab). LINE enforces none of the conditions; they are the
-- coupon's usageCondition text (max 100) that staff check at the cashier.
alter table crm.coupon_sends add column if not exists reward jsonb;
alter table crm.coupon_sends add column if not exists usage_condition text;
alter table crm.coupon_sends add column if not exists max_use int;
