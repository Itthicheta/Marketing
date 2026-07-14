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
| Supabase project | **Marketing** — ref `qtpwrwapbefczvqdfzes`, region ap-southeast-1. (Do NOT touch `mamapook-planner` — that's the separate production-planning project.) |
| Migrations applied | 0001–0005 applied and verified (36 tables, seeded dims incl. 2,557-day calendar). |
| Migration 0006 (RLS lockdown) | **In repo, NOT applied — awaiting owner approval.** Enables RLS on all tables with no policies (public keys blocked; service role unaffected). |
| Dashboard | Not started (phase 4). Page map in `docs/03-system-design.md`. |
| Ingestion | No feeds connected yet. `core.load_pos(from, to)` transform function is ready and tested. |
| Alerts | Rules seeded in `ops.alert_rules`; check functions deployed. pg_cron NOT scheduled yet; LINE Edge Function not built (needs LINE OA credentials). |
| GitHub ↔ Supabase | Not connected; not required. Migrations are applied via the Supabase integration from Claude sessions. |

## Where things are

- `docs/01-agency-report-catalog.md` — page-by-page inventory of the 77-page agency deck
- `docs/02-metrics-catalog.md` — all 35 metrics with formulas (note the add-on denominators from deck p.21)
- `docs/03-system-design.md` — architecture, ingestion plan, alert rules, dashboard page map, roadmap
- `docs/04-gap-analysis.md` — inventory by category + tiered gaps for further analysis
- `supabase/migrations/` — 0001 raw+ops, 0002 dims+seeds, 0003 facts+plans, 0004 metric views, 0005 alerts, 0006 RLS (pending)

## Key design rules (do not violate)

1. Dashboard reads **only** `marts.*`. All calculations live in SQL views, defined once.
2. `raw` is append-only; `core` is always rebuildable from `raw` (see `core.load_pos`).
3. Add-on metrics: % attachment divides by ALL bills; units-per-bill divides by bills WITH add-on; Set items excluded (deck p.21 methodology).
4. Main dish = Signature, Noodles, Rice, Gaolao. OCC has no delivery channel.
5. LINE alerts use the **Messaging API** (LINE Notify is discontinued).
6. New POS item names must be mapped in `core.map_item_name`; unmapped ones show in `marts.v_unmapped_items`.

## Blocked on owner input

- [ ] Approval to apply migration 0006 (RLS lockdown)
- [ ] POS vendor + daily export format (file/API? item-level? customer identifier? delivery-platform field?)
- [ ] Detailed menu + cost file → populate `core.dim_menu_item` (unlocks menu engineering)
- [ ] LINE OA channel ID + access token (alerts, then OA webhook)
- [ ] Meta / TikTok API tokens; Google Places API key
- [ ] Competitor list (names, social handles, Google Maps place IDs) → `core.dim_competitor`
- [ ] Accounting system name/access for the marketing-spend automation

## Next phases (from docs/03 roadmap)

3. POS ingest Edge Function + backfill; schedule pg_cron checks; menu master load
4. Dashboard v1 on Cloudflare Pages (Overview, Dayparts, Menu, Basket)
5. Accounting spend automation → ROI/budget pages
6. Social APIs + listings/reviews ingest + Claude enrichment → Social/Reputation pages
7. LINE OA webhook + `send-line-alerts` Edge Function + daily digest
8. Competitor scraping; CRM link (repeat rate, RFM); Tier-1 gap views (item affinity, discount effectiveness, targets/pace, share of voice)

## Change log (append-only)

- **2026-07-14** — Screened the 77-page agency deck into docs/01–03; built and locally validated
  migrations 0001–0005; applied them to Supabase project `qtpwrwapbefczvqdfzes`; added 0006 RLS
  lockdown (unapplied, pending approval); added docs/04 gap analysis; created this handoff.
  Branch: `claude/marketing-model-supabase-aikp7e`.
