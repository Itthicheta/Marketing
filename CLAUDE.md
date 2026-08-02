# Marketing — project instructions

MamaPook restaurant marketing data warehouse + metrics engine on Supabase, with a
Cloudflare-hosted dashboard and LINE alerts. **Read `HANDOFF.md` first** — it holds the
current state, what's deployed, what's pending, and the append-only change log.

## Database

- Supabase project: **Marketing** (`qtpwrwapbefczvqdfzes`, ap-southeast-1).
- This project owns schemas **`raw`, `core`, `marts`, `ops`** only.

## Hard boundaries — never violate

1. NEVER read, modify, or drop anything in the **`operation_log`** schema — that belongs to
   the separate Operation Log project. Marketing and Operation Log share one Supabase
   database but never touch each other's schemas.
2. NEVER touch the `mamapook-planner` Supabase project — separate production-planning system.
3. Prefix Marketing cron jobs `marketing-`, edge functions/buckets `marketing-`.

## Key design rules (full list in HANDOFF.md)

0. Set-menu decisions use the **incremental-GP framework** (docs/05): attacher gain vs.
   cannibalization; verdicts from `marts.v_set_pnl`, never revenue alone. Insight rules
   name a counterfactual and end in one action verb (docs/06).
1. The dashboard reads **only** `marts.*`. All calculations live in SQL views, defined once.
2. `raw` is append-only; `core` is always rebuildable from `raw` (see `core.load_pos`).
3. Add-on metrics: % attachment ÷ ALL bills; units-per-bill ÷ bills WITH add-on; Sets excluded.
4. Main dish = Signature, Noodles, Rice, Gaolao. OCC has no delivery channel.
5. LINE alerts use the **Messaging API** (LINE Notify is discontinued).
6. Map new POS item names in `core.map_item_name`; unmapped ones surface in `marts.v_unmapped_items`.

## Workflow

- Migrations live in `supabase/migrations/`; validate locally, then apply to Supabase.
- Update `HANDOFF.md` (state + append-only change log) with every change.
- Docs: `docs/01`–`06` (report catalog, metrics, system design, gap analysis, set engine,
  rule catalog). Dashboard in `dashboard/`.
