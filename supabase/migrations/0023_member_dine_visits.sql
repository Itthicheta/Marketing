-- 0023 — dine-in vs take-away share per member (Point 2026-11-20). take-away visits = visits - dine_visits.
alter table crm.pos_member_stats add column if not exists dine_visits int;
