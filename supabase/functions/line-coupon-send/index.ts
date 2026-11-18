// line-coupon-send — create a LINE built-in coupon with the Messaging API coupon endpoints and
// push it to chosen LINE user IDs (first test 2026-11-18, Point's own account only).
// Records quota consumption before/after so we learn whether a coupon message costs quota.
// ARMING: one-time key, cleared on use:
//   update crm.settings set value = '<random>' where key = 'send_key';
// then POST with header x-send-key: <random> and JSON body:
//   { coupon: {title, description?, reward?, start, end, maxUse?}, to: ["U..."] }
//   or { mode: "card", note?: "text", to: ["U..."] } to push each person their member card
//   (our own crm.coupons, redeemed by the staff tap).
// start/end are ISO times (Asia/Bangkok). Max 500 recipients per call (one multicast).
// Secrets: LINE_CHANNEL_ID + LINE_CHANNEL_SECRET (token minted here), or LINE_CHANNEL_ACCESS_TOKEN.
// verify_jwt = false (the one-time key is the guard).
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });
const FIXED_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
const CHANNEL_ID = Deno.env.get("LINE_CHANNEL_ID") ?? "";
const CHANNEL_SECRET = Deno.env.get("LINE_CHANNEL_SECRET") ?? "";

async function token(): Promise<string> {
  if (FIXED_TOKEN) return FIXED_TOKEN;
  const r = await fetch("https://api.line.me/oauth2/v3/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: CHANNEL_ID, client_secret: CHANNEL_SECRET }),
  });
  if (!r.ok) throw new Error(`token ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

async function line(tok: string, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const r = await fetch("https://api.line.me/v2/bot" + path, {
    method, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : {};
}


// ---- member card: COPY of memberCard() in line-webhook (keep in sync) ----
const RED = "#C8102E", GREY = "#8E8E93";
const txt = (text: string, o: Record<string, unknown> = {}) => ({ type: "text", text, wrap: true, align: "center", ...o });
const fmtPhone = (p: string) => `${p.slice(0, 3)}-${p.slice(3, 6)}-${p.slice(6)}`;
const bkkDate = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const thDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
async function memberCard(userId: string) {
  const [b] = await sql`select coalesce(value, '') v from crm.settings where key = 'brand_name'`;
  const [m] = await sql`select phone from crm.line_members where line_user_id = ${userId}`;
  if (!m?.phone) return null;
  const t = bkkDate();
  const coupons = await sql`
    select id, title, to_char(valid_from,'YYYY-MM-DD') vf, to_char(valid_to,'YYYY-MM-DD') vt,
           to_char(redeemed_at at time zone 'Asia/Bangkok','HH24:MI') used_at,
           case when redeemed_at is not null then 'used' when ${t}::date < valid_from then 'soon' else 'ready' end st
    from crm.coupons
    where line_user_id = ${userId}
      and (redeemed_at is null and valid_to >= ${t}::date
           or (redeemed_at at time zone 'Asia/Bangkok')::date = ${t}::date)
    order by valid_from`;
  const body: unknown[] = [
    txt("เบอร์สมาชิก", { size: "sm", color: GREY }),
    txt(fmtPhone(m.phone), { size: "3xl", weight: "bold" }),
    txt("แสดงให้แคชเชียร์เพื่อสะสมแต้ม", { size: "sm" }),
  ];
  const buttons: unknown[] = [];
  for (const c of coupons) {
    const used = c.st === "used", soon = c.st === "soon";
    body.push({
      type: "box", layout: "vertical", margin: "lg", paddingAll: "12px", cornerRadius: "12px",
      borderWidth: "2px", borderColor: used || soon ? "#E5E5EA" : RED,
      contents: [
        txt(c.title, { weight: "bold", size: "lg", color: used ? GREY : "#1D1D1F", decoration: used ? "line-through" : "none" }),
        txt(used ? `ใช้สิทธิ์แล้ว ${c.used_at} น.`
          : soon ? `ใช้ได้ในการมาครั้งถัดไป ${thDate(c.vf)} ถึง ${thDate(c.vt)}`
          : `ใช้ได้ถึง ${thDate(c.vt)}`, { size: "sm", color: used ? "#1A7F3C" : GREY }),
      ],
    });
    if (c.st === "ready") buttons.push({
      type: "button", style: "primary", color: RED, height: "sm",
      action: { type: "postback", label: "ใช้สิทธิ์ (สำหรับพนักงาน)", data: `action=redeem&id=${c.id}` },
    });
  }
  return {
    type: "flex", altText: `บัตรสมาชิก ${fmtPhone(m.phone)}`,
    contents: {
      type: "bubble",
      header: { type: "box", layout: "vertical", backgroundColor: RED, paddingAll: "14px",
        contents: [txt(b?.v || "Mama Pook", { color: "#FFFFFF", weight: "bold", size: "lg" }),
                   txt("บัตรสมาชิก", { color: "#FFFFFF", size: "sm" })] },
      body: { type: "box", layout: "vertical", spacing: "sm", contents: body },
      ...(buttons.length ? { footer: { type: "box", layout: "vertical", spacing: "sm", contents: buttons } } : {}),
    },
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const key = req.headers.get("x-send-key") ?? "";
  const armed = await sql`update crm.settings set value = null, updated_at = now()
                          where key = 'send_key' and value is not null and value = ${key} returning 1`;
  if (!key || armed.length !== 1) return new Response("not armed", { status: 403 });
  try {
    const { coupon: c, to, mode, note } = await req.json();
    if (!Array.isArray(to) || to.length < 1 || to.length > 500) throw new Error("to: 1-500 user IDs");
    const tok = await token();
    if (mode === "card") {            // push each person their own member card (our-system coupons)
      const before = await line(tok, "/message/quota/consumption");
      const out = [];
      for (const u of to) {
        const card = await memberCard(u);
        if (!card) { out.push({ to: u, ok: false, error: "not a linked member" }); continue; }
        const msgs = note ? [{ type: "text", text: note }, card] : [card];
        await line(tok, "/message/push", { to: u, messages: msgs });
        out.push({ to: u, ok: true });
      }
      const after = await line(tok, "/message/quota/consumption");
      return Response.json({ ok: true, mode, out, quotaBefore: before, quotaAfter: after });
    }
    const quotaBefore = await line(tok, "/message/quota/consumption");
    const body = {
      title: c.title,
      description: c.description,
      acquisitionCondition: { type: "normal" },
      maxUseCountPerTicket: c.maxUse ?? 1,
      startTimestamp: Math.floor(new Date(c.start).getTime() / 1000),
      endTimestamp: Math.floor(new Date(c.end).getTime() / 1000),
      timezone: "ASIA_BANGKOK",
      reward: c.reward ?? { type: "free" },
      visibility: "UNLISTED",
      ...(c.imageUrl ? { imageUrl: c.imageUrl } : {}),
      ...(c.usageCondition ? { usageCondition: c.usageCondition } : {}),
    };
    const { couponId } = await line(tok, "/coupon", body);
    const msg = [{ type: "coupon", couponId }];
    if (to.length === 1) await line(tok, "/message/push", { to: to[0], messages: msg });
    else await line(tok, "/message/multicast", { to, messages: msg });
    const detail = await line(tok, `/coupon/${couponId}`);
    const quotaAfter = await line(tok, "/message/quota/consumption");
    return Response.json({ ok: true, couponId, sent: to.length, quotaBefore, quotaAfter, detail });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
