# Recommendation Engine & Suggestion Layer

Two decision-support mechanisms built in migration 0007. Both are deterministic SQL —
every suggestion can be traced back to the exact bills and thresholds that produced it.

## 1. Set-menu recommendation engine

**Question it answers:** "Which items should I bundle into a set, at what price, aimed where?"

### Pipeline

```
bills (90d) ─▶ v_item_affinity ─▶ v_set_candidates ─▶ ranked suggestions
                (pair statistics)   (score + price + target + rationale)
```

**Step 1 — affinity (`marts.v_item_affinity`).** For every item pair over the last 90 days
of data (Sets excluded, min 20 shared bills):
- `support` = share of all bills containing both items
- `confidence(a→b)` = of bills with item a, share that also had b
- `lift` = observed co-occurrence ÷ expected-if-independent. **Lift > 1 means customers
  actively combine these**; lift ≈ 1 is coincidence. Verified in testing: independently
  ordered items score exactly 1.0 and are filtered out.

**Step 2 — candidates (`marts.v_set_candidates`).** 
- **Anchor**: top-10 main dishes by units (a set must be carried by a high-traffic dish).
- **Companion**: an add-on item (drink/snack/dessert) with lift ≥ 1.1 to the anchor.
- **Price**: à-la-carte sum × 0.88, floored to a ฿5 charm price.
- **Margin guard**: combined `food_cost_pct` computed when unit costs exist — reject/flag
  candidates above ~45%.
- **Target**: the channel with the lowest add-on attachment (the measured revenue gap,
  per deck p.20–23) — that's where the set earns incremental money instead of repackaging.
- **Score** = lift × ln(1 + shared bills) × anchor-traffic weight. Transparent, monotone,
  no magic.
- Every row carries a plain-language `rationale`.

### Closing the loop
When a set launches: register its recipe in `core.set_component` and the launch in
`core.plan_campaign`. Then:
- `marts.v_set_cannibalization` — component à-la-carte volume before vs after launch
  (did the set create new revenue or repackage old revenue?)
- `marts.v_campaign_uplift` — total sales vs baseline during the set campaign.

## 2. Suggestion / insight layer

**Question it answers:** "What is bad → do this. What is good → do this. What can be
amplified → do this."

### Mechanism
`ops.generate_insights()` runs nightly (pg_cron `marketing-insights`, 09:15 Bangkok).
Each rule is a SQL condition over the marts + an action template. Results land in
`ops.insights` (deduped per rule × entity × period), surfaced via `marts.v_insights`
on the dashboard Suggestions page, and the top items go into the LINE digest.

### Rule catalog (v1)

| Rule | Status | Fires when | Action template |
|---|---|---|---|
| sales_slump | bad | branch < baseline −15% on ≥3 of last 7 days | check ops first, then daypart promo + competitor scan |
| sales_surge | good | branch > baseline +20% on ≥3 of last 7 days | find the driver, repeat deliberately, secure stock/staff |
| attachment_drop | bad | channel attachment −3pts vs prior 4 weeks | re-brief upsell / fix storefront add-on visibility |
| set_opportunity | amplify | top-ranked set candidate exists | launch the set, register for measurement |
| rising_item | amplify | item units +20% vs prior 4 weeks (min volume) | feature in content batch, pin higher on delivery |
| menu_tail | bad | ≥15 items produce the last 5% of sales | apply the agency curation rule (deck p.58) |
| payday_pattern | amplify | payday lift > 15% | premium pushes on payday, discounts mid-cycle |
| peak_saturated | amplify | branch-hour near capacity ≥60% of weekdays | shift demand off-peak instead of promoting into a full house |
| review_theme_spike | bad | complaint theme 2× prior month, ≥3 mentions | route to ops with review texts, reply, re-check |

The catalog grows as feeds arrive (budget overrun, content-lift, CPO-drift rules come
with phases 5–6). A weekly Claude narrative pass over `ops.insights` is planned as a
layer on top — the rules stay the auditable source of truth.

## 3. Group A+B analytics added alongside (same migration)

| View | What it answers |
|---|---|
| `v_payday_effect` / `v_holiday_effect` | real lift per payday window / per named holiday |
| `v_hour_dow` | full hour × day-of-week grid per branch |
| `v_pareto` | ABC classification, cumulative revenue share |
| `v_peak_saturation` | which branch-hours run at capacity (promo waste detector) |
| `v_void_discount_trend` | void rate, discount depth per branch-month |
| `v_ramp_curve` | weekly sales by weeks-since-open (new-branch reference) |
| `v_payment_mix` | cash/QR/card mix (tourist proxy) — needs `payment_method` from POS |
| `v_price_change_impact` | qty/day 28d before vs after every logged price change |
| `v_price_position` | own vs competitor median menu price × rating |
| `v_set_cannibalization` | set launch vs component à-la-carte volume |

New inputs these rely on: `core.price_change` (log every price change),
`core.set_component` (set recipes), `raw.competitor_menu_items` (scraped competitor
menus), and POS fields `payment_method` / `is_voided` (nullable — work without them).
