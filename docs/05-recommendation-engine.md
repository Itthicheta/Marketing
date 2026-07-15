# Set-Menu Recommendation Engine — finalized logic (v2)

Owner-approved 2026-07-14. Implemented in `supabase/migrations/0008_set_engine_v2.sql`
(`marts.v_set_candidates`, `marts.v_set_pnl`). The suggestion-layer rule catalog lives in
`docs/06-rule-catalog.md`.

**Design goal (owner's framing):** a set must increase both revenue AND gross profit.
Revenue up + GP down means the bundle discount leaked to customers who would have paid
full price — cannibalization beat incrementality. Every step below exists to predict
that outcome before launch and measure it after.

## Step 0 — Inputs
Last 90 days of bill lines (window anchored to the newest data date, so backfills work);
menu master with `price` and `unit_cost`. Without costs, steps 4–5 return NULL and
ranking falls back to the behavioral score — the engine degrades gracefully, never guesses.

## Step 1 — Pair statistics (`marts.v_item_affinity`)
For item pair (a,b): N = all bills, n_a / n_b = bills with each item, n_ab = bills with both.
- support = n_ab / N
- confidence(a→b) = n_ab / n_a
- **lift = n_ab·N / (n_a·n_b)** — co-occurrence vs chance. Lift ≈ 1 is coincidence and is
  rejected; candidates need lift ≥ 1.1 and n_ab ≥ 20 (no small-sample ghosts).

## Step 2 — Candidate generation (two classes)
- **`attachment`** — anchor: top-10 main dish by traffic (a set must ride demand);
  companion: an add-on item (drink/snack/dessert). The profit workhorse: add-ons are
  cheap to make, so attaching them is nearly pure incremental margin.
- **`revival`** — companion is a *slow* item (bills below menu median) that earns its
  seat with BOTH: margin ≥ 55% AND the **visibility signature** (lift ≥ 1.3 with the
  anchor despite low volume → the people who find it love pairing it → bundling fixes
  discoverability). Slow items with flat lift everywhere are an *appeal* problem —
  they go to the menu-tail curation rule, never into a bundle (a bad companion
  devalues the hero anchor).
- (Group Sets — multiple mains for tables/sharing — are a share-of-wallet play judged
  manually from the combination-pattern views, not scored by this engine.)

## Step 3 — Pricing
list_sum = anchor price + companion price → **suggested_price = list_sum × 0.88,
floored to a ฿5 charm price** → discount D = list_sum − suggested_price.
The 12% depth is a starting default; Step 5 shows when it must be shallower.

## Step 4 — Margin math (needs the cost file)
- set margin = suggested_price − cost_anchor − cost_companion
- **food-cost guard**: (cost_a + cost_b) ÷ suggested_price ≤ 45%, else `fails_margin_guard`.

## Step 5 — The decision number: projected incremental gross profit
Two populations from the same 90 days:
- **P (potential attachers)** = bills with anchor but WITHOUT companion — the market
  the set is aimed at
- **E (existing pairers)** = bills already containing both — the cannibalization exposure

Per converted attacher, gain **g = suggested_price − anchor_price − cost_companion**
(they pay more than anchor-alone; the only extra cost is the companion).
Per switching pairer, loss = **D** (they'd have paid the full sum). Worst case assumes
all E switch. With adoption rate α of P:

> **Projected ΔGP = α·P·g − E·D**
> **Break-even adoption α\* = (E·D) ÷ (P·g)**

Interpretation: α\* is "what share of anchor-only buyers must upgrade before the set
stops losing money." Low α\* (a few %) = safe; high α\* = the discount leaks faster than
attach can recover — shrink D or pick a cheaper/higher-margin companion.

Worked example: S1 ฿89/cost ฿32 + drink ฿25/cost ฿8.
At 12% off → set ฿100, D=14, g=3 → almost unwinnable. At 8% → set ฿105, D=9, g=8;
with P=5,000, E=1,000: α\* = 9,000/40,000 = **22.5%** — marginal; the engine ranks a
lower-E or higher-margin companion above it. Note how the framework *sets the discount
depth*, not just the pairing.

View columns: `potential_attachers`, `existing_pairers`, `gain_per_attacher`,
`breakeven_adoption_pct`, `projected_gp_at_10pct_adoption` (conservative α=10% used
for ranking), plus `behavior_score` (lift × ln(1+n_ab) × traffic weight) as tiebreak
and pre-cost fallback.

## Step 6 — Targeting
Target channel = the one with the lowest add-on attachment (the measured gap, deck
p.20–23). The more un-attached the target population, the higher the incremental
share of set buyers — Step 5's math is *why* this targeting rule works.

## Step 7 — Launch → measure → verdict (`marts.v_set_pnl` + `set_verdict` rule)
On launch: create the set SKU (`is_set=true`), record its recipe in `core.set_component`,
register the campaign. From day 28 the P&L view compares **actual gross profit per day of
the whole family (set + its components sold standalone) after vs the 28 days before**:
- `delta_gp_per_day ≥ 0` → insight **good**: scale (push channel, content, more branches)
- `delta_gp_per_day < 0` → insight **bad**: cannibalization won — reprice, swap companion,
  or kill; re-verdict 28 days after any change.

This is the empirical answer to "did it grow profit or just repackage revenue" — measured,
not assumed, for every set, automatically.
