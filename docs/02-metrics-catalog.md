# Metrics Catalog — Marketing Model

Every metric the system computes, with its exact formula, grain, and source. These definitions are
implemented as SQL views in `supabase/migrations/0004_marts.sql` so the dashboard never re-computes
anything — all charts read finished numbers.

## Core sales metrics (POS)

| # | Metric | Formula | Grain / dimensions | Deck ref |
|---|--------|---------|--------------------|----------|
| 1 | Sales | Σ line net amount | any: branch, channel, date, hour, category, item | p.4–8 |
| 2 | Transactions (Bills) | count(distinct bill) | same | p.4, 6 |
| 3 | ABS — Average Basket Size | Sales ÷ Bills (THB/bill) | branch × channel × period × hour | p.7, 10, 24, 28 |
| 4 | Average Sales per Day | period sales ÷ open days in period | branch × month | p.53 |
| 5 | Channel contribution % | channel sales ÷ branch total sales | branch × channel; sums to 100% per branch | p.5–6, 8 |
| 6 | Hour contribution % | hour sales ÷ series total sales | series = branch/channel/day-type; sums to 100% per series | p.9, 29–30 |
| 7 | Category share % | category sales ÷ channel (or branch) total | category × channel; category × branch | p.13, 16, 31–32 |
| 8 | Menu item share % + rank | item sales ÷ channel total; rank desc | normalized item × channel | p.14 |
| 9 | Noodle-type mix % | noodle-modifier qty ÷ total noodle qty | noodle type × channel / branch | p.15, 17 |
| 10 | Day-type split | metrics 1–3 averaged per day | branch × weekday/weekend | p.28, 33 |

## Basket-composition metrics (bill-level)

Main dish = item in {Signature, Noodles, Rice, Gaolao}. Add-on = item in {Beverages, Snacks, Desserts}
with subcategory ∈ {soft drink/water, brewed drink, fried, general, sides, share, dessert}.
**All add-on metrics exclude bills' Set items (deck rule, p.20 footnote).**

| # | Metric | Formula | Grain | Deck ref |
|---|--------|---------|-------|----------|
| 11 | Main dishes per bill | Σ main-dish qty per bill, bucketed 0,1,2,…,10,11+ | bill → distribution by branch/channel/day-type | p.19, 33 |
| 12 | Combination pattern | ordered multiset of main-dish categories per bill (e.g. "Signature x1 + Noodles x1"); top-N share within each main-dish-count group | bill patterns × main-dish count | p.19 |
| 13 | % bills with add-on (attachment rate) | bills with ≥1 add-on ÷ **all** bills | main-dish-count group × channel / branch | p.20–23, 25 |
| 14 | Add-on units per bill | Σ add-on units ÷ bills **with** add-on ← note denominator | same | p.21 (methodology) |
| 15 | Add-on units per bill, by subcategory | Σ subcategory units ÷ bills with add-on | subcategory × group × channel / branch | p.20–23, 26 |
| 16 | Add-on units per main dish | Σ add-on units ÷ Σ main-dish units | same | p.20, 25 |
| 17 | ABS per main dish | bill ABS ÷ main-dish count | main-dish-count group × branch | p.24 |
| 18 | % of sales by basket group | group sales ÷ branch sales | main-dish-count group × branch | p.24 |

## Marketing finance metrics (accounting + ad platforms)

| # | Metric | Formula | Grain | Deck ref |
|---|--------|---------|-------|----------|
| 19 | Marketing spend | Σ spend by cost type (influencer fee, influencer budget, social ads, Google ads, delivery-platform ads) | cost type × month | p.53, 56 |
| 20 | Marketing ROI | Sales ÷ Total marketing spend (×) | month, optionally branch/channel | p.53 |
| 21 | Budget vs actual | actual spend ÷ planned budget | cost type × month | p.56 |
| 22 | Ads budget proportion | platform budget ÷ total ads budget (%) | ad platform | p.57 |
| 23 | CPO — Cost per Order | ad spend ÷ attributed orders (THB/order) | campaign × audience × day — the deciding metric of the A/B framework | p.59 |
| 24 | Promo/campaign uplift | actual sales − baseline (see #31) during campaign window | campaign × branch/channel | added (deck implies, never computes) |

## Social, content & reputation metrics (APIs + scraping)

| # | Metric | Formula | Grain | Deck ref |
|---|--------|---------|-------|----------|
| 25 | Profile snapshot | followers, following, post count, total likes | platform × account (own + competitor) × date | p.37–41 |
| 26 | Post performance | reach, impressions, views, likes, comments, shares, saves; engagement rate = engagements ÷ reach (fallback ÷ followers) | post × platform | p.5 (user goal) |
| 27 | Content → sales link | sales of the post's `menu focus` item(s) in the 7 days after posting vs 7-day pre-post baseline | post × menu item | user requirement #5 |
| 28 | Pillar performance | avg engagement rate and linked-sales uplift by content pillar | 7-pillar taxonomy | p.64, 66–75 |
| 29 | Listing rating | platform avg rating + rating count | branch × platform (Google, Grab, LINE MAN) × snapshot date | p.42, 50 |
| 30 | Review themes | count/share of reviews per coded theme (taste-sweet, off-smell, portion-value, consistency, packaging, service, wait time…) + avg rating per theme; sentiment score | branch × platform × month | p.48–51 |

## Baseline & alerting metrics (system additions)

| # | Metric | Formula | Purpose |
|---|--------|---------|---------|
| 31 | Expected sales baseline | trailing 4-week average for same branch × channel × weekday (holiday-aware via dim_date) | anomaly detection, uplift measurement |
| 32 | Sales anomaly score | (actual − baseline) ÷ baseline | LINE alert when below threshold (default −30%) |
| 33 | Data freshness | hours since last POS/accounting/social ingest per source | LINE alert when late (default > 26 h for POS) |
| 34 | Review alert | any new review with rating ≤ 2, or listing avg drops ≥ 0.2 | LINE alert |
| 35 | Competitor signal | competitor post classified as promo/new-menu launch | LINE digest |

## Dimension notes

- **dim_date** carries: day type (weekday/weekend), day of week, day of month, month, Thai public holiday flag, payday flag (1st/15th/month-end window), custom event tags — the "extra factors" for pattern analysis (user requirement #3).
- **dim_menu_item** carries the raw-name → normalized-name → SKU-code → category mapping (deck p.14), plus flags: is_main_dish, is_addon (+ subcategory), is_set, is_signature, and — once menu/cost detail is provided (user requirement #6) — unit cost and price for margin & menu-engineering (popularity × margin matrix).
- **Branch rules:** OCC has no Delivery channel; branches have open_date (OCC opened month 5) — per-day averages must divide by days actually open.
