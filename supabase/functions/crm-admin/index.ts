// crm-admin — the CRM area of the sales site (Point 2026-11-18). Config, members, promotions, rewards,
// promotional LINE coupon sends, results and insights for the LINE member program.
// Caller: the sales site's Pages Function /api/crm (behind the whole-site login), which adds
//   x-admin-key  = Pages secret CRM_ADMIN_KEY   (sha256 must equal crm.settings.admin_key_sha256)
//   x-admin-user = the logged-in user name      (written to crm.admin_log / crm.coupon_sends)
// One door: POST {op, ...}. Reads: overview, members, config, sends. Writes (all logged): set_setting,
// promo_save, promo_delete, reward_save, test_points_save, test_points_delete, change_phone,
// coupon_preview, coupon_send. coupon_send needs `expect` = the recipient count the page showed in
// the preview, so a send never reaches more people than were confirmed.
// Secrets: LINE_CHANNEL_ID + LINE_CHANNEL_SECRET (token minted here) or LINE_CHANNEL_ACCESS_TOKEN.
// verify_jwt = false (the admin key is the guard).
// v6 (2026-11-20): coupon_send takes reward (validReward), usageCondition (≤100, staff check it) and maxUse (1 | -1).
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });
const FIXED_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
const CHANNEL_ID = Deno.env.get("LINE_CHANNEL_ID") ?? "";
const CHANNEL_SECRET = Deno.env.get("LINE_CHANNEL_SECRET") ?? "";

// settings the page may change (everything else in crm.settings is wiring, not config)
const EDITABLE: Record<string, (v: string) => boolean> = {
  brand_name: (v) => v.length >= 2 && v.length <= 40,
  reward_text: (v) => v.length >= 2 && v.length <= 60,
  reward_days: (v) => /^\d+$/.test(v) && +v >= 1 && +v <= 90,
  points_expiry_note: (v) => v.length <= 60,
  signup_push: (v) => v === "on" || v === "off",
  signup_reward: (v) => v === "on" || v === "off",
  privacy_version: (v) => v.length >= 2 && v.length <= 40,
  promo_style: (v) => validStyle(v),
};
// promotion card look (0018): every key optional, unknown keys refused
function validStyle(v: string): boolean {
  let o: any; try { o = JSON.parse(v); } catch { return false; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return false;
  const HEX = /^#[0-9A-Fa-f]{6}$/;
  const ok: Record<string, (x: any) => boolean> = {
    size: (x) => ["kilo", "mega", "giga"].includes(x), ratio: (x) => ["20:13", "1:1", "3:4"].includes(x),
    band: (x) => typeof x === "boolean", band_text: (x) => typeof x === "string" && x.length <= 20,
    color: (x) => HEX.test(x), title_color: (x) => HEX.test(x),
    dates: (x) => ["end", "range", "none"].includes(x), branch: (x) => typeof x === "boolean",
  };
  return Object.keys(o).every((k) => ok[k] && ok[k](o[k]));
}
const PHONE = /^0[689]\d{8}$/;
// LINE coupon reward (2026-11-20): free / gift / others, or a discount: fixed ฿, percentage 1–99, or explicit (was → now)
function validReward(r: any): any {
  const pos = (x: any) => Number.isInteger(x) && x > 0;
  if (!r || typeof r !== "object") return { type: "free" };
  if (["free", "gift", "others"].includes(r.type)) return { type: r.type };
  if (r.type !== "discount" || !r.priceInfo) return null;
  const p = r.priceInfo;
  if (p.type === "fixed" && pos(p.fixedAmount)) return { type: "discount", priceInfo: { type: "fixed", fixedAmount: p.fixedAmount } };
  if (p.type === "percentage" && pos(p.percentage) && p.percentage <= 99) return { type: "discount", priceInfo: { type: "percentage", percentage: p.percentage } };
  if (p.type === "explicit" && pos(p.originalPrice) && pos(p.priceAfterDiscount) && p.priceAfterDiscount < p.originalPrice)
    return { type: "discount", priceInfo: { type: "explicit", originalPrice: p.originalPrice, priceAfterDiscount: p.priceAfterDiscount } };
  return null;
}
const DAY = /^\d{4}-\d{2}-\d{2}$/;

async function token(): Promise<string> {
  if (FIXED_TOKEN) return FIXED_TOKEN;
  const r = await fetch("https://api.line.me/oauth2/v3/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: CHANNEL_ID, client_secret: CHANNEL_SECRET }),
  });
  if (!r.ok) throw new Error(`token ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}
async function line(tok: string, path: string, body?: unknown) {
  const r = await fetch("https://api.line.me/v2/bot" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : {};
}
async function quota(tok: string) {
  const [q, c] = await Promise.all([line(tok, "/message/quota"), line(tok, "/message/quota/consumption")]);
  return { type: q.type, limit: q.type === "limited" ? Number(q.value) : null, used: Number(c.totalUsage ?? 0) };
}
async function sha256hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const bad = (msg: string, status = 400) => Response.json({ ok: false, error: msg }, { status });
const badField = (field: string, msg: string) => Response.json({ ok: false, error: msg, field }, { status: 400 });
const log = (actor: string, op: string, detail: unknown) =>
  sql`insert into crm.admin_log (actor, op, detail) values (${actor}, ${op}, ${sql.json(detail as any)})`;

// ---------- audience -> LINE user ids ----------
async function audienceIds(aud: string): Promise<string[]> {
  let rows;
  if (aud === "friends") rows = await sql`select line_user_id from crm.line_members where blocked_at is null`;
  else if (aud === "members") rows = await sql`select line_user_id from crm.line_members where blocked_at is null and phone is not null`;
  else if (/^branch:\d+$/.test(aud)) rows = await sql`select line_user_id from crm.line_members
      where blocked_at is null and phone is not null and branch_id = ${Number(aud.slice(7))}`;
  else if (/^user:U[0-9a-f]{32}$/.test(aud)) rows = await sql`select line_user_id from crm.line_members
      where blocked_at is null and line_user_id = ${aud.slice(5)}`;
  else throw new Error("unknown audience");
  return rows.map((r) => r.line_user_id as string);
}

// ---------- reads ----------
async function overview() {
  const [s] = await sql`select value from crm.settings where key = 'menu_action_card'`;
  const [p] = await sql`select value from crm.settings where key = 'menu_action_promotions'`;
  const cardId = s?.value ?? "-", promoId = p?.value ?? "-";
  const [k] = await sql`
    with m as (select * from crm.line_members),
         minr as (select coalesce(min(points), 0) mp from crm.pos_rewards)
    select
      count(*) filter (where blocked_at is null)                                   friends,
      count(*) filter (where blocked_at is not null)                               blocked,
      count(*) filter (where phone is not null and blocked_at is null)             members,
      count(*) filter (where phone is not null and consent_at is not null)         consented,
      count(*) filter (where phone is not null and exists (select 1 from crm.pos_points x where x.phone = m.phone))  in_ers,
      count(*) filter (where phone is not null and exists (select 1 from crm.pos_points x where x.phone = m.phone and x.points > 0)) with_points,
      count(*) filter (where phone is not null and exists (select 1 from crm.pos_points x, minr where x.phone = m.phone and minr.mp > 0 and x.points >= minr.mp)) reward_ready,
      count(*) filter (where phone is not null and exists (select 1 from crm.pos_points x where x.phone = m.phone and x.last_bill_at >= now() - interval '30 days')) active30,
      count(*) filter (where linked_at >= now() - interval '7 days')               new7,
      (select count(*) from crm.pos_points)                                          ers_phones,
      (select max(synced_at) from crm.pos_points)                                    points_synced
    from m`;
  const daily = await sql`
    with d as (select generate_series((now() at time zone 'Asia/Bangkok')::date - 29, (now() at time zone 'Asia/Bangkok')::date, '1 day')::date d)
    select to_char(d.d, 'YYYY-MM-DD') d,
      (select count(*) from crm.line_members where (added_at at time zone 'Asia/Bangkok')::date = d.d)::int follows,
      (select count(*) from crm.line_members where (linked_at at time zone 'Asia/Bangkok')::date = d.d)::int signups,
      (select count(*) from crm.coupons where (redeemed_at at time zone 'Asia/Bangkok')::date = d.d)::int redeemed
    from d order by d.d`;
  const byBranch = await sql`
    select coalesce(b.name, 'ไม่ระบุ') name, count(*)::int members,
           count(*) filter (where exists (select 1 from crm.pos_points x where x.phone = m.phone))::int in_ers
    from crm.line_members m left join crm.branches b on b.branch_id = m.branch_id
    where m.phone is not null and m.blocked_at is null group by 1 order by 2 desc`;
  const bySource = await sql`
    select coalesce(signup_source, 'chat') source, count(*)::int n from crm.line_members
    where phone is not null group by 1 order by 2 desc`;
  const [cp] = await sql`
    select count(*)::int issued,
      count(*) filter (where redeemed_at is not null)::int used,
      count(*) filter (where redeemed_at is null and valid_to < (now() at time zone 'Asia/Bangkok')::date)::int expired,
      count(*) filter (where redeemed_at is null and valid_to >= (now() at time zone 'Asia/Bangkok')::date)::int open
    from crm.coupons where kind = 'signup'`;
  const [taps] = await sql`
    select count(*) filter (where payload->'postback'->>'data' like ${"%actionId=" + cardId + "%"}
                              or payload->'postback'->>'data' = 'action=card')::int members_btn,
           count(*) filter (where payload->'postback'->>'data' like ${"%actionId=" + promoId + "%"}
                              or payload->'postback'->>'data' in ('action=promotions', 'action=coupons'))::int promotions_btn,
           count(*) filter (where payload->'postback'->>'data' like 'action=redeem_ok%')::int staff_redeems,
           count(*) filter (where event_type = 'follow')::int follows,
           count(*) filter (where event_type = 'unfollow')::int unfollows,
           count(*) filter (where event_type = 'message')::int messages
    from raw.line_events where event_ts >= now() - interval '30 days'`;
  const [form] = await sql`
    select count(*)::int links, count(*) filter (where used_at is not null)::int done
    from crm.signup_tokens where created_at >= now() - interval '30 days'`;
  const pts = await sql`
    select case when x.points = 0 then '0' when x.points < 10 then '1-9' when x.points < 20 then '10-19'
                when x.points < 50 then '20-49' else '50+' end b, count(*)::int n
    from crm.line_members m join crm.pos_points x using (phone) where m.blocked_at is null group by 1`;
  const sends = await sql`select id, to_char(at at time zone 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') at, actor, title,
      audience, recipients, error, reward, usage_condition, max_use from crm.coupon_sends order by id desc limit 10`;
  let q = null;
  try { q = await quota(await token()); } catch (_) { q = null; }
  return { kpi: k, daily, byBranch, bySource, coupons: cp, taps, form, points: pts, sends, quota: q };
}

// Point 2026-11-20: every form field + ERS visit stats (crm.pos_member_stats / pos_promo_uses, pushed with the points).
// scope 'line' = LINE friends / members (default); 'ers' = every phone ERS knows (points or in-store bills), LINE row if any.
async function members(f: any) {
  const q = String(f.q ?? "").trim();
  const like = "%" + q.replace(/[%_\\]/g, "") + "%";
  const ers = f.scope === "ers";
  const base = ers
    ? sql`select e.phone, m.line_user_id from (select phone from crm.pos_points union select phone from crm.pos_member_stats) e
          left join crm.line_members m on m.phone = e.phone`
    : sql`select m.phone, m.line_user_id from crm.line_members m`;
  const rows = await sql`
    with base as (${base})
    select coalesce(m.line_user_id, 'tel:' || bs.phone) id, m.line_user_id is not null on_line, m.display_name, m.full_name, bs.phone,
      to_char(m.birthday, 'YYYY-MM-DD') birthday,
      b.name branch, to_char(m.added_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD') added,
      to_char(m.linked_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD') linked, m.consent_at is not null consent, m.consent_version,
      coalesce(m.signup_source, case when m.phone is not null then 'chat' end) source, m.blocked_at is not null blocked,
      x.points, to_char(x.last_bill_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD') last_bill, lb.name last_branch,
      s.visits, s.days, to_char(s.first_visit, 'YYYY-MM-DD') first_visit, to_char(s.last_visit, 'YYYY-MM-DD') last_visit,
      s.bowls::float bowls, s.spend_thb::float spend, s.addon_units::float addon, s.drink_units::float drinks, s.weekend_visits, s.slots,
      (select json_agg(json_build_object('kind', c.kind, 'title', c.title, 'from', c.valid_from, 'to', c.valid_to,
               'issued', to_char(c.issued_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD'),
               'used', to_char(c.redeemed_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI')) order by c.id)
         from crm.coupons c where c.line_user_id = m.line_user_id) coupons,
      (select json_agg(json_build_object('at', to_char(u.sold_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI'),
               'branch', pb.name, 'promo', coalesce(u.promo_name, '#' || u.promo_id), 'items', u.items) order by u.sold_at desc)
         from crm.pos_promo_uses u left join crm.branches pb on pb.branch_id = u.branch_id where u.phone = bs.phone) promos,
      exists (select 1 from crm.test_points t where t.phone = bs.phone and t.expires_at > now()) test_points
    from base bs
    left join crm.line_members m on m.line_user_id = bs.line_user_id
    left join crm.branches b on b.branch_id = m.branch_id
    left join crm.pos_points x on x.phone = bs.phone
    left join crm.branches lb on lb.branch_id = x.last_branch_id
    left join crm.pos_member_stats s on s.phone = bs.phone
    where ${q} = '' or bs.phone like ${like} or m.full_name ilike ${like} or m.display_name ilike ${like}
    order by ${ers ? sql`s.visits desc nulls last, x.last_bill_at desc nulls last` : sql`m.linked_at desc nulls last, m.added_at desc`}
    limit ${ers ? 1000 : 500}`;
  const [st] = await sql`select to_char(max(synced_at) at time zone 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') synced,
      to_char(min(first_visit), 'YYYY-MM-DD') since from crm.pos_member_stats`;
  return { rows, scope: ers ? "ers" : "line", stats_synced: st?.synced ?? null, stats_since: st?.since ?? null };
}

async function config() {
  const st = await sql`select key, value, to_char(updated_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') updated
                       from crm.settings where key = any(${Object.keys(EDITABLE)}) order by key`;
  const [form] = await sql`select value from crm.settings where key = 'signup_form_url'`;
  const promos = await sql`select id, title, body, image_url, to_char(valid_from, 'YYYY-MM-DD') valid_from,
      to_char(valid_to, 'YYYY-MM-DD') valid_to, coalesce(branch_ids, '{}') branch_ids, sort, active, button_label, button_url from crm.promotions order by active desc, sort, valid_to desc`;
  const rewards = await sql`select r.item_code, r.ers_name, r.points, d.display_name, coalesce(d.hidden, false) hidden
      from crm.pos_rewards r left join crm.reward_display d using (item_code) order by r.points, r.item_code`;
  const branches = await sql`select branch_id, name, active from crm.branches order by sort`;
  const tests = await sql`select phone, points, note, to_char(expires_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') expires
      from crm.test_points where expires_at > now() order by phone`;
  const log = await sql`select to_char(at at time zone 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') at, actor, op, detail
      from crm.admin_log order by id desc limit 30`;
  return { settings: st, form_url: form?.value ?? null, promos, rewards, branches, tests, log };
}

// ---------- writes ----------
async function write(op: string, f: any, actor: string) {
  if (op === "set_setting") {
    const key = String(f.key), value = String(f.value ?? "").trim();
    if (!EDITABLE[key]) return bad("setting not editable");
    if (!EDITABLE[key](value)) return bad("ค่าไม่ถูกต้อง");
    await sql`update crm.settings set value = ${value}, updated_at = now() where key = ${key}`;
    await log(actor, op, { key, value });
    return Response.json({ ok: true });
  }
  if (op === "promo_save") {
    // field names in errors let the page outline the wrong input (Point 2026-11-19)
    const title = String(f.title ?? "").trim(), body = String(f.body ?? "").trim() || null;
    const img = String(f.image_url ?? "").trim() || null;
    const vf = String(f.valid_from ?? ""), vt = String(f.valid_to ?? "");
    const ids = [...new Set((Array.isArray(f.branch_ids) ? f.branch_ids : []).map(Number).filter(Number.isInteger))];
    const sort = Number.isFinite(Number(f.sort)) ? Number(f.sort) : 100, active = f.active === true;
    if (title.length < 2 || title.length > 80) return badField("title", "กรุณาใส่ชื่อโปรโมชั่น (2–80 ตัวอักษร)");
    if (body && body.length > 300) return badField("body", "รายละเอียดยาวเกิน 300 ตัวอักษร");
    if (img && !/^https:\/\/\S+$/.test(img)) return badField("image_url", "ลิงก์รูปต้องขึ้นต้นด้วย https://");
    if (!DAY.test(vf)) return badField("valid_from", "กรุณาเลือกวันเริ่ม");
    if (!DAY.test(vt)) return badField("valid_to", "กรุณาเลือกวันสิ้นสุด");
    if (vt < vf) return badField("valid_to", "วันสิ้นสุดต้องไม่ก่อนวันเริ่ม");
    const blabel = String(f.button_label ?? "").trim() || null, burl = String(f.button_url ?? "").trim() || null;
    if (blabel && blabel.length > 20) return badField("button_label", "ข้อความปุ่มยาวเกิน 20 ตัวอักษร");
    if (blabel && !burl) return badField("button_url", "ใส่ลิงก์ของปุ่มด้วย");
    if (burl && !blabel) return badField("button_label", "ใส่ข้อความบนปุ่มด้วย");
    if (burl && !/^https:\/\/\S+$/.test(burl)) return badField("button_url", "ลิงก์ปุ่มต้องขึ้นต้นด้วย https://");
    if (ids.length) {
      const [{ n }] = await sql`select count(*)::int n from crm.branches where branch_id = any(${sql.array(ids)}::int[]) and active`;
      if (n !== ids.length) return badField("branches", "มีสาขาที่ไม่ถูกต้อง");
    }
    const bids = ids.length ? sql.array(ids) : null;
    let id = f.id ? Number(f.id) : null;
    if (id) await sql`update crm.promotions set title = ${title}, body = ${body}, image_url = ${img}, valid_from = ${vf},
                        valid_to = ${vt}, branch_ids = ${bids}::int[], sort = ${sort}, active = ${active},
                        button_label = ${blabel}, button_url = ${burl} where id = ${id}`;
    else [{ id }] = await sql`insert into crm.promotions (title, body, image_url, valid_from, valid_to, branch_ids, sort, active, button_label, button_url)
                        values (${title}, ${body}, ${img}, ${vf}, ${vt}, ${bids}::int[], ${sort}, ${active}, ${blabel}, ${burl}) returning id`;
    await log(actor, op, { id, title, valid_from: vf, valid_to: vt, branch_ids: ids.length ? ids : null, active });
    return Response.json({ ok: true, id });
  }
  if (op === "promo_delete") {
    const [r] = await sql`delete from crm.promotions where id = ${Number(f.id)} returning title`;
    if (!r) return bad("not found", 404);
    await log(actor, op, { id: Number(f.id), title: r.title });
    return Response.json({ ok: true });
  }
  if (op === "reward_save") {
    const code = String(f.item_code ?? ""), name = String(f.display_name ?? "").trim() || null, hidden = f.hidden === true;
    const [r] = await sql`select 1 from crm.pos_rewards where item_code = ${code}`;
    if (!r) return bad("reward not found", 404);
    if (name && name.length > 60) return bad("ชื่อยาวเกิน 60 ตัวอักษร");
    await sql`insert into crm.reward_display (item_code, display_name, hidden) values (${code}, ${name}, ${hidden})
              on conflict (item_code) do update set display_name = excluded.display_name, hidden = excluded.hidden`;
    await log(actor, op, { item_code: code, display_name: name, hidden });
    return Response.json({ ok: true });
  }
  if (op === "test_points_save") {
    const phone = String(f.phone ?? ""), pts = Number(f.points), days = Math.min(14, Math.max(1, Number(f.days) || 3));
    if (!PHONE.test(phone)) return bad("เบอร์ไม่ถูกต้อง");
    if (!Number.isFinite(pts) || pts < 0 || pts > 10000) return bad("แต้มไม่ถูกต้อง");
    await sql.begin(async (tx) => {
      await tx`insert into crm.test_points (phone, points, note, expires_at)
               values (${phone}, ${pts}, ${"set by " + actor}, now() + make_interval(days => ${days}))
               on conflict (phone) do update set points = excluded.points, note = excluded.note, expires_at = excluded.expires_at`;
      await tx`insert into crm.pos_points (phone, points, as_of) values (${phone}, ${pts}, now())
               on conflict (phone) do update set points = excluded.points, as_of = excluded.as_of, synced_at = now()`;
    });
    await log(actor, op, { phone, points: pts, days });
    return Response.json({ ok: true });
  }
  if (op === "test_points_delete") {
    const phone = String(f.phone ?? "");
    await sql`update crm.test_points set expires_at = now() where phone = ${phone}`;
    await log(actor, op, { phone, note: "real ERS balance returns at the next 30-min sync" });
    return Response.json({ ok: true });
  }
  if (op === "change_phone") {
    const id = String(f.id ?? ""), phone = String(f.phone ?? "").replace(/\D/g, ""), note = String(f.note ?? "").trim() || null;
    if (!PHONE.test(phone)) return bad("เบอร์ไม่ถูกต้อง (10 หลัก เช่น 0812345678)");
    const [taken] = await sql`select 1 from crm.line_members where phone = ${phone} and line_user_id <> ${id}`;
    if (taken) return bad("เบอร์นี้เป็นของสมาชิกอื่นแล้ว", 409);
    const [m] = await sql`select phone from crm.line_members where line_user_id = ${id}`;
    if (!m) return bad("not found", 404);
    await sql`select crm.change_phone(${id}, ${phone}, ${actor}, ${note})`;
    await log(actor, op, { id, old: m.phone, new: phone, note });
    return Response.json({ ok: true });
  }
  if (op === "coupon_preview" || op === "coupon_send") {
    const aud = String(f.audience ?? "");
    const ids = await audienceIds(aud);
    const tok = await token();
    const q = await quota(tok);
    if (op === "coupon_preview") return Response.json({ ok: true, recipients: ids.length, quota: q });
    const c = f.coupon ?? {};
    const title = String(c.title ?? "").trim(), desc = String(c.description ?? "").trim();
    const start = Date.parse(String(c.start ?? "")), end = Date.parse(String(c.end ?? ""));
    const reward = validReward(c.reward);
    const cond = String(c.usageCondition ?? "").trim(), maxUse = c.maxUse === -1 ? -1 : 1;
    if (!reward) return bad("รางวัลไม่ถูกต้อง");
    if (cond.length > 100) return bad("เงื่อนไขยาวเกิน 100 ตัวอักษร");
    if (Number(f.expect) !== ids.length) return bad(`จำนวนผู้รับเปลี่ยนเป็น ${ids.length} คน กรุณาดูตัวอย่างอีกครั้ง`, 409);
    if (!ids.length) return bad("ไม่มีผู้รับ");
    if (title.length < 2 || title.length > 60) return bad("ชื่อคูปอง 2–60 ตัวอักษร");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end < Date.now()) return bad("วันเวลาไม่ถูกต้อง");
    if (q.limit !== null && q.used + ids.length > q.limit) return bad(`โควตาไม่พอ: เหลือ ${q.limit - q.used} ข้อความ`);
    const [{ id: sendId }] = await sql`insert into crm.coupon_sends (actor, title, audience, recipients, valid_from, valid_to, quota_before,
          reward, usage_condition, max_use)
        values (${actor}, ${title}, ${aud}, ${ids.length}, ${new Date(start)}, ${new Date(end)}, ${q.used},
          ${sql.json(reward)}, ${cond || null}, ${maxUse}) returning id`;
    try {
      const { couponId } = await line(tok, "/coupon", {
        title, description: desc || undefined, acquisitionCondition: { type: "normal" }, maxUseCountPerTicket: maxUse,
        ...(cond ? { usageCondition: cond } : {}),
        startTimestamp: Math.floor(start / 1000), endTimestamp: Math.floor(end / 1000), timezone: "ASIA_BANGKOK",
        reward, visibility: "UNLISTED", ...(c.imageUrl ? { imageUrl: String(c.imageUrl) } : {}),
      });
      await sql`update crm.coupon_sends set coupon_id = ${couponId} where id = ${sendId}`;
      const msg = [{ type: "coupon", couponId }];
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        if (chunk.length === 1) await line(tok, "/message/push", { to: chunk[0], messages: msg });
        else await line(tok, "/message/multicast", { to: chunk, messages: msg });
      }
      const after = await quota(tok).catch(() => null);
      await sql`update crm.coupon_sends set quota_after = ${after?.used ?? null} where id = ${sendId}`;
      await log(actor, op, { send_id: sendId, title, audience: aud, recipients: ids.length, coupon_id: couponId, reward, usage_condition: cond || null, max_use: maxUse });
      return Response.json({ ok: true, send_id: sendId, recipients: ids.length, coupon_id: couponId, quota: after });
    } catch (e) {
      await sql`update crm.coupon_sends set error = ${String(e).slice(0, 500)} where id = ${sendId}`;
      throw e;
    }
  }
  return bad("unknown op");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const key = req.headers.get("x-admin-key") ?? "";
  const [s] = await sql`select value from crm.settings where key = 'admin_key_sha256'`;
  if (!key || !s?.value || (await sha256hex(key)) !== s.value) return new Response("forbidden", { status: 403 });
  const actor = (req.headers.get("x-admin-user") ?? "").slice(0, 40) || "unknown";
  try {
    const f = await req.json();
    const op = String(f.op ?? "");
    if (op === "overview") return Response.json({ ok: true, ...(await overview()) });
    if (op === "members") return Response.json({ ok: true, ...(await members(f)) });
    if (op === "config") return Response.json({ ok: true, ...(await config()) });
    return await write(op, f, actor);
  } catch (e) {
    console.error("crm-admin", e);
    return Response.json({ ok: false, error: String(e).slice(0, 300) }, { status: 500 });
  }
});
