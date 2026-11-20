-- 0027: "bill must have no promotion / discount / points" becomes a per-rule switch (Point 2026-11-20), default on.
-- Off = a bill with something applied can still earn; a line still has to be charged its full list price
-- (so a free 2 แถม 1 bowl or a discounted dish never earns), and amount rules use the bill total actually paid.
-- Applied through MCP with the full crm.rule_hits body: same as 0026 except the first join condition is
--   (not r.require_clean or not b.voids_earning)
alter table crm.coupon_rules add column if not exists require_clean boolean not null default true;
