# System Design — MamaPook Marketing Model on Supabase

## Architecture

```
POS (daily)  ────────────┐
Accounting (daily) ──────┤        ┌────────────────────────────── Supabase ──┐
Meta/TikTok/LINE APIs ───┼──▶ raw │ raw ─▶ core (dims + facts) ─▶ marts (views)│
Google/Grab/LINE MAN ────┤        │  ops: ingestion_log · alert_rules · alerts │
Competitor scraping ─────┘        └───────────────┬──────────────┬────────────┘
Manual inputs (budget,                            │              │
content & promo calendar)              Cloudflare Pages     pg_cron + Edge Fn
                                       dashboard (HTML,     ─▶ LINE Messaging
                                       reads marts only)       API push alerts
```

Four Postgres schemas:

| Schema | Purpose | Mutability |
|---|---|---|
| `raw` | Landing zone, one table per source, append-only, keeps original payload (jsonb) | never updated, only inserted |
| `core` | Cleaned dimensions + facts; all business rules applied here | rebuilt/backfilled from raw at any time |
| `marts` | Metric views/materialized views, one per dashboard component — mirrors the agency report pages | pure SQL, no stored data except matviews |
| `ops` | ingestion_log, alert_rules, alert_log, data-freshness checks | operational |

Design rule: **the dashboard reads only `marts.*`**. Calculations live in SQL once; every data feed refresh updates all numbers automatically (the user's "do it once" requirement).

## Data sources & ingestion

| Source | Method | Frequency | Lands in |
|---|---|---|---|
| POS bills + lines | daily export → Edge Function `ingest-pos` (or direct DB insert) | daily | raw.pos_bills, raw.pos_bill_lines |
| Accounting (marketing costs) | automation pulls expense lines tagged as marketing | daily/weekly | raw.accounting_expenses |
| Own social (FB/IG via Meta Graph API, TikTok API) | Edge Function `ingest-social`, scheduled | daily | raw.social_posts, raw.social_profile_snapshots |
| LINE OA | webhook `line-webhook` Edge Function (messages, follows, coupon usage) + Insights API | realtime + daily | raw.line_events |
| Google Maps (own + competitor) | Places API: rating, count, reviews | daily | raw.listing_snapshots, raw.reviews |
| Grab / LINE MAN listings & reviews | scraper (Cloudflare Worker / scheduled job) | daily | raw.listing_snapshots, raw.reviews |
| Competitor social | public scraping, light-touch | daily | raw.social_posts (is_competitor=true), raw.social_profile_snapshots |
| Review/content enrichment | Claude API: sentiment, theme coding, competitor-promo classification | after each ingest | core.review_analysis, core.post_analysis |
| Budget plan, content & promo calendar, menu master + costs | manual entry (dashboard form or SQL/CSV) | as needed | core.* directly |

Every ingest writes an `ops.ingestion_log` row (source, run started/finished, rows, status). `ops.check_freshness()` runs on pg_cron and raises LINE alerts for late feeds.

## Alerting (LINE Messaging API push — LINE Notify is discontinued)

`ops.alert_rules` (rule key, threshold, severity, cooldown) evaluated by pg_cron → `ops.alert_queue` → Edge Function `send-line-alerts` pushes to the owner's LINE OA. Dedup via cooldown per rule × entity.

Default rules:
1. `pos_data_late` — no POS ingest for > 26 h.
2. `sales_anomaly` — yesterday's branch sales < baseline × 0.7 (baseline = trailing 4-week same-weekday avg, holiday-aware). Also fires upward (> ×1.5) as a positive note.
3. `bad_review` — new review with rating ≤ 2 (includes text + branch + platform).
4. `rating_drop` — listing avg rating drops ≥ 0.2 between snapshots.
5. `competitor_promo` — competitor post classified as promotion/new-menu.
6. `daily_digest` — 09:00 summary: yesterday sales vs baseline per branch, ABS, top item, spend MTD, ROI MTD.

## Dashboard (Cloudflare Pages) — page map

Single-page HTML app reading `marts.*` through a thin API (Cloudflare Worker proxy or Supabase anon key restricted by RLS to marts read-only). Pages mirror the agency deck so the monthly report is generated continuously:

1. **Overview** — sales / transactions / ABS trend by branch (p.4); branch × channel matrices (p.5–8); ROI + spend summary (p.53).
2. **Dayparts** — hour-contribution heatmaps by branch/channel/day-type (p.9–10, 29–30) with peak-window highlights.
3. **Menu & Category** — category × channel and × branch share tables (p.13, 16, 31–32); top-item ranking (p.14); noodle-type mix (p.15, 17); menu-engineering matrix (popularity × margin — needs menu cost input).
4. **Basket & Add-on** — main-dish distribution + combination patterns (p.19, 33); attachment heatmaps per channel and branch benchmark matrix (p.20–26); ABS by basket group (p.24).
5. **Marketing & Campaigns** — budget vs actual (p.56), ROI (p.53), CPO by campaign/test (p.59), promo calendar with measured uplift vs baseline.
6. **Social & Content** — profile growth own vs competitors; post performance; pillar performance; content → item-sales correlation (p.64–75 taxonomy).
7. **Reputation** — ratings by branch × platform over time; review themes trend; latest negative reviews (p.42, 48–51).
8. **Data health** — ingestion log, freshness, alert history.

Visual conventions copied from the deck: column-normalized % tables with red→green heat shading, 100% stacked bars for mix, small-multiple hour lines per branch, clustered WD/WE bars.

## Roadmap

| Phase | Deliverable | Depends on |
|---|---|---|
| 1 (this commit) | Schema + metric views + docs | — |
| 2 | Apply migrations to the Supabase project; seed dims (branches, categories, pillars); menu master load | menu & cost detail from owner; Supabase project choice |
| 3 | POS ingest Edge Function + first backfill; freshness alerts live | POS export format |
| 4 | Dashboard v1 (Overview, Dayparts, Menu, Basket) on Cloudflare Pages | phase 3 |
| 5 | Accounting spend automation; ROI/budget pages | accounting system access |
| 6 | Social APIs + Google/Grab/LINE MAN listing & review ingest; Claude enrichment; Reputation + Social pages | API tokens |
| 7 | LINE OA webhook + Messaging API alerts + daily digest | LINE OA channel credentials |
| 8 | Competitor scraping; CRM link (customer identity → repeat rate, RFM) | CRM go-live |

## Open items (need owner input)

- POS vendor + export format (file/API? item-level lines? any customer identifier?).
- Menu master with costs (promised — enables margin & menu engineering).
- Which Supabase project/org to deploy to.
- LINE OA channel ID + access token; Meta/TikTok API tokens; Google Places API key.
- Competitor list (names + social handles + Google Maps place IDs).
- Accounting system name for the spend automation.
