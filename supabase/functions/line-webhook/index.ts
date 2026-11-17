// line-webhook — LINE Member Link Playbook, "What the webhook script does" (Point 2026-11-17).
// LINE calls this for every event on @mamapook. It (1) proves the call came from LINE,
// (2) logs every event to raw.line_events (LINE never re-sends a text), (3) saves the
// LINE user + phone, issues the next-visit เก๊กฮวย coupon, replies, and switches the
// customer's rich menu. Ordinary chat gets NO reply so staff can answer by hand.
// v2 2026-11-17 — card-message version: @mamapook's Messaging API channel sits under a provider
// Point's console login can't reach, so there is no LINE Login/LIFF channel. The member card is a
// free reply (Flex message) with the number, the coupon and a two-step "ใช้สิทธิ์" button.
// v3 2026-11-17 — the rich menu is built by Point in the OA Manager (6 buttons). MEMBERS and COUPONS
// are "Text" actions that send a fixed word; the webhook answers those words (KEYWORDS below).
// COUPONS lists the running LINE built-in coupons from crm.line_coupon_list (members only).
// NOTE: an OA Manager menu "Text" button does NOT deliver its text to the webhook; LINE sends a postback
// "oaPlusRichMenu=true&richMenuId=default&actionId=<id>&version=<n>". The two ids are mapped in
// crm.settings (menu_action_card, menu_action_coupons). Editing the menu in the OA Manager may change
// the ids: unmapped ids are logged ("unmapped OA menu action") so they can be re-mapped.
// Secrets (Edge Functions → Secrets): LINE_CHANNEL_ID, LINE_CHANNEL_SECRET. The script mints its own
// short-lived stateless access token from those two (no Developers Console needed). An optional
// LINE_CHANNEL_ACCESS_TOKEN, if ever set, is used instead.
// Deploy with verify_jwt = false (LINE cannot send a Supabase JWT; the signature is the guard).
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });
const SECRET = Deno.env.get("LINE_CHANNEL_SECRET") ?? "";
const CHANNEL_ID = Deno.env.get("LINE_CHANNEL_ID") ?? "";
const FIXED_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
const API = "https://api.line.me/v2/bot";

// Stateless channel access token (valid 15 min): issued from channel id + secret, cached per instance.
let cached = { token: "", until: 0 };
async function token(): Promise<string> {
  if (FIXED_TOKEN) return FIXED_TOKEN;
  if (cached.token && Date.now() < cached.until) return cached.token;
  const r = await fetch("https://api.line.me/oauth2/v3/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: CHANNEL_ID, client_secret: SECRET }),
  });
  if (!r.ok) throw new Error(`token ${r.status} ${await r.text()}`);
  const j = await r.json();
  cached = { token: j.access_token, until: Date.now() + (Math.max(60, (j.expires_in ?? 900) - 60)) * 1000 };
  return cached.token;
}

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

const line = async (path: string, body?: unknown, method = "POST") =>
  fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const send = (replyToken: string, messages: unknown[]) => line("/message/reply", { replyToken, messages });
const reply = (replyToken: string, text: string) => send(replyToken, [{ type: "text", text }]);

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
  already: "บัญชีนี้ลงทะเบียนไว้แล้วค่ะ แสดงบัตรนี้ให้แคชเชียร์ได้เลยค่ะ",
  otherNumber: (p: string) =>
    `บัญชีนี้ลงทะเบียนเบอร์ ${fmtPhone(p)} ไว้แล้วค่ะ หากต้องการเปลี่ยนเบอร์ รบกวนแจ้งพนักงานที่ร้านนะคะ`,
  confirm: (p: string, reward: string, from: string, to: string) =>
    `ลงทะเบียนเรียบร้อยค่ะ เบอร์สมาชิก ${fmtPhone(p)}\n` +
    `รับ${reward} ในการมาครั้งถัดไป ใช้ได้ ${thDate(from)} ถึง ${thDate(to)}\n` +
    `ครั้งหน้ากดปุ่ม "MEMBERS" ที่เมนูด้านล่าง แล้วแสดงบัตรให้แคชเชียร์ได้เลยค่ะ`,
};

// Words sent by the OA Manager menu's "Text" buttons (and anything a customer types that matches).
const KEYWORDS: Record<string, "card" | "coupons"> = {
  "บัตรสมาชิก": "card", "สมาชิก": "card", "members": "card", "member": "card",
  "คูปองของฉัน": "coupons", "คูปอง": "coupons", "coupons": "coupons", "coupon": "coupons",
};

const RED = "#C8102E", GREY = "#8E8E93";
const txt = (text: string, o: Record<string, unknown> = {}) => ({ type: "text", text, wrap: true, align: "center", ...o });

// The member card: a free reply (Flex). Number large; coupons below; "ใช้สิทธิ์" only on a usable coupon.
async function memberCard(userId: string) {
  const s = await settings();
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
        contents: [txt(s.brand_name || "Mama Pook", { color: "#FFFFFF", weight: "bold", size: "lg" }),
                   txt("บัตรสมาชิก", { color: "#FFFFFF", size: "sm" })] },
      body: { type: "box", layout: "vertical", spacing: "sm", contents: body },
      ...(buttons.length ? { footer: { type: "box", layout: "vertical", spacing: "sm", contents: buttons } } : {}),
    },
  };
}

async function linkMemberMenu(userId: string, s: Record<string, string>) {
  if (s.richmenu_member) await line(`/user/${userId}/richmenu/${s.richmenu_member}`);
}

async function onPhone(userId: string, replyToken: string, phone: string) {
  const s = await settings();
  const [me] = await sql`select phone from crm.line_members where line_user_id = ${userId}`;
  if (me?.phone === phone) {
    await linkMemberMenu(userId, s);
    return send(replyToken, [{ type: "text", text: MSG.already }, await memberCard(userId)]);
  }
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
  await send(replyToken, [{ type: "text", text: MSG.confirm(phone, reward, from, to) }, await memberCard(userId)]);
  await linkMemberMenu(userId, s);
}

// COUPONS button: running LINE built-in coupons, one box each with an open button (max 10).
async function couponList() {
  const t = bkkDate();
  const rows = await sql`
    select title, url, image_url, to_char(valid_to,'YYYY-MM-DD') vt from crm.line_coupon_list
    where active and ${t}::date between valid_from and valid_to
    order by sort, valid_to limit 10`;
  if (!rows.length) return null;
  return {
    type: "flex", altText: "คูปองของฉัน",
    contents: { type: "carousel", contents: rows.map((r) => ({
      type: "bubble", size: "kilo",
      ...(r.image_url ? { hero: { type: "image", url: r.image_url, size: "full", aspectMode: "cover", aspectRatio: "20:13" } } : {}),
      body: { type: "box", layout: "vertical", spacing: "sm", contents: [
        txt(r.title, { weight: "bold", size: "md" }),
        txt(`ใช้ได้ถึง ${thDate(r.vt)}`, { size: "xs", color: GREY }),
      ] },
      footer: { type: "box", layout: "vertical", contents: [{
        type: "button", style: "primary", color: RED, height: "sm",
        action: { type: "uri", label: "เปิดคูปอง", uri: r.url },
      }] },
    })) },
  };
}

// MEMBERS / COUPONS taps (menu text words or postbacks). Non-members get the register prompt.
async function onMenu(userId: string, replyToken: string, what: "card" | "coupons" | "register") {
  await ensureMember(userId);
  const card = await memberCard(userId);
  if (!card) {
    return reply(replyToken, what === "coupons" ? "สมัครสมาชิกก่อนเพื่อรับคูปองค่ะ\n" + MSG.register : MSG.register);
  }
  await linkMemberMenu(userId, await settings());
  if (what === "coupons") {
    const list = await couponList();
    const note = { type: "text", text: "แตะ \"เปิดคูปอง\" แล้วกด \"ใช้คูปอง\" ต่อหน้าพนักงานค่ะ\nคูปองเก๊กฮวยสมาชิกอยู่ที่ปุ่ม \"MEMBERS\" ค่ะ" };
    return list ? send(replyToken, [note, list]) : reply(replyToken, "ยังไม่มีคูปองใหม่ค่ะ ติดตามได้เร็วๆ นี้\nคูปองเก๊กฮวยสมาชิกอยู่ที่ปุ่ม \"MEMBERS\" ค่ะ");
  }
  return send(replyToken, what === "register" ? [{ type: "text", text: MSG.already }, card] : [card]);
}

// Two-step redeem: the button asks for confirmation; only "ยืนยัน" marks the coupon used.
async function onRedeem(userId: string, replyToken: string, id: number, confirmed: boolean) {
  const [c] = await sql`
    select title, to_char(valid_from,'YYYY-MM-DD') vf, to_char(valid_to,'YYYY-MM-DD') vt,
           to_char(redeemed_at at time zone 'Asia/Bangkok','DD/MM HH24:MI') used_at,
           ${bkkDate()}::date < valid_from too_early, ${bkkDate()}::date > valid_to expired
    from crm.coupons where id = ${id} and line_user_id = ${userId}`;
  if (!c) return;
  if (c.used_at) return reply(replyToken, `คูปองนี้ใช้สิทธิ์ไปแล้วเมื่อ ${c.used_at} น. ค่ะ`);
  if (c.too_early) return reply(replyToken, `คูปองนี้ใช้ได้ในการมาครั้งถัดไป ตั้งแต่ ${thDate(c.vf)} ค่ะ`);
  if (c.expired) return reply(replyToken, `คูปองนี้หมดอายุแล้วเมื่อ ${thDate(c.vt)} ค่ะ`);
  if (!confirmed) {
    return send(replyToken, [{
      type: "template", altText: "ยืนยันใช้สิทธิ์",
      template: { type: "confirm", text: `พนักงาน: ยืนยันใช้สิทธิ์ "${c.title}" ?\nแล้วใส่คูปองในบิลที่ POS`,
        actions: [{ type: "postback", label: "ยืนยัน", data: `action=redeem_ok&id=${id}` },
                  { type: "postback", label: "ยกเลิก", data: "action=noop" }] },
    }]);
  }
  const done = await sql`
    update crm.coupons set redeemed_at = now()
    where id = ${id} and line_user_id = ${userId} and redeemed_at is null
      and ${bkkDate()}::date between valid_from and valid_to
    returning to_char(redeemed_at at time zone 'Asia/Bangkok','HH24:MI') at`;
  if (!done.length) return reply(replyToken, "ใช้สิทธิ์ไม่สำเร็จค่ะ กรุณาเปิดบัตรสมาชิกใหม่อีกครั้ง");
  return reply(replyToken, `✅ ใช้สิทธิ์ "${c.title}" เรียบร้อย เวลา ${done[0].at} น.\nพนักงาน: ใส่คูปองในบิลที่ POS ค่ะ`);
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
  if (ev.type === "postback") {
    const q = new URLSearchParams(ev.postback?.data ?? "");
    if (q.get("oaPlusRichMenu") === "true") {                          // OA Manager menu button
      const s = await settings(), id = q.get("actionId") ?? "";
      if (id && id === s.menu_action_card) return onMenu(userId, ev.replyToken, "card");
      if (id && id === s.menu_action_coupons) return onMenu(userId, ev.replyToken, "coupons");
      console.log("unmapped OA menu action", id, q.get("version"));
      return;
    }
    const action = q.get("action");
    if (action === "register" || action === "card" || action === "coupons") return onMenu(userId, ev.replyToken, action);
    if (action === "redeem" || action === "redeem_ok") return onRedeem(userId, ev.replyToken, Number(q.get("id")), action === "redeem_ok");
    return;                                                            // noop / unknown
  }
  if (ev.type === "message" && ev.message?.type === "text") {
    const word = KEYWORDS[(ev.message.text ?? "").trim().toLowerCase()];
    if (word) return onMenu(userId, ev.replyToken, word);
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
