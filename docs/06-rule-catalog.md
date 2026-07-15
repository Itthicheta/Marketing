# Suggestion-Layer Rule Catalog

Owner-approved 2026-07-14. The master list of insight rules for `ops.generate_insights()`
(+ `ops.check_set_verdicts()`), run nightly via `ops.run_insights()` (pg_cron 09:15 Bangkok).

**Design principles (hold for every future rule):**
1. Every rule names its **counterfactual** — vs baseline, vs prior period, vs plan. Never "feels low".
2. Every rule ends in **one verb** someone can do this week.
3. Thresholds live in this table; tune here, then update the SQL to match.

Status legend: ✅ implemented · 🔜 implementable on POS data (phase 3) · ⏳ waits on a feed.

## Sales & demand

| # | Rule key | St. | Trigger (threshold) | Action | State |
|---|---|---|---|---|---|
| 1 | sales_slump | bad | branch < baseline −15% on ≥3 of last 7 days | check ops first; if clean, daypart promo + competitor scan | ✅ |
| 2 | sales_surge | good | branch > baseline +20% on ≥3 of last 7 days | identify driver, repeat deliberately, secure stock/staff | ✅ |
| 3 | daypart_erosion | bad | one daypart −10%+ for 3 consecutive weeks while branch total holds | targeted daypart action, not blanket promo | 🔜 |
| 4 | channel_divergence | bad | one channel −15% vs its baseline while branch total holds | storefront/platform check (visibility, downtime, ranking) | 🔜 |
| 5 | daytype_flip | amplify | branch weekday:weekend ratio shifts >10pts over 4 weeks | revisit that branch's target-segment plan (deck p.54) | 🔜 |
| 6 | payday_pattern | amplify | payday lift > 15% over ≥6 observed windows | premium pushes on payday; discount mid-cycle instead | ✅ |
| 7 | holiday_playbook | amplify | after each holiday: record lift vs baseline | pre-load next year's calendar action from history | 🔜 |
| 8 | peak_saturated | amplify | branch-hour ≥85% of its p95 on ≥60% of weekdays | shift demand (pre-order, off-peak pricing); don't advertise into a full house | ✅ |

## Basket & menu

| # | Rule key | St. | Trigger | Action | State |
|---|---|---|---|---|---|
| 9 | attachment_drop | bad | channel attachment −3pts vs prior 4 weeks | re-brief upsell / fix storefront add-on visibility & stock | ✅ |
| 10 | set_opportunity | amplify | top-ranked candidate in v_set_candidates | launch at suggested price on target channel; register recipe + campaign | ✅ |
| 11 | set_verdict | good/bad | 28+ days post-launch: family ΔGP/day ≥ 0 → good; < 0 → bad | scale ‖ reprice / swap companion / kill (see docs/05 step 7) | ✅ |
| 12 | rising_item | amplify | item units +20% vs prior 4 weeks (≥100 units) | feature in content (Appetite Appeal pillar), pin on delivery | ✅ |
| 13 | falling_star | bad | A-class item −15% units for 3 consecutive weeks | investigate quality/photo/price before it becomes a review theme | 🔜 |
| 14 | menu_tail | bad | ≥15 C-class items (last 5% of sales) | curate delivery storefront per deck p.58 (fold into variants / dine-in only) | ✅ |
| 15 | revival_candidate | amplify | slow item with margin ≥55% + visibility signature (lift ≥1.3) | bundle with a hero anchor (revival class) or dedicate a content piece | ✅ (class in engine; standalone insight 🔜) |
| 16 | price_change_verdict | good/bad | 28 days after logged change: margin gain vs quantity response | keep ‖ roll back; log verdict on the price_change row | 🔜 |
| 17 | discount_creep | bad | discount depth +2pts vs trailing 3-month norm with no registered campaign | find the unmanaged discounting; register or stop it | 🔜 |
| 18 | void_spike | bad | branch void rate > 2× its trailing norm | ops/training investigation | 🔜 |

## Marketing money (accounting + ads feeds)

| # | Rule key | St. | Trigger | Action | State |
|---|---|---|---|---|---|
| 19 | budget_overrun | bad | actual > 110% of plan AND month ROI < trailing 3-month median | pause spend, reallocate to what's working | ⏳ phase 5 |
| 20 | cpo_drift | bad | CPO rising 3 consecutive weeks on a platform | refresh creative/audience per the A/B matrix (deck p.59) | ⏳ phase 5 |
| 21 | campaign_verdict | good/bad | campaign end: uplift ÷ spend vs target | repeat / adjust / retire — written back to the campaign record | ⏳ phase 5 |
| 22 | underspend | bad | <40% of monthly plan deployed by day 15 | deploy or formally release the budget | ⏳ phase 5 |

## Content & social (social API feeds)

| # | Rule key | St. | Trigger | Action | State |
|---|---|---|---|---|---|
| 23 | post_outperformer | amplify | engagement > 2× account trailing median | boost it, plan a sequel, credit the pillar | ⏳ phase 6 |
| 24 | pillar_fatigue | bad | a pillar's engagement declining across its last 3 posts | rotate pillars in next batch | ⏳ phase 6 |
| 25 | posting_gap | bad | no post in 7 days on an active channel | publish the next planned calendar item | ⏳ phase 6 |
| 26 | content_sales_hit | amplify | post's focus item shows >15% 7-day sales lift vs pre-post week | repeat format; scale the approach to sibling items | ⏳ phase 6 |

## Reputation & competitors (reviews / scraping feeds)

| # | Rule key | St. | Trigger | Action | State |
|---|---|---|---|---|---|
| 27 | review_theme_spike | bad | theme mentions ≥3 and >2× prior month | route to ops with review texts; reply; re-check in 2 weeks | ✅ (fires when reviews flow) |
| 28 | rating_gap | bad | competitor rating overtakes yours on a platform | review-request push at POS/LINE OA; fix top theme | ⏳ phase 6 |
| 29 | competitor_promo | amplify | competitor post classified as promo/new menu | assess match-or-ignore; log their move | ✅ as alert; insight version ⏳ |
| 30 | price_position_drift | bad | own median price rises above rating-tier trend vs competitor map | value-perception risk — justify via content or adjust | ⏳ phase 8 |

## Data health

| # | Rule key | St. | Trigger | Action | State |
|---|---|---|---|---|---|
| 31 | feed_late / unmapped_growth | bad | POS >26h late; unmapped item names >2% of sales | fix pipeline / add map_item_name rows before trusting the week's insights | ✅ alert; Suggestions-page surface 🔜 |

## Delivery pipeline

- 🔜 rules (3,4,5,7,13,15-standalone,16,17,18,31-surface) ship with phase 3, once real POS
  data lets thresholds be sanity-checked against actual variance.
- ⏳ rules activate automatically as each feed lands (phases 5–8); their SQL is written
  against views that already exist.
- Weekly Claude narrative pass over `ops.insights` (a readable "this week" summary for
  LINE) layers on top later; the rules stay the auditable source of truth.
