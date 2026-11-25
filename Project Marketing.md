# HANDOFF — MamaPook Marketing Model

> **Living document.** Every session/change that touches this project must update this file:
> what changed, what's deployed, what's pending, and what's needed next. Keep the log at the
> bottom append-only.

## Project in one paragraph

Marketing data warehouse + metrics engine on Supabase for MamaPook restaurant (branches:
Rama9, Silom, Gaysorn, OCC), reverse-engineered from the LyftUp Partners agency deck so the
agency's entire analysis regenerates automatically from daily data feeds. Planned outputs:
Cloudflare Pages HTML dashboard reading the `marts` schema, and LINE Messaging API push
alerts (anomalies, bad reviews, late data, competitor promos, daily digest).

## Current state (updated 2026-07-14)

| Area | State |
|---|---|
| Supabase project | **Marketing** — ref `qtpwrwapbefczvqdfzes`, region ap-southeast-1. (Do NOT touch `mamapook-planner` — separate production-planning project.) The database also hosts the **`operation_log` schema** — a separate owner project with its own repo/sessions; Marketing work must NEVER touch `operation_log.*`, and vice versa (see operation-log-starter/). |
| Migrations applied | 0001–0005 applied and verified (36 tables, seeded dims incl. 2,557-day calendar). |
| Migration 0006 (RLS lockdown) | **Applied 2026-07-14.** RLS enabled on all 36 tables, no policies: public keys fully blocked; service role and SQL unaffected. |
| Dashboard | **v1 LIVE (synthetic data)** at https://marketing.itthichet-a.workers.dev — Cloudflare Worker static assets, Git-connected, assets dir `dashboard/`. Owner decision: NO Access wall while data is synthetic; **Cloudflare Access becomes a hard prerequisite of phase 4** (before real POS data shows on the dashboard). Preview URLs disabled; production workers.dev toggle must stay ON. |
| Ingestion | No feeds connected yet. `core.load_pos(from, to)` transform function is ready and tested. |
| Alerts | Rules seeded; check functions deployed; **pg_cron live**: hourly checks :30, digest 02:00 UTC, insights 02:15 UTC (**ops.run_insights** = generate_insights + check_set_verdicts). LINE Edge Function not built (needs LINE OA credentials). |
| GitHub ↔ Supabase | Not connected; not required. Migrations are applied via the Supabase integration from Claude sessions. |

## Where things are

- `docs/01-agency-report-catalog.md` — page-by-page inventory of the 77-page agency deck
- `docs/02-metrics-catalog.md` — all 35 metrics with formulas (note the add-on denominators from deck p.21)
- `docs/03-system-design.md` — architecture, ingestion plan, alert rules, dashboard page map, roadmap
- `docs/04-gap-analysis.md` — inventory by category + tiered gaps for further analysis
- `docs/05-recommendation-engine.md` — set-menu engine v2: 7-step logic, incremental-GP framework (owner-approved)
- `docs/06-rule-catalog.md` — the full 31-rule suggestion-layer catalog with thresholds + delivery states (owner-approved)
- `supabase/migrations/` — 0001 raw+ops, 0002 dims+seeds, 0003 facts+plans, 0004 metric views, 0005 alerts, 0006 RLS, 0007 rec engine + insights + A/B analytics, 0008 set engine v2 (incremental GP) — all applied
- `dashboard/` — Pages site (index.html, data.js synthetic adapter, README with deploy steps)

## Key design rules (do not violate)

0. Set-menu decisions use the **incremental-GP framework** (docs/05 step 5): compare
   attacher gain α·P·g against pairer loss E·D; verdicts come from marts.v_set_pnl, never
   from revenue alone. Insight rules must name a counterfactual and end in one action verb (docs/06).
1. Dashboard reads **only** `marts.*`. All calculations live in SQL views, defined once.
2. `raw` is append-only; `core` is always rebuildable from `raw` (see `core.load_pos`).
3. Add-on metrics: % attachment divides by ALL bills; units-per-bill divides by bills WITH add-on; Set items excluded (deck p.21 methodology).
4. Main dish = Signature, Noodles, Rice, Gaolao. OCC has no delivery channel.
5. LINE alerts use the **Messaging API** (LINE Notify is discontinued).
6. New POS item names must be mapped in `core.map_item_name`; unmapped ones show in `marts.v_unmapped_items`.
7. The `operation_log` schema belongs to the separate Operation Log project — Marketing migrations and sessions never touch it. Shared project-level resources (cron prefixes marketing-/oplog-, edge functions, exposed schemas) follow the naming conventions in operation-log-starter/CLAUDE.md.

## Blocked on owner input

- [ ] POS vendor + daily export format (file/API? item-level? customer identifier? delivery-platform field?)
- [ ] Detailed menu + cost file → populate `core.dim_menu_item` (unlocks menu engineering)
- [ ] LINE OA channel ID + access token (alerts, then OA webhook)
- [ ] Meta / TikTok API tokens; Google Places API key
- [ ] Competitor list (names, social handles, Google Maps place IDs) → `core.dim_competitor`
- [ ] Accounting system name/access for the marketing-spend automation

## Next phases (from docs/03 roadmap)

3. POS ingest Edge Function + backfill; menu master + cost load (activates margin math in set engine); implement the 🔜 rules from docs/06 (daypart erosion, channel divergence, falling star, price/discount/void rules) with thresholds sanity-checked on real variance
4. Dashboard v1 on Cloudflare Pages (Overview, Dayparts, Menu, Basket)
5. Accounting spend automation → ROI/budget pages
6. Social APIs + listings/reviews ingest + Claude enrichment → Social/Reputation pages
7. LINE OA webhook + `send-line-alerts` Edge Function + daily digest
8. Competitor scraping; CRM link (repeat rate, RFM); remaining Tier-1 gap views (targets/pace, share of voice) — item affinity + discount effectiveness shipped in 0007

## LINE member link (live 2026-11-17)
Phone-number link between LINE friends of @mamapook and POS members, with a next-visit
เก๊กฮวย coupon redeemed on the member card. Schema `crm` (migration 0009), Edge Functions
`line-webhook`, `member-card`, `line-menu-setup` (source `supabase/functions/`), card page
`member-card-page/` on Cloudflare (`mamapook-member.itthichet-a.workers.dev`). Inert until the
owner enters the LINE secrets. Full decisions, addresses and the owner checklist:
`docs/07-line-member-link-setup.md`. Design: LINE Member Link Playbook (sales site `#mk-crm`).
Member program v4 (built 2026-11-18): sign-up form (`member-card-page/register.html` on Worker
`mamapook-member`, one-time links in `crm.signup_tokens`), ERS points + reward ladder on the card
(`crm.pos_points` / `crm.pos_rewards`, pushed every pipeline cycle by `~/mamapook-data/tools/crm_points_push.py`

**CRM admin area (2026-11-18):** config, members, promotions, coupon sends and insights now live in the sales site's CRM area (whole site behind login) — Edge Function `crm-admin` (supabase/functions/crm-admin, migration 0014). The one-time-key scripts (line-coupon-send, line-webhook admin push) stay for emergencies. See docs/07 and the sales repo's Project Sales Web.md › CRM area.
to Edge Function `crm-points-sync`), PROMOTIONS button (`crm.promotions`). Migration 0012. SMS code not built.
LINE coupon API (tested 2026-11-18): Edge Function `line-coupon-send` creates a real LINE
built-in coupon (POST /v2/bot/coupon) and pushes it as a `coupon` message to chosen user IDs,
armed by a one-time key in `crm.settings.send_key`. One push to one person used 1 message of
quota. LINE gives no per-person usage data for these coupons; totals are in OA Manager Insights.

**Auto-earned member-card coupons (built 2026-11-20, Point):** CRM tabs กติกาคูปอง (coupon templates) and เงื่อนไขรับคูปอง (criteria rules + hand-picked groups). Every ~30 min the Mac push sends the last 14 days of in-store bills with lines (`bills`) and the menu (`menu`); `crm-points-sync` v9 stores them (crm.pos_bills / pos_bill_lines / pos_menu) and runs `crm.apply_coupon_rules()` in a savepoint (a rule error never blocks the points sync). Rules: a bill earns only when NOTHING is applied to it (promotion, line discount, price override, bill discount, points redemption); 1 coupon per full-price unit of a qualifying dish; LINE members only (bill phone = linked phone); silent (no LINE message); coupons never combine with other promotions (card + staff confirm say so); valid from the day after the bill for N days, or from the arrival day if a branch uploads late; only bills after a rule is switched on (armed_at) count. Card stacks identical coupons ("×N"); each staff confirm uses exactly one (line-webhook onRedeemEarned). Earned coupons use kind `rule:<rule>:<line>:<unit>`, so the sign-up one-per-member constraint is untouched. Migration 0025 (+ fixture test supabase/tests/0025_coupon_rules_test.sql), crm-admin v11 ops rules_data / template_save / rule_save / rule_toggle / rule_preview / group_save / group_delete. Spec + plan: docs/superpowers/. Cashiers key the ERS coupon discount button when a coupon is used (that makes the bill "discounted", so it earns nothing).

## Change log (append-only)

- **2026-07-14** — Screened the 77-page agency deck into docs/01–03; built and locally validated
  migrations 0001–0005; applied them to Supabase project `qtpwrwapbefczvqdfzes`; added 0006 RLS
  lockdown (unapplied, pending approval); added docs/04 gap analysis; created this handoff.
  Branch: `claude/marketing-model-supabase-aikp7e`.
- **2026-07-14 (later)** — Owner approved: applied migration 0006 (RLS enabled on all tables,
  verified by advisor). Decision: no Supabase Auth for now; dashboard will be protected with
  Cloudflare Access at phase 4.
- **2026-07-14 (later)** — Seeded Thai holidays 2024-2030 into core.dim_date (lunar dates verified
  for 2026-27; 2028-30 fixed-date only — refresh lunar dates yearly). Enabled pg_cron and scheduled
  marketing-checks (hourly :30) + marketing-digest (02:00 UTC). Built dashboard v1 skeleton in
  dashboard/ with synthetic data adapter mirroring marts view shapes; render-verified via headless
  Chromium. Owner to connect Cloudflare Pages (see dashboard/README.md).
- **2026-07-14 (later)** — Owner connected Cloudflare to the repo; dashboard deployed as a Worker
  with static assets (not classic Pages) at https://marketing.itthichet-a.workers.dev. Pending:
  Cloudflare Access in front of the URL.
- **2026-07-14 (later)** — Migration 0007 (validated locally, applied to Supabase): set-menu
  recommendation engine (v_item_affinity market-basket stats + v_set_candidates with price/margin/
  target logic), suggestion layer (ops.insights + generate_insights() with 9 rules: bad/good/amplify
  -> action; cron 02:15 UTC), and group A+B analytics (payday/holiday effects, hour x DOW, Pareto/ABC,
  peak saturation, void/discount trend, ramp curve, payment mix, price_change log + impact,
  set_component + cannibalization, competitor menu prices + price positioning). New POS fields:
  payment_method, is_voided (nullable-safe). docs/05 documents the logic. Dashboard: new
  Suggestions page (insight cards + set-candidate table, synthetic preview).
- **2026-07-14 (later)** — Discussion with owner finalized the set-menu economics: sets must grow
  revenue AND gross profit; decision metric = incremental GP (attacher gain vs pairer loss).
  Migration 0008 (validated locally, applied): v_set_candidates v2 with candidate classes
  (attachment + revival with visibility-signature guard), P/E populations, gain_per_attacher,
  breakeven_adoption_pct, projected_gp_at_10pct_adoption; v_set_pnl realized family-GP verdict;
  set_verdict rule; cron consolidated into ops.run_insights(). docs/05 rewritten as the 7-step
  owner-approved logic; docs/06 created as the approved 31-rule catalog with delivery states.
- **2026-07-14 (later)** — Owner requested a second, separated project inside the same Supabase
  project (free-plan slot limit). Created schema `operation_log` (comment documents the boundary).
  Added operation-log-starter/ (CLAUDE.md guardrails + SETUP.md) for the owner to copy into a new
  operation-log repo; new Claude sessions on that repo are scoped by its CLAUDE.md. Design rule 7
  added: Marketing never touches operation_log.* and vice versa.
- 2026-11-17 — LINE member link built and deployed (crm schema, 3 Edge Functions, card page); waiting on owner LINE steps A, 9, 11–13, 15. See docs/07.
- 2026-11-18 — LINE coupon API test: `line-coupon-send` deployed; test coupon 01M7PCBVPR38CYTZSRHVZHNAH2 (free เก๊กฮวย, valid to 2026-11-19, one use) pushed to Point only; quota 3→4. Decision pending: build the CRM-tab send form on this API instead of share links.
- 2026-11-18 — `line-coupon-send` v2 adds mode "card": pushes each person their member card (our crm.coupons, staff tap). Test coupon id 3 (kind test-2026-11-18, valid 18–19 Nov) pushed to Point with a note; one push of note + card used 1 message (quota 4→5). The card code is a copy of the webhook's memberCard; keep the two in sync.
- 2026-11-18 — Decided (Point): earned coupons live on our member card, promotional coupons go as LINE coupons by API. Points: ERS is the only points system; card shows the ERS balance (~30 min) and a view-only reward ladder; all redemption at the cashier with the ERS redemption item; only the sign-up เก๊กฮวย uses the staff tap. Details in docs/07. Not built yet.
- 2026-11-18 — Decided (Point): drop the COUPONS list; second button = PROMOTIONS from `crm.promotions` (open to everyone, per-branch later); SMS one-time code on phone numbers; sign-up form (name, birthday, branch, phone, consent) opened from the chat. Details in docs/07. Not built yet.
- 2026-11-18 — Built v4: migration 0012, crm-points-sync, line-webhook v4 (card with points/rewards/inline buttons, PROMOTIONS, sign-up form API, admin push), sign-up form page, pipeline step crm_points (backbone repo). Tested on Point's account. Waiting on Point: privacy wording, OA greeting, PROMOTIONS button label, real promotions.
- 2026-11-20 — CRM Members table gets ERS visit stats (Point): migration 0019 (crm.pos_member_stats, crm.pos_promo_uses), crm-points-sync v3 (accepts `stats` + `promo_uses`, replaced each sync), crm-admin v5 (members `scope` line|ers + stats, coupons, promotions), backbone tools/crm_points_push.py computes them from mp_clean in-store bills (delivery = 3 platform customers in ERS, excluded). Definitions: people/visit = (main + set units) ÷ visits; add-on % = side+topping+dessert ÷ bowls; drinks % = beverage ÷ bowls; day-clock slots follow the sales site's MK_DAY.bands (keep the SQL in step). First run: 634 phones with bills, 995 visits, 619 promotion uses (mostly โปรสมาชิก 2 แถม 1).
- 2026-11-20 — Send coupon conditions (Point): crm-admin v6 coupon_send validates reward (free/gift/others, discount fixed/percentage/explicit), usageCondition (≤100, LINE shows it, enforces nothing), maxUse 1|-1; migration 0020 adds coupon_sends.reward / usage_condition / max_use. LINE's coupon API has no day/time/spend fields — conditions are text for staff to check.
- 2026-11-20 — Visits per branch (Point): migration 0021 adds crm.branches.short / short_sort (G Gaysorn Tower, Si ParkSilom, O One City Centre, SS Sathorn Square, AS All Season Place, R9 Rama9) and pos_member_stats.branch_visits jsonb; crm-points-sync v5 (pass the object, not JSON.stringify — postgres.js stores a string otherwise), crm-admin v7 returns branch_visits + branches. New branch → set its short + short_sort in crm.branches.
- 2026-11-20 — People per visit two ways (Point): migration 0022 adds pos_member_stats.pax (sum of ERS guest count keyed by staff), med_bowls, med_pax (per-member medians per visit); crm-points-sync v6, crm-admin v8. First run: 2.92 people/visit by bowls vs 2.15 keyed (take-away is keyed as 1).
- 2026-11-20 — Dine-in vs take-away per member (Point): migration 0023 pos_member_stats.dine_visits; crm-points-sync v7, crm-admin v9. First run 886 dine-in / 109 take-away of 995 visits.
- 2026-11-20 — Member visit list (Point): migration 0024 crm.pos_member_visits (one row per in-store bill: bill_no, at, branch, channel, bowls, pax, spend, addon, drinks, items ≤400, promos); crm-points-sync v8 (`visits`), crm-admin v10 op member_visits {phone}. Totals reconcile with pos_member_stats (995 visits, ฿477,993). Open question for Point: beverage units include ฿0 lines H4 น้ำแข็งฟรี (803) and H2 แก้วเปล่า (166), about half of drink units.
- 2026-11-20 — Drinks fixed at the source (Point): backbone map_item_category sets H4 น้ำแข็งฟรี / H2 แก้วเปล่า to 'free'; CRM member drinks 65% → 32% after the re-push. Visit list time is split into peak / pre-peak / off-peak columns.
- 2026-11-20 — Auto-earned member-card coupons (Point): migration 0025, crm-points-sync v9 (bills + menu, rules in a savepoint), crm-admin v11, line-webhook v12 (card stacks ×N, each confirm uses one), backbone crm_points_push sends bills + menu, sales site tabs กติกาคูปอง / เงื่อนไขรับคูปอง (app/site/crm/crm_rules.js). First bill push: 257 bills / 1,204 lines in 14 days, 162 with something applied (160 = member 2 แถม 1), 0 from LINE members yet. Live test with Point pending.
- 2026-11-20 — Coupon rules tab shows how to earn each coupon (rule sentence) + delete (Point): crm-admin v12 template_delete {id, withdraw} / rule_delete; sales 33276d3. Point's first real rule created OFF: coupon ลดราคาชามหลัก 30% (id 5) ← rule 10 จานหลัก ParkSilom 16:00–20:00, all LINE members, every day.
- 2026-11-20 — Rules by bill amount + per-bill tick (Point): migration 0026 (coupon_rules.min_spend, multi; pos_bills.total; rule_hits rewritten: per-bill hits use source_line 'bill:<order_id>'), crm-points-sync v10 (bills carry total), crm-admin v13 (a rule is product OR amount, never both), backbone push sends total_thb. multi on = 1 per dish (product) or 1 per every full min_spend (amount); off = 1 per bill. Three coupon kinds confirmed with Point: sign-up (card), earned from bills (card, this engine), sent LINE coupon (ส่งคูปอง tab).
- 2026-11-20 — "Nothing applied to the bill" is now a per-rule switch (Point): migration 0027 coupon_rules.require_clean (default true; rule_hits first join = not require_clean or not voids_earning), crm-admin v14. Off = bills with a promotion / discount / points earn too; lines still need full list price, so a free 2 แถม 1 bowl never earns. Same day: Criteria tab merged into the coupon cards, new กลุ่มสมาชิก (audiences) tab.
- 2026-11-23 — Sign-up form: every field required up front (Point): member-card-page/register.html marks name, birthday, branch, phone with *, keeps the button off until all five (incl. consent) pass the same rules as the server, lists what is missing, outlines a bad field after it is touched. Deployed to Worker mamapook-member (`npx wrangler deploy --name mamapook-member` from member-card-page/). Server rules unchanged (line-webhook /signup already refused incomplete forms).
- 2026-11-23 — Coupon master switch (Point): the coupon's own on/off is a switch on its card (page sends template_save with active flipped). Migration 0028: trigger coupon_templates_rearm sets armed_at = now() on the coupon's live rules when it goes off → on, so bills paid while it was off never earn. Found the same day: Point's Friday 20 Nov test got no coupon because the rule had been switched on and off within the same minute (18:35) and stayed off; page now ignores a second toggle click within 3 s.
- 2026-11-23 — Member card layout + cancel (Point): line-webhook v13. Card body now has two headed sections with dividers: แลกแต้ม (point rewards) and คูปองของฉัน (coupons). The confirm's ยกเลิก (postback action=noop) now replies that nothing was used. Same day in the backbone push: bill-level void flags and card balance read mp_raw.pos_sales, not the lagging pos_t_sale (same-day points redemption was treated as a clean bill and the card stayed on the overnight balance).
- 2026-11-23 — Cancelled confirms can no longer redeem (Point): line-webhook v14. LINE cannot remove buttons from a sent message, so ยืนยัน / ยกเลิก on a confirm carry the same ts; ยืนยัน is refused if that confirm's ยกเลิก was pressed (looked up in raw.line_events) or it is older than 10 minutes, or has no ts (confirms sent before v14).
- 2026-11-24 — Coupons from voided bills are taken back (Point): migration 0029 (crm.coupons.keep_on_void, crm.coupon_takebacks log, crm.take_back_voided(orders[], lines[])), crm-points-sync v11 (optional `voided` {orders, lines}; runs take-back before apply_coupon_rules; response coupons_taken_back). The Mac push sends member bills voided in the last 21 days with all their lines, plus single lines voided off live bills. Only UNUSED rule coupons are deleted (copied to coupon_takebacks first, so restorable); used ones stay. ERS refunds are voids (no isreturn bills exist). Point kept his 14 coupons from the voided 23 Nov test bills (keep_on_void = true).
- 2026-11-24 — Launch prep (Point): all 5 test coupons paused. Coupon use window: migration 0030 (coupon_templates.use_from / use_to / use_days), crm-admin v15 (template_save keeps the window when the payload has no use_days, so the on/off switch can't wipe it), line-webhook v15 (card line "ใช้ได้ทุกวัน หลัง 14:00 น."; ใช้สิทธิ์ refused outside the window, checked at tap time — the bill's opening time is not known to LINE). After-2PM coupon created OFF: template 16 "ลด 40% จานหลักหรือชุด 1 จาน" (+1 day, 7 days, usable after 14:00 every day, no second dish needed — Point chose option C) + rule 33 (Mon–Fri bills opened 14:00–23:59, main + set lines at full price, bill may have promotions, 1 coupon per dish, several per bill, no cap). Only 5 LINE-linked members vs 746 in ERS: the last 14 days would have earned 367 coupons if all were on LINE.
- ERS facts found 2026-11-24: points expiry is already on (loyalty rank Standard: expiredtype 3, expiredindays 90 — Point wants 180); bills that redeem points earn 0 points (Point wants points on what was paid); both 2 แถม 1 promotions run every day 16:00–22:00 (member one = custtype 55); sets never get 2 แถม 1; pos_m_discountsalereason is empty in our copy.
- 2026-11-24 — ตั้งค่า POS checklist (Point): crm-points-sync v12 stores the Mac push's `ers_config` snapshot in crm.settings 'ers_config'; crm-admin v16 ops pos_setup (snapshot + manual ticks crm.settings 'pos_manual' + our switches) and pos_tick {key, done} (logged). Page: sales site CRM › ตั้งค่า POS (crm_pos.js). Found while building: sign-up gift is OFF (crm.settings signup_reward) although Point wants it for launch — left for Point to switch on; only 6% of in-store bills (524/8,175, 30 days) have a member keyed.
- 2026-11-24 — Final rules (Point): points expiry stays 90 days (POS checklist expects 90 / "3 เดือน"). Weekend 2 แถม 1 = members, Sat–Sun 10:00–20:00. One bill may carry the 2PM coupon + a points redemption or the sign-up gift; 2 แถม 1 + redemption / gift is fine but the redeemed dish and the gift never count toward 2 แถม 1; the 2PM coupon never combines with 2 แถม 1. crm-points-sync v13–v15: ers_config.breaks rule-break rows + LINE-tap check (c40_no_tap / tap_no_c40). Lessons: `day` is a reserved word as a column alias; postgres.js `${JSON.stringify(x)}::jsonb` double-encodes (cast via ::text::jsonb). First live run: 144 weekday 2 แถม 1 bills (ERS still runs it daily), 3 to non-members, 14 member bills ≥ ฿100 with 0 points and no redemption, 1 LINE tap without a POS discount (Point's 23 Nov test).
- 2026-11-25 — Point: the 2PM coupon stays usable every day incl. weekends, but never on the same bill as 2 แถม 1 — the customer picks one (weekend bills with the coupon earn no new coupon). Template 16 detail now says "ใช้คู่กับ 2 แถม 1 ไม่ได้ (เลือกอย่างใดอย่างหนึ่ง)" (admin_log 95); Final rules weekend afternoon cell = "เลือก 1 อย่าง". Rule break c40_w21 flags any bill with both.
- 2026-11-25 — Point: the 40% coupon discounts mains only, never a set. Template 16 renamed "ลด 40% จานหลัก 1 จาน" + ers_hint/detail updated (admin_log 96); Final rules updated; new rule break c40_set (crm_points_push.py) flags a coupon discount on a set line. Point then edited rule 33 himself (admin_log 100): earns on full-price MAINS only (sets no longer earn), and branch_ids = [6] ParkSilom = a PILOT (Point confirmed). His save also cleared days; he had no preference, so Claude restored Mon–Fri (admin_log 101). Coupons earned at ParkSilom are usable at any branch (template has no branch limit). Final rules shows the rule's branches from rules_data.
