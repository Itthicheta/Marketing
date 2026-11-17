-- 0011: per-person COUPONS list (Point 2026-11-17). A LINE built-in coupon in crm.line_coupon_list is
-- either for everyone (audience = 'all') or for a target group: the LINE user IDs Claude exported as the
-- OA Manager audience file are recorded in crm.line_coupon_targets, so the COUPONS button shows each
-- member only the coupons broadcast to them.
alter table crm.line_coupon_list add column if not exists audience text not null default 'all';  -- 'all' or a group name
create table if not exists crm.line_coupon_targets (
  coupon_id     bigint not null references crm.line_coupon_list(id) on delete cascade,
  line_user_id  text not null,
  primary key (coupon_id, line_user_id)
);
alter table crm.line_coupon_targets enable row level security;
