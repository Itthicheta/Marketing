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

## v3 (2026-11-17): Point's own 6-button rich menu in the OA Manager
MEMBERS | COUPONS | OUR MENU / LOCATIONS | DELIVERY | CATERING. Buttons 3–6 are Point's links in the OA Manager.
MEMBERS and COUPONS use the OA Manager action type **Text**, sending `บัตรสมาชิก` and `คูปองของฉัน`; the webhook
answers those words (also members/member/สมาชิก, coupons/coupon/คูปอง). Non-members get the register prompt.
COUPONS lists rows of `crm.line_coupon_list` (migration 0010) whose dates include today: title, LINE coupon share URL,
optional image, valid_from/valid_to. LINE enforces one use per person for its built-in coupons.
**Gotcha (found in testing):** an OA Manager "Text" button does NOT send its text to the webhook. LINE sends a
postback `oaPlusRichMenu=true&richMenuId=default&actionId=<id>&version=<n>`. The two ids live in `crm.settings`
(`menu_action_card` = vjUpcXcCtD541roC, `menu_action_coupons` = FULFZq1xez8kuj8Q at menu version 13). Editing the
menu in the OA Manager may change them; unmapped ids are logged as "unmapped OA menu action" in the function logs.
`line-menu-setup` (script menus) is NOT used in v3; running it would override the OA Manager menu.
Per-person (migration 0011, 2026-11-17): `crm.line_coupon_list.audience` = 'all' or a group name; for a group,
the LINE user IDs Claude exported as the OA Manager "User ID upload" file go into `crm.line_coupon_targets`
(coupon_id, line_user_id). The COUPONS button shows a member only 'all' coupons plus those targeted to them.
Getting the customer link: OA Manager → Coupons → "⋯" next to the coupon → **Share** → "Share on social media
(copy coupon URL)", a `https://lin.ee/...` link. (The coupon's own admin page has no link; "Copy" duplicates the coupon.)
Add a coupon to the list:
```sql
insert into crm.line_coupon_list (title, url, valid_from, valid_to) values ('ส่วนลด 20 บาท สำหรับสมาชิก', '<share URL>', '2026-12-01', '2026-12-15');
```

## Owner checklist — v2 (replaces Parts A–C below)
1. OA Manager → Settings → Messaging API → Webhook URL: `https://qtpwrwapbefczvqdfzes.supabase.co/functions/v1/line-webhook` → Save.
2. Supabase Marketing → Edge Functions → Secrets: `LINE_CHANNEL_ID` = 2009768336, `LINE_CHANNEL_SECRET` = the secret on that page.
3. OA Manager → Response settings: Chat on, Greeting on, Auto-response off, **Webhook on** (only after step 2).
4. Greeting text (Point 2026-11-17, final):
   ```
   สวัสดีค่ะ ขอบคุณที่เพิ่มเพื่อนกับ Mama Pook 🍜

   สมัครสมาชิกเพียงพิมพ์เบอร์โทรที่ใช้ 10 หลัก ส่งมาในแชตนี้ (เช่น 0812345678)

   ✅ รับฟรี เก๊กฮวย 1 แก้ว มูลค่า 69 บาท ในการมาครั้งถัดไป
   ✅ รับสิทธิพิเศษ และคูปองต่างๆ มากมาย ทุกเดือน
   ✅ สะสมแต้ม 100 บาท = 1 แต้ม เพื่อแลกของฟรี
   ```
   OA Manager rich menu: none active. Coupon title (`crm.settings.reward_text`) = เก๊กฮวยฟรี 1 แก้ว (มูลค่า 69 บาท).
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

## LINE coupon API (tested 2026-11-18)
- LINE's Messaging API can now create built-in coupons and send them as messages (docs: developers.line.biz/en/docs/messaging-api/send-coupons-to-users/). API coupons also appear in the OA Manager coupon list.
- Function `line-coupon-send` (verify_jwt off, one-time key `crm.settings.send_key`, header `x-send-key`): body `{coupon:{title, description, start, end, maxUse, reward?, imageUrl?, usageCondition?}, to:[userIds ≤500]}`. Visibility is always UNLISTED, timezone ASIA_BANGKOK, reward defaults to `{type:"free"}`. It returns couponId, the coupon details and quota use before/after.
- First test: coupon 01M7PCBVPR38CYTZSRHVZHNAH2 pushed to Point only. Quota went 3 → 4, so a coupon push costs one message per person (a reply would be free).
- Limits: coupons can't be edited (close and recreate), up to 5,000 live coupons per channel, no API or webhook for who opened or used a coupon (OA Manager Insights shows totals only).
- Plan: the CRM-tab send form should use this API instead of copied share links, and record recipients in our own table.
- v2 (2026-11-18): body `{mode:"card", note?, to:[...]}` pushes each linked member their own member card, so our own coupons (crm.coupons, staff tap) can be announced by push. One push request counts as one message per person even with a note plus the card. The card builder is a copy of line-webhook's memberCard: change both together.

## Points and rewards on the member card (decided 2026-11-18, Point)
- ERS is the only points system: points are earned and deducted only in the POS. We never keep our own points count.
- The card shows the ERS balance for the member's phone (ERS customer `acct`), refreshed about every 30 min from the latest bill's `balancepoint` (nightly customer master as fallback), with the update time printed.
- The card lists rewards view-only: affordable ones highlighted "แลกได้ที่แคชเชียร์", the rest grey "อีก X แต้ม". No redeem button in LINE.
- Redemption happens only at the cashier with the ERS points-redemption item; ERS checks the live balance, so the card's delay can't be used to redeem twice. Checked 2026-11-18: ERS keeps one balance across branches (14 of 15 cross-branch bills continue the balance).
- Rewards list = ERS redeemable items (`pos_m_items.isredeempoint`, cost `pointtoredeem`); optional customer-facing name and picture kept on our side by item code. Today: one item, คอหมูย่าง for 20 points.
- LINE members who aren't ERS members see "ยังไม่มีแต้ม แจ้งเบอร์นี้ที่แคชเชียร์เพื่อเริ่มสะสม"; staff create the ERS member with the same phone the first time the card is shown (we can't write into ERS).
- Phones on two ERS records (8 found): show the record with the latest bill; give Point the list to merge in ERS.
- Only the sign-up เก๊กฮวย uses the staff tap on the card. Promotional coupons go out as LINE coupons through the API.
- Open: whether ERS points expire (not answered yet; card shows no expiry until decided).

## Menu, promotions, phone code and sign-up form (decided 2026-11-18, Point)
- COUPONS list dropped: LINE can't tell us which coupons a customer has left, so promotional LINE coupons stay in the chat and customers scroll back to them.
- The second menu button becomes PROMOTIONS: promotions open to everyone (per-branch later). The webhook replies with a swipeable set of cards (picture, text, dates, branch) from table `crm.promotions` in this Marketing project; expired ones hide themselves; replies are free. Pictures in a public storage bucket. Point edits rows in the Supabase Table Editor at first; a sales-site form later. Changing the button in OA Manager may change its actionId: re-map from the "unmapped OA menu action" log.
- Phone numbers are verified by a 6-digit SMS one-time code before linking (needed once the card shows ERS points). Needs a Thai SMS provider account opened by Point and a sender name; the provider key goes into Supabase secrets by Point, never into chat.
- Sign-up becomes a form opened from a "สมัครสมาชิก" button that the webhook sends on follow (free reply), through a one-time link tied to the LINE user. Fields: name, birthday, branch, phone (with code), consent with a short privacy notice (Thai PDPA). After submit the reply shows the member card with the free เก๊กฮวย as today.

## Built 2026-11-18 (v4): points, rewards, PROMOTIONS, sign-up form
- Migration 0012: profile columns on crm.line_members (full_name, birthday, branch_id, consent_at, consent_version, signup_source); crm.pos_points, crm.pos_rewards, crm.reward_display, crm.branches, crm.promotions, crm.signup_tokens; settings points_sync_key, signup_form_url, privacy_version (draft-2026-11-18), points_expiry_note, signup_push, menu_action_promotions.
- Points: `~/mamapook-data/tools/crm_points_push.py` runs in run_local.sh every cycle (step crm_points) and POSTs to Edge Function `crm-points-sync` (header x-sync-key = settings.points_sync_key = Mac .env MARKETING_POINTS_KEY). It replaces crm.pos_points (684 phones on first run), crm.pos_rewards (PRO1, 20 points) and crm.branches (6). The script lives in the backbone repo so launchd never reads ~/Documents.
- Migration 0013 + crm-points-sync v2: `crm.test_points(phone, points, note, expires_at default +3 days)` — demo balances re-applied after every sync until they expire (they override the ERS balance for that phone, so owner/staff test numbers only). Card rule: a used coupon stays on the card, crossed out, until midnight Bangkok time on the day it was used (Point 2026-11-18).
- **CRM admin area (2026-11-18):** the sales site (mamapook-sales.pages.dev, whole site behind login) has a top-level CRM area: overview/insights, members (full details + change phone), promotions editor, promotional LINE coupon send (preview → confirm, server checks `expect` + quota), settings, reward display names, test points, change log. Door: Pages Function `/api/crm` → Edge Function `crm-admin` (migration 0014: crm.admin_log, crm.coupon_sends; key = Pages secret CRM_ADMIN_KEY, sha256 in crm.settings.admin_key_sha256, raw also in the Mac .env). Every write is logged with the login name. Details: sales repo `Project Sales Web.md` › CRM area.
- line-webhook v4 (one function, three doors): LINE events; `/signup` for the form (GET ?t= / POST); admin push with the one-time send_key, modes card | promotions (include_inactive for previews) | signup. Follow sends the sign-up button (free reply); a typed number from a non-member gets the button; MEMBERS for a non-member gets the button. The card shows the ERS balance with update time and "แต้มมีอายุ 3 เดือน", the reward ladder (affordable = red box "แลกได้ที่แคชเชียร์", else grey "อีก X แต้ม"), and each coupon with its own ใช้สิทธิ์ button; coupons that start later say "เริ่มใช้ได้ …" (sign-up keeps "ใช้ได้ในการมาครั้งถัดไป").
- Sign-up form: `member-card-page/register.html` on Cloudflare Worker `mamapook-member` → https://mamapook-member.itthichet-a.workers.dev/register?t=<token>. Tokens are 40 hex, one use, 7 days. Existing members can open it to add their details; their phone is locked. After submit the webhook pushes the confirmation + card (1 message; setting signup_push = off stops it).
- Reward names: crm.reward_display maps ERS item codes to customer names (PRO1 = ก๋วยเตี๋ยวคอหมูย่าง ฟรี 1 ชาม, wording by Claude, Point to confirm).
- line-coupon-send v3: coupon creation only; card pushes moved to the webhook so the card code exists once.
- Tested 2026-11-18: form API (consent missing, phone taken, valid, token reuse, second token with another phone) with a throwaway member, then deleted; card, promotions preview (2 inactive test promotions) and the form button pushed to Point.
- Owner to do: approve the privacy wording; shorten the OA Manager greeting (no more "type your number"); relabel the COUPONS button to PROMOTIONS (re-map its action id if taps stop working); add real promotions in crm.promotions; brief staff to create ERS members with the same phone.
- **2026-11-18 (Point): sign-up gift OFF for now.** Switch `crm.settings.signup_reward` (0015): off = no coupon on sign-up and no gift wording on the chat button, form or confirmation; already-issued coupons stay. Toggle in the sales site CRM › Settings. Same day: Job's member record (1 coupon, 3 LINE events) deleted at Point's request (logged in crm.admin_log).
