// line-menu-setup — playbook step 14: create the two rich menus by script (only script-made menus
// can be switched per customer). Register = default for everyone; Member card opens the LIFF card.
// Re-runnable: deletes the previous pair, then re-links every already-linked member to the new
// Member card menu. Images (2500 x 843, PNG/JPEG, < 1 MB) come from the private storage bucket
// "line-menus" as register.png|jpg and member.png|jpg.
// ARMING: a one-time key. Set it in SQL right before running:
//   update crm.settings set value = '<random>' where key = 'setup_key';
// then POST here with header x-setup-key: <random>. The key is cleared on use.
// Secrets: LINE_CHANNEL_ACCESS_TOKEN. verify_jwt = false (the one-time key is the guard).
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });
const TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const auth = { Authorization: `Bearer ${TOKEN}` };

async function lineJson(path: string, body?: unknown, method = "POST") {
  const r = await fetch("https://api.line.me/v2/bot" + path, {
    method, headers: { ...auth, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function image(name: string): Promise<{ bytes: Uint8Array; type: string }> {
  for (const [ext, type] of [["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"]]) {
    const r = await fetch(`${SB_URL}/storage/v1/object/line-menus/${name}.${ext}`,
      { headers: { Authorization: `Bearer ${SB_KEY}`, apikey: SB_KEY } });
    if (r.ok) return { bytes: new Uint8Array(await r.arrayBuffer()), type };
  }
  throw new Error(`image ${name}.png|jpg not found in storage bucket line-menus`);
}

async function createMenu(name: string, chatBarText: string, action: unknown, img: { bytes: Uint8Array; type: string }) {
  const { richMenuId } = await lineJson("/richmenu", {
    size: { width: 2500, height: 843 }, selected: true, name, chatBarText,
    areas: [{ bounds: { x: 0, y: 0, width: 2500, height: 843 }, action }],
  });
  const up = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
    { method: "POST", headers: { ...auth, "Content-Type": img.type }, body: img.bytes });
  if (!up.ok) throw new Error(`upload ${name} image -> ${up.status} ${await up.text()}`);
  return richMenuId as string;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const key = req.headers.get("x-setup-key") ?? "";
  const armed = await sql`update crm.settings set value = null, updated_at = now()
                          where key = 'setup_key' and value is not null and value = ${key} returning 1`;
  if (!key || armed.length !== 1) return new Response("not armed", { status: 403 });
  try {
    const rows = await sql`select key, value from crm.settings`;
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (!s.liff_id) throw new Error("liff_id is not set in crm.settings (playbook step 11)");
    if (!TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN secret is not set (playbook step 9)");

    const [regImg, memImg] = await Promise.all([image("register"), image("member")]);
    const register = await createMenu("register", "สมัครสมาชิก",
      { type: "postback", data: "action=register", displayText: "สมัครสมาชิก" }, regImg);
    const member = await createMenu("member", "บัตรสมาชิก",
      { type: "uri", uri: `https://liff.line.me/${s.liff_id}` }, memImg);

    await lineJson(`/user/all/richmenu/${register}`);                 // default for everyone
    const linked = await sql`select line_user_id from crm.line_members where phone is not null and blocked_at is null`;
    for (let i = 0; i < linked.length; i += 500) {
      await lineJson("/richmenu/bulk/link", { richMenuId: member, userIds: linked.slice(i, i + 500).map((r) => r.line_user_id) });
    }
    for (const old of [s.richmenu_register, s.richmenu_member]) {
      if (old && old !== register && old !== member) {
        await fetch(`https://api.line.me/v2/bot/richmenu/${old}`, { method: "DELETE", headers: auth }).catch(() => {});
      }
    }
    await sql`update crm.settings set value = ${register}, updated_at = now() where key = 'richmenu_register'`;
    await sql`update crm.settings set value = ${member}, updated_at = now() where key = 'richmenu_member'`;
    return Response.json({ ok: true, register, member, relinked: linked.length });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
