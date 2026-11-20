# Coupon rules + Criteria: auto-earned member-card coupons (design)

Date: 2026-11-20 · Status: design approved in chat by Point, spec awaiting review
Repos: Marketing (schema, Edge Functions), sales (CRM tabs), Mamapook-data (bill push)

## Goal

Members earn coupons on their **member card** automatically from what they buy.
Example: a hand-picked group buys main dishes at Silom between 16:00 and 20:00 at full price.
Each dish earns one "ลด 30% จานหลัก 1 จาน" coupon, valid from tomorrow for 7 days.

## Decisions (Point, 2026-11-20)

| Topic | Decision |
|---|---|
| Notification | **Silent.** The coupon appears on the card; no LINE message is sent and no quota is used. The standing rule (no customer message without a preview and Point's "send") is untouched. |
| How many | **1 coupon per qualifying dish (unit), stackable.** A bill with 5 qualifying bowls earns 5 coupons. |
| Full price only | A bill with **any promotion or discount earns nothing**, including a 2 แถม 1 bill whose other bowls were paid in full. So a visit where coupons are used never earns new ones. |
| Who | A **hand-picked member list**, or all LINE members. Groups defined by criteria (visits, branch, birthday…) come later, using the same group table. |
| Not on LINE | **LINE members only.** An ERS customer without a linked LINE account earns nothing; coupons are not held for them. |
| Tabs | Two new CRM tabs: **Coupon rules** (what the coupon is) and **Criteria** (who earns it, and when). |
| With other promotions | Each coupon has a **"use with other promotions: yes/no"** setting. It is shown on the card and in the staff confirm step. |

## Definitions

- **In-store bill:** a finalized, not-voided, not-returned ERS bill, channel dine_in or take_away, with the customer's phone on it (customer record phone `^0[689]\d{8}$`). If the customer doesn't give their phone at the cashier, nothing is earned.
- **Bill time:** the bill opening time, Asia/Bangkok, the same clock as the day-clock slots.
- **Promotion or discount on a bill (voids earning):** any of
  - an active line with `appliedpromotionid > 0`. 2 แถม 1 free bowls are their own ฿0 lines carrying the promotion id (checked 2026-11-20);
  - any line with a discount (`discountamount + amountdiscount > 0`) or `ispriceoverride`;
  - a bill-level discount (`pos_t_sale.discountamount > 0`);
  - a points redemption on the bill (`redeemedpoint > 0`).

  ฿0 freebies that aren't promotions (free ice H4, empty glass H2, A13) do **not** void a bill.
- **Qualifying dish:** an active, non-special line whose `tree_category` is in the rule's categories (main / set / side / topping / dessert / beverage), optionally narrowed to listed ERS item ids. Each unit of qty earns one coupon.

## Data flow

```
ERS → Mac pipeline (every ~30 min) ── tools/crm_points_push.py
        adds `bills`: in-store bills of the last 7 days, with lines + void flag
      → Edge Function crm-points-sync (Marketing)
        replaces crm.pos_bills / crm.pos_bill_lines (rolling 7 days)
        then runs crm.apply_coupon_rules() in the same transaction
      → crm.coupons (member card)
```

- **Rules live in the Marketing database** and are edited in the CRM tabs. The Mac never needs to know about them.
- **Latency:** a coupon is issued within ~30–60 min of the bill reaching HQ. Branch POS uploads can lag, so check `branch_sync_status` before calling a coupon missing. If a bill arrives so late that the coupon's whole validity window has passed, the coupon is not issued.
- **Idempotent:** a coupon is keyed by (rule, bill line, unit number). Re-running a sync, or the same bill appearing in several syncs, never issues a duplicate.
- **No backdating:** a rule only counts bills opened at or after the moment it was last switched on (`armed_at`).

## Schema (Marketing migration 0025)

```sql
-- what a coupon is (Coupon rules tab)
crm.coupon_templates (
  id bigint identity pk,
  title text not null,                   -- on the card, e.g. ลด 30% จานหลัก 1 จาน (≤ 40 chars)
  detail text,                           -- optional second line, e.g. เฉพาะเมนูจานหลัก ไม่รวมเครื่องดื่ม (≤ 100)
  start_after_days int not null default 1,   -- 1 = valid from the day after the bill
  valid_days int not null default 7,         -- validity length in days, counted from the start day
  with_promos boolean not null default false,-- can be used together with other promotions
  ers_hint text,                         -- what the cashier keys in ERS, e.g. ส่วนลด "คูปองสมาชิก 30%"
  active boolean not null default true,
  created_at, updated_at timestamptz
)

-- who: hand-picked lists now, criteria-based groups later (kind)
crm.member_groups (id bigint identity pk, name text not null, kind text not null default 'list', created_at)
crm.member_group_members (group_id → member_groups, line_user_id → line_members, added_at, pk (group_id, line_user_id))

-- who earns which coupon, and when (Criteria tab)
crm.coupon_rules (
  id bigint identity pk,
  name text not null,
  template_id bigint not null → coupon_templates,
  group_id bigint → member_groups,       -- null = all LINE members
  branch_ids int[],                      -- null/empty = all branches
  days int[],                            -- ISO weekdays 1–7; null/empty = every day
  t_from time, t_to time,                -- bill opening time window; null = all day; t_to exclusive
  categories text[] not null,            -- tree_category values that qualify
  item_ids bigint[],                     -- optional: only these ERS items
  active boolean not null default false,
  armed_at timestamptz,                  -- set each time the rule is switched on
  ends_on date,                          -- optional last bill date
  created_at, updated_at
)

-- rolling 7-day bill copy pushed by the Mac (replaced every sync)
crm.pos_bills (order_id text pk, phone text, bill_no text, branch_id int, opened_at timestamptz,
               business_date date, voids_earning boolean not null)
crm.pos_bill_lines (line_id text pk, order_id text → pos_bills, item_id bigint, name text,
                    category text, qty numeric)

-- crm.coupons gains
alter table crm.coupons
  add column template_id bigint, add column rule_id bigint,
  add column source_line text, add column unit_no int,
  add column with_promos boolean, add column detail text;
-- drop unique (line_user_id, kind); keep one sign-up coupon per member with a partial unique index:
create unique index coupons_signup_once on crm.coupons (line_user_id) where kind = 'signup';
create unique index coupons_rule_unit on crm.coupons (rule_id, source_line, unit_no) where rule_id is not null;
-- kind = 'rule' for earned coupons
```

`crm.apply_coupon_rules()` is a plpgsql function that returns the number of coupons issued. For every active rule (with `ends_on` null or ≥ the bill date), it inserts one coupon per unit where:

- the bill is in `pos_bills`, `not voids_earning`, and `opened_at ≥ armed_at`;
- the bill's phone belongs to a LINE member (`crm.line_members.phone`) who is in the rule's group, or is any LINE member when there is no group;
- the branch, weekday and time window match, and the line's category (and item id, if listed) qualifies;
- `valid_to = business_date + start_after_days + valid_days − 1` and `valid_to ≥ today`.

It uses `on conflict do nothing` on `coupons_rule_unit`. Title, detail and with_promos are copied from the template at issue time, so editing a template later doesn't rewrite coupons already issued.

## Edge Functions

- **crm-points-sync v9:** accepts `bills: [{order_id, phone, bill_no, branch_id, opened_at, business_date, voids_earning, lines: [{line_id, item_id, name, category, qty}]}]`. It replaces pos_bills / pos_bill_lines and calls `crm.apply_coupon_rules()` in the same transaction. Guards: it only replaces when `bills` is an array; an empty array is allowed (a quiet week); a missing key leaves the tables untouched. The response adds `bills` and `coupons_issued`.
- **crm-admin v11**, new ops (every change logged in admin_log):
  - `templates` / `template_save`;
  - `groups` / `group_save` (name + member list) / `group_members`;
  - `rules` / `rule_save` (switching a rule on sets armed_at = now());
  - `rule_preview {rule}`: for a draft rule, how many coupons and members it *would* have produced from the bills currently in pos_bills, ignoring armed_at. Nothing is written;
  - `rule_stats`: per rule, coupons issued / used / expired / active, and members reached.

  The Members `coupons` json already lists each member's coupons, so earned coupons show there with their rule name.
- **line-webhook memberCard** (and the copy in line-coupon-send mode "card"):
  - Coupons with the same template, validity and status are grouped into one box, e.g. `ลด 30% จานหลัก 1 จาน ×5 · ใช้ได้ถึง 27 พ.ย.`. The detail line and `ใช้ร่วมกับโปรโมชั่นอื่นได้` / `ใช้ร่วมกับโปรโมชั่นอื่นไม่ได้` are shown underneath.
  - One button per group; each tap uses **one** coupon (the one expiring soonest).
  - The staff confirm text adds the promotion rule and the ERS hint: `พนักงาน: ยืนยันใช้สิทธิ์ "…" (1 ใบ) ? ใช้ร่วมกับโปรอื่นไม่ได้ · ใส่ส่วนลด "คูปองสมาชิก 30%" ที่ POS`.
  - Sign-up coupons render as today.
- **member-card** (LIFF, later): same grouping when LIFF is switched on.

## Mac pipeline (Mamapook-data `tools/crm_points_push.py`)

New `BILLS_SQL`: in-store bills with `business_date ≥ today − 7` for customer phones `^0[689]\d{8}$`, with their active, non-special lines (`mp_clean.order_lines`: line_id, itemid, name_th, tree_category, qty) and `voids_earning` computed from `mp_raw.pos_sale_items` (promotion id, discounts, price override) and `mp_raw.pos_t_sale` (bill discount, redeemedpoint). Split-bill duplicate lines are excluded via `mp_metrics.split_dupe_lines`, as in the other CRM queries. Posted as `bills` with the existing payload.

## Sales site (CRM area, crm.js)

**Coupon rules tab** (`crm-coupons`)
- A list of templates showing title, validity ("from day +1, 7 days"), with promotions yes/no, active, and issued / used / expired counts.
- The form edits: title, detail, start after N days, valid N days, use with other promotions (yes/no), ERS hint, active.
- A live preview of how the coupon box will look on the card.

**Criteria tab** (`crm-criteria`)
- A list of rules showing name → coupon, group, branches, days/time, dishes, on/off, and issued / used.
- The form:
  - name;
  - coupon (template picker);
  - group (all LINE members / a saved list);
  - branches (chips, using the G / Si / O / SS / AS / R9 initials);
  - days (chips) and time from–to, reusing the send form's day and band chips;
  - dish categories (chips) plus optional items (search the menu);
  - an optional end date;
  - on/off.
- **Preview** button: "the last 7 days would have given N coupons to M members". Switching a rule on asks for confirmation and states that only bills from now on count.
- **Groups** section: create or rename a list, and add members by searching LINE members (name / phone) or removing them.

Each tab has TH/EN labels, with key sets checked equal as before.

## Not in v1

- Criteria-based groups (the table is ready via `member_groups.kind`).
- Holding coupons for non-LINE customers.
- LINE notifications of new coupons.
- A per-bill cap on coupons used, or a minimum spend.
- Checking actual coupon use against ERS bills (possible later once the ERS discount exists: count bills with "คูปองสมาชิก" vs card taps).

## Needed from Point

- Create an ERS discount (e.g. "คูปองสมาชิก 30%") for cashiers to key when a coupon is used. It keeps the discount consistent, marks the bill as discounted (so it earns nothing), and lets usage be counted later.
- Brief staff: the customer gives their phone at the cashier to earn coupons; the card's button uses one coupon per dish.

## Testing

1. Migration on Marketing; check that the existing sign-up coupon stays unique per member.
2. Run `crm.apply_coupon_rules()` against a hand-made pos_bills fixture inside a rolled-back transaction, covering:
   - a full-price bill earning per unit;
   - a promo bill earning 0;
   - a discounted bill earning 0;
   - a wrong branch, wrong time, or bill before armed_at earning 0;
   - a non-group member and a non-LINE phone earning 0;
   - running twice and getting no duplicates;
   - a late bill whose window has passed earning 0.
3. Live: a test rule on a test template, group = Point only, at Point's usual branch.
   - Run Preview, then switch it on, then a real full-price bill, then confirm the coupon appears on Point's card at the next sync.
   - Tap to use one coupon and check that the count drops by one.
   - Then remove the test rule and its coupons.
4. Sales site: render both tabs in the browser preview, save/edit round trip, preview numbers equal the SQL.
