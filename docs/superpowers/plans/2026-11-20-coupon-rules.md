# Coupon rules + Criteria Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Members earn member-card coupons automatically, one per qualifying dish on a bill with nothing applied to it, configured in two new CRM tabs (Coupon rules, Criteria).

**Architecture:** The Mac pipeline adds the last 14 days of in-store bills (with lines and a "something was applied" flag) and the menu to the payload it already posts every ~30 min. Edge Function crm-points-sync stores them in the Marketing DB and runs `crm.apply_coupon_rules()`, which inserts coupons into `crm.coupons`. The LINE member card groups identical coupons, and each staff confirm uses exactly one. The sales site edits templates, rules and hand-picked groups through crm-admin.

**Tech Stack:** Postgres (Supabase Marketing `qtpwrwapbefczvqdfzes`, schema `crm`), Deno Edge Functions with postgres.js 3.4.5, Python 3 (backbone venv, psycopg via `shared.backbone`), plain browser JS (sales site, Cloudflare Pages).

**Spec:** `docs/superpowers/specs/2026-11-20-coupon-rules-design.md` (Marketing repo).

## Global Constraints

- A bill earns **only if nothing is applied to it**: no `appliedpromotionid > 0` on any active line, no line discount (`discountamount + amountdiscount > 0`), no `ispriceoverride`, no bill discount (`pos_t_sale.discountamount > 0`), no points redemption (`redeemedpoint > 0`).
- **1 coupon per unit of a qualifying dish**; a line qualifies only if `full_price` (`initprice > 0 and extendedprice ≥ initprice × qty`).
- **LINE members only** (`crm.line_members.phone` = bill phone, `blocked_at is null`). Non-LINE customers earn nothing.
- **Silent.** No LINE message is ever sent by this feature. The standing rule (no customer message without a preview and Point's explicit "send") is untouched.
- **Coupons never combine with other promotions.** The card and the staff confirm always show `ใช้ร่วมกับโปรโมชั่นอื่นไม่ได้`.
- **Validity:** `valid_from = greatest(business_date + start_after_days, today_bkk)`, `valid_to = valid_from + valid_days − 1`. Bill window is 14 days.
- **No backdating:** only bills with `opened_at ≥ armed_at` count. armed_at is reset to now() when a rule is switched on, or when a live rule is saved.
- Earned coupons use `kind = 'rule:<rule_id>:<line_id>:<unit_no>'`; the existing `unique (line_user_id, kind)` stays (it keeps one sign-up coupon per member).
- Never print CRM_ADMIN_KEY, MARKETING_POINTS_KEY or any secret; never put LINE user ids in admin_log.
- Edge Functions are deployed with the Supabase MCP `deploy_edge_function` (full file content, `verify_jwt: false`), migrations with MCP `apply_migration`.
- Every CRM label exists in both `th` and `en` with identical key sets.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Repo | Responsibility |
|---|---|---|
| `supabase/migrations/0025_coupon_rules.sql` | Marketing | Create: tables, `crm.rule_hits`, `crm.apply_coupon_rules` |
| `supabase/tests/0025_coupon_rules_test.sql` | Marketing | Create: fixture test, runs in one rolled-back transaction |
| `supabase/functions/crm-points-sync/index.ts` | Marketing | Modify: v9 accepts `bills` + `menu`, runs the rules |
| `supabase/functions/crm-admin/index.ts` | Marketing | Modify: v11 ops `rules_data`, `template_save`, `rule_save`, `rule_toggle`, `rule_preview`, `group_save`, `group_delete` |
| `supabase/functions/line-webhook/index.ts` | Marketing | Modify: card groups coupons; earned-coupon redeem |
| `tools/crm_points_push.py` | Mamapook-data (`~/mamapook-data`) | Modify: `BILLS_SQL`, `MENU_SQL`, `--dry` |
| `app/site/crm/crm_rules.js` | sales (`~/sales`) | Create: the two tabs + groups (labels, render, actions) |
| `app/site/index.html` | sales | Modify: two `<section>`s + one `<script>` |
| `Project Marketing.md`, `Project Sales Web.md` (+ vault copy), `Project Data Backbone.md` | all | Modify: log + how it works |

---

### Task 1: Schema and rule engine (migration 0025)

**Files:**
- Create: `~/Documents/GitHub/Marketing/supabase/tests/0025_coupon_rules_test.sql`
- Create: `~/Documents/GitHub/Marketing/supabase/migrations/0025_coupon_rules.sql`

**Interfaces:**
- Produces tables `crm.coupon_templates`, `crm.member_groups`, `crm.member_group_members`, `crm.coupon_rules`, `crm.pos_bills`, `crm.pos_bill_lines`, `crm.pos_menu`, and new `crm.coupons` columns `template_id, rule_id, source_line, unit_no, detail`.
- Produces `crm.rule_hits(p_rule_id bigint, p_preview boolean default false) returns table (line_user_id text, line_id text, units int, business_date date)`. With `p_preview` true it ignores `active` and `armed_at`.
- Produces `crm.apply_coupon_rules() returns int` (coupons inserted).

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/0025_coupon_rules_test.sql`:

```sql
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
```

- [ ] **Step 2: Run the test and check that it fails**

Run it with MCP `execute_sql` (project `qtpwrwapbefczvqdfzes`) with the file content.
Expected: error `relation "crm.coupon_rules" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0025_coupon_rules.sql`:

```sql
-- 0025: auto-earned member-card coupons (Point 2026-11-20). Spec: docs/superpowers/specs/2026-11-20-coupon-rules-design.md
-- Templates (CRM › Coupon rules) say what a coupon is; rules (CRM › Criteria) say who earns it and when.
-- The Mac pushes 14 days of in-store bills (crm.pos_bills / pos_bill_lines) and the menu (crm.pos_menu)
-- through crm-points-sync, which then runs crm.apply_coupon_rules(). Earn only when nothing is applied to the
-- bill; 1 coupon per full-price unit; LINE members only; silent (no LINE message); never combined with promotions.
create table if not exists crm.coupon_templates (
  id               bigint generated always as identity primary key,
  title            text not null check (char_length(title) between 2 and 40),
  detail           text check (detail is null or char_length(detail) <= 100),
  start_after_days int not null default 1 check (start_after_days between 0 and 30),
  valid_days       int not null default 7 check (valid_days between 1 and 90),
  ers_hint         text check (ers_hint is null or char_length(ers_hint) <= 60),   -- what the cashier keys in ERS
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create table if not exists crm.member_groups (
  id         bigint generated always as identity primary key,
  name       text not null unique check (char_length(name) between 2 and 60),
  kind       text not null default 'list' check (kind in ('list')),   -- criteria-based groups later
  created_at timestamptz not null default now()
);
create table if not exists crm.member_group_members (
  group_id     bigint not null references crm.member_groups(id) on delete cascade,
  line_user_id text not null references crm.line_members(line_user_id) on delete cascade,
  added_at     timestamptz not null default now(),
  primary key (group_id, line_user_id)
);
create table if not exists crm.coupon_rules (
  id          bigint generated always as identity primary key,
  name        text not null check (char_length(name) between 2 and 60),
  template_id bigint not null references crm.coupon_templates(id),
  group_id    bigint references crm.member_groups(id),     -- null = all LINE members
  branch_ids  int[],                                       -- null/empty = all branches
  days        int[],                                       -- ISO weekdays 1-7; null/empty = every day
  t_from      time,
  t_to        time,                                        -- exclusive; both null = all day
  categories  text[] not null check (cardinality(categories) > 0),
  item_ids    bigint[],                                    -- null/empty = every item in the categories
  active      boolean not null default false,
  armed_at    timestamptz,                                 -- bills opened before this never count
  ends_on     date,                                        -- last bill date, optional
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint coupon_rules_time check ((t_from is null) = (t_to is null) and (t_from is null or t_from < t_to)),
  constraint coupon_rules_armed check (not active or armed_at is not null)
);
create table if not exists crm.pos_bills (
  order_id      text primary key,          -- backbone order_id = branchid-saleid
  phone         text not null,
  bill_no       text,
  branch_id     int not null,
  opened_at     timestamptz not null,
  business_date date not null,
  voids_earning boolean not null,          -- promotion, discount, price override, bill discount or points redemption
  synced_at     timestamptz not null default now()
);
create table if not exists crm.pos_bill_lines (
  line_id    text primary key,             -- backbone line_id = branchid-saleitemid
  order_id   text not null references crm.pos_bills(order_id) on delete cascade,
  item_id    bigint,
  name       text,
  category   text,                         -- backbone tree_category
  qty        numeric not null,
  full_price boolean not null              -- initprice > 0 and extendedprice >= initprice × qty
);
create index if not exists pos_bills_phone on crm.pos_bills (phone);
create index if not exists pos_bill_lines_order on crm.pos_bill_lines (order_id);
create table if not exists crm.pos_menu (
  item_id   bigint primary key,
  item_code text,
  name      text,
  category  text
);
alter table crm.coupons
  add column if not exists template_id bigint references crm.coupon_templates(id),
  add column if not exists rule_id     bigint references crm.coupon_rules(id),
  add column if not exists source_line text,
  add column if not exists unit_no     int,
  add column if not exists detail      text;
create unique index if not exists coupons_rule_unit on crm.coupons (rule_id, source_line, unit_no) where rule_id is not null;
alter table crm.coupon_templates     enable row level security;
alter table crm.member_groups        enable row level security;
alter table crm.member_group_members enable row level security;
alter table crm.coupon_rules         enable row level security;
alter table crm.pos_bills            enable row level security;
alter table crm.pos_bill_lines       enable row level security;
alter table crm.pos_menu             enable row level security;

-- which (member, bill line, units) a rule matches; p_preview ignores active/armed_at (CRM "ลองนับ")
create or replace function crm.rule_hits(p_rule_id bigint, p_preview boolean default false)
returns table (line_user_id text, line_id text, units int, business_date date)
language sql stable as $$
  select m.line_user_id, l.line_id, floor(l.qty)::int, b.business_date
  from crm.coupon_rules r
  join crm.pos_bills b on not b.voids_earning
    and (p_preview or b.opened_at >= r.armed_at)
    and (r.ends_on is null or b.business_date <= r.ends_on)
    and (coalesce(cardinality(r.branch_ids), 0) = 0 or b.branch_id = any(r.branch_ids))
    and (coalesce(cardinality(r.days), 0) = 0 or extract(isodow from b.opened_at at time zone 'Asia/Bangkok')::int = any(r.days))
    and (r.t_from is null or ((b.opened_at at time zone 'Asia/Bangkok')::time >= r.t_from
                              and (b.opened_at at time zone 'Asia/Bangkok')::time < r.t_to))
  join crm.line_members m on m.phone = b.phone and m.blocked_at is null
  join crm.pos_bill_lines l on l.order_id = b.order_id and l.full_price and l.qty >= 1
    and l.category = any(r.categories)
    and (coalesce(cardinality(r.item_ids), 0) = 0 or l.item_id = any(r.item_ids))
  where r.id = p_rule_id and (p_preview or r.active)
    and (r.group_id is null or exists (select 1 from crm.member_group_members g
                                       where g.group_id = r.group_id and g.line_user_id = m.line_user_id))
$$;

-- issue every coupon the active rules have earned; safe to run any number of times
create or replace function crm.apply_coupon_rules() returns int language plpgsql as $$
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
  where r.active
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
```

- [ ] **Step 4: Apply the migration**

MCP `apply_migration`, project `qtpwrwapbefczvqdfzes`, name `0025_coupon_rules`, query = the file content.
Expected: success.

- [ ] **Step 5: Run the test again and check that it passes**

MCP `execute_sql` with the test file content.
Expected: one row `ALL PASS`. Then check that nothing leaked: `select count(*) from crm.line_members where line_user_id like 'Utest%'` → 0.

- [ ] **Step 6: Commit**

```bash
cd ~/Documents/GitHub/Marketing
git add supabase/migrations/0025_coupon_rules.sql supabase/tests/0025_coupon_rules_test.sql
git commit -m "0025 coupon rules: templates, groups, rules, 14-day bill copy, rule_hits + apply_coupon_rules (fixture test passes)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 2: crm-points-sync v9 (store bills + menu, run the rules)

**Files:**
- Modify: `~/Documents/GitHub/Marketing/supabase/functions/crm-points-sync/index.ts`

**Interfaces:**
- Consumes: `crm.pos_bills`, `crm.pos_bill_lines`, `crm.pos_menu`, `crm.apply_coupon_rules()` (Task 1).
- Produces: POST body may add `bills: [{order_id, phone, bill_no, branch_id, opened_at, business_date, voids_earning, lines: [{line_id, item_id, name, category, qty, full_price}]}]` and `menu: [{item_id, item_code, name, category}]`. The response adds `bills`, `menu`, `coupons_issued`, `coupon_error`.
- Rules: `bills` absent → tables untouched; `bills: []` → tables emptied. `voids_earning` defaults to true unless exactly `false` (fail closed). The rules run in a savepoint, so a rule error never blocks the points sync.

- [ ] **Step 1: Edit the header comment and the body destructuring**

Append to the header comment block (after the `v8` line):

```ts
// v9 (2026-11-20, 0025): optional `bills` (14 days of in-store bills with lines + voids_earning) replaces crm.pos_bills /
// crm.pos_bill_lines, optional `menu` replaces crm.pos_menu; then crm.apply_coupon_rules() issues earned member-card
// coupons inside a savepoint (a rule error is reported as coupon_error and never blocks the points sync).
```

Change:

```ts
    const { members, rewards, branches, stats, promo_uses, visits } = await req.json();
```

to:

```ts
    const { members, rewards, branches, stats, promo_uses, visits, bills, menu } = await req.json();
    let issued: number | null = null, couponError: string | null = null;
```

- [ ] **Step 2: Add the bills / menu / rules block**

Insert immediately before the line `      if (Array.isArray(rewards)) {`:

```ts
      if (Array.isArray(menu) && menu.length) {
        await tx`delete from crm.pos_menu`;
        const mr = [...new Map(menu.filter((r: any) => Number.isInteger(Number(r.item_id))).map((r: any) => [Number(r.item_id), {
          item_id: Number(r.item_id), item_code: r.item_code ?? null, name: r.name ?? null, category: r.category ?? null }])).values()];
        for (let i = 0; i < mr.length; i += 500) {
          await tx`insert into crm.pos_menu ${tx(mr.slice(i, i + 500), "item_id", "item_code", "name", "category")}`;
        }
      }
      if (Array.isArray(bills)) {
        await tx`delete from crm.pos_bill_lines`;
        await tx`delete from crm.pos_bills`;
        const bs = [...new Map(bills
          .filter((b: any) => ok(String(b.phone)) && b.order_id && b.opened_at && b.business_date && Number.isInteger(Number(b.branch_id)))
          .map((b: any) => [String(b.order_id), {
            order_id: String(b.order_id), phone: String(b.phone), bill_no: b.bill_no ?? null, branch_id: Number(b.branch_id),
            opened_at: b.opened_at, business_date: b.business_date,
            voids_earning: b.voids_earning !== false,   // fail closed: only an explicit false lets a bill earn
          }])).values()];
        const keep = new Set(bs.map((b) => b.order_id));
        const ls = [...new Map(bills.filter((b: any) => keep.has(String(b.order_id))).flatMap((b: any) =>
          (Array.isArray(b.lines) ? b.lines : []).filter((l: any) => l.line_id).map((l: any) => [String(l.line_id), {
            line_id: String(l.line_id), order_id: String(b.order_id),
            item_id: Number.isInteger(Number(l.item_id)) ? Number(l.item_id) : null,
            name: l.name ?? null, category: l.category ?? null, qty: Number(l.qty) || 0, full_price: l.full_price === true,
          }]))).values()];
        for (let i = 0; i < bs.length; i += 500) {
          await tx`insert into crm.pos_bills ${tx(bs.slice(i, i + 500), "order_id", "phone", "bill_no", "branch_id", "opened_at", "business_date", "voids_earning")}`;
        }
        for (let i = 0; i < ls.length; i += 500) {
          await tx`insert into crm.pos_bill_lines ${tx(ls.slice(i, i + 500), "line_id", "order_id", "item_id", "name", "category", "qty", "full_price")}`;
        }
      }
      try {   // earned member-card coupons (0025); a failure here must not roll back the points sync
        issued = await tx.savepoint(async (sp) => (await sp`select crm.apply_coupon_rules() n`)[0].n as number);
      } catch (e) {
        couponError = String(e).slice(0, 300);
        console.error("apply_coupon_rules", e);
      }
```

- [ ] **Step 3: Extend the response**

Change:

```ts
      stats: stats?.length ?? 0, promo_uses: promo_uses?.length ?? 0, visits: visits?.length ?? 0 });
```

to:

```ts
      stats: stats?.length ?? 0, promo_uses: promo_uses?.length ?? 0, visits: visits?.length ?? 0,
      bills: Array.isArray(bills) ? bills.length : null, menu: Array.isArray(menu) ? menu.length : null,
      coupons_issued: issued, coupon_error: couponError });
```

- [ ] **Step 4: Deploy**

MCP `deploy_edge_function`, project `qtpwrwapbefczvqdfzes`, name `crm-points-sync`, entrypoint `index.ts`, `verify_jwt: false`, files = the full new `index.ts`.

- [ ] **Step 5: Check that the current Mac payload still works (no `bills` yet)**

```bash
~/mamapook-data/venv/bin/python ~/mamapook-data/tools/crm_points_push.py
```

Expected: `crm_points_push: {"ok":true,"members":7xx,...,"bills":null,"menu":null,"coupons_issued":0,"coupon_error":null}`.

- [ ] **Step 6: Commit**

```bash
cd ~/Documents/GitHub/Marketing
git add supabase/functions/crm-points-sync/index.ts
git commit -m "crm-points-sync v9: bills + menu, apply_coupon_rules in a savepoint

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 3: Mac push sends bills and menu

**Files:**
- Modify: `~/mamapook-data/tools/crm_points_push.py`

**Interfaces:**
- Consumes: the v9 payload keys from Task 2.
- Produces: `bills` (one object per in-store bill of the last 14 days for a real phone, with `lines`) and `menu`; `--dry` prints counts and posts nothing.

- [ ] **Step 1: Add the queries**

Add after `VISITS_SQL` (this exact query was checked on 2026-11-20: 0.65 s, 257 bills / 1,204 lines):

```python
BILLS_SQL = r"""
with cust as materialized (
  select customerid, regexp_replace(acct,'\D','','g') phone from mp_raw.pos_m_customer
  where regexp_replace(coalesce(acct,''),'\D','','g') ~ '^0[689]\d{8}$'
), o as materialized (
  select c.phone, o.order_id, o.bill_number, coalesce(o.opened_at, o.closed_at) at, o.branchid, o.business_date
  from mp_clean.orders o join cust c using (customerid)
  where o.is_finalized and not o.is_voided and not coalesce(o.is_return, false) and o.channel in ('dine_in', 'take_away')
    and o.business_date >= (now() at time zone 'Asia/Bangkok')::date - 14
), si as materialized (
  select si.branchid || '-' || si.saleid order_id,
    bool_or(coalesce(si.appliedpromotionid, 0) > 0 or coalesce(si.discountamount, 0) + coalesce(si.amountdiscount, 0) > 0
            or coalesce(si.ispriceoverride, false)) any_line
  from mp_raw.pos_sale_items si
  where si.active and si.insertdate >= (now() at time zone 'UTC') - interval '16 days'
  group by 1
), s as materialized (
  select s.branchid || '-' || s.saleid order_id, bool_or(coalesce(s.discountamount, 0) > 0 or coalesce(s.redeemedpoint, 0) > 0) bill_level
  from mp_raw.pos_t_sale s
  where s.insertdate >= (now() at time zone 'UTC') - interval '16 days' and s.deletedate is null
  group by 1
)
select o.phone, o.order_id, o.bill_number, o.at, o.branchid, o.business_date,
       coalesce(si.any_line, false) or coalesce(s.bill_level, false) voids,
       li.line_id, li.itemid, coalesce(li.name_th, li.name_en) name, li.tree_category, li.qty,
       (li.base_price_thb > 0 and li.gross_ex_vat_thb >= li.base_price_thb * li.qty - 0.005) full_price
from o
join mp_clean.order_lines li on li.order_id = o.order_id and li.is_active and not li.is_special_line
left join si on si.order_id = o.order_id
left join s on s.order_id = o.order_id
where not exists (select 1 from mp_metrics.split_dupe_lines d where d.line_id = li.line_id)
order by o.order_id, li.line_id
"""
MENU_SQL = r"""
select itemid, item_code, coalesce(name_th, name_en, itemid::text), tree_category from mp_clean.items
where is_active and not coalesce(is_special_line, false)
  and tree_category in ('main', 'set', 'side', 'topping', 'dessert', 'beverage')
order by item_code nulls last, itemid
"""
```

- [ ] **Step 2: Build `bills` / `menu`, add `--dry`, post them**

In `main()`, insert after the `visits = [...]` statement and before `c.execute(REWARDS_SQL)`:

```python
        c.execute(BILLS_SQL)
        by_order = {}
        for ph, oid, bn, at, br, bd, vo, lid, iid, nm, cat, q, fp in c.fetchall():
            b = by_order.setdefault(oid, {"order_id": oid, "phone": ph, "bill_no": bn, "opened_at": iso(at), "branch_id": br,
                                          "business_date": iso(bd), "voids_earning": bool(vo), "lines": []})
            b["lines"].append({"line_id": lid, "item_id": iid, "name": nm, "category": cat,
                               "qty": float(q or 0), "full_price": bool(fp)})
        bills = list(by_order.values())
        c.execute(MENU_SQL)
        menu = [{"item_id": i, "item_code": code, "name": n, "category": cat} for i, code, n, cat in c.fetchall()]
```

Replace the `body = json.dumps(...)` statement with:

```python
    if "--dry" in sys.argv:
        print("crm_points_push --dry:", json.dumps({
            "members": len(members), "stats": len(stats), "visits": len(visits), "bills": len(bills),
            "lines": sum(len(b["lines"]) for b in bills), "bills_voided": sum(b["voids_earning"] for b in bills),
            "menu": len(menu)}))
        return 0
    body = json.dumps({"members": members, "rewards": rewards, "branches": branches, "stats": stats,
                       "promo_uses": promo_uses, "visits": visits, "bills": bills, "menu": menu}).encode()
```

Add to the module docstring, after the `visits = ...` line:

```
Coupon rules (2026-11-20, Marketing 0025): bills = in-store bills of the last 14 days with their lines
(full_price = initprice > 0 and extendedprice >= initprice x qty) and voids_earning (any promotion, line
discount, price override, bill discount or points redemption); menu = active items for the Criteria picker.
crm-points-sync stores them and runs crm.apply_coupon_rules(). `--dry` prints counts and posts nothing.
```

- [ ] **Step 3: Dry run**

```bash
~/mamapook-data/venv/bin/python ~/mamapook-data/tools/crm_points_push.py --dry
```

Expected: one line, with `bills` around 250, `lines` around 1,200, `bills_voided` > 0 and < bills, `menu` > 50.

- [ ] **Step 4: Real run and check the Marketing tables**

```bash
~/mamapook-data/venv/bin/python ~/mamapook-data/tools/crm_points_push.py
```

Expected: the response has `"bills":2xx`, `"menu":`(the same number as the dry run), `"coupons_issued":0`, `"coupon_error":null`.
Then MCP `execute_sql` (Marketing):

```sql
select (select count(*) from crm.pos_bills) bills, (select count(*) from crm.pos_bill_lines) lines,
       (select count(*) filter (where voids_earning) from crm.pos_bills) voided, (select count(*) from crm.pos_menu) menu
```

Expected: these numbers equal the dry-run counts. Lines can be slightly lower because duplicate line ids are dropped; there should be none.

- [ ] **Step 5: Commit**

```bash
cd ~/mamapook-data
git add tools/crm_points_push.py
git commit -m "crm_points_push: 14-day bills with lines + voids flag, menu, --dry (Marketing 0025 coupon rules)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 4: crm-admin v11 (templates, rules, groups, preview)

**Files:**
- Modify: `~/Documents/GitHub/Marketing/supabase/functions/crm-admin/index.ts`
- Test helper (scratch, not committed): `/private/tmp/claude-501/-Users-point-Claude-automation-SQL-server/3fd09c68-6eef-4dfd-a52c-8948c86171d0/scratchpad/crm_admin_call.py`

**Interfaces:**
- Consumes: Task 1 tables and `crm.rule_hits`.
- Produces ops (POST `{op, ...}`):
  - `rules_data` → `{templates[], rules[], groups[], line_members[], branches[], menu[]}`. All ids are ints.
    - `templates[]`: `{id, title, detail, start_after_days, valid_days, ers_hint, active, issued, used, expired}`.
    - `rules[]`: `{id, name, template_id, group_id, branch_ids[], days[], t_from 'HH:MM'|null, t_to, categories[], item_ids[], active, armed_at, ends_on, issued, used, members}`.
    - `groups[]`: `{id, name, members[{id, name, phone}]}`.
    - `line_members[]`: `{id, name, phone}`.
    - `branches[]`: `{branch_id, name, short}`.
    - `menu[]`: `{item_id, item_code, name, category}`.
  - `template_save {id?, title, detail, start_after_days, valid_days, ers_hint, active}` → `{id}`.
  - `rule_save {id?, name, template_id, group_id|null, branch_ids[], days[], t_from, t_to, categories[], item_ids[], ends_on}` → `{id}`. Saving an active rule resets armed_at to now().
  - `rule_toggle {id, active}`; switching on sets armed_at = now() and refuses if the template is off.
  - `rule_preview {same fields as rule_save}` → `{coupons, members}` from the last 14 days, ignoring armed_at. Writes nothing.
  - `group_save {id?, name, members[line_user_id]}` → `{id}`; `group_delete {id}` refuses while a rule uses the group.
  - Errors carry `field` for the page to outline.

- [ ] **Step 1: Write the failing test helper**

Create the scratch file `crm_admin_call.py`:

```python
"""Call crm-admin with the Mac .env key (never printed). Usage: crm_admin_call.py '<json body>'"""
import json, sys, urllib.request
sys.path.insert(0, "/Users/point/mamapook-data")
from shared.env import load
env = load()
req = urllib.request.Request("https://qtpwrwapbefczvqdfzes.supabase.co/functions/v1/crm-admin",
                             data=sys.argv[1].encode(), method="POST",
                             headers={"Content-Type": "application/json", "x-admin-key": env["CRM_ADMIN_KEY"], "x-admin-user": "claude-test"})
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        print(r.read().decode()[:3000])
except urllib.error.HTTPError as e:
    print(e.code, e.read().decode()[:1000])
```

Run: `~/mamapook-data/venv/bin/python <scratchpad>/crm_admin_call.py '{"op":"rules_data"}'`
Expected: `400 {"ok":false,"error":"unknown op"}`.

- [ ] **Step 2: Add the helpers and reads**

Add after the `const log = ...` definition:

```ts
// ---------- coupon rules (0025): templates, criteria rules, hand-picked groups ----------
const CATS = ["main", "set", "side", "topping", "dessert", "beverage"];
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const LINE_ID = /^U[0-9a-f]{32}$/;
const ints = (v: any): number[] => [...new Set((Array.isArray(v) ? v : []).map(Number).filter(Number.isInteger))];
const pgArr = (a: (number | string)[]) => "{" + a.join(",") + "}";   // values are validated ints / CATS words only
class Rollback extends Error {}

async function rulesData() {
  const today = sql`(now() at time zone 'Asia/Bangkok')::date`;
  const templates = await sql`select t.id::int id, t.title, t.detail, t.start_after_days, t.valid_days, t.ers_hint, t.active,
      count(c.id)::int issued, count(c.redeemed_at)::int used,
      count(c.id) filter (where c.redeemed_at is null and c.valid_to < ${today})::int expired
    from crm.coupon_templates t left join crm.coupons c on c.template_id = t.id
    group by t.id order by t.active desc, t.id desc`;
  const rules = await sql`select r.id::int id, r.name, r.template_id::int template_id, r.group_id::int group_id,
      coalesce(r.branch_ids, '{}') branch_ids, coalesce(r.days, '{}') days,
      to_char(r.t_from, 'HH24:MI') t_from, to_char(r.t_to, 'HH24:MI') t_to, r.categories, coalesce(r.item_ids, '{}')::int[] item_ids,
      r.active, to_char(r.armed_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') armed_at, to_char(r.ends_on, 'YYYY-MM-DD') ends_on,
      count(c.id)::int issued, count(c.redeemed_at)::int used, count(distinct c.line_user_id)::int members
    from crm.coupon_rules r left join crm.coupons c on c.rule_id = r.id
    group by r.id order by r.active desc, r.id desc`;
  const groups = await sql`select g.id::int id, g.name,
      coalesce(json_agg(json_build_object('id', m.line_user_id, 'name', coalesce(m.full_name, m.display_name), 'phone', m.phone)
        order by coalesce(m.full_name, m.display_name)) filter (where m.line_user_id is not null), '[]') members
    from crm.member_groups g left join crm.member_group_members gm on gm.group_id = g.id
    left join crm.line_members m on m.line_user_id = gm.line_user_id
    group by g.id order by g.name`;
  const line_members = await sql`select line_user_id id, coalesce(full_name, display_name) name, phone from crm.line_members
    where phone is not null and blocked_at is null order by coalesce(full_name, display_name)`;
  const branches = await sql`select branch_id, name, coalesce(short, left(name, 2)) short from crm.branches
    where active order by coalesce(short_sort, 100 + sort)`;
  const menu = await sql`select item_id::int item_id, item_code, name, category from crm.pos_menu order by item_code nulls last, item_id`;
  return { templates, rules, groups, line_members, branches, menu };
}

// validate a rule from the page; returns { res } (an error Response) or { r } (clean values)
async function parseRule(f: any): Promise<{ res?: Response; r?: any }> {
  const name = String(f.name ?? "").trim();
  if (name.length < 2 || name.length > 60) return { res: badField("name", "ชื่อกติกา 2–60 ตัวอักษร") };
  const template_id = Number(f.template_id);
  const [tp] = Number.isInteger(template_id) ? await sql`select 1 from crm.coupon_templates where id = ${template_id}` : [];
  if (!tp) return { res: badField("template_id", "เลือกคูปอง") };
  const group_id = f.group_id == null || f.group_id === "" ? null : Number(f.group_id);
  if (group_id !== null) {
    const [g] = Number.isInteger(group_id) ? await sql`select 1 from crm.member_groups where id = ${group_id}` : [];
    if (!g) return { res: badField("group_id", "ไม่พบกลุ่ม") };
  }
  const branch_ids = ints(f.branch_ids);
  if (branch_ids.length) {
    const [{ n }] = await sql`select count(*)::int n from crm.branches where branch_id = any(${pgArr(branch_ids)}::int[]) and active`;
    if (n !== branch_ids.length) return { res: badField("branch_ids", "มีสาขาที่ไม่ถูกต้อง") };
  }
  const days = ints(f.days).filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  const t_from = f.t_from ? String(f.t_from) : null, t_to = f.t_to ? String(f.t_to) : null;
  if ((t_from === null) !== (t_to === null)) return { res: badField("t_from", "ใส่เวลาเริ่มและเวลาสิ้นสุด") };
  if (t_from && (!HM.test(t_from) || !HM.test(t_to!) || t_from >= t_to!)) return { res: badField("t_from", "เวลาไม่ถูกต้อง (เริ่มต้องก่อนสิ้นสุด)") };
  const categories = [...new Set((Array.isArray(f.categories) ? f.categories : []).map(String))].filter((c) => CATS.includes(c));
  if (!categories.length) return { res: badField("categories", "เลือกอย่างน้อย 1 หมวด") };
  const item_ids = ints(f.item_ids);
  if (item_ids.length) {
    const [{ n }] = await sql`select count(*)::int n from crm.pos_menu
        where item_id = any(${pgArr(item_ids)}::bigint[]) and category = any(${pgArr(categories)}::text[])`;
    if (n !== item_ids.length) return { res: badField("item_ids", "มีเมนูที่ไม่อยู่ในหมวดที่เลือก") };
  }
  const ends_on = f.ends_on ? String(f.ends_on) : null;
  if (ends_on && !DAY.test(ends_on)) return { res: badField("ends_on", "วันสิ้นสุดไม่ถูกต้อง") };
  return { r: { name, template_id, group_id, branch_ids, days, t_from, t_to, categories, item_ids, ends_on } };
}
async function insertRule(q: any, r: any): Promise<number> {
  const [{ id }] = await q`insert into crm.coupon_rules (name, template_id, group_id, branch_ids, days, t_from, t_to, categories, item_ids, ends_on)
      values (${r.name}, ${r.template_id}, ${r.group_id}, ${pgArr(r.branch_ids)}::int[], ${pgArr(r.days)}::int[],
              ${r.t_from}::time, ${r.t_to}::time, ${pgArr(r.categories)}::text[], ${pgArr(r.item_ids)}::bigint[], ${r.ends_on}::date)
      returning id`;
  return Number(id);
}
```

- [ ] **Step 3: Add the write ops**

Insert at the top of `write()` (before `if (op === "set_setting")`):

```ts
  if (op === "template_save") {
    const title = String(f.title ?? "").trim(), detail = String(f.detail ?? "").trim() || null;
    const hint = String(f.ers_hint ?? "").trim() || null, active = f.active === true;
    const sa = Number(f.start_after_days), vd = Number(f.valid_days);
    if (title.length < 2 || title.length > 40) return badField("title", "ชื่อคูปอง 2–40 ตัวอักษร");
    if (detail && detail.length > 100) return badField("detail", "รายละเอียดยาวเกิน 100 ตัวอักษร");
    if (!Number.isInteger(sa) || sa < 0 || sa > 30) return badField("start_after_days", "เริ่มใช้ได้หลังบิล 0–30 วัน");
    if (!Number.isInteger(vd) || vd < 1 || vd > 90) return badField("valid_days", "ใช้ได้ 1–90 วัน");
    if (hint && hint.length > 60) return badField("ers_hint", "ข้อความ ERS ยาวเกิน 60 ตัวอักษร");
    let id = f.id ? Number(f.id) : null;
    if (id) {
      const u = await sql`update crm.coupon_templates set title = ${title}, detail = ${detail}, start_after_days = ${sa},
          valid_days = ${vd}, ers_hint = ${hint}, active = ${active}, updated_at = now() where id = ${id} returning id`;
      if (!u.length) return bad("not found", 404);
    } else {
      [{ id }] = await sql`insert into crm.coupon_templates (title, detail, start_after_days, valid_days, ers_hint, active)
          values (${title}, ${detail}, ${sa}, ${vd}, ${hint}, ${active}) returning id::int id`;
    }
    await log(actor, op, { id, title, detail, start_after_days: sa, valid_days: vd, ers_hint: hint, active });
    return Response.json({ ok: true, id });
  }
  if (op === "rule_save") {
    const p = await parseRule(f);
    if (p.res) return p.res;
    const r = p.r;
    let id = f.id ? Number(f.id) : null;
    if (id) {
      // saving a live rule counts bills from now on (no backdating with the new conditions)
      const u = await sql`update crm.coupon_rules set name = ${r.name}, template_id = ${r.template_id}, group_id = ${r.group_id},
          branch_ids = ${pgArr(r.branch_ids)}::int[], days = ${pgArr(r.days)}::int[], t_from = ${r.t_from}::time, t_to = ${r.t_to}::time,
          categories = ${pgArr(r.categories)}::text[], item_ids = ${pgArr(r.item_ids)}::bigint[], ends_on = ${r.ends_on}::date,
          armed_at = case when active then now() else armed_at end, updated_at = now()
        where id = ${id} returning id`;
      if (!u.length) return bad("not found", 404);
    } else id = await insertRule(sql, r);
    await log(actor, op, { id, ...r });
    return Response.json({ ok: true, id });
  }
  if (op === "rule_toggle") {
    const id = Number(f.id), on = f.active === true;
    const [cur] = await sql`select r.name, t.active tpl_on from crm.coupon_rules r join crm.coupon_templates t on t.id = r.template_id
        where r.id = ${id}`;
    if (!cur) return bad("not found", 404);
    if (on && !cur.tpl_on) return bad("คูปองของกติกานี้ปิดอยู่ เปิดคูปองในแท็บกติกาคูปองก่อน");
    await sql`update crm.coupon_rules set active = ${on}, armed_at = case when ${on} then now() else armed_at end, updated_at = now()
        where id = ${id}`;
    await log(actor, op, { id, name: cur.name, active: on });
    return Response.json({ ok: true });
  }
  if (op === "rule_preview") {
    const p = await parseRule(f);
    if (p.res) return p.res;
    let out: any = { coupons: 0, members: 0 };
    await sql.begin(async (tx) => {   // the draft rule exists only inside this transaction
      const id = await insertRule(tx, p.r);
      [out] = await tx`select coalesce(sum(units), 0)::int coupons, count(distinct line_user_id)::int members
          from crm.rule_hits(${id}, true)`;
      throw new Rollback();
    }).catch((e) => { if (!(e instanceof Rollback)) throw e; });
    return Response.json({ ok: true, ...out });
  }
  if (op === "group_save") {
    const name = String(f.name ?? "").trim();
    const ids = [...new Set((Array.isArray(f.members) ? f.members : []).map(String))].filter((x) => LINE_ID.test(x));
    if (name.length < 2 || name.length > 60) return badField("name", "ชื่อกลุ่ม 2–60 ตัวอักษร");
    if (ids.length) {
      const [{ n }] = await sql`select count(*)::int n from crm.line_members
          where line_user_id = any(${pgArr(ids)}::text[]) and phone is not null`;
      if (n !== ids.length) return badField("members", "มีสมาชิกที่ไม่ถูกต้อง");
    }
    let id = f.id ? Number(f.id) : null;
    try {
      await sql.begin(async (tx) => {
        if (id) {
          const u = await tx`update crm.member_groups set name = ${name} where id = ${id} returning id`;
          if (!u.length) throw new Error("group not found");
        } else {
          [{ id }] = await tx`insert into crm.member_groups (name) values (${name}) returning id::int id`;
        }
        await tx`delete from crm.member_group_members where group_id = ${id}`;
        if (ids.length) await tx`insert into crm.member_group_members (group_id, line_user_id)
            select ${id}, unnest(${pgArr(ids)}::text[])`;
      });
    } catch (e) {
      if (String(e).includes("member_groups_name_key")) return badField("name", "มีกลุ่มชื่อนี้แล้ว");
      throw e;
    }
    await log(actor, op, { id, name, members: ids.length });   // count only: LINE ids are personal data
    return Response.json({ ok: true, id });
  }
  if (op === "group_delete") {
    const id = Number(f.id);
    const [used] = await sql`select name from crm.coupon_rules where group_id = ${id} limit 1`;
    if (used) return bad(`กลุ่มนี้ใช้อยู่ในกติกา "${used.name}"`, 409);
    const [g] = await sql`delete from crm.member_groups where id = ${id} returning name`;
    if (!g) return bad("not found", 404);
    await log(actor, op, { id, name: g.name });
    return Response.json({ ok: true });
  }
```

- [ ] **Step 4: Wire the read op and bump the header**

In `Deno.serve`, after `if (op === "config") ...`, add:

```ts
    if (op === "rules_data") return Response.json({ ok: true, ...(await rulesData()) });
```

Add to the header comment (after the `v10` line):

```ts
// v11 (2026-11-20, 0025): coupon rules — reads rules_data; writes template_save, rule_save, rule_toggle, rule_preview
// (draft rule inside a rolled-back transaction, last 14 days, ignores armed_at), group_save, group_delete.
```

- [ ] **Step 5: Deploy**

MCP `deploy_edge_function`, project `qtpwrwapbefczvqdfzes`, name `crm-admin`, `verify_jwt: false`, full `index.ts`.

- [ ] **Step 6: Run the helper through every op and check the results**

Run each command and check the expected output (`H` = `~/mamapook-data/venv/bin/python <scratchpad>/crm_admin_call.py`):

```bash
H '{"op":"rules_data"}'
```
Expected: `{"ok":true,"templates":[],"rules":[],"groups":[],"line_members":[...],"branches":[...6 rows...],"menu":[...]}`.

```bash
H '{"op":"template_save","title":"TEST ลด 30% จานหลัก","start_after_days":1,"valid_days":7,"active":true}'
H '{"op":"template_save","title":"x","start_after_days":1,"valid_days":7,"active":true}'
```
Expected: the first returns `{"ok":true,"id":N}`; the second returns `400 ... "field":"title"`.

```bash
H '{"op":"rule_preview","name":"TEST","template_id":N,"group_id":null,"branch_ids":[],"days":[],"t_from":"","t_to":"","categories":["main","set"],"item_ids":[],"ends_on":""}'
```
Expected: `{"ok":true,"coupons":C,"members":M}`. Compare C with MCP `execute_sql`:
`select coalesce(sum(floor(l.qty)),0) from crm.pos_bills b join crm.line_members m on m.phone = b.phone and m.blocked_at is null join crm.pos_bill_lines l on l.order_id = b.order_id and l.full_price and l.qty >= 1 and l.category in ('main','set') where not b.voids_earning` → the same C.
Then check `select count(*) from crm.coupon_rules` → 0 (the preview wrote nothing).

```bash
H '{"op":"rule_save","name":"TEST","template_id":N,"group_id":null,"branch_ids":[7],"days":[1,2,3,4,5],"t_from":"16:00","t_to":"20:00","categories":["main"],"item_ids":[],"ends_on":""}'
H '{"op":"rule_save","name":"TEST bad","template_id":N,"categories":[],"t_from":"","t_to":""}'
H '{"op":"rule_toggle","id":R,"active":true}'
H '{"op":"rules_data"}'
```
Expected: the save returns `{"ok":true,"id":R}`; the bad save returns `"field":"categories"`; the toggle returns `{"ok":true}`; rules_data shows rule R with `active:true` and `armed_at` set to now.

```bash
H '{"op":"group_save","name":"TEST group","members":[]}'
H '{"op":"group_delete","id":G}'
```
Expected: `{"ok":true,"id":G}` then `{"ok":true}`.

- [ ] **Step 7: Clean up the test rows**

MCP `execute_sql` (Marketing):

```sql
delete from crm.coupons where rule_id in (select id from crm.coupon_rules where name like 'TEST%');
delete from crm.coupon_rules where name like 'TEST%';
delete from crm.coupon_templates where title like 'TEST%';
delete from crm.member_groups where name like 'TEST%';
select (select count(*) from crm.coupon_rules) rules, (select count(*) from crm.coupon_templates) templates;
```

Expected: `0, 0`.

- [ ] **Step 8: Commit**

```bash
cd ~/Documents/GitHub/Marketing
git add supabase/functions/crm-admin/index.ts
git commit -m "crm-admin v11: coupon templates, criteria rules, hand-picked groups, rule preview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 5: Member card groups earned coupons; each confirm uses one

**Files:**
- Modify: `~/Documents/GitHub/Marketing/supabase/functions/line-webhook/index.ts` (memberCard coupon query + rendering, `onRedeem`)

**Interfaces:**
- Consumes: `crm.coupons.template_id / detail`, `crm.coupon_templates.ers_hint` (Task 1).
- Produces: card boxes `"<title> ×N"`. The postback `action=redeem&id=<id>` opens a confirm for the soonest-expiring ready coupon of that stack; `action=redeem_ok&id=<id>` uses exactly that one coupon. Sign-up and test coupons behave exactly as before.

- [ ] **Step 1: Replace the coupon query in `memberCard`**

Replace the whole `const coupons = await sql\`...\`;` statement in `memberCard` with:

```ts
  // earned coupons (0025) with the same template, title, dates and status show as one box "×N"
  const coupons = await sql`
    select min(id) id, min(kind) kind, bool_or(template_id is not null) earned, title, max(detail) detail,
           to_char(valid_from,'YYYY-MM-DD') vf, to_char(valid_to,'YYYY-MM-DD') vt,
           max(to_char(redeemed_at at time zone 'Asia/Bangkok','HH24:MI')) used_at, st, count(*)::int n
    from (select *, case when redeemed_at is not null then 'used' when ${t}::date < valid_from then 'soon' else 'ready' end st
          from crm.coupons
          where line_user_id = ${userId}
            and (redeemed_at is null and valid_to >= ${t}::date
                 or (redeemed_at at time zone 'Asia/Bangkok')::date = ${t}::date)) c
    group by coalesce(template_id::text, 'c' || id), title, valid_from, valid_to, st
    order by valid_from, min(id)`;
```

- [ ] **Step 2: Render the count, detail and the fixed promotion line**

In the `for (const c of coupons)` loop, change the title line:

```ts
      txt(c.title, { weight: "bold", size: "lg", color: used ? GREY : INK, decoration: used ? "line-through" : "none" }),
```

to:

```ts
      txt(c.n > 1 ? `${c.title} ×${c.n}` : c.title, { weight: "bold", size: "lg", color: used ? GREY : INK, decoration: used ? "line-through" : "none" }),
```

Insert immediately before `if (c.st === "ready") contents.push({`:

```ts
    if (c.detail) contents.push(txt(c.detail, { size: "xs", color: GREY }));
    if (c.earned) contents.push(txt("ใช้ร่วมกับโปรโมชั่นอื่นไม่ได้", { size: "xs", color: GREY }));
```

- [ ] **Step 3: Route earned coupons in `onRedeem`**

At the top of `onRedeem` (before `const [c] = await sql\``), insert:

```ts
  const [tap] = await sql`select template_id, title from crm.coupons where id = ${id} and line_user_id = ${userId}`;
  if (!tap) return;
  if (tap.template_id != null) return onRedeemEarned(userId, replyToken, id, tap, confirmed);
```

Add this new function right after `onRedeem`:

```ts
// Earned coupons (0025): the card's button stands for a stack of the same coupon. The confirm names one coupon id
// (the one expiring soonest) and "ยืนยัน" uses exactly that id, so a double tap can never use two.
async function onRedeemEarned(userId: string, replyToken: string, id: number, tap: any, confirmed: boolean) {
  const d = bkkDate();
  const left = async () => (await sql`select count(*)::int n from crm.coupons where line_user_id = ${userId}
      and template_id = ${tap.template_id} and title = ${tap.title} and redeemed_at is null
      and ${d}::date between valid_from and valid_to`)[0].n as number;
  if (confirmed) {
    const done = await sql`update crm.coupons set redeemed_at = now()
        where id = ${id} and line_user_id = ${userId} and redeemed_at is null and ${d}::date between valid_from and valid_to
        returning to_char(redeemed_at at time zone 'Asia/Bangkok','HH24:MI') at`;
    if (!done.length) return reply(replyToken, `คูปองใบนี้ใช้ไปแล้วหรือหมดอายุแล้วค่ะ (เหลือ ${await left()} ใบ)`);
    return reply(replyToken, `✅ ใช้สิทธิ์ "${tap.title}" 1 ใบ เวลา ${done[0].at} น. · เหลือ ${await left()} ใบ\nพนักงาน: ใส่ส่วนลดในบิลที่ POS ค่ะ`);
  }
  const [c] = await sql`select c.id, tp.ers_hint from crm.coupons c left join crm.coupon_templates tp on tp.id = c.template_id
      where c.line_user_id = ${userId} and c.template_id = ${tap.template_id} and c.title = ${tap.title}
        and c.redeemed_at is null and ${d}::date between c.valid_from and c.valid_to
      order by c.valid_to, c.id limit 1`;
  if (!c) return reply(replyToken, `วันนี้ไม่มีคูปอง "${tap.title}" ที่ใช้ได้แล้วค่ะ`);
  const text = `พนักงาน: ยืนยันใช้สิทธิ์ "${tap.title}" 1 ใบ? (มี ${await left()} ใบ)\nใช้ร่วมกับโปรโมชั่นอื่นไม่ได้` +
    (c.ers_hint ? `\nใส่ ${c.ers_hint} ที่ POS` : "");
  return send(replyToken, [{
    type: "template", altText: "ยืนยันใช้สิทธิ์",
    template: { type: "confirm", text: text.slice(0, 240),
      actions: [{ type: "postback", label: "ยืนยัน", data: `action=redeem_ok&id=${c.id}` },
                { type: "postback", label: "ยกเลิก", data: "action=noop" }] },
  }]);
}
```

Add to the file's header comment:

```ts
// 2026-11-20 (0025): earned coupons show as one box per stack ("×N") with "ใช้ร่วมกับโปรโมชั่นอื่นไม่ได้";
// each staff confirm uses exactly one (onRedeemEarned). Sign-up / test coupons unchanged.
```

- [ ] **Step 4: Deploy**

MCP `deploy_edge_function`, project `qtpwrwapbefczvqdfzes`, name `line-webhook`, `verify_jwt: false`, full `index.ts`.

- [ ] **Step 5: Seed 3 test coupons on Point's card**

Point's LINE id is the holder of the 2026-11-18 test coupon. MCP `execute_sql` (Marketing):

```sql
with p as (select line_user_id from crm.coupons where kind = 'test-2026-11-18' limit 1),
     tpl as (insert into crm.coupon_templates (title, detail, ers_hint, active) values ('TEST ลด 30% จานหลัก', 'ทดสอบระบบ', 'ส่วนลด "คูปองสมาชิก 30%"', false) returning id)
insert into crm.coupons (line_user_id, kind, title, detail, valid_from, valid_to, template_id)
select p.line_user_id, 'test-card-' || g, 'TEST ลด 30% จานหลัก', 'ทดสอบระบบ',
       (now() at time zone 'Asia/Bangkok')::date, (now() at time zone 'Asia/Bangkok')::date + 6, tpl.id
from p, tpl, generate_series(1, 3) g
returning id;
```

Expected: 3 ids.

- [ ] **Step 6: Point checks the card (needs Point)**

Ask Point to tap MEMBERS in the LINE OA chat. The reply is free and uses no quota. Expected:
- one box `TEST ลด 30% จานหลัก ×3`, `ใช้ได้ถึง …`, `ทดสอบระบบ`, `ใช้ร่วมกับโปรโมชั่นอื่นไม่ได้`, and one red button;
- the button → confirm `… 1 ใบ? (มี 3 ใบ) … ใส่ ส่วนลด "คูปองสมาชิก 30%" ที่ POS`;
- ยืนยัน → `✅ … 1 ใบ … เหลือ 2 ใบ`;
- tapping the same old card's button again → a confirm with `(มี 2 ใบ)`;
- tapping ยืนยัน twice on one confirm → the second reply says `ใช้ไปแล้ว…`.

Check: `select count(*) filter (where redeemed_at is not null) from crm.coupons where kind like 'test-card-%'` equals the number of confirms.

- [ ] **Step 7: Remove the test coupons**

```sql
delete from crm.coupons where kind like 'test-card-%';
delete from crm.coupon_templates where title = 'TEST ลด 30% จานหลัก';
```

- [ ] **Step 8: Commit**

```bash
cd ~/Documents/GitHub/Marketing
git add supabase/functions/line-webhook/index.ts
git commit -m "line-webhook: card stacks earned coupons (×N, no-combine line); each confirm uses exactly one

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 6: Sales site, Coupon rules tab

**Files:**
- Create: `~/sales/app/site/crm/crm_rules.js`
- Modify: `~/sales/app/site/index.html` (after line 308 `<section id="crm-send"></section>` and after line 316 `<script src="crm/crm.js"></script>`)

**Interfaces:**
- Consumes: crm-admin `rules_data`, `template_save` (Task 4); crm.js globals `CRM`, `CRM_T`, `CRM_TABS`, `CRM_ACT`, `CRM_CHANGE`, `crmNeed`, `crmHead`, `crmMsg`, `crmIn`, `crmDo`, `crmApi`, `crmToday`, `n0`; index.html globals `t`, `esc`, `render`.
- Produces: tab `crm-coupons`; state `CRM.rd` (rules data), `CRM.tf` (template form); helpers used by Task 7: `crChip(on, act, k, label)`, `crToggle(arr, v)`, `CR_CATS`.

- [ ] **Step 1: Write the failing label check**

Run:

```bash
cd ~/sales/app/site && node -e "
const vm=require('vm'),fs=require('fs');const ctx={window:{},document:{addEventListener(){}},console};ctx.window=ctx;vm.createContext(ctx);
for(const f of ['crm/crm.js','crm/crm_rules.js'])vm.runInContext(fs.readFileSync(f,'utf8'),ctx,{filename:f});
const th=Object.keys(ctx.CRM_T.th),en=Object.keys(ctx.CRM_T.en);const miss=[...th.filter(k=>!en.includes(k)),...en.filter(k=>!th.includes(k))];
console.log(miss.length?'FAIL '+miss:'labels OK '+th.length, vm.runInContext('CRM_TABS.map(m=>m.id).join(\",\")',ctx));"
```

Expected: `ENOENT ... crm/crm_rules.js`.

- [ ] **Step 2: Create `crm_rules.js` with the Coupon rules tab**

```js
'use strict';
// CRM › Coupon rules + Criteria (Point 2026-11-20). Members earn member-card coupons from bills with nothing
// applied: 1 coupon per qualifying dish, LINE members only, silent, never combined with other promotions.
// Spec: Marketing repo docs/superpowers/specs/2026-11-20-coupon-rules-design.md. Data: crm-admin ops rules_data,
// template_save, rule_save, rule_toggle, rule_preview, group_save, group_delete.
// Loaded after crm.js and before the main script: adds its labels to CRM_T, its tabs to CRM_TABS and its
// handlers to CRM_ACT / CRM_CHANGE, so index.html merges them with the rest of the CRM area.

Object.assign(window.CRM_T.th, {
  crm_cpr: 'กติกาคูปอง', crm_crit: 'เงื่อนไขรับคูปอง',
  ct_sub: 'คูปองบนบัตรสมาชิกที่ระบบแจกเองตามเงื่อนไขในแท็บ "เงื่อนไขรับคูปอง" · ทุกใบใช้ร่วมกับโปรโมชั่นอื่นไม่ได้',
  ct_title: 'ชื่อคูปอง (บนบัตร)', ct_detail: 'รายละเอียด (ไม่บังคับ)', ct_start: 'เริ่มใช้ได้หลังวันบิล (วัน)', ct_days: 'ใช้ได้กี่วัน',
  ct_hint: 'แคชเชียร์ใส่ใน ERS', ct_hint_ph: 'เช่น ส่วนลด "คูปองสมาชิก 30%"', ct_active: 'เปิดใช้', ct_valid: 'เริ่มวันบิล +{0} · ใช้ได้ {1} วัน',
  ct_issued: 'แจก', ct_used: 'ใช้แล้ว', ct_expired: 'หมดอายุ', ct_empty: 'ยังไม่มีคูปอง', ct_prev: 'ตัวอย่างบนบัตร (ถ้ามี 2 ใบ)',
  ct_fixed: 'ทุกใบแสดง "ใช้ร่วมกับโปรโมชั่นอื่นไม่ได้" · ถ้าคูปองมาช้า (สาขาส่งบิลช้า) จะเริ่มนับวันใช้จากวันที่ได้รับ',
  cr_on: 'เปิดอยู่', cr_off: 'ปิดอยู่',
});
Object.assign(window.CRM_T.en, {
  crm_cpr: 'Coupon rules', crm_crit: 'Criteria',
  ct_sub: 'Member-card coupons the system gives out by the rules in the Criteria tab · none can be combined with other promotions',
  ct_title: 'Coupon title (on the card)', ct_detail: 'Detail (optional)', ct_start: 'Starts after the bill day (days)', ct_days: 'Valid for (days)',
  ct_hint: 'Cashier keys in ERS', ct_hint_ph: 'e.g. ส่วนลด "คูปองสมาชิก 30%"', ct_active: 'Active', ct_valid: 'Bill day +{0} · valid {1} days',
  ct_issued: 'Issued', ct_used: 'Used', ct_expired: 'Expired', ct_empty: 'No coupons yet', ct_prev: 'On the card (when there are 2)',
  ct_fixed: 'Every coupon shows "ใช้ร่วมกับโปรโมชั่นอื่นไม่ได้" (not with other promotions) · a coupon that arrives late (branch uploads late) counts its days from the day it arrives',
  cr_on: 'On', cr_off: 'Off',
});

CRM_TABS.splice(CRM_TABS.findIndex(m => m.id === 'crm-send') + 1, 0,
  {id:'crm-coupons', key:'crm_cpr', render:() => crmCoupons()});

const CR_CATS = ['main', 'set', 'side', 'topping', 'dessert', 'beverage'];
const crToggle = (arr, v) => arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v];
const crChip = (on, act, k, label) => `<button class="btn" data-act="${act}" data-k="${esc(String(k))}" style="margin:2px 2px 2px 0;${on ? 'background:var(--accent);color:#fff;border-color:var(--accent)' : ''}">${label}</button>`;

// ---------------------------------------------------------------- Coupon rules tab
function crTplPreview(f) {   // the card box as LINE draws it (Thai, because the card is Thai)
  const add = n => new Date(Date.parse(crmToday()) + n * 864e5).toISOString().slice(0, 10);
  const vt = add((Number(f.start_after_days) || 0) + Math.max(1, Number(f.valid_days) || 1) - 1);
  return `<div style="max-width:300px;border:2px solid #C8102E;border-radius:12px;padding:12px;text-align:center;background:#fff;color:#1D1D1F">` +
    `<div style="font-weight:700;font-size:17px">${esc(f.title || '…')} ×2</div>` +
    `<div style="color:#8E8E93;font-size:13px">ใช้ได้ถึง ${vt.slice(8)}/${vt.slice(5, 7)}</div>` +
    (f.detail ? `<div style="color:#8E8E93;font-size:12px">${esc(f.detail)}</div>` : '') +
    `<div style="color:#8E8E93;font-size:12px">ใช้ร่วมกับโปรโมชั่นอื่นไม่ได้</div>` +
    `<div style="background:#C8102E;color:#fff;border-radius:6px;padding:6px;margin-top:8px;font-size:13px">ใช้สิทธิ์ (สำหรับพนักงาน)</div></div>`;
}
function crTplForm(f) {
  const inp = (k, attrs) => crmIn('crm-t-' + k, f[k], `data-act="crmtf" data-k="${k}" ${attrs || ''}`);
  const L = (l, x) => `<tr><td class="muted" style="width:190px">${l}</td><td>${x}</td></tr>`;
  return `<div class="card"><div class="split"><div><table>` +
    L(t('ct_title'), inp('title', 'maxlength="40" style="width:100%"')) +
    L(t('ct_detail'), inp('detail', 'maxlength="100" style="width:100%"')) +
    L(t('ct_start'), inp('start_after_days', 'type="number" min="0" max="30" style="width:80px"')) +
    L(t('ct_days'), inp('valid_days', 'type="number" min="1" max="90" style="width:80px"')) +
    L(t('ct_hint'), inp('ers_hint', `maxlength="60" placeholder="${esc(t('ct_hint_ph'))}" style="width:100%"`)) +
    L(t('ct_active'), `<input type="checkbox" id="crm-t-active" data-act="crmtf" data-k="active"${f.active ? ' checked' : ''}>`) + '</table>' +
    `<div class="note">${t('ct_fixed')}</div>` +
    `<button class="btn" data-act="crmts">${t('crm_save')}</button> <button class="btn" data-act="crmte" data-k="">${t('crm_cancel')}</button>${crmMsg('tpl')}</div>` +
    `<div><div class="muted">${t('ct_prev')}</div><div id="crm-t-prev">${crTplPreview(f)}</div></div></div></div>`;
}
function crmCoupons() {
  const el = document.getElementById('crm-coupons');
  if (!crmNeed(el, 'rd', 'rules_data')) return;
  const d = CRM.rd;
  let h = crmHead(t('crm_cpr'), t('ct_sub'), 'rd') +
    `<div class="card"><button class="btn" data-act="crmte" data-k="new">${t('crm_add')}</button>${CRM.tf ? '' : crmMsg('tpl')}</div>`;
  if (CRM.tf) h += crTplForm(CRM.tf);
  h += '<div class="card">' + (d.templates.length
    ? `<table><tr><th>${t('ct_title')}</th><th>${t('ct_days')}</th><th class="n">${t('ct_issued')}</th><th class="n">${t('ct_used')}</th><th class="n">${t('ct_expired')}</th><th></th><th></th></tr>` +
      d.templates.map(x => `<tr><td><b>${esc(x.title)}</b>${x.detail ? `<div class="muted">${esc(x.detail)}</div>` : ''}${x.ers_hint ? `<div class="muted">ERS: ${esc(x.ers_hint)}</div>` : ''}</td>` +
        `<td class="nw">${t('ct_valid', x.start_after_days, x.valid_days)}</td><td class="n">${n0(x.issued)}</td><td class="n">${n0(x.used)}</td><td class="n">${n0(x.expired)}</td>` +
        `<td><span class="tag ${x.active ? 'ok' : ''}">${t(x.active ? 'cr_on' : 'cr_off')}</span></td>` +
        `<td><button class="btn" data-act="crmte" data-k="${x.id}">${t('crm_edit')}</button></td></tr>`).join('') + '</table>'
    : `<div class="muted">${t('ct_empty')}</div>`) + '</div>';
  el.innerHTML = h;
}

Object.assign(window.CRM_ACT, {
  crmte: k => {
    CRM.msg.tpl = null;
    if (!k) { CRM.tf = null; render(); return; }
    const x = k === 'new' ? null : CRM.rd.templates.find(v => String(v.id) === String(k));
    CRM.tf = x ? {id:x.id, title:x.title, detail:x.detail || '', start_after_days:x.start_after_days, valid_days:x.valid_days, ers_hint:x.ers_hint || '', active:x.active}
               : {id:null, title:'', detail:'', start_after_days:1, valid_days:7, ers_hint:'', active:true};
    render();
  },
  crmts: () => {
    const f = CRM.tf; if (!f) return;
    crmDo('tpl', 'template_save', {id:f.id, title:f.title, detail:f.detail, start_after_days:Number(f.start_after_days),
      valid_days:Number(f.valid_days), ers_hint:f.ers_hint, active:f.active === true}, () => { CRM.tf = null; CRM.rd = null; render(); });
  },
});
Object.assign(window.CRM_CHANGE, {
  crmtf: (v, el) => { if (CRM.tf) CRM.tf[el.dataset.k] = el.type === 'checkbox' ? el.checked : v; },
});
// typing in the template form redraws only the card preview (focus and caret stay)
document.addEventListener('input', e => {
  const el = e.target.closest && e.target.closest('[data-act="crmtf"]'); if (!el || !CRM.tf) return;
  CRM.tf[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value;
  const p = document.getElementById('crm-t-prev'); if (p) p.innerHTML = crTplPreview(CRM.tf);
});
```

- [ ] **Step 3: Wire it into index.html**

After `<section id="crm-send"></section>` add:

```html
<section id="crm-coupons"></section>
<section id="crm-criteria"></section>
```

After `<script src="crm/crm.js"></script>` add:

```html
<script src="crm/crm_rules.js"></script>
```

- [ ] **Step 4: Run the label check and a syntax check**

Run the Step 1 command, then `node --check crm/crm_rules.js`.
Expected: `labels OK <n> crm-overview,crm-members,crm-promos,crm-send,crm-coupons,crm-settings,crm-plan`, and no syntax error.

- [ ] **Step 5: Deploy and check in the browser**

```bash
~/sales/app/deploy.sh
```

Open https://mamapook-sales.pages.dev/#crm-coupons in the browser pane (Point's session is already logged in; never type a password). Reload with `{cache:'reload'}` if the old script is served. Check:
- the "กติกาคูปอง" tab is between ส่งคูปอง and ตั้งค่า;
- + เพิ่ม opens the form with 1 / 7 filled in;
- typing a title updates the card preview live;
- saving `TEST คูปอง` shows it in the list (issued 0 / used 0 / expired 0);
- a 1-character title shows the server error next to Save;
- read_console_messages shows no errors.

Then delete the test row with MCP `execute_sql`: `delete from crm.coupon_templates where title like 'TEST%';`

- [ ] **Step 6: Commit**

```bash
cd ~/sales
git add app/site/crm/crm_rules.js app/site/index.html
git commit -m "CRM: Coupon rules tab (member-card coupon templates with live card preview)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 7: Sales site, Criteria tab + hand-picked groups

**Files:**
- Modify: `~/sales/app/site/crm/crm_rules.js` (append)

**Interfaces:**
- Consumes: crm-admin `rule_save`, `rule_toggle`, `rule_preview`, `group_save`, `group_delete` (Task 4); `crChip`, `crToggle`, `CR_CATS`, `CRM.rd` (Task 6); crm.js `crmBands()`, `crmPh()`; index.html label `lp_day_<band>` and CRM label `s_dnames` (Mon-first, so index 0 = ISO weekday 1).
- Produces: tab `crm-criteria`; state `CRM.rf` (rule form), `CRM.rprev`, `CRM.riOpen`, `CRM.gf` (group form), `CRM.gq`.

- [ ] **Step 1: Write the failing check**

Run the Task 6 Step 1 command.
Expected: the tab list does not contain `crm-criteria` yet. That is the failing condition for this task.

- [ ] **Step 2: Append labels and the tab registration**

Append to `crm_rules.js`:

```js
// ---------------------------------------------------------------- Criteria tab (rules + groups)
Object.assign(window.CRM_T.th, {
  cr_sub: 'บิลที่ไม่มีโปรโมชั่น ส่วนลด หรือการแลกแต้ม ได้คูปอง 1 ใบต่อ 1 จานที่ตรงเงื่อนไข · เฉพาะสมาชิก LINE ที่ให้เบอร์ที่แคชเชียร์ · ไม่ส่งข้อความ คูปองขึ้นบนบัตรเอง · นับเฉพาะบิลหลังเปิดกติกา',
  cr_name: 'ชื่อกติกา', cr_coupon: 'คูปองที่ได้', cr_group: 'ใครได้', cr_allline: 'สมาชิก LINE ทุกคน', cr_branches: 'สาขา', cr_days: 'วัน',
  cr_time: 'เวลาเปิดบิล', cr_cats: 'จานที่นับ', cr_items: 'เฉพาะเมนู (ไม่บังคับ)', cr_items_all: 'ทุกเมนูในหมวดที่เลือก', cr_items_n: '{0} เมนู',
  cr_ends: 'บิลวันสุดท้าย (ไม่บังคับ)', cr_alldays: 'ทุกวัน', cr_wd: 'จ–ศ', cr_we: 'ส–อา', cr_alltime: 'ทั้งวัน', cr_to: 'ถึง',
  cr_turn_on: 'เปิด', cr_turn_off: 'ปิด', cr_on_ok: 'เปิดกติกา "{0}"? นับเฉพาะบิลตั้งแต่ตอนนี้', cr_off_ok: 'ปิดกติกา "{0}"? คูปองที่แจกไปแล้วยังใช้ได้',
  cr_armed: 'นับบิลตั้งแต่ {0}', cr_members: 'คน', cr_preview: 'ลองนับ (14 วันล่าสุด)', cr_prev_res: '14 วันล่าสุดจะได้ {0} ใบ ถึง {1} คน',
  cr_empty: 'ยังไม่มีกติกา', cr_need_tpl: 'สร้างและเปิดคูปองในแท็บ "กติกาคูปอง" ก่อน', cr_live_note: 'กติกานี้เปิดอยู่: บันทึกแล้วจะนับเฉพาะบิลตั้งแต่ตอนบันทึก',
  cg_h: 'กลุ่มสมาชิก (เลือกเอง)', cg_name: 'ชื่อกลุ่ม', cg_n: '{0} คน', cg_search: 'ค้นหาชื่อหรือเบอร์ แล้วกด Enter', cg_del_ok: 'ลบกลุ่ม "{0}"?',
  cg_empty: 'ยังไม่มีกลุ่ม', cg_pick: 'สมาชิกในกลุ่ม',
  cat_main: 'จานหลัก', cat_set: 'ชุด', cat_side: 'เครื่องเคียง', cat_topping: 'ท็อปปิ้ง', cat_dessert: 'ของหวาน', cat_beverage: 'เครื่องดื่ม',
});
Object.assign(window.CRM_T.en, {
  cr_sub: 'A bill with no promotion, discount or points redemption earns 1 coupon per qualifying dish · LINE members who give their phone at the cashier · no message is sent, the coupon appears on the card · only bills after the rule is switched on count',
  cr_name: 'Rule name', cr_coupon: 'Coupon', cr_group: 'Who', cr_allline: 'All LINE members', cr_branches: 'Branches', cr_days: 'Days',
  cr_time: 'Bill opened', cr_cats: 'Dishes that count', cr_items: 'Only these items (optional)', cr_items_all: 'Every item in the chosen categories', cr_items_n: '{0} items',
  cr_ends: 'Last bill date (optional)', cr_alldays: 'Every day', cr_wd: 'Mon–Fri', cr_we: 'Sat–Sun', cr_alltime: 'All day', cr_to: 'to',
  cr_turn_on: 'Turn on', cr_turn_off: 'Turn off', cr_on_ok: 'Turn on "{0}"? Only bills from now on count', cr_off_ok: 'Turn off "{0}"? Coupons already given stay usable',
  cr_armed: 'Counting bills since {0}', cr_members: 'People', cr_preview: 'Try it (last 14 days)', cr_prev_res: 'The last 14 days would give {0} coupons to {1} people',
  cr_empty: 'No rules yet', cr_need_tpl: 'Create and switch on a coupon in the Coupon rules tab first', cr_live_note: 'This rule is on: after saving, only bills from the moment of saving count',
  cg_h: 'Member groups (hand-picked)', cg_name: 'Group name', cg_n: '{0} people', cg_search: 'Search name or phone, then Enter', cg_del_ok: 'Delete group "{0}"?',
  cg_empty: 'No groups yet', cg_pick: 'Members',
  cat_main: 'Mains', cat_set: 'Sets', cat_side: 'Sides', cat_topping: 'Toppings', cat_dessert: 'Desserts', cat_beverage: 'Drinks',
});
CRM_TABS.splice(CRM_TABS.findIndex(m => m.id === 'crm-coupons') + 1, 0,
  {id:'crm-criteria', key:'crm_crit', render:() => crmCriteria()});
```

- [ ] **Step 3: Append the helpers, rule form, groups and tab render**

```js
const crHm = h => String(Math.floor(h)).padStart(2, '0') + ':' + (h % 1 ? '30' : '00');
const crDN = () => t('s_dnames').split(',');
const crTplName = id => { const x = CRM.rd.templates.find(v => v.id === id); return x ? x.title : '#' + id; };
const crGroupName = id => { if (!id) return t('cr_allline'); const g = CRM.rd.groups.find(v => v.id === id); return g ? `${g.name} (${g.members.length})` : '#' + id; };
const crBranchList = ids => !ids || !ids.length ? t('crm_all') : ids.map(id => { const b = CRM.rd.branches.find(x => x.branch_id === id); return b ? b.short : id; }).join(' ');
const crDaysLabel = ds => !ds || !ds.length || ds.length === 7 ? t('cr_alldays') : [...ds].sort((a, b) => a - b).map(i => crDN()[i - 1]).join(' ');
const crCatsLabel = r => r.categories.map(c => t('cat_' + c)).join(', ') + (r.item_ids && r.item_ids.length ? ' · ' + t('cr_items_n', r.item_ids.length) : '');
const crSame = (a, b) => a.length === b.length && a.every(x => b.includes(x));
const crRulePayload = f => ({id:f.id, name:f.name, template_id:Number(f.template_id) || null, group_id:f.group_id ? Number(f.group_id) : null,
  branch_ids:f.branch_ids, days:f.days, t_from:f.t_from || null, t_to:f.t_to || null, categories:f.categories, item_ids:f.item_ids, ends_on:f.ends_on || null});

function crRuleForm(f, d) {
  const L = (l, x) => `<tr><td class="muted" style="width:160px">${l}</td><td>${x}</td></tr>`;
  const sel = (id, k, opts, v) => `<select id="${id}" data-act="crmrf" data-k="${k}" style="font:inherit;font-size:12.5px;padding:3px 6px">` +
    opts.map(([val, lab]) => `<option value="${esc(String(val))}"${String(val) === String(v == null ? '' : v) ? ' selected' : ''}>${esc(lab)}</option>`).join('') + '</select>';
  const tpls = d.templates.filter(x => x.active || x.id === f.template_id);
  const menu = d.menu.filter(m => f.categories.includes(m.category));
  const items = `<details id="crm-ri"${CRM.riOpen ? ' open' : ''}><summary style="cursor:pointer">${f.item_ids.length ? t('cr_items_n', f.item_ids.length) : t('cr_items_all')} ▾</summary>` +
    `<div style="max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:6px;padding:6px 10px;margin-top:4px">` +
    menu.map(m => `<label style="display:block;padding:1px 0"><input type="checkbox" data-act="crmri" value="${m.item_id}"${f.item_ids.includes(m.item_id) ? ' checked' : ''}> ${esc(m.name)}</label>`).join('') + '</div></details>';
  const bands = crmBands().map(([k, a, b]) => crChip(f.t_from === crHm(a) && f.t_to === crHm(b), 'crmrtm', crHm(a) + '|' + crHm(b), `${t('lp_day_' + k)} ${crHm(a)}–${crHm(b)}`)).join('');
  return `<div class="card">${f.active ? `<div class="note">${t('cr_live_note')}</div>` : ''}<table>` +
    L(t('cr_name'), crmIn('crm-r-name', f.name, 'data-act="crmrf" data-k="name" maxlength="60" style="width:100%"')) +
    L(t('cr_coupon'), sel('crm-r-tpl', 'template_id', tpls.map(x => [x.id, x.title]), f.template_id)) +
    L(t('cr_group'), sel('crm-r-grp', 'group_id', [['', t('cr_allline')], ...d.groups.map(g => [g.id, `${g.name} (${g.members.length})`])], f.group_id)) +
    L(t('cr_branches'), crChip(!f.branch_ids.length, 'crmrb', 'all', t('crm_all')) + d.branches.map(b => crChip(f.branch_ids.includes(b.branch_id), 'crmrb', b.branch_id, esc(b.short))).join('')) +
    L(t('cr_days'), crChip(!f.days.length, 'crmrdq', 'all', t('cr_alldays')) + crChip(crSame(f.days, [1, 2, 3, 4, 5]), 'crmrdq', 'wd', t('cr_wd')) +
      crChip(crSame(f.days, [6, 7]), 'crmrdq', 'we', t('cr_we')) + ' ' + crDN().map((x, i) => crChip(f.days.includes(i + 1), 'crmrd', i + 1, x)).join('')) +
    L(t('cr_time'), crmIn('crm-r-t1', f.t_from, 'type="time" data-act="crmrf" data-k="t_from"') + ` ${t('cr_to')} ` +
      crmIn('crm-r-t2', f.t_to, 'type="time" data-act="crmrf" data-k="t_to"') + `<div style="margin-top:4px">${crChip(!f.t_from, 'crmrtm', '', t('cr_alltime'))}${bands}</div>`) +
    L(t('cr_cats'), CR_CATS.map(c => crChip(f.categories.includes(c), 'crmrc', c, t('cat_' + c))).join('')) +
    L(t('cr_items'), items) +
    L(t('cr_ends'), crmIn('crm-r-end', f.ends_on, 'type="date" data-act="crmrf" data-k="ends_on"')) + '</table>' +
    `<button class="btn" data-act="crmrs">${t('crm_save')}</button> <button class="btn" data-act="crmrp">${t('cr_preview')}</button> ` +
    `<button class="btn" data-act="crmre" data-k="">${t('crm_cancel')}</button>${crmMsg('rule')}` +
    (CRM.rprev ? ` <b>${t('cr_prev_res', n0(CRM.rprev.coupons), n0(CRM.rprev.members))}</b>` : '') + '</div>';
}
function crGroups(d) {
  let h = `<div class="card"><b>${t('cg_h')}</b> <button class="btn" data-act="crmge" data-k="new">${t('crm_add')}</button>${crmMsg('grp')}`;
  if (CRM.gf) {
    const f = CRM.gf, q = (CRM.gq || '').toLowerCase();
    const list = d.line_members.filter(m => !q || (m.name || '').toLowerCase().includes(q) || (m.phone || '').includes(q));
    h += `<div style="margin:8px 0">${t('cg_name')} ${crmIn('crm-g-name', f.name, 'data-act="crmgf" data-k="name" maxlength="60" style="width:240px"')}</div>` +
      `<div>${crmIn('crm-g-q', CRM.gq || '', `data-act="crmgq" placeholder="${esc(t('cg_search'))}" style="width:240px"`)} <span class="muted" id="crm-g-n">${t('cg_n', f.members.length)}</span></div>` +
      `<div style="max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:6px;padding:6px 10px;margin:6px 0">` +
      list.map(m => `<label style="display:block;padding:1px 0"><input type="checkbox" data-act="crmgm" value="${esc(m.id)}"${f.members.includes(m.id) ? ' checked' : ''}> ${esc(m.name || '–')} <span class="muted">${esc(crmPh(m.phone))}</span></label>`).join('') + '</div>' +
      `<button class="btn" data-act="crmgs">${t('crm_save')}</button> <button class="btn" data-act="crmge" data-k="">${t('crm_cancel')}</button>` +
      (f.id ? ` <button class="btn" data-act="crmgd">${t('crm_del')}</button>` : '');
  }
  h += d.groups.length
    ? `<table><tr><th>${t('cg_name')}</th><th>${t('cg_pick')}</th><th></th></tr>` +
      d.groups.map(g => `<tr><td><b>${esc(g.name)}</b></td><td>${g.members.map(m => esc(m.name || crmPh(m.phone))).join(', ') || '–'}</td>` +
        `<td><button class="btn" data-act="crmge" data-k="${g.id}">${t('crm_edit')}</button></td></tr>`).join('') + '</table>'
    : `<div class="muted">${t('cg_empty')}</div>`;
  return h + '</div>';
}
function crmCriteria() {
  const el = document.getElementById('crm-criteria');
  if (!crmNeed(el, 'rd', 'rules_data')) return;
  const d = CRM.rd;
  let h = crmHead(t('crm_crit'), t('cr_sub'), 'rd') + '<div class="card">' +
    (d.templates.some(x => x.active) ? `<button class="btn" data-act="crmre" data-k="new">${t('crm_add')}</button>` : `<span class="muted">${t('cr_need_tpl')}</span>`) +
    (CRM.rf ? '' : crmMsg('rule')) + '</div>';
  if (CRM.rf) h += crRuleForm(CRM.rf, d);
  h += '<div class="card">' + (d.rules.length
    ? `<table><tr><th>${t('cr_name')}</th><th>${t('cr_coupon')}</th><th>${t('cr_group')}</th><th>${t('cr_branches')}</th><th>${t('cr_days')} · ${t('cr_time')}</th>` +
      `<th>${t('cr_cats')}</th><th class="n">${t('ct_issued')}</th><th class="n">${t('ct_used')}</th><th class="n">${t('cr_members')}</th><th></th><th></th></tr>` +
      d.rules.map(r => `<tr><td><b>${esc(r.name)}</b>${r.active && r.armed_at ? `<div class="muted">${t('cr_armed', esc(r.armed_at))}</div>` : ''}` +
        `${r.ends_on ? `<div class="muted">${t('cr_ends')}: ${esc(r.ends_on)}</div>` : ''}</td>` +
        `<td>${esc(crTplName(r.template_id))}</td><td>${esc(crGroupName(r.group_id))}</td><td>${esc(crBranchList(r.branch_ids))}</td>` +
        `<td class="nw">${esc(crDaysLabel(r.days))} · ${r.t_from ? esc(r.t_from + '–' + r.t_to) : t('cr_alltime')}</td><td>${esc(crCatsLabel(r))}</td>` +
        `<td class="n">${n0(r.issued)}</td><td class="n">${n0(r.used)}</td><td class="n">${n0(r.members)}</td>` +
        `<td class="nw"><span class="tag ${r.active ? 'ok' : ''}">${t(r.active ? 'cr_on' : 'cr_off')}</span> ` +
        `<button class="btn" data-act="crmrt" data-k="${r.id}">${t(r.active ? 'cr_turn_off' : 'cr_turn_on')}</button></td>` +
        `<td><button class="btn" data-act="crmre" data-k="${r.id}">${t('crm_edit')}</button></td></tr>`).join('') + '</table>'
    : `<div class="muted">${t('cr_empty')}</div>`) + '</div>';
  h += crGroups(d);
  el.innerHTML = h;
}
```

- [ ] **Step 4: Append the handlers**

```js
Object.assign(window.CRM_ACT, {
  crmre: k => {
    CRM.msg.rule = null; CRM.rprev = null; CRM.riOpen = false;
    if (!k) { CRM.rf = null; render(); return; }
    const r = k === 'new' ? null : CRM.rd.rules.find(v => String(v.id) === String(k)), tp = CRM.rd.templates.find(x => x.active);
    CRM.rf = r ? {id:r.id, name:r.name, template_id:r.template_id, group_id:r.group_id || '', branch_ids:[...r.branch_ids], days:[...r.days],
                  t_from:r.t_from || '', t_to:r.t_to || '', categories:[...r.categories], item_ids:[...r.item_ids], ends_on:r.ends_on || '', active:r.active}
               : {id:null, name:'', template_id:tp ? tp.id : '', group_id:'', branch_ids:[], days:[], t_from:'', t_to:'',
                  categories:['main', 'set'], item_ids:[], ends_on:'', active:false};
    render();
  },
  crmrb: k => { const f = CRM.rf; f.branch_ids = k === 'all' ? [] : crToggle(f.branch_ids, Number(k)); CRM.rprev = null; render(); },
  crmrd: k => { const f = CRM.rf; f.days = crToggle(f.days, Number(k)); CRM.rprev = null; render(); },
  crmrdq: k => { CRM.rf.days = k === 'wd' ? [1, 2, 3, 4, 5] : k === 'we' ? [6, 7] : []; CRM.rprev = null; render(); },
  crmrtm: k => { const [a, b] = k ? k.split('|') : ['', '']; CRM.rf.t_from = a; CRM.rf.t_to = b; CRM.rprev = null; render(); },
  crmrc: k => {
    const f = CRM.rf; f.categories = crToggle(f.categories, k);
    const keep = new Set(CRM.rd.menu.filter(m => f.categories.includes(m.category)).map(m => m.item_id));
    f.item_ids = f.item_ids.filter(i => keep.has(i)); CRM.rprev = null; render();
  },
  crmrs: () => { const f = CRM.rf; if (!f) return;
    crmDo('rule', 'rule_save', crRulePayload(f), () => { CRM.rf = null; CRM.rprev = null; CRM.rd = null; render(); }); },
  crmrp: () => {
    const f = CRM.rf; if (!f) return;
    CRM.rprev = null; CRM.msg.rule = {ok:true, t:'…'}; render();
    crmApi('rule_preview', crRulePayload(f)).then(j => { CRM.rprev = j; CRM.msg.rule = null; render(); })
      .catch(e => { CRM.msg.rule = {ok:false, t:e.message}; render(); });
  },
  crmrt: k => {
    const r = CRM.rd.rules.find(v => String(v.id) === String(k)); if (!r) return;
    if (!confirm(t(r.active ? 'cr_off_ok' : 'cr_on_ok', r.name))) return;
    crmDo('rule', 'rule_toggle', {id:r.id, active:!r.active}, () => { CRM.rd = null; render(); });
  },
  crmge: k => {
    CRM.msg.grp = null; CRM.gq = '';
    if (!k) { CRM.gf = null; render(); return; }
    const g = k === 'new' ? null : CRM.rd.groups.find(v => String(v.id) === String(k));
    CRM.gf = g ? {id:g.id, name:g.name, members:g.members.map(m => m.id)} : {id:null, name:'', members:[]};
    render();
  },
  crmgs: () => { const f = CRM.gf; if (!f) return;
    crmDo('grp', 'group_save', {id:f.id, name:f.name, members:f.members}, () => { CRM.gf = null; CRM.rd = null; render(); }); },
  crmgd: () => { const f = CRM.gf; if (!f || !confirm(t('cg_del_ok', f.name))) return;
    crmDo('grp', 'group_delete', {id:f.id}, () => { CRM.gf = null; CRM.rd = null; render(); }); },
});
Object.assign(window.CRM_CHANGE, {
  crmrf: (v, el) => { if (CRM.rf) { CRM.rf[el.dataset.k] = v; CRM.rprev = null; } },
  crmri: (v, el) => {   // item ticks update in place so the list stays open
    const f = CRM.rf; if (!f) return; const id = Number(v);
    f.item_ids = el.checked ? [...new Set([...f.item_ids, id])] : f.item_ids.filter(x => x !== id); CRM.rprev = null;
    const sm = document.querySelector('#crm-ri summary'); if (sm) sm.textContent = (f.item_ids.length ? t('cr_items_n', f.item_ids.length) : t('cr_items_all')) + ' ▾';
  },
  crmgf: (v, el) => { if (CRM.gf) CRM.gf[el.dataset.k] = v; },
  crmgq: v => { CRM.gq = v.trim(); render(); },
  crmgm: (v, el) => {
    const f = CRM.gf; if (!f) return;
    f.members = el.checked ? [...new Set([...f.members, v])] : f.members.filter(x => x !== v);
    const n = document.getElementById('crm-g-n'); if (n) n.textContent = t('cg_n', f.members.length);
  },
});
document.addEventListener('toggle', e => { if (e.target.id === 'crm-ri') CRM.riOpen = e.target.open; }, true);
```

- [ ] **Step 5: Run the label check and a syntax check**

Run the Task 6 Step 1 command and `node --check crm/crm_rules.js`.
Expected: `labels OK <n> crm-overview,crm-members,crm-promos,crm-send,crm-coupons,crm-criteria,crm-settings,crm-plan`.

- [ ] **Step 6: Deploy and check in the browser**

Run `~/sales/app/deploy.sh`, then open `#crm-criteria` (reload with `{cache:'reload'}`).
- With no active coupon, the tab shows "สร้างและเปิดคูปองในแท็บ…".
- Create template `TEST คูปอง` (active) in กติกาคูปอง, then in เงื่อนไขรับคูปอง:
  - make group `TEST group` and tick 1 member; it is listed with that name;
  - + เพิ่ม rule: the branch chips show G / Si / O / SS / AS / R9; จ–ศ; the band chip "peak 17:30–19:00" fills both times; categories main;
  - ลองนับ shows "14 วันล่าสุดจะได้ N ใบ ถึง M คน", with N and M equal to Task 4's SQL check under the same conditions;
  - บันทึก → the row is listed as ปิดอยู่;
  - เปิด → the confirm text appears, then the row shows เปิดอยู่ and "นับบิลตั้งแต่ <now>";
  - ปิด again.
- read_console_messages shows no errors.

Then clean up with MCP `execute_sql`:

```sql
delete from crm.coupons where rule_id in (select id from crm.coupon_rules where name like 'TEST%');
delete from crm.coupon_rules where name like 'TEST%';
delete from crm.coupon_templates where title like 'TEST%';
delete from crm.member_groups where name like 'TEST%';
```

- [ ] **Step 7: Commit**

```bash
cd ~/sales
git add app/site/crm/crm_rules.js
git commit -m "CRM: Criteria tab (earning rules with preview, on/off) + hand-picked member groups

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 8: Live test with Point, then the handoff docs

**Files:**
- Modify: `~/Documents/GitHub/Marketing/Project Marketing.md`
- Modify: `~/sales/Project Sales Web.md`, and copy it to the vault `raw/legacy-vault/Projects/Sales Web/Project Sales Web.md`
- Modify: `~/mamapook-data/Project Data Backbone.md`
- Modify: `/Users/point/Claude automation/TOOLBOX.md` (rule: postgres.js savepoint)

- [ ] **Step 1: Set up Point's test (Point does it in the CRM, or Claude does it with Point watching)**

1. In กติกาคูปอง, create `ทดสอบ ลด 30% จานหลัก 1 จาน`: start after 1 day, valid 7 days, ERS hint = the name of the discount button Point created, active.
2. In เงื่อนไขรับคูปอง, create group `ทดสอบ Point` containing only Point.
3. Create a rule with that coupon and group, Point's branch, every day, all day, categories main + set.
4. Press ลองนับ and note the number.
5. Press เปิด.

- [ ] **Step 2: Point buys at full price (needs Point)**

Point eats at that branch, gives his phone at the cashier, and has nothing applied to the bill. After the next pipeline run (≤ ~30 min after the branch uploads; check `mp_metrics.branch_sync_status` if it's slow), check:

```sql
select title, valid_from, valid_to, source_line, unit_no from crm.coupons where rule_id = <rule id> order by id;
```

Expected: one row per main/set unit on that bill, valid from tomorrow for 7 days.
Point taps MEMBERS and sees `ทดสอบ ลด 30% จานหลัก 1 จาน ×N` with `เริ่มใช้ได้ <tomorrow> ถึง <+6>` and no button (status "soon").

- [ ] **Step 3: Negative check (needs Point)**

On a later visit, Point uses one coupon (staff tap → ยืนยัน, and the cashier keys the ERS discount). After the next sync, that bill must add **no** new coupons; the voids flag is set by the ERS discount. Check `select voids_earning from crm.pos_bills where order_id = '<branch>-<saleid>'` → true.

- [ ] **Step 4: Switch the test rule off once Point is satisfied**

Press ปิด in the Criteria tab. The test coupons stay on Point's card until they expire, unless Point asks to remove them.

- [ ] **Step 5: Write the handoff docs**

- **`Project Marketing.md`:** add a log entry:
  `2026-11-20 — Auto-earned member-card coupons (Point): 0025 (coupon_templates, member_groups, coupon_rules, pos_bills/pos_bill_lines/pos_menu, rule_hits, apply_coupon_rules), crm-points-sync v9 (bills + menu, rules in a savepoint), crm-admin v11 (rules_data, template_save, rule_save, rule_toggle, rule_preview, group_save, group_delete), line-webhook card stacks earned coupons ×N and each confirm uses one. Rules: earn only when nothing is applied to the bill (promotion, discount, price override, bill discount, points redemption); 1 coupon per full-price unit; LINE members only; silent; never combined with promotions; late coupons get full validity from arrival; 14-day bill window. Spec/plan: docs/superpowers/.`
  Also update the CRM section's description of the card.
- **`Project Sales Web.md`:** in the CRM area section, add the two tabs (กติกาคูปอง / เงื่อนไขรับคูปอง) and the file `app/site/crm/crm_rules.js` (loaded after crm.js; adds its labels / tabs / actions). Copy the file to the vault path above.
- **`Project Data Backbone.md`:** under the crm_points_push section, add `bills` (14 days, voids_earning definition, full_price definition), `menu`, and `--dry`.
- **`TOOLBOX.md`:** under hard-won rules, add: "postgres.js: run optional work inside a big transaction with `tx.savepoint(...)` and catch, so a failure there can't roll back the main sync (crm-points-sync v9 runs the coupon rules this way)."

- [ ] **Step 6: Commit the docs in each repo**

```bash
cd ~/Documents/GitHub/Marketing && git add "Project Marketing.md" && git commit -m "Handoff: auto-earned member-card coupons

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push
cd ~/sales && git add "Project Sales Web.md" && git commit -m "Handoff: CRM Coupon rules + Criteria tabs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push
cd ~/mamapook-data && git add "Project Data Backbone.md" && git commit -m "Handoff: crm_points_push bills + menu for coupon rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push
```
