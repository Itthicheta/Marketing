// crm-admin — the CRM area of the sales site (Point 2026-11-18). Config, members, promotions, rewards,
// promotional LINE coupon sends, results and insights for the LINE member program.
// Caller: the sales site's Pages Function /api/crm (behind the whole-site login), which adds
//   x-admin-key  = Pages secret CRM_ADMIN_KEY   (sha256 must equal crm.settings.admin_key_sha256)
//   x-admin-user = the logged-in user name      (written to crm.admin_log / crm.coupon_sends)
// One door: POST {op, ...}. Reads: overview, members, member_visits, config, sends. Writes (all logged): set_setting,
// promo_save, promo_delete, reward_save, test_points_save, test_points_delete, change_phone,
// coupon_preview, coupon_send. coupon_send needs `expect` = the recipient count the page showed in
// the preview, so a send never reaches more people than were confirmed.
// Secrets: LINE_CHANNEL_ID + LINE_CHANNEL_SECRET (token minted here) or LINE_CHANNEL_ACCESS_TOKEN.
// verify_jwt = false (the admin key is the guard).
// v10 (2026-11-20): op member_visits {phone} = one row per visit. v9: members returns dine_visits. v8: pax / med_bowls / med_pax. v7: branch_visits + branch initials. v6: coupon_send takes reward (validReward), usageCondition (≤100, staff check it) and maxUse (1 | -1).
// v11 (2026-11-20, 0025): coupon rules — reads rules_data; writes template_save, rule_save, rule_toggle, rule_preview
// (draft rule inside a rolled-back transaction, last 14 days, ignores armed_at), group_save, group_delete.
// v14 (0027): rules take require_clean (default true).
// v15 (0030, 2026-11-24): coupons carry a use window — use_from / use_to (HH:MM, Bangkok) and use_days (ISO 1–7);
// template_save changes them only when the payload has use_days (the on/off switch sends none, so it keeps them).
// v16 (2026-11-24): ตั้งค่า POS checklist — read pos_setup (ERS snapshot crm.settings 'ers_config' from crm-points-sync v12,
// manual ticks 'pos_manual', our own switches); write pos_tick {key, done} (logged).
// v13 (0026): a rule is by product (categories) OR by bill amount (min_spend), never both; multi = more than one coupon per bill.
// v12: template_delete {id, withdraw?} (409 field "withdraw" while copies are still usable on cards), rule_delete {id}.
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

// ---------- coupon rules (0025): templates, criteria rules, hand-picked groups ----------
const CATS = ["main", "set", "side", "topping", "dessert", "beverage"];
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const LINE_ID = /^U[0-9a-f]{32}$/;
const ints = (v: any): number[] => [...new Set((Array.isArray(v) ? v : []).map(Number).filter(Number.isInteger))];
const pgArr = (a: (number | string)[]) => "{" + a.join(",") + "}";   // values are validated ints / CATS words only
class Rollback extends Error {}

async function rulesData() {
  const today = sql`(now() at time zone 'Asia/Bangkok')::date`;
  const templates = await sql`select t.id::int id, t.title, t.detail, t.start_after_days, t.valid_days, t.ers_hint, t.active,
      to_char(t.use_from, 'HH24:MI') use_from, to_char(t.use_to, 'HH24:MI') use_to, coalesce(t.use_days, '{}')::int[] use_days,
      count(c.id)::int issued, count(c.redeemed_at)::int used,
      count(c.id) filter (where c.redeemed_at is null and c.valid_to < ${today})::int expired
    from crm.coupon_templates t left join crm.coupons c on c.template_id = t.id
    group by t.id order by t.active desc, t.id desc`;
  const rules = await sql`select r.id::int id, r.name, r.template_id::int template_id, r.group_id::int group_id,
      coalesce(r.branch_ids, '{}') branch_ids, coalesce(r.days, '{}') days,
      to_char(r.t_from, 'HH24:MI') t_from, to_char(r.t_to, 'HH24:MI') t_to, coalesce(r.categories, '{}') categories, coalesce(r.item_ids, '{}')::int[] item_ids,
      r.min_spend::float min_spend, r.multi, r.require_clean,
      r.active, to_char(r.armed_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') armed_at, to_char(r.ends_on, 'YYYY-MM-DD') ends_on,
      count(c.id)::int issued, count(c.redeemed_at)::int used, count(distinct c.line_user_id)::int members
    from crm.coupon_rules r left join crm.coupons c on c.rule_id = r.id
    group by r.id order by r.active desc, r.id desc`;
  const groups = await sql`select g.id::int id, g.name,
      coalesce(json_agg(json_build_object('id', m.line_user_id, 'name', coalesce(m.full_name, m.display_name), 'phone', m.phone)
        order by coalesce(m.full_name, m.display_name)) filter (where m.line_user_id is not null), '[]') members
    from crm.member_groups g left join crm.member_group_members gm on gm.group_id = g.id
    left join crm.line_members m on m.line_user_id = gm.line_user_id
    group by g.id order by g.name`;
  const line_members = await sql`select line_user_id id, coalesce(full_name, display_name) name, phone from crm.line_members
    where phone is not null and blocked_at is null order by coalesce(full_name, display_name)`;
  const branches = await sql`select branch_id, name, coalesce(short, left(name, 2)) short from crm.branches
    where active order by coalesce(short_sort, 100 + sort)`;
  const menu = await sql`select item_id::int item_id, item_code, name, category from crm.pos_menu order by item_code nulls last, item_id`;
  return { templates, rules, groups, line_members, branches, menu };
}

// validate a rule from the page; returns { res } (an error Response) or { r } (clean values)
async function parseRule(f: any): Promise<{ res?: Response; r?: any }> {
  const name = String(f.name ?? "").trim();
  if (name.length < 2 || name.length > 60) return { res: badField("name", "ชื่อกติกา 2–60 ตัวอักษร") };
  const template_id = Number(f.template_id);
  const [tp] = Number.isInteger(template_id) ? await sql`select 1 from crm.coupon_templates where id = ${template_id}` : [];
  if (!tp) return { res: badField("template_id", "เลือกคูปอง") };
  const group_id = f.group_id == null || f.group_id === "" ? null : Number(f.group_id);
  if (group_id !== null) {
    const [g] = Number.isInteger(group_id) ? await sql`select 1 from crm.member_groups where id = ${group_id}` : [];
    if (!g) return { res: badField("group_id", "ไม่พบกลุ่ม") };
  }
  const branch_ids = ints(f.branch_ids);
  if (branch_ids.length) {
    const [{ n }] = await sql`select count(*)::int n from crm.branches where branch_id = any(${pgArr(branch_ids)}::int[]) and active`;
    if (n !== branch_ids.length) return { res: badField("branch_ids", "มีสาขาที่ไม่ถูกต้อง") };
  }
  const days = ints(f.days).filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  const t_from = f.t_from ? String(f.t_from) : null, t_to = f.t_to ? String(f.t_to) : null;
  if ((t_from === null) !== (t_to === null)) return { res: badField("t_from", "ใส่เวลาเริ่มและเวลาสิ้นสุด") };
  if (t_from && (!HM.test(t_from) || !HM.test(t_to!) || t_from >= t_to!)) return { res: badField("t_from", "เวลาไม่ถูกต้อง (เริ่มต้องก่อนสิ้นสุด)") };
  const categories = [...new Set((Array.isArray(f.categories) ? f.categories : []).map(String))].filter((c) => CATS.includes(c));
  // 0026: condition types = product (categories) and/or bill amount (min_spend); multi = more than one coupon per bill
  const min_spend = f.min_spend == null || f.min_spend === "" ? null : Number(f.min_spend);
  if (min_spend !== null && (!Number.isFinite(min_spend) || min_spend <= 0 || min_spend > 100000)) return { res: badField("min_spend", "ยอดบิลไม่ถูกต้อง") };
  if (!categories.length && min_spend === null) return { res: badField("categories", "เลือกสินค้าอย่างน้อย 1 หมวด หรือใส่ยอดบิล") };
  if (categories.length && min_spend !== null) return { res: badField("min_spend", "เลือกได้อย่างเดียว: สินค้า หรือ ยอดบิล") };
  const multi = f.multi !== false;
  const require_clean = f.require_clean !== false;   // 0027: off = bills with a promotion / discount / points can earn too
  const item_ids = ints(f.item_ids);
  if (item_ids.length) {
    const [{ n }] = await sql`select count(*)::int n from crm.pos_menu
        where item_id = any(${pgArr(item_ids)}::bigint[]) and category = any(${pgArr(categories)}::text[])`;
    if (n !== item_ids.length) return { res: badField("item_ids", "มีเมนูที่ไม่อยู่ในหมวดที่เลือก") };
  }
  const ends_on = f.ends_on ? String(f.ends_on) : null;
  if (ends_on && !DAY.test(ends_on)) return { res: badField("ends_on", "วันสิ้นสุดไม่ถูกต้อง") };
  return { r: { name, template_id, group_id, branch_ids, days, t_from, t_to, categories, item_ids, ends_on, min_spend, multi, require_clean } };
}
async function insertRule(q: any, r: any): Promise<number> {
  const [{ id }] = await q`insert into crm.coupon_rules (name, template_id, group_id, branch_ids, days, t_from, t_to, categories, item_ids, ends_on, min_spend, multi, require_clean)
      values (${r.name}, ${r.template_id}, ${r.group_id}, ${pgArr(r.branch_ids)}::int[], ${pgArr(r.days)}::int[],
              ${r.t_from}::time, ${r.t_to}::time, ${pgArr(r.categories)}::text[], ${pgArr(r.item_ids)}::bigint[], ${r.ends_on}::date, ${r.min_spend}, ${r.multi}, ${r.require_clean})
      returning id`;
  return Number(id);
}

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
      s.bowls::float bowls, s.spend_thb::float spend, s.addon_units::float addon, s.drink_units::float drinks, s.weekend_visits, s.slots, s.branch_visits,
      s.pax::float pax, s.med_bowls::float med_bowls, s.med_pax::float med_pax, s.dine_visits,
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
  // column heads for visits per branch (0021: initials G, Si, O, SS, AS, R9 in Point's order)
  const branches = await sql`select branch_id, name, coalesce(short, left(name, 2)) short from crm.branches
      where active order by coalesce(short_sort, 100 + sort)`;
  return { rows, branches, scope: ers ? "ers" : "line", stats_synced: st?.synced ?? null, stats_since: st?.since ?? null };
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

// ---------- ตั้งค่า POS checklist (v16) ----------
async function posSetup() {
  const rows = await sql`select key, value, to_char(updated_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') at
      from crm.settings where key in ('ers_config', 'pos_manual', 'signup_reward', 'reward_text', 'points_expiry_note')`;
  const g = (k: string) => rows.find((r) => r.key === k);
  const parse = (v: any) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  const templates = await sql`select t.id::int id, t.title, t.active, to_char(t.use_from, 'HH24:MI') use_from,
      (select count(*)::int from crm.coupon_rules r where r.template_id = t.id and r.active) live_rules,
      (select count(*)::int from crm.coupon_rules r where r.template_id = t.id) rules
    from crm.coupon_templates t order by t.id`;
  const [promos] = await sql`select count(*) filter (where active and (now() at time zone 'Asia/Bangkok')::date between valid_from and valid_to)::int live,
      count(*)::int total from crm.promotions`;
  const [line] = await sql`select count(*) filter (where phone is not null and blocked_at is null)::int members,
      count(*) filter (where blocked_at is null)::int friends from crm.line_members`;
  const [ps] = await sql`select value from crm.settings where key = 'menu_action_promotions'`;
  const [tap] = await sql`select to_char(max(event_ts) at time zone 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') at from raw.line_events
      where event_type = 'postback' and payload->'postback'->>'data' like ${"%actionId=" + (ps?.value ?? "-") + "%"}`;
  return { ers: parse(g("ers_config")?.value), ers_at: g("ers_config")?.at ?? null, manual: parse(g("pos_manual")?.value) ?? {},
    signup_reward: g("signup_reward")?.value ?? null, reward_text: g("reward_text")?.value ?? null,
    expiry_note: g("points_expiry_note")?.value ?? null, templates, promos, line, promo_tap: tap?.at ?? null };
}

// ---------- writes ----------
async function write(op: string, f: any, actor: string) {
  if (op === "template_save") {
    const title = String(f.title ?? "").trim(), detail = String(f.detail ?? "").trim() || null;
    const hint = String(f.ers_hint ?? "").trim() || null, active = f.active === true;
    const sa = Number(f.start_after_days), vd = Number(f.valid_days);
    if (title.length < 2 || title.length > 40) return badField("title", "ชื่อคูปอง 2–40 ตัวอักษร");
    if (detail && detail.length > 100) return badField("detail", "รายละเอียดยาวเกิน 100 ตัวอักษร");
    if (!Number.isInteger(sa) || sa < 0 || sa > 30) return badField("start_after_days", "เริ่มใช้ได้หลังบิล 0–30 วัน");
    if (!Number.isInteger(vd) || vd < 1 || vd > 90) return badField("valid_days", "ใช้ได้ 1–90 วัน");
    if (hint && hint.length > 60) return badField("ers_hint", "ข้อความ ERS ยาวเกิน 60 ตัวอักษร");
    const win = "use_days" in f;   // the use window is sent by the edit form only
    const uf = f.use_from ? String(f.use_from) : null, ut = f.use_to ? String(f.use_to) : null;
    if (win && uf && !HM.test(uf)) return badField("use_from", "เวลาเริ่มใช้ไม่ถูกต้อง");
    if (win && ut && !HM.test(ut)) return badField("use_to", "เวลาสิ้นสุดไม่ถูกต้อง");
    if (win && uf && ut && uf >= ut) return badField("use_to", "เวลาสิ้นสุดต้องหลังเวลาเริ่ม");
    const udRaw = ints(f.use_days).filter((x) => x >= 1 && x <= 7);
    const ud = win && udRaw.length && udRaw.length < 7 ? pgArr(udRaw.sort()) : null;
    let id = f.id ? Number(f.id) : null;
    if (id) {
      const u = win
        ? await sql`update crm.coupon_templates set title = ${title}, detail = ${detail}, start_after_days = ${sa},
            valid_days = ${vd}, ers_hint = ${hint}, active = ${active}, use_from = ${uf}::time, use_to = ${ut}::time,
            use_days = ${ud}::smallint[], updated_at = now() where id = ${id} returning id`
        : await sql`update crm.coupon_templates set title = ${title}, detail = ${detail}, start_after_days = ${sa},
            valid_days = ${vd}, ers_hint = ${hint}, active = ${active}, updated_at = now() where id = ${id} returning id`;
      if (!u.length) return bad("not found", 404);
    } else {
      [{ id }] = await sql`insert into crm.coupon_templates (title, detail, start_after_days, valid_days, ers_hint, active, use_from, use_to, use_days)
          values (${title}, ${detail}, ${sa}, ${vd}, ${hint}, ${active}, ${uf}::time, ${ut}::time, ${ud}::smallint[]) returning id::int id`;
    }
    await log(actor, op, { id, title, detail, start_after_days: sa, valid_days: vd, ers_hint: hint, active,
      ...(win ? { use_from: uf, use_to: ut, use_days: ud } : {}) });
    return Response.json({ ok: true, id });
  }
  if (op === "pos_tick") {
    const key = String(f.key ?? ""), done = f.done === true;
    if (!/^[a-z0-9_]{2,30}$/.test(key)) return bad("bad key");
    const [cur] = await sql`select value from crm.settings where key = 'pos_manual'`;
    let m: any = {}; try { m = cur?.value ? JSON.parse(cur.value) : {}; } catch { m = {}; }
    m[key] = { done, by: actor, at: new Date().toISOString() };
    await sql`insert into crm.settings (key, value, updated_at) values ('pos_manual', ${JSON.stringify(m)}, now())
              on conflict (key) do update set value = excluded.value, updated_at = now()`;
    await log(actor, op, { key, done });
    return Response.json({ ok: true });
  }
  if (op === "rule_save") {
    const p = await parseRule(f);
    if (p.res) return p.res;
    const r = p.r;
    let id = f.id ? Number(f.id) : null;
    if (id) {
      // saving a live rule counts bills from now on (no backdating with the new conditions)
      const u = await sql`update crm.coupon_rules set name = ${r.name}, template_id = ${r.template_id}, group_id = ${r.group_id},
          branch_ids = ${pgArr(r.branch_ids)}::int[], days = ${pgArr(r.days)}::int[], t_from = ${r.t_from}::time, t_to = ${r.t_to}::time,
          categories = ${pgArr(r.categories)}::text[], item_ids = ${pgArr(r.item_ids)}::bigint[], ends_on = ${r.ends_on}::date, min_spend = ${r.min_spend}, multi = ${r.multi}, require_clean = ${r.require_clean},
          armed_at = case when active then now() else armed_at end, updated_at = now()
        where id = ${id} returning id`;
      if (!u.length) return bad("not found", 404);
    } else id = await insertRule(sql, r);
    await log(actor, op, { id, ...r });
    return Response.json({ ok: true, id });
  }
  if (op === "rule_toggle") {
    const id = Number(f.id), on = f.active === true;
    const [cur] = await sql`select r.name, t.active tpl_on from crm.coupon_rules r join crm.coupon_templates t on t.id = r.template_id
        where r.id = ${id}`;
    if (!cur) return bad("not found", 404);
    if (on && !cur.tpl_on) return bad("คูปองของกติกานี้ปิดอยู่ เปิดคูปองในแท็บกติกาคูปองก่อน");
    await sql`update crm.coupon_rules set active = ${on}, armed_at = case when ${on} then now() else armed_at end, updated_at = now()
        where id = ${id}`;
    await log(actor, op, { id, name: cur.name, active: on });
    return Response.json({ ok: true });
  }
  if (op === "rule_preview") {
    const p = await parseRule(f);
    if (p.res) return p.res;
    let out: any = { coupons: 0, members: 0 };
    await sql.begin(async (tx) => {   // the draft rule exists only inside this transaction
      const id = await insertRule(tx, p.r);
      [out] = await tx`select coalesce(sum(units), 0)::int coupons, count(distinct line_user_id)::int members
          from crm.rule_hits(${id}, true)`;
      throw new Rollback();
    }).catch((e) => { if (!(e instanceof Rollback)) throw e; });
    return Response.json({ ok: true, ...out });
  }
  if (op === "group_save") {
    const name = String(f.name ?? "").trim();
    const ids = [...new Set((Array.isArray(f.members) ? f.members : []).map(String))].filter((x) => LINE_ID.test(x));
    if (name.length < 2 || name.length > 60) return badField("name", "ชื่อกลุ่ม 2–60 ตัวอักษร");
    if (ids.length) {
      const [{ n }] = await sql`select count(*)::int n from crm.line_members
          where line_user_id = any(${pgArr(ids)}::text[]) and phone is not null`;
      if (n !== ids.length) return badField("members", "มีสมาชิกที่ไม่ถูกต้อง");
    }
    let id = f.id ? Number(f.id) : null;
    try {
      await sql.begin(async (tx) => {
        if (id) {
          const u = await tx`update crm.member_groups set name = ${name} where id = ${id} returning id`;
          if (!u.length) throw new Error("group not found");
        } else {
          [{ id }] = await tx`insert into crm.member_groups (name) values (${name}) returning id::int id`;
        }
        await tx`delete from crm.member_group_members where group_id = ${id}`;
        if (ids.length) await tx`insert into crm.member_group_members (group_id, line_user_id)
            select ${id}, unnest(${pgArr(ids)}::text[])`;
      });
    } catch (e) {
      if (String(e).includes("member_groups_name_key")) return badField("name", "มีกลุ่มชื่อนี้แล้ว");
      throw e;
    }
    await log(actor, op, { id, name, members: ids.length });   // count only: LINE ids are personal data
    return Response.json({ ok: true, id });
  }
  if (op === "group_delete") {
    const id = Number(f.id);
    const [used] = await sql`select name from crm.coupon_rules where group_id = ${id} limit 1`;
    if (used) return bad(`กลุ่มนี้ใช้อยู่ในกติกา "${used.name}"`, 409);
    const [g] = await sql`delete from crm.member_groups where id = ${id} returning name`;
    if (!g) return bad("not found", 404);
    await log(actor, op, { id, name: g.name });
    return Response.json({ ok: true });
  }
  if (op === "template_delete") {
    // a coupon with copies still usable on members' cards needs `withdraw` (the page asks first); used / expired copies stay as history
    const id = Number(f.id);
    const [tp] = await sql`select title from crm.coupon_templates where id = ${id}`;
    if (!tp) return bad("not found", 404);
    const live = sql`template_id = ${id} and redeemed_at is null and valid_to >= (now() at time zone 'Asia/Bangkok')::date`;
    const [{ n }] = await sql`select count(*)::int n from crm.coupons where ${live}`;
    if (n > 0 && f.withdraw !== true) return Response.json({ ok: false, error: `ยังมีคูปองนี้บนบัตรสมาชิก ${n} ใบที่ยังใช้ได้`, field: "withdraw", active: n }, { status: 409 });
    let withdrawn = 0;
    await sql.begin(async (tx) => {
      if (n > 0) withdrawn = (await tx`delete from crm.coupons where template_id = ${id} and redeemed_at is null
          and valid_to >= (now() at time zone 'Asia/Bangkok')::date returning id`).length;
      await tx`update crm.coupons set template_id = null, rule_id = null
          where template_id = ${id} or rule_id in (select r.id from crm.coupon_rules r where r.template_id = ${id})`;
      await tx`delete from crm.coupon_rules where template_id = ${id}`;
      await tx`delete from crm.coupon_templates where id = ${id}`;
    });
    await log(actor, op, { id, title: tp.title, withdrawn });
    return Response.json({ ok: true, withdrawn });
  }
  if (op === "rule_delete") {   // coupons this rule already gave stay on the cards
    const id = Number(f.id);
    const [r] = await sql`select name from crm.coupon_rules where id = ${id}`;
    if (!r) return bad("not found", 404);
    await sql.begin(async (tx) => {
      await tx`update crm.coupons set rule_id = null where rule_id = ${id}`;
      await tx`delete from crm.coupon_rules where id = ${id}`;
    });
    await log(actor, op, { id, name: r.name });
    return Response.json({ ok: true });
  }
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
    if (op === "rules_data") return Response.json({ ok: true, ...(await rulesData()) });
    if (op === "pos_setup") return Response.json({ ok: true, ...(await posSetup()) });
    if (op === "member_visits") {   // the detail card's visit list (0024), newest first
      const phone = String(f.phone ?? "");
      if (!PHONE.test(phone)) return bad("เบอร์ไม่ถูกต้อง");
      const visits = await sql`select bill_no, to_char(at at time zone 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') at,
          extract(isodow from at at time zone 'Asia/Bangkok')::int dow, branch_id, channel, bowls::float bowls, pax::float pax,
          spend::float spend, addon::float addon, drinks::float drinks, items, promos
        from crm.pos_member_visits where phone = ${phone} order by at desc limit 500`;
      return Response.json({ ok: true, visits });
    }
    return await write(op, f, actor);
  } catch (e) {
    console.error("crm-admin", e);
    return Response.json({ ok: false, error: String(e).slice(0, 300) }, { status: 500 });
  }
});
