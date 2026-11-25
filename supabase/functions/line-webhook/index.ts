// line-webhook — LINE member program for @mamapook (Point 2026-11-17, v4 2026-11-18).
// One function, four doors (4 = /gift, see v16 below):
//  1. LINE events (X-Line-Signature): logs every event to raw.line_events, sends the sign-up button on
//     follow, answers the MEMBERS and PROMOTIONS menu buttons, runs the two-step staff redeem.
//  2. /signup (the sign-up form page): GET ?t=<one-time token> -> form data; POST -> link the phone,
//     save name/birthday/branch/consent, issue the next-visit เก๊กฮวย, push the confirmation + card.
//  3. Admin push (header x-send-key = the one-time crm.settings.send_key, cleared on use):
//     {to, mode: card|promotions|signup, note?, include_inactive?} -> push to one LINE user.
// Decisions (docs/07): ERS is the only points system; the card shows the ERS balance (crm.pos_points,
// ~30 min, from the Mac pipeline) and a view-only reward ladder (crm.pos_rewards); redemption only at the
// cashier in ERS; points expire after 3 months; only the sign-up เก๊กฮวย uses the staff tap. The sign-up gift has an
// on/off switch, crm.settings.signup_reward (0015; off since 2026-11-18, Point). PROMOTIONS =
// crm.promotions, open to everyone. Promotional coupons go out as LINE coupons (line-coupon-send).
// OA Manager menu buttons arrive as postbacks "oaPlusRichMenu=true&actionId=<id>"; ids are mapped in
// crm.settings (menu_action_card, menu_action_promotions); unmapped ids are logged for re-mapping.
// Secrets: LINE_CHANNEL_ID, LINE_CHANNEL_SECRET (stateless token minted here) or LINE_CHANNEL_ACCESS_TOKEN.
// Deploy with verify_jwt = false (signature / one-time token / one-time key are the guards).
// 2026-11-20 (0025): earned coupons show as one box per stack ("×N") with "ใช้ร่วมกับโปรโมชั่นอื่นไม่ได้";
// each staff confirm uses exactly one (onRedeemEarned). Sign-up / test coupons unchanged.
// 2026-11-23: a confirm dies when its ยกเลิก is pressed or after 10 minutes (confirmDead).
// 2026-11-23: card has two headed sections (แลกแต้ม / คูปองของฉัน) with dividers; the confirm's ยกเลิก now answers.
// v15 2026-11-24 (0030): a coupon's use window (use_from / use_to / use_days on crm.coupon_templates) shows on the card
// ("ใช้ได้ทุกวัน หลัง 14:00 น.") and ใช้สิทธิ์ / ยืนยัน are refused outside it (useWindow / useText).
// v16 2026-11-25 (0031, Point): coupon gifts. With crm.settings.coupon_gifts = 'on' the card carries "ส่งต่อคูปองให้เพื่อน"
// (a fresh 30-min one-time link to member-card-page/gift.html) when the member holds a giftable coupon: a rule coupon
// they earned themselves (never the sign-up gift; received coupons are never giftable again = one hop). The page talks
// to the 4th door, /gift (giftApi): stacks -> friend lookup (masked name, max 10 per link) -> crm.gift_coupons().
// Received stacks show "ได้รับจาก คุณสมชาย ใ***". The friend gets no LINE message (Point: no quota).
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });
const SECRET = Deno.env.get("LINE_CHANNEL_SECRET") ?? "";
const CHANNEL_ID = Deno.env.get("LINE_CHANNEL_ID") ?? "";
const FIXED_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
const API = "https://api.line.me/v2/bot";

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
const push = async (to: string, messages: unknown[]) => {
  const r = await line("/message/push", { to, messages });
  if (!r.ok) throw new Error(`push ${r.status} ${await r.text()}`);
};

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
const bkkDate = (offsetDays = 0) => new Date(Date.now() + 7 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
const thDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
// coupon use window (0030): times "HH:MM" Bangkok (use_to exclusive), days ISO 1=Mon..7=Sun; null / empty = no limit
const TH_DAY = ["จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส.", "อา."];
function useText(from: string | null, to: string | null, days: number[] | null): string | null {
  const ds = (days ?? []).map(Number).sort((a, b) => a - b);
  const dayTxt = !ds.length || ds.length === 7 ? "ทุกวัน"
    : ds.join() === "1,2,3,4,5" ? "จันทร์–ศุกร์" : ds.join() === "6,7" ? "เสาร์–อาทิตย์" : ds.map((d) => TH_DAY[d - 1]).join(" ");
  const timeTxt = from && to ? `${from}–${to} น.` : from ? `หลัง ${from} น.` : to ? `ก่อน ${to} น.` : "";
  if (dayTxt === "ทุกวัน" && !timeTxt) return null;
  return `ใช้ได้${dayTxt}${timeTxt ? " " + timeTxt : ""}`;
}
function useWindow(from: string | null, to: string | null, days: number[] | null): { ok: boolean; now: string } {
  const d = new Date(Date.now() + 7 * 3600e3), now = d.toISOString().slice(11, 16);
  const dow = ((d.getUTCDay() + 6) % 7) + 1;
  const ds = (days ?? []).map(Number);
  const ok = (!ds.length || ds.includes(dow)) && (!from || now >= from) && (!to || now < to);
  return { ok, now };
}
const fmtNum = (n: number) => Math.floor(n).toLocaleString("en-US");
// "สมชาย ใจดี" -> "คุณสมชาย ใ***" (Point 2026-11-25: first name + masked surname, never the full name)
function maskName(full: string | null, disp: string | null): string {
  const parts = String(full || disp || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "สมาชิก";
  return "คุณ" + Array.from(parts[0]).slice(0, 20).join("") + (parts[1] ? " " + Array.from(parts[1])[0] + "***" : "");
}
const newToken = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "").slice(0, 8);

const MSG = {
  taken: "เบอร์นี้ลงทะเบียนกับ LINE บัญชีอื่นแล้วค่ะ รบกวนแจ้งพนักงานที่ร้านนะคะ",
  already: "บัญชีนี้ลงทะเบียนไว้แล้วค่ะ แสดงบัตรนี้ให้แคชเชียร์ได้เลยค่ะ",
  otherNumber: (p: string) =>
    `บัญชีนี้ลงทะเบียนเบอร์ ${fmtPhone(p)} ไว้แล้วค่ะ หากต้องการเปลี่ยนเบอร์ รบกวนแจ้งพนักงานที่ร้านนะคะ`,
  confirm: (p: string, reward: string | null, from: string, to: string) =>
    `สมัครสมาชิกเรียบร้อยค่ะ เบอร์สมาชิก ${fmtPhone(p)}\n` +
    (reward ? `รับ${reward} ในการมาครั้งถัดไป ใช้ได้ ${thDate(from)} ถึง ${thDate(to)}\n` : "") +
    `ครั้งหน้ากดปุ่ม "MEMBERS" ที่เมนูด้านล่าง แล้วแสดงบัตรให้แคชเชียร์ได้เลยค่ะ`,
  updated: "บันทึกข้อมูลเรียบร้อยค่ะ ขอบคุณค่ะ",
  noPromo: "ยังไม่มีโปรโมชั่นตอนนี้ค่ะ ติดตามได้เร็วๆ นี้นะคะ",
};

// Words a customer may type (the OA Manager menu buttons arrive as postbacks, see handle()).
const KEYWORDS: Record<string, "card" | "promotions"> = {
  "บัตรสมาชิก": "card", "สมาชิก": "card", "members": "card", "member": "card",
  "โปรโมชั่น": "promotions", "โปรโมชัน": "promotions", "โปร": "promotions", "promotions": "promotions",
  "promotion": "promotions", "คูปอง": "promotions", "คูปองของฉัน": "promotions", "coupons": "promotions", "coupon": "promotions",
};

const RED = "#C8102E", GREY = "#8E8E93", INK = "#1D1D1F", LINE_GREY = "#E5E5EA", GREEN = "#1A7F3C";
const txt = (text: string, o: Record<string, unknown> = {}) => ({ type: "text", text, wrap: true, align: "center", ...o });

// ---------- member card ----------
async function memberCard(userId: string) {
  const s = await settings();
  const [m] = await sql`select phone from crm.line_members where line_user_id = ${userId}`;
  if (!m?.phone) return null;
  const t = bkkDate();
  const [pts] = await sql`select points, to_char(synced_at at time zone 'Asia/Bangkok','YYYY-MM-DD') sd,
                                 to_char(synced_at at time zone 'Asia/Bangkok','HH24:MI') st
                          from crm.pos_points where phone = ${m.phone}`;
  const rewards = await sql`
    select coalesce(d.display_name, r.ers_name) name, r.points
    from crm.pos_rewards r left join crm.reward_display d using (item_code)
    where not coalesce(d.hidden, false) order by r.points, name`;
  // earned coupons (0025) with the same template, title, dates and status show as one box "×N"
  const coupons = await sql`
    select min(id) id, min(kind) kind, bool_or(template_id is not null) earned, title, max(detail) detail,
           to_char(valid_from,'YYYY-MM-DD') vf, to_char(valid_to,'YYYY-MM-DD') vt,
           max(to_char(redeemed_at at time zone 'Asia/Bangkok','HH24:MI')) used_at, st, count(*)::int n,
           max(u_from) u_from, max(u_to) u_to, max(u_days) u_days,
           bool_or(rule_id is not null and gifted_from is null) giftable, max(from_name) from_name
    from (select c.*, case when c.redeemed_at is not null then 'used' when ${t}::date < c.valid_from then 'soon' else 'ready' end st,
                 to_char(tp.use_from, 'HH24:MI') u_from, to_char(tp.use_to, 'HH24:MI') u_to, array_to_string(tp.use_days, ',') u_days,
                 case when c.gifted_from is not null then coalesce(gm.full_name, gm.display_name, '') end from_name
          from crm.coupons c left join crm.coupon_templates tp on tp.id = c.template_id
               left join crm.line_members gm on gm.line_user_id = c.gifted_from
          where c.line_user_id = ${userId}
            and (c.redeemed_at is null and c.valid_to >= ${t}::date
                 or (c.redeemed_at at time zone 'Asia/Bangkok')::date = ${t}::date)) c
    group by coalesce(template_id::text, 'c' || id), title, valid_from, valid_to, st, gifted_from
    order by valid_from, min(id)`;

  const body: unknown[] = [
    txt("เบอร์สมาชิก", { size: "sm", color: GREY }),
    txt(fmtPhone(m.phone), { size: "3xl", weight: "bold" }),
    { type: "separator", margin: "lg" },
  ];
  const balance = pts ? Number(pts.points) : null;
  if (pts) {
    const when = pts.sd === t ? `อัปเดต ${pts.st}` : `อัปเดต ${thDate(pts.sd)} ${pts.st}`;
    body.push(
      txt("แต้มสะสม", { size: "sm", color: GREY, margin: "lg" }),
      txt(`${fmtNum(balance!)} แต้ม`, { size: "xxl", weight: "bold", color: RED }),
      txt(`${when} · ${s.points_expiry_note || "แต้มมีอายุ 3 เดือน"}`, { size: "xs", color: GREY }),
    );
  } else {
    body.push(
      txt("ยังไม่มีแต้ม", { size: "md", weight: "bold", margin: "lg" }),
      txt("แจ้งเบอร์นี้ที่แคชเชียร์เพื่อเริ่มสะสม", { size: "sm", color: GREY }),
    );
  }
  if (rewards.length) {
    // section 1 of 2 (Point 2026-11-23): point rewards, clearly apart from the coupons below
    body.push({ type: "separator", margin: "xl" },
      txt("แลกแต้ม", { size: "md", weight: "bold", color: INK, margin: "lg" }),
      txt("ของรางวัลจากแต้มสะสม · แลกที่แคชเชียร์", { size: "xs", color: GREY }));
    for (const r of rewards) {
      const cost = Number(r.points), ok = balance !== null && balance >= cost;
      body.push({
        type: "box", layout: "vertical", margin: "sm", paddingAll: "10px", cornerRadius: "10px",
        borderWidth: "1px", borderColor: ok ? RED : LINE_GREY, backgroundColor: ok ? "#FFF5F6" : "#F7F7F8",
        contents: [
          txt(r.name, { size: "sm", weight: "bold", color: ok ? INK : GREY }),
          txt(ok ? `${fmtNum(cost)} แต้ม · แลกได้ที่แคชเชียร์`
                 : `${fmtNum(cost)} แต้ม · อีก ${fmtNum(cost - (balance ?? 0))} แต้ม`,
              { size: "xs", color: ok ? GREEN : GREY }),
        ],
      });
    }
  }
  // section 2 of 2: coupons on the card
  if (coupons.length) body.push({ type: "separator", margin: "xl" },
    txt("คูปองของฉัน", { size: "md", weight: "bold", color: INK, margin: "lg" }),
    txt("ให้พนักงานกดใช้สิทธิ์ที่แคชเชียร์", { size: "xs", color: GREY }));
  for (const c of coupons) {
    const used = c.st === "used", soon = c.st === "soon";
    const contents: unknown[] = [
      txt(c.n > 1 ? `${c.title} ×${c.n}` : c.title, { weight: "bold", size: "lg", color: used ? GREY : INK, decoration: used ? "line-through" : "none" }),
      txt(used ? `ใช้สิทธิ์แล้ว ${c.used_at} น.`
        : soon ? (c.kind === "signup" ? `ใช้ได้ในการมาครั้งถัดไป ${thDate(c.vf)} ถึง ${thDate(c.vt)}`
                                      : `เริ่มใช้ได้ ${thDate(c.vf)} ถึง ${thDate(c.vt)}`)
        : `ใช้ได้ถึง ${thDate(c.vt)}`, { size: "sm", color: used ? GREEN : GREY }),
    ];
    if (c.detail) contents.push(txt(c.detail, { size: "xs", color: GREY }));
    const ut = useText(c.u_from, c.u_to, c.u_days ? String(c.u_days).split(",").map(Number) : null);
    if (ut && !used) contents.push(txt(ut, { size: "xs", color: INK, weight: "bold" }));
    if (c.earned) contents.push(txt("ใช้ร่วมกับโปรโมชั่นอื่นไม่ได้", { size: "xs", color: GREY }));
    if (c.from_name !== null && c.from_name !== undefined) contents.push(txt(`ได้รับจาก ${maskName(c.from_name, null)}`, { size: "xs", color: GREEN }));
    if (c.st === "ready") contents.push({
      type: "button", style: "primary", color: RED, height: "sm", margin: "md",
      action: { type: "postback", label: "ใช้สิทธิ์ (สำหรับพนักงาน)", data: `action=redeem&id=${c.id}` },
    });
    body.push({
      type: "box", layout: "vertical", margin: "lg", paddingAll: "12px", cornerRadius: "12px",
      borderWidth: "2px", borderColor: used || soon ? LINE_GREY : RED, contents,
    });
  }
  // gift button (0031): one per card, only when gifts are on and something can be passed on
  if (s.coupon_gifts === "on" && s.gift_form_url && coupons.some((c: any) => c.giftable && c.st !== "used")) {
    const tok = newToken();
    await sql`delete from crm.gift_tokens where expires_at < now() - interval '1 day'`;
    await sql`insert into crm.gift_tokens (token, line_user_id) values (${tok}, ${userId})`;
    body.push({ type: "button", style: "secondary", height: "sm", margin: "lg",
      action: { type: "uri", label: "ส่งต่อคูปองให้เพื่อน", uri: `${s.gift_form_url}?t=${tok}` } });
  }
  return {
    type: "flex", altText: `บัตรสมาชิก ${fmtPhone(m.phone)}`,
    contents: {
      type: "bubble",
      header: { type: "box", layout: "vertical", backgroundColor: RED, paddingAll: "14px",
        contents: [txt(s.brand_name || "Mama Pook", { color: "#FFFFFF", weight: "bold", size: "lg" }),
                   txt("บัตรสมาชิก", { color: "#FFFFFF", size: "sm" })] },
      body: { type: "box", layout: "vertical", spacing: "sm", contents: body },
    },
  };
}

// ---------- PROMOTIONS ----------
// Card look = crm.settings.promo_style (0018, set in the sales site CRM › โปรโมชั่น with a live preview).
const PROMO_STYLE = { size: "kilo", ratio: "20:13", band: false, band_text: "โปรโมชั่น", color: RED,
                      title_color: INK, dates: "end", branch: true };
function promoStyle(s: Record<string, string>) {
  try { return { ...PROMO_STYLE, ...JSON.parse(s.promo_style || "{}") }; } catch { return PROMO_STYLE; }
}
async function promotions(userId: string | null, includeInactive = false) {
  // branch_ids (0016): null/empty = all branches; otherwise only members whose sign-up branch is listed
  const t = bkkDate(), st = promoStyle(await settings());
  const [m] = userId ? await sql`select m.branch_id, b.name branch from crm.line_members m
                                 left join crm.branches b using (branch_id) where m.line_user_id = ${userId}` : [null];
  const rows = await sql`
    select p.title, p.body, p.image_url, to_char(p.valid_from,'YYYY-MM-DD') vf, to_char(p.valid_to,'YYYY-MM-DD') vt,
           coalesce(cardinality(p.branch_ids), 0) > 0 only_some, p.button_label, p.button_url
    from crm.promotions p
    where (p.active or ${includeInactive}) and ${t}::date between p.valid_from and p.valid_to
      and (coalesce(cardinality(p.branch_ids), 0) = 0 or ${m?.branch_id ?? -1} = any(p.branch_ids) or ${includeInactive})
    order by p.sort, p.valid_to limit 12`;
  if (!rows.length) return null;
  const meta = (r: any) => {
    const parts: string[] = [];
    if (st.dates === "end") parts.push(`ถึง ${thDate(r.vt)}`);
    else if (st.dates === "range") parts.push(`${r.vf.slice(8, 10)}/${r.vf.slice(5, 7)} – ${thDate(r.vt)}`);
    if (st.branch) parts.push(r.only_some ? (m?.branch ? `สาขา ${m.branch}` : "บางสาขา") : "ทุกสาขา");
    return parts.join(" · ");
  };
  return {
    type: "flex", altText: "โปรโมชั่น Mama Pook",
    contents: { type: "carousel", contents: rows.map((r) => ({
      type: "bubble", size: st.size,
      ...(st.band ? { header: { type: "box", layout: "vertical", backgroundColor: st.color, paddingAll: "8px",
        contents: [txt(st.band_text || "โปรโมชั่น", { color: "#FFFFFF", weight: "bold", size: "sm", align: "start" })] } } : {}),
      ...(r.image_url ? { hero: { type: "image", url: r.image_url, size: "full", aspectMode: "cover", aspectRatio: st.ratio } } : {}),
      body: { type: "box", layout: "vertical", spacing: "sm", contents: [
        txt(r.title, { weight: "bold", size: "md", align: "start", color: st.title_color }),
        ...(r.body ? [txt(r.body, { size: "sm", align: "start" })] : []),
        ...(meta(r) ? [txt(meta(r), { size: "xs", color: GREY, align: "start" })] : []),
      ] },
      ...(r.button_label && r.button_url ? { footer: { type: "box", layout: "vertical", contents: [{
        type: "button", style: "primary", color: st.color, height: "sm",
        action: { type: "uri", label: r.button_label, uri: r.button_url } }] } } : {}),
    })) },
  };
}

// ---------- sign-up button (one-time link to the form) ----------
async function signupMessage(userId: string, s: Record<string, string>) {
  const tok = newToken();
  await sql`insert into crm.signup_tokens (token, line_user_id) values (${tok}, ${userId})`;
  const url = `${s.signup_form_url}?t=${tok}`;
  return {
    type: "flex", altText: "สมัครสมาชิก Mama Pook",
    contents: { type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "sm", contents: [
        txt("สมัครสมาชิก Mama Pook", { weight: "bold", size: "lg" }),
        ...(s.signup_reward !== "off" ? [txt(`รับฟรี ${s.reward_text || "เก๊กฮวย 1 แก้ว"} ในการมาครั้งถัดไป`, { size: "sm" })] : []),
        txt("สะสมแต้ม 100 บาท = 1 แต้ม เพื่อแลกของฟรี", { size: "sm", color: GREY }),
      ] },
      footer: { type: "box", layout: "vertical", contents: [{
        type: "button", style: "primary", color: RED, height: "sm",
        action: { type: "uri", label: "สมัครสมาชิก", uri: url },
      }] },
    },
  };
}

// MEMBERS / PROMOTIONS taps (postbacks or typed words). Non-members get the sign-up button for MEMBERS.
async function onMenu(userId: string, replyToken: string, what: "card" | "promotions" | "register") {
  await ensureMember(userId);
  const s = await settings();
  if (what === "promotions") {
    const p = await promotions(userId);
    return p ? send(replyToken, [p]) : reply(replyToken, MSG.noPromo);
  }
  const card = await memberCard(userId);
  if (!card) return send(replyToken, [await signupMessage(userId, s)]);
  return send(replyToken, what === "register" ? [{ type: "text", text: MSG.already }, card] : [card]);
}

// LINE cannot remove buttons from a message already in the chat, so the server decides whether a confirm is still
// good (Point 2026-11-23): its two buttons carry the same time stamp; ยืนยัน is refused once that confirm's ยกเลิก was
// pressed (every postback is in raw.line_events) or after 10 minutes. Confirms without a stamp (older ones) are dead.
const CONFIRM_MS = 10 * 60e3;
function confirmActions(id: number | string) {
  const ts = Date.now();
  return [{ type: "postback", label: "ยืนยัน", data: `action=redeem_ok&id=${id}&ts=${ts}` },
          { type: "postback", label: "ยกเลิก", data: `action=cancel&id=${id}&ts=${ts}` }];
}
async function confirmDead(userId: string, id: number, ts: number): Promise<string | null> {
  if (!Number.isFinite(ts) || ts <= 0 || Date.now() - ts > CONFIRM_MS)
    return "หมดเวลายืนยันแล้วค่ะ ยังไม่ได้ใช้สิทธิ์ กรุณากดปุ่ม \"ใช้สิทธิ์\" บนบัตรสมาชิกอีกครั้ง";
  const [c] = await sql`select 1 from raw.line_events where line_user_id = ${userId} and event_type = 'postback'
      and payload->'postback'->>'data' = ${`action=cancel&id=${id}&ts=${ts}`} limit 1`;
  return c ? "รายการนี้กดยกเลิกไปแล้วค่ะ ยังไม่ได้ใช้สิทธิ์ หากต้องการใช้ กรุณากดปุ่ม \"ใช้สิทธิ์\" บนบัตรสมาชิกอีกครั้ง" : null;
}

// Two-step redeem: the button asks for confirmation; only "ยืนยัน" marks the coupon used.
async function onRedeem(userId: string, replyToken: string, id: number, confirmed: boolean) {
  const [tap] = await sql`select template_id, title from crm.coupons where id = ${id} and line_user_id = ${userId}`;
  if (!tap) return;
  if (tap.template_id != null) return onRedeemEarned(userId, replyToken, id, tap, confirmed);
  const [c] = await sql`
    select title, to_char(valid_from,'YYYY-MM-DD') vf, to_char(valid_to,'YYYY-MM-DD') vt,
           to_char(redeemed_at at time zone 'Asia/Bangkok','DD/MM HH24:MI') used_at,
           ${bkkDate()}::date < valid_from too_early, ${bkkDate()}::date > valid_to expired
    from crm.coupons where id = ${id} and line_user_id = ${userId}`;
  if (!c) return;
  if (c.used_at) return reply(replyToken, `คูปองนี้ใช้สิทธิ์ไปแล้วเมื่อ ${c.used_at} น. ค่ะ`);
  if (c.too_early) return reply(replyToken, `คูปองนี้เริ่มใช้ได้ตั้งแต่ ${thDate(c.vf)} ค่ะ`);
  if (c.expired) return reply(replyToken, `คูปองนี้หมดอายุแล้วเมื่อ ${thDate(c.vt)} ค่ะ`);
  if (!confirmed) {
    return send(replyToken, [{
      type: "template", altText: "ยืนยันใช้สิทธิ์",
      template: { type: "confirm", text: `พนักงาน: ยืนยันใช้สิทธิ์ "${c.title}" ?\nแล้วใส่คูปองในบิลที่ POS`,
        actions: confirmActions(id) },
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

// Earned coupons (0025): the card's button stands for a stack of the same coupon. The confirm names one coupon id
// (the one expiring soonest) and "ยืนยัน" uses exactly that id, so a double tap can never use two.
async function onRedeemEarned(userId: string, replyToken: string, id: number, tap: any, confirmed: boolean) {
  const d = bkkDate();
  const [w] = await sql`select to_char(use_from, 'HH24:MI') f, to_char(use_to, 'HH24:MI') t, use_days::int[] days
      from crm.coupon_templates where id = ${tap.template_id}`;
  if (w) {
    const chk = useWindow(w.f, w.t, w.days);
    if (!chk.ok) return reply(replyToken,
      `ยังใช้คูปอง "${tap.title}" ตอนนี้ไม่ได้ค่ะ (ตอนนี้ ${chk.now} น.)\n${useText(w.f, w.t, w.days)} · คูปองยังอยู่ในบัตรสมาชิกเหมือนเดิม`);
  }
  const left = async () => (await sql`select count(*)::int n from crm.coupons where line_user_id = ${userId}
      and template_id = ${tap.template_id} and title = ${tap.title} and redeemed_at is null
      and ${d}::date between valid_from and valid_to`)[0].n as number;
  if (confirmed) {
    const done = await sql`update crm.coupons set redeemed_at = now()
        where id = ${id} and line_user_id = ${userId} and redeemed_at is null and ${d}::date between valid_from and valid_to
        returning to_char(redeemed_at at time zone 'Asia/Bangkok','HH24:MI') at`;
    if (!done.length) return reply(replyToken, `คูปองใบนี้ใช้ไปแล้วหรือหมดอายุแล้วค่ะ (เหลือ ${await left()} ใบ)`);
    return reply(replyToken, `✅ ใช้สิทธิ์ "${tap.title}" 1 ใบ เวลา ${done[0].at} น. · เหลือ ${await left()} ใบ\nพนักงาน: ใส่ส่วนลดในบิลที่ POS ค่ะ`);
  }
  const [c] = await sql`select c.id, tp.ers_hint from crm.coupons c left join crm.coupon_templates tp on tp.id = c.template_id
      where c.line_user_id = ${userId} and c.template_id = ${tap.template_id} and c.title = ${tap.title}
        and c.redeemed_at is null and ${d}::date between c.valid_from and c.valid_to
      order by c.valid_to, c.id limit 1`;
  if (!c) return reply(replyToken, `วันนี้ไม่มีคูปอง "${tap.title}" ที่ใช้ได้แล้วค่ะ`);
  const text = `พนักงาน: ยืนยันใช้สิทธิ์ "${tap.title}" 1 ใบ? (มี ${await left()} ใบ)\nใช้ร่วมกับโปรโมชั่นอื่นไม่ได้` +
    (c.ers_hint ? `\nใส่ ${c.ers_hint} ที่ POS` : "");
  return send(replyToken, [{
    type: "template", altText: "ยืนยันใช้สิทธิ์",
    template: { type: "confirm", text: text.slice(0, 240),
      actions: confirmActions(c.id) },
  }]);
}

async function handle(ev: any) {
  const userId: string | undefined = ev.source?.userId;
  await sql`insert into raw.line_events (event_type, line_user_id, event_ts, payload)
            values (${ev.type}, ${userId ?? null}, to_timestamp(${(ev.timestamp ?? Date.now()) / 1000}), ${sql.json(ev)})`;
  if (!userId || ev.source?.type !== "user") return;

  if (ev.type === "follow") {                     // the OA greeting text comes from the OA Manager; we add the button
    await ensureMember(userId);
    const s = await settings();
    if (await memberCard(userId)) return;         // re-follow of a linked member: nothing extra
    return send(ev.replyToken, [await signupMessage(userId, s)]);
  }
  if (ev.type === "unfollow") {
    await sql`update crm.line_members set blocked_at = now(), updated_at = now() where line_user_id = ${userId}`;
    return;
  }
  if (ev.type === "postback") {
    const q = new URLSearchParams(ev.postback?.data ?? "");
    if (q.get("oaPlusRichMenu") === "true") {
      const s = await settings(), id = q.get("actionId") ?? "";
      if (id && id === s.menu_action_card) return onMenu(userId, ev.replyToken, "card");
      if (id && (id === s.menu_action_promotions || id === s.menu_action_coupons)) return onMenu(userId, ev.replyToken, "promotions");
      console.log("unmapped OA menu action", id, q.get("version"));
      return;
    }
    const action = q.get("action");
    if (action === "card" || action === "register") return onMenu(userId, ev.replyToken, action);
    if (action === "promotions" || action === "coupons") return onMenu(userId, ev.replyToken, "promotions");
    if (action === "redeem_ok") {
      const dead = await confirmDead(userId, Number(q.get("id")), Number(q.get("ts")));
      if (dead) return reply(ev.replyToken, dead);
    }
    if (action === "redeem" || action === "redeem_ok") return onRedeem(userId, ev.replyToken, Number(q.get("id")), action === "redeem_ok");
    if (action === "noop" || action === "cancel") return reply(ev.replyToken, "ยกเลิกแล้วค่ะ ยังไม่ได้ใช้สิทธิ์ คูปองยังอยู่ในบัตรสมาชิกเหมือนเดิม");   // the confirm's ยกเลิก
    return;
  }
  if (ev.type === "message" && ev.message?.type === "text") {
    const word = KEYWORDS[(ev.message.text ?? "").trim().toLowerCase()];
    if (word) return onMenu(userId, ev.replyToken, word);
    const { digitLike } = cleanNumber(ev.message.text ?? "");
    if (!digitLike) return;                       // ordinary chat: stay silent for staff
    return onMenu(userId, ev.replyToken, "register"); // a typed number: card if linked, else the form button
  }
}

// ---------- sign-up form API (/signup) ----------
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
               "Access-Control-Allow-Headers": "content-type" };
const json = (o: unknown, status = 200) => Response.json(o, { status, headers: CORS });

async function tokenRow(tok: string) {
  if (!/^[a-f0-9]{40}$/.test(tok)) return null;
  const [r] = await sql`select t.line_user_id, m.phone, m.full_name, m.display_name,
                               to_char(m.birthday,'YYYY-MM-DD') birthday, m.branch_id, m.consent_at
                        from crm.signup_tokens t join crm.line_members m using (line_user_id)
                        where t.token = ${tok} and t.used_at is null and t.expires_at > now()`;
  return r ?? null;
}

async function signupApi(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const s = await settings();
  if (req.method === "GET") {
    const r = await tokenRow(new URL(req.url).searchParams.get("t") ?? "");
    if (!r) return json({ ok: false, error: "expired" }, 410);
    const branches = await sql`select branch_id id, name from crm.branches where active order by sort`;
    return json({ ok: true, member: { phone: r.phone, full_name: r.full_name ?? r.display_name ?? "",
      birthday: r.birthday, branch_id: r.branch_id }, branches, privacy_version: s.privacy_version,
      reward: s.signup_reward !== "off" ? s.reward_text : null });
  }
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  let f: any;
  try { f = await req.json(); } catch { return json({ ok: false, error: "ข้อมูลไม่ถูกต้อง" }, 400); }
  const r = await tokenRow(String(f.t ?? ""));
  if (!r) return json({ ok: false, error: "ลิงก์นี้ใช้แล้วหรือหมดอายุค่ะ กลับไปที่แชตแล้วกด MEMBERS เพื่อรับลิงก์ใหม่" }, 410);
  const name = String(f.full_name ?? "").trim().slice(0, 100);
  const bday = String(f.birthday ?? "");
  const branchId = Number(f.branch_id);
  const { phone } = cleanNumber(String(f.phone ?? ""));
  const bdOk = /^\d{4}-\d{2}-\d{2}$/.test(bday) && bday >= "1920-01-01" && bday <= bkkDate(-365 * 5);
  const [br] = Number.isInteger(branchId) ? await sql`select 1 from crm.branches where branch_id = ${branchId} and active` : [];
  if (name.length < 2) return json({ ok: false, error: "กรุณากรอกชื่อค่ะ" }, 400);
  if (!bdOk) return json({ ok: false, error: "กรุณาเลือกวันเกิดค่ะ" }, 400);
  if (!br) return json({ ok: false, error: "กรุณาเลือกสาขาค่ะ" }, 400);
  if (!phone) return json({ ok: false, error: "เบอร์โทรไม่ถูกต้องค่ะ กรุณากรอก 10 หลัก เช่น 0812345678" }, 400);
  if (f.consent !== true) return json({ ok: false, error: "กรุณากดยินยอมก่อนสมัครค่ะ" }, 400);
  if (r.phone && r.phone !== phone) return json({ ok: false, error: MSG.otherNumber(r.phone) }, 409);
  const [owner] = await sql`select 1 from crm.line_members where phone = ${phone} and line_user_id <> ${r.line_user_id}`;
  if (owner) return json({ ok: false, error: MSG.taken }, 409);

  const isNew = !r.phone;
  const days = Math.max(1, parseInt(s.reward_days || "14", 10));
  const from = bkkDate(1), to = bkkDate(days);
  const reward = s.reward_text || "เก๊กฮวยฟรี 1 แก้ว";
  const giveReward = s.signup_reward !== "off";   // 0015 switch (Point 2026-11-18: off for now)
  try {
    await sql.begin(async (tx) => {
      const used = await tx`update crm.signup_tokens set used_at = now() where token = ${f.t} and used_at is null returning 1`;
      if (!used.length) throw new Error("token raced");
      await tx`update crm.line_members set phone = ${phone}, linked_at = coalesce(linked_at, now()),
                 full_name = ${name}, birthday = ${bday}, branch_id = ${branchId},
                 consent_at = now(), consent_version = ${s.privacy_version || null},
                 signup_source = coalesce(signup_source, 'form'), updated_at = now()
               where line_user_id = ${r.line_user_id}`;
      if (isNew && giveReward) await tx`insert into crm.coupons (line_user_id, kind, title, valid_from, valid_to)
                          values (${r.line_user_id}, 'signup', ${reward}, ${from}, ${to})
                          on conflict (line_user_id, kind) do nothing`;
    });
  } catch (e) {
    if (String(e).includes("line_members_phone_uq")) return json({ ok: false, error: MSG.taken }, 409);
    console.error("signup failed", e);
    return json({ ok: false, error: "บันทึกไม่สำเร็จ กรุณาลองใหม่อีกครั้งค่ะ" }, 500);
  }
  if (s.signup_push !== "off") {
    try {
      const card = await memberCard(r.line_user_id);
      await push(r.line_user_id, [{ type: "text", text: isNew ? MSG.confirm(phone, giveReward ? reward : null, from, to) : MSG.updated }, card]);
    } catch (e) { console.error("signup push failed", e); }
  }
  return json({ ok: true, isNew });
}

// ---------- coupon gift page API (/gift, 0031) ----------
const GIFT_ERR: Record<string, string> = {
  expired: "ลิงก์นี้ใช้แล้วหรือหมดอายุค่ะ กลับไปที่แชต LINE แล้วกด MEMBERS เพื่อเปิดบัตรใหม่",
  not_member: "เบอร์นี้ยังไม่ได้เป็นสมาชิก Mama Pook ใน LINE ค่ะ ชวนเพื่อนสมัครสมาชิกก่อนแล้วค่อยส่งนะคะ",
  self: "ส่งให้เบอร์ของตัวเองไม่ได้ค่ะ",
  not_enough: "คูปองไม่พอหรือถูกใช้ไปแล้วค่ะ กลับไปที่แชตแล้วกด MEMBERS เพื่อเปิดบัตรใหม่",
  bad_qty: "กรุณาเลือกคูปองและจำนวนค่ะ", nothing: "กรุณาเลือกคูปองและจำนวนค่ะ",
  too_many: "ค้นหาเบอร์เกินจำนวนครั้งแล้วค่ะ กลับไปที่แชตแล้วกด MEMBERS เพื่อเปิดลิงก์ใหม่",
  phone: "เบอร์โทรไม่ถูกต้องค่ะ กรุณากรอก 10 หลัก เช่น 0812345678",
};
async function giftTokenUser(tok: string): Promise<string | null> {
  if (!/^[a-f0-9]{40}$/.test(tok)) return null;
  const [r] = await sql`select line_user_id from crm.gift_tokens where token = ${tok} and used_at is null and expires_at > now()`;
  return r?.line_user_id ?? null;
}
async function giftApi(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const t = bkkDate();
  if (req.method === "GET") {
    const u = await giftTokenUser(new URL(req.url).searchParams.get("t") ?? "");
    if (!u) return json({ ok: false, error: GIFT_ERR.expired }, 410);
    const stacks = await sql`
      select min(id)::int key, title, max(detail) detail, to_char(valid_from,'YYYY-MM-DD') vf, to_char(valid_to,'YYYY-MM-DD') vt,
             count(*)::int n, ${t}::date < valid_from soon
      from crm.coupons where line_user_id = ${u} and rule_id is not null and gifted_from is null
        and redeemed_at is null and valid_to >= ${t}::date
      group by template_id, title, valid_from, valid_to order by valid_to, min(id)`;
    return json({ ok: true, stacks });
  }
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  let f: any;
  try { f = await req.json(); } catch { return json({ ok: false, error: "ข้อมูลไม่ถูกต้อง" }, 400); }
  const tok = String(f.t ?? "");
  const u = await giftTokenUser(tok);
  if (!u) return json({ ok: false, error: GIFT_ERR.expired }, 410);
  const { phone } = cleanNumber(String(f.phone ?? ""));
  if (!phone) return json({ ok: false, error: GIFT_ERR.phone }, 400);
  if (f.confirm !== true) {            // step 1: who is this number? (counted, max 10 per link)
    const ok = await sql`update crm.gift_tokens set lookups = lookups + 1 where token = ${tok} and lookups < 10 returning 1`;
    if (!ok.length) return json({ ok: false, error: GIFT_ERR.too_many }, 429);
    const [m] = await sql`select line_user_id, full_name, display_name from crm.line_members
                          where phone = ${phone} and linked_at is not null and blocked_at is null`;
    if (!m) return json({ ok: false, error: GIFT_ERR.not_member }, 404);
    if (m.line_user_id === u) return json({ ok: false, error: GIFT_ERR.self }, 400);
    return json({ ok: true, name: maskName(m.full_name, m.display_name), last4: phone.slice(-4) });
  }
  const items = Array.isArray(f.items) ? f.items.map((x: any) => ({ key: Number(x.key), n: Number(x.n) }))
                                         .filter((x: any) => Number.isInteger(x.key) && Number.isInteger(x.n) && x.n > 0) : [];
  try {             // step 2: move them (all or nothing, crm.gift_coupons)
    const [{ r }] = await sql`select crm.gift_coupons(${tok}, ${phone}, ${JSON.stringify(items)}::text::jsonb) r`;
    const [m] = await sql`select full_name, display_name from crm.line_members where line_user_id = ${r.to_user}`;
    return json({ ok: true, n: r.n, items: r.items, name: maskName(m?.full_name, m?.display_name) });
  } catch (e) {
    const code = /gift:(\w+)/.exec(String(e))?.[1];
    if (!code) console.error("gift failed", e);
    return json({ ok: false, error: GIFT_ERR[code ?? ""] ?? "ส่งไม่สำเร็จ กรุณาลองใหม่อีกครั้งค่ะ" }, code ? 409 : 500);
  }
}

// ---------- admin push (one-time key) ----------
async function adminPush(req: Request, body: string, sendKey: string): Promise<Response> {
  const armed = await sql`update crm.settings set value = null, updated_at = now()
                          where key = 'send_key' and value is not null and value = ${sendKey} returning 1`;
  if (armed.length !== 1) return new Response("not armed", { status: 403 });
  try {
    const { to, mode, note, include_inactive } = JSON.parse(body);
    const s = await settings();
    let msg: unknown = null;
    if (mode === "card") msg = await memberCard(String(to));
    else if (mode === "promotions") msg = await promotions(String(to), include_inactive === true);
    else if (mode === "signup") msg = await signupMessage(String(to), s);
    if (!msg) return Response.json({ ok: false, error: `nothing to send for mode ${mode}` }, { status: 400 });
    await push(String(to), note ? [{ type: "text", text: String(note) }, msg] : [msg]);
    return Response.json({ ok: true, mode });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname;
  if (path.endsWith("/signup")) return signupApi(req);
  if (path.endsWith("/gift")) return giftApi(req);
  if (req.method !== "POST") return new Response("ok");
  const body = await req.text();
  const sendKey = req.headers.get("x-send-key");
  if (sendKey) return adminPush(req, body, sendKey);
  if (!(await validSignature(body, req.headers.get("x-line-signature")))) {
    return new Response("bad signature", { status: 401 });
  }
  const events = JSON.parse(body).events ?? [];
  for (const ev of events) {
    try { await handle(ev); } catch (e) { console.error("event failed", ev?.type, e); }
  }
  return new Response("ok");   // always 200 so LINE does not retry-storm
});
