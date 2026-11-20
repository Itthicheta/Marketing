-- Test for 0025 (crm.rule_hits / crm.apply_coupon_rules). One transaction, always rolled back.
-- Run: paste the whole file into Supabase MCP execute_sql, project qtpwrwapbefczvqdfzes.
-- PASS = the result row says ALL PASS; any FAIL raises an error naming the case.
begin;
delete from crm.pos_bill_lines; delete from crm.pos_bills;              -- isolate from real synced bills
update crm.coupon_rules set active = false;                             -- and from real rules
insert into crm.line_members (line_user_id, display_name, phone) values
  ('Utest_A', 'Test A', '0699999901'), ('Utest_B', 'Test B', '0699999902');
with tpl as (insert into crm.coupon_templates (title, start_after_days, valid_days) values ('TEST ลด 30%', 1, 7) returning id),
     grp as (insert into crm.member_groups (name) values ('TEST group') returning id)
insert into crm.coupon_rules (name, template_id, group_id, branch_ids, t_from, t_to, categories, active, armed_at)
select 'TEST rule', tpl.id, grp.id, '{7}', '16:00', '20:00', '{main,set}', true, now() - interval '20 days' from tpl, grp;
insert into crm.member_group_members (group_id, line_user_id) select id, 'Utest_A' from crm.member_groups where name = 'TEST group';
insert into crm.coupon_rules (name, template_id, categories, active)          -- matches everything but is off
select 'TEST off', id, '{main,set,side,topping,dessert,beverage}', false from crm.coupon_templates where title = 'TEST ลด 30%';
insert into crm.pos_bills (order_id, phone, branch_id, opened_at, business_date, voids_earning)
select x.oid, x.phone, x.br, ((t.d - x.ago) + x.tm) at time zone 'Asia/Bangkok', t.d - x.ago, x.void
from (select (now() at time zone 'Asia/Bangkok')::date d) t,
     (values ('T-1', '0699999901', 7,  1, time '17:00', false),   -- earns 2: main ×2 full price (฿0 main and drink don't)
             ('T-2', '0699999901', 7,  1, time '17:30', true),    -- something applied: 0
             ('T-3', '0699999901', 8,  1, time '17:00', false),   -- other branch: 0
             ('T-4', '0699999901', 7,  1, time '15:00', false),   -- before 16:00: 0
             ('T-5', '0699999902', 7,  1, time '17:00', false),   -- LINE member outside the group: 0
             ('T-6', '0699999903', 7,  1, time '17:00', false),   -- not on LINE: 0
             ('T-7', '0699999901', 7, 10, time '18:00', false),   -- arrived 10 days late: 1, valid from today for 7 days
             ('T-8', '0699999901', 7, 25, time '18:00', false)    -- before the rule was armed: 0
     ) x(oid, phone, br, ago, tm, void);
insert into crm.pos_bill_lines (line_id, order_id, item_id, name, category, qty, full_price) values
  ('T-1-a', 'T-1', 892, 'S1', 'main', 2, true), ('T-1-b', 'T-1', 893, 'S2 free', 'main', 1, false),
  ('T-1-c', 'T-1', 1599, 'water', 'beverage', 1, true), ('T-2-a', 'T-2', 892, 'S1', 'main', 3, true),
  ('T-3-a', 'T-3', 892, 'S1', 'main', 1, true), ('T-4-a', 'T-4', 892, 'S1', 'main', 1, true),
  ('T-5-a', 'T-5', 892, 'S1', 'main', 1, true), ('T-6-a', 'T-6', 892, 'S1', 'main', 1, true),
  ('T-7-a', 'T-7', 970, 'S3', 'set', 1, true), ('T-8-a', 'T-8', 892, 'S1', 'main', 1, true);
do $$
declare n int; d date := (now() at time zone 'Asia/Bangkok')::date; r record;
begin
  n := crm.apply_coupon_rules();
  if n <> 3 then raise exception 'FAIL first run issued % (want 3)', n; end if;
  n := crm.apply_coupon_rules();
  if n <> 0 then raise exception 'FAIL second run issued % (want 0: no duplicates)', n; end if;
  select count(*) into n from crm.coupons where line_user_id = 'Utest_A' and source_line = 'T-1-a';
  if n <> 2 then raise exception 'FAIL main ×2 gave % coupons (want 2)', n; end if;
  select * into r from crm.coupons where source_line = 'T-1-a' and unit_no = 1;
  if r.valid_from <> d or r.valid_to <> d + 6 then raise exception 'FAIL validity % – % (want % – %)', r.valid_from, r.valid_to, d, d + 6; end if;
  if r.title <> 'TEST ลด 30%' or r.kind not like 'rule:%:T-1-a:1' then raise exception 'FAIL title/kind % / %', r.title, r.kind; end if;
  select * into r from crm.coupons where source_line = 'T-7-a';
  if r.valid_from <> d or r.valid_to <> d + 6 then raise exception 'FAIL late bill validity % – % (want % – %)', r.valid_from, r.valid_to, d, d + 6; end if;
  select count(*) into n from crm.coupons where line_user_id = 'Utest_B';
  if n <> 0 then raise exception 'FAIL member outside the group got % coupons', n; end if;
  select coalesce(sum(units), 0) into n from crm.rule_hits((select id from crm.coupon_rules where name = 'TEST rule'), true);
  if n <> 4 then raise exception 'FAIL preview counted % (want 4: T-1 ×2, T-7, T-8)', n; end if;
  update crm.coupon_templates set active = false where title = 'TEST ลด 30%';
  insert into crm.pos_bill_lines values ('T-1-d', 'T-1', 892, 'S1', 'main', 1, true);
  n := crm.apply_coupon_rules();
  if n <> 0 then raise exception 'FAIL inactive template still issued %', n; end if;
  insert into crm.coupons (line_user_id, kind, title, valid_from, valid_to) values ('Utest_A', 'signup', 'x', d, d);
  begin
    insert into crm.coupons (line_user_id, kind, title, valid_from, valid_to) values ('Utest_A', 'signup', 'x', d, d);
    raise exception 'FAIL a second sign-up coupon was allowed';
  exception when unique_violation then null;
  end;
end $$;
select 'ALL PASS' as result;
rollback;
