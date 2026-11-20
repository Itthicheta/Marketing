-- 0021 — per-branch visit counts on the CRM Members table (Point 2026-11-20): branch initials as column heads
-- (G, Si, O, SS, AS, R9, in that order) and each member's in-store visits per branch.
alter table crm.branches add column if not exists short text;
alter table crm.branches add column if not exists short_sort int;
update crm.branches b set short = v.short, short_sort = v.o
from (values (7, 'G', 1), (6, 'Si', 2), (8, 'O', 3), (9, 'SS', 4), (10, 'AS', 5), (5, 'R9', 6)) v(id, short, o)
where b.branch_id = v.id;
alter table crm.pos_member_stats add column if not exists branch_visits jsonb;   -- {"<branch_id>": visits}
