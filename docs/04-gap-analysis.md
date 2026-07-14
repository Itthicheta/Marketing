# System Inventory & Gap Analysis

Part 1: everything the system contains (deck-derived + agreed additions), grouped by category.
Part 2: gaps for further analysis, tiered by effort.

## Part 1 — Inventory by category

### A. Sales performance (POS)
- `core.fact_bill`, `core.fact_bill_line` — receipt/line grain, everything derives from here
- Sales / Transactions / ABS trio (deck p.4-8) — branch & channel health
- Average sales per day (p.53) — month-length and branch-open-date corrected
- Channel contribution % (p.5-8) — channel dependence per branch
- Daypart profiles: hour contribution %, ABS by hour (p.9-10, 29-30) — peak/dead windows
- Weekday/weekend splits (p.28-33) — office vs family demand patterns

### B. Menu & category intelligence
- `dim_category` (8 + main-dish/add-on flags), `dim_menu_item` (SKU master), `map_item_name`
  (raw POS name normalization), `dim_noodle_type` (modifier preference)
- Category mix by channel/branch/day-type (p.13, 16, 31-32)
- Menu ranking with per-channel share (p.14); noodle-type mix (p.15, 17)
- Menu engineering matrix — popularity x margin (needs cost file)

### C. Basket & combination behavior
- Per-bill basket stats: main-dish count, add-on units (Set-excluded), combo pattern
- Basket distribution + combination patterns (p.19, 33) — Set design input
- Add-on attachment: % with add-on, units/bill, by subcategory (p.20-26, methodology p.21)
- ABS by basket group x branch (p.24)

### D. Marketing finance
- `plan_budget`, `fact_marketing_spend`, `fact_ad_performance`, `plan_campaign`
- ROI = sales / spend; budget vs actual (p.53, 56)
- CPO + ROAS by campaign/audience/day (p.59 A/B framework)
- Campaign uplift vs baseline (deck implies, never computes)

### E. Content & social
- `plan_content` (calendar + 2-level creative brief, p.66-75), `fact_social_post`,
  `fact_social_snapshot`, `dim_content_pillar` (7 pillars, p.64)
- Follower growth, engagement rate — own vs competitor
- Content -> item-sales impact (7d pre/post window); pillar performance

### F. Reputation & journey
- `fact_review` (+ Claude sentiment/theme enrichment), `fact_listing_snapshot`, `dim_competitor`
- Ratings trend per branch x platform (p.42, 50); review theme trends (p.48-51)

### G. Foundations & ops
- `dim_date` with weekday/weekend, Thai holidays, payday windows, event tags
- Baseline: trailing 4-week same-weekday, holiday-aware — anomaly & uplift reference
- `ops.ingestion_log` + freshness checks; alert rules/queue -> LINE; unmapped-items view

## Part 2 — Gaps

### Tier 1 — pure SQL on incoming data (fold into phase 3)
1. Item-level market-basket affinity (item->item lift), sharper than category combos
2. Discount effectiveness: % bills discounted, depth vs ABS change, margin give-away
3. `plan_targets` (monthly target per branch) + pace-vs-target view
4. Share-of-voice views: posting frequency, engagement, rating gap vs each competitor

### Tier 2 — one new field or feed
5. Delivery platform split (Grab vs LINE MAN) + net-of-commission revenue — needs platform
   field from POS and commission rates
6. Coupon/promo-code registry linked to bills — closed-loop attribution pre-CRM
7. Bitly short links + QR per campaign; click/scan data into `fact_ad_performance`
8. Daily weather feed — improves baseline, explains delivery/dine-in swings

### Tier 3 — arriving systems (design for now)
9. Customer analytics via CRM + LINE OA: repeat rate, frequency, RFM, cohorts, CLV,
   new-vs-returning per campaign (`dim_customer` already in schema)
10. Demand forecast (baseline + holiday/payday/weather factors, per item per branch)
    feeding the mamapook-planner production system
11. Ad-platform APIs (Meta/TikTok/Google) for daily spend/results instead of month-end accounting
12. Menu lifecycle: Set-launch adoption curves + cannibalization vs a-la-carte

Recommended order: Tier 1 with phase 3; coupon registry + platform field shaped by the POS
export; forecast->planner once a few months of clean data exist.
