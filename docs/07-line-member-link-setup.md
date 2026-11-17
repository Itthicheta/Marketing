# LINE member link — setup checklist and what is live (2026-11-17)

> **v2, same day: card-message version.** @mamapook's Messaging API channel (ID 2009768336) sits under
> a provider Point's LINE Developers login cannot see (Point is the only OA Administrator; checked
> Developers Console providers, direct channel URL = 404). So no LINE Login/LIFF channel can be made under
> the same provider. Instead: the script mints its own short-lived access token from channel ID + secret
> (stateless token, `oauth2/v3/token`), the Member card button sends a postback, and the webhook replies
> with a Flex card (number + coupon + two-step "ใช้สิทธิ์"). Replies are free. The LIFF pieces below
> (`member-card` function, `member-card-page/`, mamapook-member site) are PARKED, kept for if the provider
> is ever found. The channel secret was shown in a screenshot on 2026-11-17 and cannot be reissued
> without that provider: reissue it if the provider turns up.

## Owner checklist — v2 (replaces Parts A–C below)
1. OA Manager → Settings → Messaging API → Webhook URL: `https://qtpwrwapbefczvqdfzes.supabase.co/functions/v1/line-webhook` → Save.
2. Supabase Marketing → Edge Functions → Secrets: `LINE_CHANNEL_ID` = 2009768336, `LINE_CHANNEL_SECRET` = the secret on that page.
3. OA Manager → Response settings: Chat on, Greeting on, Auto-response off, **Webhook on** (only after step 2).
4. Greeting text (below). OA Manager rich menu: none active.
5. Two menu images to Claude (2500 × 843); Claude uploads + runs `line-menu-setup`.
6. POS: create the "LINE เก๊กฮวยฟรี" coupon.
7. Tests: as in Part D, except "Tap Member card" now returns a card message; "ใช้สิทธิ์" asks ยืนยัน/ยกเลิก before marking used.


Source design: "LINE Member Link Playbook" (sales site → Marketing → CRM tab, `#mk-crm`).
This file records the decisions, what Claude built, and the owner's remaining clicks.

## Decisions (Point, 2026-11-17)
| Item | Decision |
|---|---|
| LINE Official Account | @mamapook |
| Database | Supabase project **Marketing** (`qtpwrwapbefczvqdfzes`) |
| Sign-up reward | Free เก๊กฮวย 1 แก้ว on the **next** visit, valid from the day after sign-up for **14 days** |
| Redemption | Cashier taps "ใช้สิทธิ์ (สำหรับพนักงาน)" on the customer's member card (one use, time-stamped), then adds the เก๊กฮวย coupon to the bill in the POS for the discount |
| Pilot branch | Park Silom (data location `silom`), 30 days, target members on 10% of bills by day 30 |
| Repeat sign-up | Sending the same number again → reminder only, no second coupon |
| Different number from a linked account | Reply "see staff"; nothing saved. Staff changes it with `crm.change_phone(line_user_id, new_phone, staff_name, note)` (audit row in `crm.phone_changes`) |
| Friends from before the webhook | Row created when they send a number |

## What is live
| Piece | Where | Guard |
|---|---|---|
| Tables `crm.line_members`, `crm.coupons`, `crm.phone_changes`, `crm.settings`; events in `raw.line_events` | Marketing DB, migration `0009_crm_line_members.sql` | RLS on, no policies, schema revoked from anon/authenticated |
| Webhook `line-webhook` | `https://qtpwrwapbefczvqdfzes.supabase.co/functions/v1/line-webhook` | LINE signature (HMAC-SHA256 with channel secret); unsigned calls get 401 |
| Card script `member-card` | `https://qtpwrwapbefczvqdfzes.supabase.co/functions/v1/member-card` | Verifies LINE's ID token with LINE; returns only the caller's own number/coupons |
| Menu setup `line-menu-setup` | `https://qtpwrwapbefczvqdfzes.supabase.co/functions/v1/line-menu-setup` | One-time key armed in SQL (`crm.settings.setup_key`), cleared on use |
| Card page (LIFF endpoint) | `https://mamapook-member.itthichet-a.workers.dev` (Cloudflare, project `mamapook-member`, source `member-card-page/`) | Public page; shows nothing without a verified LINE login |

Runtime settings (change in SQL, no redeploy): `crm.settings` keys `reward_text`, `reward_days`, `brand_name`, `liff_id`, `richmenu_register`, `richmenu_member`.
All functions are inert until the secrets below exist.

## Owner checklist (playbook steps, with the exact values)
**Part A — LINE (about 45 min)**
1. manager.line.biz → @mamapook.
2. Settings → Messaging API → Enable. Create the provider for the group (cannot be changed later).
3. Settings → Response settings: Webhooks **on**, Auto-response **off**, Greeting message **on**, Chat **on**.
4. Greeting message text (updated for the next-visit reward):
   `สวัสดีค่ะ ขอบคุณที่เพิ่มเพื่อนกับ Mama Pook พิมพ์เบอร์โทรที่ใช้สะสมแต้ม 10 หลัก ส่งมาในแชตนี้ รับเก๊กฮวยฟรี 1 แก้ว ในการมาครั้งถัดไปค่ะ`
5. developers.line.biz/console → the provider → Messaging API channel: copy **Channel secret** (Basic settings) and issue a **long-lived Channel access token** (Messaging API tab). Never paste them into chat, docs or email.
6. Same provider → Create a new channel → **LINE Login**, app type **Web app**. Copy its **Channel ID**.

**Part B — one owner step**
9. Supabase → project **Marketing** → Edge Functions → Secrets → add exactly:
   - `LINE_CHANNEL_SECRET`
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `LINE_LOGIN_CHANNEL_ID`

**Part C — connect**
11. LINE Login channel → LIFF tab → Add: name `Member card`, size **Tall**, Endpoint URL `https://mamapook-member.itthichet-a.workers.dev`, scope **openid**. Give Claude the LIFF ID (not secret); Claude stores it in `crm.settings.liff_id`.
12. Messaging API channel → Messaging API tab → Webhook URL `https://qtpwrwapbefczvqdfzes.supabase.co/functions/v1/line-webhook` → Verify (Success) → Use webhook **on**. Must be on before the first customer.
13. Content creator: two images 2500 × 843 px, PNG/JPEG, under 1 MB — "สมัครสมาชิก" (Register) and "บัตรสมาชิก" (Member card). Upload to Supabase Marketing → Storage → private bucket `line-menus` as `register.png` and `member.png` (Claude can create the bucket and upload if sent the files).
14. Claude runs the menu setup (arms the one-time key, calls `line-menu-setup`). Leave the OA Manager's own rich menu empty.
15. LINE Login channel → **Publish** (while "Developing", only admins can open the card).
16. Eight tests from the playbook, plus: tap "ใช้สิทธิ์" on a coupon dated from tomorrow → refused until tomorrow; after it works the coupon turns grey and cannot be used twice.

**Part E — pilot at Park Silom**: print the add-friend QR (table tents, queue sign, cashier); brief staff with the playbook scripts, saying "เก๊กฮวยฟรีครั้งหน้า"; create the เก๊กฮวย coupon/discount in the POS so the cashier can add it to the bill.

## Staff scripts (Thai, staff-facing) adjusted for the next-visit reward
| Situation | Script |
|---|---|
| New customer | สะสมแต้มกับเราได้ผ่าน LINE ค่ะ แอดแล้วส่งเบอร์โทร รับเก๊กฮวยฟรี 1 แก้ว ครั้งหน้าที่มาเลยค่ะ |
| Existing member, not linked | ตอนนี้เราส่งคูปองฟรีและส่วนลดให้สมาชิกทาง LINE ค่ะ รบกวนแอด LINE แล้วส่งเบอร์เดิมเข้ามา ครั้งหน้ารับเก๊กฮวยฟรี 1 แก้วค่ะ |
| Customer declines | ไม่เป็นไรค่ะ แต้มยังสะสมได้ตามปกติค่ะ |
| Redeeming | ขอดูบัตรสมาชิกใน LINE ค่ะ → กด "ใช้สิทธิ์" → ใส่คูปองเก๊กฮวยในบิล POS |
