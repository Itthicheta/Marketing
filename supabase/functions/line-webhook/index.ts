// line-webhook — LINE Member Link Playbook, "What the webhook script does" (Point 2026-11-17).
// LINE calls this for every event on @mamapook. It (1) proves the call came from LINE,
// (2) logs every event to raw.line_events (LINE never re-sends a text), (3) saves the
// LINE user + phone, issues the next-visit เก๊กฮวย coupon, replies, and switches the
// customer's rich menu. Ordinary chat gets NO reply so staff can answer by hand.
// Secrets (Edge Functions → Secrets): LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN.
// Deploy with verify_jwt = false (LINE cannot send a Supabase JWT; the signature is the guard).
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });
const SECRET = Deno.env.get("LINE_CHANNEL_SECRET") ?? "";
const TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
const API = "https://api.line.me/v2/bot";

async function validSignature(body: string, sig: string | null): Promise<boolean> {
  if (!sig || !SECRET) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

const line = (path: string, body?: unknown, method = "POST") =>
  fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const reply = (replyToken: string, text: string) =>
  line("/message/reply", { replyToken, messages: [{ type: "text", text }] });

async function settings(): Promise<Record<string, string>> {
  const rows = await sql`select key, coalesce(value, '') value from crm.settings`;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

async function displayName(userId: string): Promise<string | null> {
  try {
    const r = await line(`/profile/${userId}`, undefined, "GET");
    return r.ok ? (await r.json()).displayName ?? null : null;
  } catch { return null; }
}

// Upsert the friend row (also covers people who were friends before the webhook existed).
async function ensureMember(userId: string) {
  const name = await displayName(userId);
  await sql`insert into crm.line_members (line_user_id, display_name)
            values (${userId}, ${name})
            on conflict (line_user_id) do update
              set display_name = coalesce(excluded.display_name, crm.line_members.display_name),
                  blocked_at = null, updated_at = now()`;
}

// "081 234-5678", "+66812345678", "66812345678" -> "0812345678"; null when not digit-like at all.
function cleanNumber(text: string): { digitLike: boolean; phone: string | null } {
  let t = text.replace(/[\s\-.()]/g, "");
  if (!/^\+?\d+$/.test(t)) return { digitLike: false, phone: null };
  t = t.replace(/^\+/, "");
  if (/^66\d{9}$/.test(t)) t = "0" + t.slice(2);
  return { digitLike: true, phone: /^0[689]\d{8}$/.test(t) ? t : null };
}
const fmtPhone = (p: string) => `${p.slice(0, 3)}-${p.slice(3, 6)}-${p.slice(6)}`;
const bkkDate = (offsetDays = 0) => {
  const d = new Date(Date.now() + 7 * 3600e3 + offsetDays * 86400e3);
  return d.toISOString().slice(0, 10);
};
const thDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

const MSG = {
  register: "พิมพ์เบอร์โทรที่ใช้สะสมแต้ม 10 หลัก ส่งมาในแชตนี้ได้เลยค่ะ เช่น 0812345678",
  retry: "เบอร์โทรไม่ครบ 10 หลักค่ะ รบกวนพิมพ์ใหม่อีกครั้ง เช่น 0812345678",
  taken: "เบอร์นี้ลงทะเบียนกับ LINE บัญชีอื่นแล้วค่ะ รบกวนแจ้งพนักงานที่ร้านนะคะ",
  already: (p: string) =>
    `บัญชีนี้ลงทะเบียนไว้แล้วค่ะ เบอร์สมาชิก ${fmtPhone(p)} กดปุ่ม "บัตรสมาชิก" ด้านล่างแล้วแสดงให้แคชเชียร์ได้เลยค่ะ`,
  otherNumber: (p: string) =>
    `บัญชีนี้ลงทะเบียนเบอร์ ${fmtPhone(p)} ไว้แล้วค่ะ หากต้องการเปลี่ยนเบอร์ รบกวนแจ้งพนักงานที่ร้านนะคะ`,
  confirm: (p: string, reward: string, from: string, to: string) =>
    `ลงทะเบียนเรียบร้อยค่ะ เบอร์สมาชิก ${fmtPhone(p)}\n` +
    `รับ${reward} ในการมาครั้งถัดไป ใช้ได้ ${thDate(from)} ถึง ${thDate(to)}\n` +
    `ครั้งหน้ากดปุ่ม "บัตรสมาชิก" ด้านล่าง แล้วแสดงให้แคชเชียร์ได้เลยค่ะ`,
};

async function linkMemberMenu(userId: string, s: Record<string, string>) {
  if (s.richmenu_member) await line(`/user/${userId}/richmenu/${s.richmenu_member}`);
}

async function onPhone(userId: string, replyToken: string, phone: string) {
  const s = await settings();
  const [me] = await sql`select phone from crm.line_members where line_user_id = ${userId}`;
  if (me?.phone === phone) { await linkMemberMenu(userId, s); return reply(replyToken, MSG.already(phone)); }
  if (me?.phone) return reply(replyToken, MSG.otherNumber(me.phone));
  const [owner] = await sql`select 1 from crm.line_members where phone = ${phone} and line_user_id <> ${userId}`;
  if (owner) return reply(replyToken, MSG.taken);

  const days = Math.max(1, parseInt(s.reward_days || "14", 10));
  const from = bkkDate(1), to = bkkDate(days);
  const reward = s.reward_text || "เก๊กฮวยฟรี 1 แก้ว";
  try {
    await sql.begin(async (tx) => {
      await tx`update crm.line_members set phone = ${phone}, linked_at = now(), updated_at = now()
               where line_user_id = ${userId}`;
      await tx`insert into crm.coupons (line_user_id, kind, title, valid_from, valid_to)
               values (${userId}, 'signup', ${reward}, ${from}, ${to})
               on conflict (line_user_id, kind) do nothing`;
    });
  } catch (e) {
    if (String(e).includes("line_members_phone_uq")) return reply(replyToken, MSG.taken); // race: taken meanwhile
    throw e;
  }
  await reply(replyToken, MSG.confirm(phone, reward, from, to));
  await linkMemberMenu(userId, s);
}

async function handle(ev: any) {
  const userId: string | undefined = ev.source?.userId;
  await sql`insert into raw.line_events (event_type, line_user_id, event_ts, payload)
            values (${ev.type}, ${userId ?? null}, to_timestamp(${(ev.timestamp ?? Date.now()) / 1000}), ${sql.json(ev)})`;
  if (!userId || ev.source?.type !== "user") return;   // ignore group/room events

  if (ev.type === "follow") return ensureMember(userId);              // greeting = the OA's built-in greeting message
  if (ev.type === "unfollow") {
    await sql`update crm.line_members set blocked_at = now(), updated_at = now() where line_user_id = ${userId}`;
    return;
  }
  if (ev.type === "postback" && /(^|&)action=register(&|$)/.test(ev.postback?.data ?? "")) {
    await ensureMember(userId);
    const [me] = await sql`select phone from crm.line_members where line_user_id = ${userId}`;
    if (me?.phone) { await linkMemberMenu(userId, await settings()); return reply(ev.replyToken, MSG.already(me.phone)); }
    return reply(ev.replyToken, MSG.register);
  }
  if (ev.type === "message" && ev.message?.type === "text") {
    const { digitLike, phone } = cleanNumber(ev.message.text ?? "");
    if (!digitLike) return;                                            // ordinary chat: stay silent for staff
    await ensureMember(userId);
    if (!phone) return reply(ev.replyToken, MSG.retry);
    return onPhone(userId, ev.replyToken, phone);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const body = await req.text();
  if (!(await validSignature(body, req.headers.get("x-line-signature")))) {
    return new Response("bad signature", { status: 401 });
  }
  const events = JSON.parse(body).events ?? [];
  for (const ev of events) {
    try { await handle(ev); } catch (e) { console.error("event failed", ev?.type, e); }
  }
  return new Response("ok");   // always 200 so LINE does not retry-storm
});
