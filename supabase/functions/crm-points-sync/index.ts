// crm-points-sync — receives ERS points balances, reward items and branches from the Mac pipeline
// (tools/crm_points_push.py, every ~30 min after the POS load) and replaces crm.pos_points,
// crm.pos_rewards and crm.branches (Point 2026-11-18: ERS is the only points system).
// Guard: header x-sync-key must equal crm.settings.points_sync_key (kept in the Mac .env as
// MARKETING_POINTS_KEY). verify_jwt = false. Active rows in crm.test_points are re-applied after each replace. Refuses an empty member list so a bad query can't wipe it.
// v3 (Point 2026-11-20): optional `stats` (per-phone in-store visit stats) and `promo_uses` (ERS promotions on
// member bills) replace crm.pos_member_stats / crm.pos_promo_uses (0019) in the same transaction.
// v4: stats rows carry branch_visits {branch_id: visits} (0021). v6: pax, med_bowls, med_pax (0022). v7: dine_visits (0023). v8: `visits` (one row per bill) replaces crm.pos_member_visits (0024).
// v9 (2026-11-20, 0025): optional `bills` (14 days of in-store bills with lines + voids_earning) replaces crm.pos_bills /
// crm.pos_bill_lines, optional `menu` replaces crm.pos_menu; then crm.apply_coupon_rules() issues earned member-card
// coupons inside a savepoint (a rule error is reported as coupon_error and never blocks the points sync).
// v10 (0026): bills carry `total` (bill amount incl. VAT) for amount rules.
// v11 (0029, 2026-11-24): optional `voided` {orders, lines} = member bills voided in the last 21 days; before issuing,
// crm.take_back_voided() deletes the UNUSED coupons earned from them (copied to crm.coupon_takebacks; keep_on_void exempts).
// v12 (2026-11-24): optional `ers_config` (ERS setup snapshot: promotions, discount reasons, loyalty ranks, observed
// behaviour) is stored as JSON in crm.settings 'ers_config' for the sales site's ตั้งค่า POS checklist.
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const key = req.headers.get("x-sync-key") ?? "";
  const [s] = await sql`select value from crm.settings where key = 'points_sync_key'`;
  if (!key || !s?.value || key !== s.value) return new Response("forbidden", { status: 403 });
  try {
    const { members, rewards, branches, stats, promo_uses, visits, bills, menu, voided, ers_config } = await req.json();
    let issued: number | null = null, takenBack: number | null = null, couponError: string | null = null;
    if (!Array.isArray(members) || members.length < 50) throw new Error(`members: got ${members?.length ?? 0}, refusing to replace`);
    const ok = (p: string) => /^0[689]\d{8}$/.test(p);
    const m = members.filter((r: any) => ok(String(r.phone)));
    await sql.begin(async (tx) => {
      await tx`delete from crm.pos_points`;
      for (let i = 0; i < m.length; i += 500) {
        const chunk = m.slice(i, i + 500).map((r: any) => ({
          phone: String(r.phone), points: Number(r.points) || 0, as_of: r.as_of,
          last_bill_at: r.last_bill_at ?? null, last_branch_id: r.last_branch_id ?? null,
        }));
        await tx`insert into crm.pos_points ${tx(chunk, "phone", "points", "as_of", "last_bill_at", "last_branch_id")}`;
      }
      // demo balances (crm.test_points, 0013) survive the replace until they expire
      await tx`insert into crm.pos_points (phone, points, as_of)
               select phone, points, now() from crm.test_points where expires_at > now()
               on conflict (phone) do update set points = excluded.points, as_of = excluded.as_of`;
      if (Array.isArray(stats) && stats.length >= 50) {
        await tx`delete from crm.pos_member_stats`;
        const rows = stats.filter((r: any) => ok(String(r.phone))).map((r: any) => ({
          phone: String(r.phone), visits: Number(r.visits) || 0, days: Number(r.days) || 0,
          first_visit: r.first_visit ?? null, last_visit: r.last_visit ?? null, bowls: Number(r.bowls) || 0,
          spend_thb: Number(r.spend_thb) || 0, addon_units: Number(r.addon_units) || 0, drink_units: Number(r.drink_units) || 0,
          weekend_visits: Number(r.weekend_visits) || 0, slots: (Array.isArray(r.slots) ? r.slots : []).map((x: any) => Number(x) || 0),
          dine_visits: Number(r.dine_visits) || 0, pax: Number(r.pax) || 0, med_bowls: Number(r.med_bowls) || 0, med_pax: Number(r.med_pax) || 0,
          branch_visits: r.branch_visits && typeof r.branch_visits === "object" ? r.branch_visits : null,   // object, not a string (postgres.js would store a JSON string)
        }));
        for (let i = 0; i < rows.length; i += 500) {
          await tx`insert into crm.pos_member_stats ${tx(rows.slice(i, i + 500), "phone", "visits", "days", "first_visit", "last_visit",
            "bowls", "spend_thb", "addon_units", "drink_units", "weekend_visits", "slots", "branch_visits", "pax", "med_bowls", "med_pax", "dine_visits")}`;
        }
      }
      if (Array.isArray(promo_uses) && Array.isArray(stats) && stats.length >= 50) {
        await tx`delete from crm.pos_promo_uses`;
        const rows = promo_uses.filter((r: any) => ok(String(r.phone))).map((r: any) => ({
          phone: String(r.phone), sold_at: r.sold_at, branch_id: r.branch_id ?? null, promo_id: r.promo_id ?? null,
          promo_name: r.promo_name ?? null, items: Number(r.items) || 0,
        }));
        for (let i = 0; i < rows.length; i += 500) {
          await tx`insert into crm.pos_promo_uses ${tx(rows.slice(i, i + 500), "phone", "sold_at", "branch_id", "promo_id", "promo_name", "items")}`;
        }
      }
      if (Array.isArray(visits) && Array.isArray(stats) && stats.length >= 50) {
        await tx`delete from crm.pos_member_visits`;
        const rows = visits.filter((r: any) => ok(String(r.phone)) && r.at).map((r: any) => ({
          phone: String(r.phone), bill_no: r.bill_no ?? null, at: r.at, branch_id: r.branch_id ?? null, channel: r.channel ?? null,
          bowls: Number(r.bowls) || 0, pax: Number(r.pax) || 0, spend: Number(r.spend) || 0, addon: Number(r.addon) || 0,
          drinks: Number(r.drinks) || 0, items: r.items ? String(r.items).slice(0, 400) : null, promos: r.promos ?? null,
        }));
        for (let i = 0; i < rows.length; i += 500) {
          await tx`insert into crm.pos_member_visits ${tx(rows.slice(i, i + 500), "phone", "bill_no", "at", "branch_id", "channel",
            "bowls", "pax", "spend", "addon", "drinks", "items", "promos")}`;
        }
      }
      if (Array.isArray(menu) && menu.length) {
        await tx`delete from crm.pos_menu`;
        const mr = [...new Map(menu.filter((r: any) => Number.isInteger(Number(r.item_id))).map((r: any) => [Number(r.item_id), {
          item_id: Number(r.item_id), item_code: r.item_code ?? null, name: r.name ?? null, category: r.category ?? null }])).values()];
        for (let i = 0; i < mr.length; i += 500) {
          await tx`insert into crm.pos_menu ${tx(mr.slice(i, i + 500), "item_id", "item_code", "name", "category")}`;
        }
      }
      if (Array.isArray(bills)) {
        await tx`delete from crm.pos_bill_lines`;
        await tx`delete from crm.pos_bills`;
        const bs = [...new Map(bills
          .filter((b: any) => ok(String(b.phone)) && b.order_id && b.opened_at && b.business_date && Number.isInteger(Number(b.branch_id)))
          .map((b: any) => [String(b.order_id), {
            order_id: String(b.order_id), phone: String(b.phone), bill_no: b.bill_no ?? null, branch_id: Number(b.branch_id),
            opened_at: b.opened_at, business_date: b.business_date, total: Number(b.total) || 0,
            voids_earning: b.voids_earning !== false,   // fail closed: only an explicit false lets a bill earn
          }])).values()];
        const keep = new Set(bs.map((b) => b.order_id));
        const ls = [...new Map(bills.filter((b: any) => keep.has(String(b.order_id))).flatMap((b: any) =>
          (Array.isArray(b.lines) ? b.lines : []).filter((l: any) => l.line_id).map((l: any) => [String(l.line_id), {
            line_id: String(l.line_id), order_id: String(b.order_id),
            item_id: Number.isInteger(Number(l.item_id)) ? Number(l.item_id) : null,
            name: l.name ?? null, category: l.category ?? null, qty: Number(l.qty) || 0, full_price: l.full_price === true,
          }]))).values()];
        for (let i = 0; i < bs.length; i += 500) {
          await tx`insert into crm.pos_bills ${tx(bs.slice(i, i + 500), "order_id", "phone", "bill_no", "branch_id", "opened_at", "business_date", "voids_earning", "total")}`;
        }
        for (let i = 0; i < ls.length; i += 500) {
          await tx`insert into crm.pos_bill_lines ${tx(ls.slice(i, i + 500), "line_id", "order_id", "item_id", "name", "category", "qty", "full_price")}`;
        }
      }
      const vo = Array.isArray(voided?.orders) ? voided.orders.map(String).filter((x: string) => /^\d+-\d+$/.test(x)) : [];
      const vl = Array.isArray(voided?.lines) ? voided.lines.map(String).filter((x: string) => /^\d+-\d+$/.test(x)) : [];
      if (vo.length || vl.length) {
        try {   // take back unused coupons of voided bills (0029); never blocks the sync
          takenBack = await tx.savepoint(async (sp) =>
            (await sp`select crm.take_back_voided(${"{" + vo.join(",") + "}"}::text[], ${"{" + vl.join(",") + "}"}::text[]) n`)[0].n as number);
        } catch (e) {
          couponError = "take_back: " + String(e).slice(0, 280);
          console.error("take_back_voided", e);
        }
      } else if (voided) takenBack = 0;
      try {   // earned member-card coupons (0025); a failure here must not roll back the points sync
        issued = await tx.savepoint(async (sp) => (await sp`select crm.apply_coupon_rules() n`)[0].n as number);
      } catch (e) {
        couponError = (couponError ? couponError + " | " : "") + String(e).slice(0, 300);
        console.error("apply_coupon_rules", e);
      }
      if (ers_config && typeof ers_config === "object" && !Array.isArray(ers_config)) {
        await tx`insert into crm.settings (key, value, updated_at) values ('ers_config', ${JSON.stringify(ers_config)}, now())
                 on conflict (key) do update set value = excluded.value, updated_at = now()`;
      }
      if (Array.isArray(rewards)) {
        await tx`delete from crm.pos_rewards`;
        const rw = rewards.map((r: any) => ({ item_code: String(r.item_code), ers_name: String(r.ers_name), points: Number(r.points) }));
        if (rw.length) await tx`insert into crm.pos_rewards ${tx(rw, "item_code", "ers_name", "points")}`;
      }
      if (Array.isArray(branches) && branches.length) {
        for (const b of branches) {
          await tx`insert into crm.branches (branch_id, name, sort) values (${b.branch_id}, ${b.name}, ${b.sort ?? 100})
                   on conflict (branch_id) do update set name = excluded.name, sort = excluded.sort, active = true`;
        }
        await tx`update crm.branches set active = false where not (branch_id = any(${branches.map((b: any) => b.branch_id)}::int[]))`;
      }
    });
    return Response.json({ ok: true, members: m.length, skipped: members.length - m.length, rewards: rewards?.length ?? 0, branches: branches?.length ?? 0,
      stats: stats?.length ?? 0, promo_uses: promo_uses?.length ?? 0, visits: visits?.length ?? 0,
      bills: Array.isArray(bills) ? bills.length : null, menu: Array.isArray(menu) ? menu.length : null,
      coupons_issued: issued, coupons_taken_back: takenBack, coupon_error: couponError });
  } catch (e) {
    console.error("crm-points-sync", e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
