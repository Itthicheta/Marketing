// member-card — backend of the member card page (LINE Member Link Playbook, "Member card").
// The page sends LINE's signed ID token; we verify it WITH LINE and only ever return the
// verified person's own number and coupons, so nobody can look up someone else.
//   GET  ?config                      -> { liff_id, brand }        (public, not secret)
//   POST { id_token }                 -> { registered, phone, name, coupons[] }
//   POST { id_token, redeem: <id> }   -> marks that coupon used (cashier taps "ใช้สิทธิ์"), returns the card
// Secret: LINE_LOGIN_CHANNEL_ID (the LINE Login channel that hosts the LIFF app). verify_jwt = false.
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });
const LOGIN_CHANNEL = Deno.env.get("LINE_LOGIN_CHANNEL_ID") ?? "";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);   // Bangkok date

async function verify(idToken: string): Promise<string | null> {
  if (!idToken || !LOGIN_CHANNEL) return null;
  const r = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: LOGIN_CHANNEL }),
  });
  if (!r.ok) return null;
  return (await r.json()).sub ?? null;
}

async function card(userId: string) {
  const [m] = await sql`select phone, display_name from crm.line_members where line_user_id = ${userId}`;
  if (!m?.phone) return { registered: false };
  const t = today();
  const coupons = await sql`
    select id, title, to_char(valid_from,'YYYY-MM-DD') valid_from, to_char(valid_to,'YYYY-MM-DD') valid_to,
           to_char(redeemed_at at time zone 'Asia/Bangkok','YYYY-MM-DD HH24:MI') redeemed_at,
           case when redeemed_at is not null then 'used'
                when ${t}::date < valid_from then 'soon'
                when ${t}::date > valid_to then 'expired'
                else 'ready' end status
    from crm.coupons
    where line_user_id = ${userId}
      and (redeemed_at is null and valid_to >= ${t}::date
           or (redeemed_at at time zone 'Asia/Bangkok')::date = ${t}::date)   -- keep today's used coupon visible (grey)
    order by valid_from`;
  return { registered: true, phone: m.phone, name: m.display_name, coupons };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method === "GET") {
    const rows = await sql`select key, value from crm.settings where key in ('liff_id','brand_name')`;
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return json({ liff_id: s.liff_id ?? null, brand: s.brand_name ?? "Mama Pook" });
  }
  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  const userId = await verify(body.id_token);
  if (!userId) return json({ error: "not verified" }, 401);

  if (body.redeem != null) {
    const t = today();
    const done = await sql`
      update crm.coupons set redeemed_at = now()
      where id = ${Number(body.redeem)} and line_user_id = ${userId} and redeemed_at is null
        and ${t}::date between valid_from and valid_to
      returning id`;
    return json({ ...(await card(userId)), redeemed: done.length === 1 });
  }
  return json(await card(userId));
});
