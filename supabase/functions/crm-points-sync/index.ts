// crm-points-sync — receives ERS points balances, reward items and branches from the Mac pipeline
// (tools/crm_points_push.py, every ~30 min after the POS load) and replaces crm.pos_points,
// crm.pos_rewards and crm.branches (Point 2026-11-18: ERS is the only points system).
// Guard: header x-sync-key must equal crm.settings.points_sync_key (kept in the Mac .env as
// MARKETING_POINTS_KEY). verify_jwt = false. Active rows in crm.test_points are re-applied after each replace. Refuses an empty member list so a bad query can't wipe it.
// v3 (Point 2026-11-20): optional `stats` (per-phone in-store visit stats) and `promo_uses` (ERS promotions on
// member bills) replace crm.pos_member_stats / crm.pos_promo_uses (0019) in the same transaction.
// v4: stats rows carry branch_visits {branch_id: visits} (0021). v6: pax, med_bowls, med_pax (0022). v7: dine_visits (0023).
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const key = req.headers.get("x-sync-key") ?? "";
  const [s] = await sql`select value from crm.settings where key = 'points_sync_key'`;
  if (!key || !s?.value || key !== s.value) return new Response("forbidden", { status: 403 });
  try {
    const { members, rewards, branches, stats, promo_uses } = await req.json();
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
      stats: stats?.length ?? 0, promo_uses: promo_uses?.length ?? 0 });
  } catch (e) {
    console.error("crm-points-sync", e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
