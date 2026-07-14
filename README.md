# MamaPook Marketing Model

Marketing data warehouse, metrics engine, dashboard, and alerting for MamaPook restaurant
(branches: Rama9, Silom, Gaysorn, OCC). Reverse-engineered from the LyftUp Partners
performance report so the agency's analysis regenerates automatically from daily data feeds.

## What this does

- **Supabase (Postgres)** holds the model: raw feeds → cleaned facts/dimensions → metric views.
  All calculations (ABS, add-on attachment, daypart profiles, ROI, CPO, baselines, uplift,
  menu engineering) are defined once in SQL; every data refresh updates every number.
- **Data inputs:** POS (daily), accounting marketing spend, own social APIs (FB/IG/TikTok/LINE OA),
  Google Maps + delivery platform listings & reviews, competitor social scraping,
  manual budget / promo / content calendar.
- **Dashboard:** HTML on Cloudflare Pages, reading only the `marts` schema.
- **Alerts:** pg_cron checks → LINE Messaging API push (data late, sales anomaly vs baseline,
  bad review, rating drop, competitor promo) + daily 09:00 digest.

## Repo map

| Path | Contents |
|---|---|
| `docs/01-agency-report-catalog.md` | Page-by-page inventory of the 77-page agency deck (every table, chart, metric, framework) |
| `docs/02-metrics-catalog.md` | All 35 metrics with exact formulas, grains, and deck references |
| `docs/03-system-design.md` | Architecture, ingestion plan, alert rules, dashboard page map, roadmap, open items |
| `supabase/migrations/0001_schemas_raw_ops.sql` | Schemas; raw landing tables (POS, accounting, social, listings, reviews, LINE); ingestion log; alert rules |
| `supabase/migrations/0002_core_dimensions.sql` | Dimensions + seeds: branches, channels, calendar (holidays/paydays/day-type), categories, add-on subcategories, menu master & name mapping, noodle types, cost types, platforms, content pillars, competitors |
| `supabase/migrations/0003_core_facts_plans.sql` | Facts: bills/lines (+ basket stats), marketing spend, ad performance, social snapshots/posts, listings, reviews; plans: budget, campaigns, content calendar; CRM-ready customer dim |
| `supabase/migrations/0004_marts.sql` | Metric views — one per dashboard component, mirroring the agency report pages |
| `supabase/migrations/0005_alerts_freshness.sql` | Alert checks, dedup/cooldown queue, daily digest, pg_cron schedule notes |

## Status

Phases 1–2a done: schema + metric definitions + docs in this repo, and migrations 0001–0005
applied to the Supabase project **Marketing** (`qtpwrwapbefczvqdfzes`, ap-southeast-1).
Migration 0006 (RLS lockdown) is in the repo pending owner approval. See
`docs/03-system-design.md` → Roadmap and Open items for what's needed next
(POS export format, menu & cost master, API credentials).
