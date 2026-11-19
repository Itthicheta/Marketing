-- 0017: line-webhook v9 and crm-admin v3 read crm.promotions.branch_ids (0016); the single branch_id is retired.
alter table crm.promotions drop column if exists branch_id;
