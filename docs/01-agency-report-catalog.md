# Agency Report Catalog — MamaPook "Overall Performance and Strategy" (LyftUp Partners, Jul 2026)

Page-by-page inventory of every table, chart, metric, and framework in the 77-page agency deck.
This is the blueprint the Supabase model and dashboard reproduce. Data values are ignored — structure only.

**Entities referenced throughout:** Branches = Gaysorn, OCC, Rama9, Silom · Sales channels = Dine-In, Take Away, Delivery (OCC has no Delivery) · Menu categories (8) = Signature, Noodles (ก๋วยเตี๋ยว), Snacks (ของทานเล่น), Set, Gaolao (เกาเหลา), Rice (ข้าว), Beverages (เครื่องดื่ม), Desserts (ขนม).

---

## Section 1a — Overall Performance (pp. 4–10)

| Page | Title | Structure |
|---|---|---|
| 4 | Overview Performance – By Branch | 3 line charts: Sales (M THB), Transactions, ABS by month; series = branch + grand total |
| 5 | Branch vs Channel (Sales) | Table branch × channel (THB) + 100% stacked bar: sales contribution by channel per branch |
| 6 | Branch vs Channel (Transactions) | Same layout, transaction counts + contribution % |
| 7 | Branch vs Channel (ABS) | Heatmap table branch × channel, ABS THB/bill; highlights Dine-In vs Take Away vs Delivery ABS gaps |
| 8 | Branch vs Channel (Adjusted) | Same as p.5 with reclassified channel figures |
| 9 | Branch vs Channel vs Time (Sales %) | 4 small-multiple line charts (one per branch): x = hour 09–21, y = % of that channel's sales, series = channel. Daypart profile; lunch peak 11:00–13:00, evening windows |
| 10 | Branch vs Channel vs Time (ABS) | Same small multiples, y = ABS THB/bill by hour; identifies high-spend windows (evening Take Away at Silom/Gaysorn) |

## Section 1b — Customer Behavior: Category & Menu Preference (pp. 13–17)

| Page | Title | Structure |
|---|---|---|
| 13 | Category vs Channel | Table: rows = 8 categories ranked by sales; column groups = Grand Total / Dine-In / Take Away / Delivery, each with Sales THB + % of channel total (columns sum to 100%) |
| 14 | Category vs Channel — Menu (normalized) | Same layout at menu-item level. Items carry SKU codes (S1, S2, N1–N7, A2, D1, C1…) and **normalized names** — implies a raw-name → normalized-name → SKU → category mapping layer |
| 15 | Noodle-type preference by Channel | 100% stacked bar: x = channel, stack = noodle type (เส้นใหญ่ wide, เส้นหมี่ vermicelli, เส้นเล็ก thin, บะหมี่แบน flat egg, บะหมี่กลม round egg). Noodle type is an order **modifier**, not an item |
| 16 | Category vs Branch | Table: rows = categories, column groups = Overall + 4 branches (Sales + %), green sequential heat shading |
| 17 | Noodle-type preference by Branch | 100% stacked bar: x = branch, stack = noodle type |

## Section 1b — Customer Behavior: Category & Menu Combination (pp. 19–26)

| Page | Title | Structure |
|---|---|---|
| 19 | Main Dish Combination by Bill | Bar chart: % of bills by main-dish count (0…11+). **Main dish = {Signature, Noodles, Rice, Gaolao}**. Plus 3 horizontal bar charts: top combination patterns within 1/2/3-main-dish bills (e.g. "Signature x1 + Noodles x1") |
| 20 | Menu Combination: Dine-In | Heatmap table: rows = main-dish-count group (1…11+, Total); cols = % bills with add-on, add-on/bill, add-on/main-dish, then add-on units per bill by add-on subcategory: Beverages {soft drinks/water, brewed}, Snacks {fried, general, sides, share}, Desserts. **Excludes Set menus (~10% of sales)** |
| 21 | Calculation: add-on unit/bill | Methodology page. **add-on per bill = total add-on units ÷ bills WITH add-on** (not all bills); **% with add-on = bills with add-on ÷ all bills**; category add-on/bill = category units ÷ bills with add-on |
| 22 | Menu Combination: Take Away | Same table as p.20, Take Away channel |
| 23 | Menu Combination: Delivery | Same table, Delivery channel |
| 24 | ABS by Menu Combination each Branch | Table: rows = main-dish count; column groups = Overall + 4 branches with bills, ABS, **ABS per main dish**, % of branch sales (heat-shaded) |
| 25 | Menu Combination: Branch | Rows = main-dish count; column groups = branch × {% with add-on, add-on/bill, add-on/main dish} |
| 26 | Branch benchmark matrix | Rows = indicators (% with add-on, add-on/bill, 7 add-on subcategories); columns = branch; heat shading within each row |

## Section 1b — Customer Behavior: Weekday vs Weekend (pp. 28–34)

| Page | Title | Structure |
|---|---|---|
| 28 | WD vs WE — Sales | 3 clustered bar charts: Sales/day, Orders/day, ABS; x = branch + grand total, series = Weekday/Weekend. Decomposition Sales = Orders × ABS |
| 29 | WD vs WE — Channel contribution by hour | Heatmap table: rows = hour 09–21; cols = channel × day-type; cells = % of that column's sales (each sums to 100%) |
| 30 | WD vs WE — Sales contribution by hour (branch) | Heatmap table: rows = hour; cols = branch × day-type; peak-window callouts |
| 31 | WD vs WE — Category contribution by Channel | Table: rows = 8 categories; cols = channel × day-type contribution % |
| 32 | WD vs WE — Category contribution by Branch | Same, branch × day-type |
| 33 | WD vs WE — Main dishes per bill | Heatmap table: rows = main-dish-count bucket; cols = branch × {WD bills, WD %, WE bills, WE %} |
| 34 | Summary Key Potential | Strategy synthesis: set/bundle design per basket segment, channel-specific journeys, under-utilized dayparts (14:00–17:00, 16:00–20:00), category upsell (drinks, desserts) |

## Section 1c — Customer Review & Customer Journey (pp. 36–51)

| Page | Title | Structure |
|---|---|---|
| 36 | Customer Journey scope | Journey audit channels: Social (FB/IG/TikTok), Google & Google Maps, Delivery platforms |
| 37–41 | Journey — Social media audits | Screenshot evidence: profile metrics (followers, likes, post counts), link-in-bio destinations (Grab, LINE MAN, Google Maps links), broken journeys (dead Lemon8 link). Defines per-platform profile snapshot fields |
| 42 | Journey — Google Maps | Listing attributes per branch: star rating, review count, price band, cuisine, open status, service options |
| 43–47 | Journey — Delivery platform audit | Storefront quality rules: category ordering (best-sellers first, mains before add-ons), category merging/naming, menu-count curation, photo/description completeness, add-on options for upsell. Per-item fields: TH/EN name, photo, description, price, discount badge, tags ("Most ordered", "Signature dish"), availability |
| 48–51 | Customer Review — Delivery | Review synthesis per branch/platform: platform avg rating + count (e.g. Grab 4.7 / 433), complaint **themes** coded from text (too sweet, off-smell items, portion/value, consistency), review fields: stars, date, text, ordered items, topic tag (e.g. Packaging) |

## Section 2 — Main Strategy & Direction (pp. 53–75)

| Page | Title | Structure |
|---|---|---|
| 53 | Sales per day + Marketing budget/ROI | Table 1: Sales and Avg Sales/Day by branch × month. Table 2: Sales by channel × month; Marketing Cost rows (Influencer budget, Social ads, Delivery-platform ads, Total); **ROI = Sales ÷ Total marketing spend** |
| 54 | Target customer roadmap | Gantt: segments × months — Office workers (weekdays), Family/leisure (weekends) |
| 55 | Monthly key action roadmap | Matrix: workstreams (Main strategy, Delivery platform mgmt, Communication, Social ads, Google ads) × months; color dots map actions to sales channel |
| 56 | Budget allocation | Budget line items THB/month: Social ads 20k, Google ads 5k, Influencer fee, Influencer budget 20k, Delivery-platform 25k, Total 70k |
| 57 | Social media ads strategy | Table: platform (TikTok/IG/FB/Google) × {objective, target, detail, budget/month, % of ads budget}. Concepts: CPM, reach, 3–5 km radius per branch, lookalikes, branded vs generic search |
| 58 | Journey enhancement actions | Rules: link-in-bio consolidation, **trackable links to attribute channel per customer (UTM)**, delivery storefront sort = best-selling category/item first weighted by price |
| 59 | Delivery campaign & in-platform ads | ABS-growth sets (Solo Set / Group Set); **CPO = ad spend ÷ attributed orders** as deciding metric; A/B test matrix (keyword, targeting, schedule, cost mode) each judged on CPO + order volume |
| 61–65 | Brand: core message, pillars, mood | Brand DNA (Authentic Local Boldness, Family-Like Care, Variety & Value); hero items = charcoal-grilled pork-neck egg noodles + traditional tom yum; **7 content pillars**: Local Bold Taste, Menu Appetite Appeal, Made Like Family, Variety & Value, Everyday Meal Occasion, Customer Proof, Purchase Decision Support |
| 66–67 | Content plan batch table | Rows = content pieces: No., pillars (multi), objective, branch scope, **menu focus** (brand / category / item+variant), key message |
| 68–75 | Content briefs (July 1–4) | Repeating 2-page brief per piece. Spec sheet: topic, channels (FB/IG/TikTok), target, pillars, content type (Reels), brief type, objective, size/aspect, tone. Detail page: key concept, key messages, voice-over, key format, reference URLs/images |
| 76–77 | Next step / Thank you | Closing |

---

## Cross-cutting model requirements extracted

1. **Fact grain:** bill line-items — branch, channel, timestamp (hour used everywhere), menu item (raw → normalized → SKU → category), noodle-type modifier, qty, amount.
2. **Item flags:** is_main_dish (Signature/Noodles/Rice/Gaolao), is_addon + subcategory (soft drink/water, brewed, fried, general, sides, share, dessert), is_set (excluded from add-on analyses), is_signature.
3. **Derived dims:** day type (WD/WE), hour bucket, main-dish-count bucket per bill (0…11+), month.
4. **Normalization rules:** contribution % columns always sum to 100% within their series; heat shading within column (dayparts) or within row (branch benchmark).
5. **Business rules:** OCC has no Delivery and opened month 5 (branch open-date handling); add-on/bill denominator = bills *with* add-on; Set exclusion filter.
6. **Marketing side:** monthly spend by cost type, ROI, CPO, per-platform ad budget allocation, A/B test framework.
7. **Content/brand side:** 7-pillar taxonomy, content calendar + 2-level brief schema, menu-focus link from content to menu items (enables content ↔ item-sales correlation).
8. **Reputation side:** platform listing snapshots (rating, count), review records with themes/topics, journey audit checklists.
