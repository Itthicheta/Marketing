-- 0016: a promotion can target several branches (Point 2026-11-19: "in drop down branch, we should be able to tick").
-- branch_ids int[]: null or empty = all branches. Backfilled from branch_id; branch_id is dropped once line-webhook
-- and crm-admin read branch_ids (same day).
alter table crm.promotions add column if not exists branch_ids int[];
update crm.promotions set branch_ids = array[branch_id] where branch_id is not null and branch_ids is null;
