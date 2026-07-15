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
