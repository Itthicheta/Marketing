-- 0022 — people per visit from two sources (Point 2026-11-20): bowls (main + set units) and the guest count
-- staff key into ERS (orders.pax). Sum of pax for the average; per-member medians of both per visit.
alter table crm.pos_member_stats add column if not exists pax numeric;
alter table crm.pos_member_stats add column if not exists med_bowls numeric;
alter table crm.pos_member_stats add column if not exists med_pax numeric;
