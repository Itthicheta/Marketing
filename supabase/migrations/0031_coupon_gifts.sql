-- 0031 coupon gifts (Point 2026-11-25): a LINE member passes unused coupons of ours to another LINE-linked member.
-- Flow: the card's "ส่งต่อให้เพื่อน" button opens member-card-page/gift.html?t=<one-time token> -> line-webhook /gift:
--   GET ?t=            -> the sender's giftable stacks
--   POST {t, phone}    -> the friend's masked name ("คุณสมชาย ใ***", last 4 digits) — at most 10 lookups per link
--   POST {t, phone, items:[{key, n}], confirm:true} -> moves the coupons; the link is then used up.
-- Rules (Point): only coupons from coupon rules (never the sign-up gift); one hop (a received coupon has gifted_from
-- set and is never giftable again); expiry / use window travel with the coupon; the friend gets no LINE message.
-- Void take-back (0029) matches by source_line, so a gifted coupon is taken back from the friend too.
-- Re-issue is impossible: coupons_rule_unit is unique on (rule_id, source_line, unit_no), whoever holds it.

alter table crm.coupons
  add column if not exists gifted_from text,          -- sender's line_user_id (null = earned by the holder)
  add column if not exists gifted_at timestamptz;

create table if not exists crm.gift_tokens (
  token        text primary key check (token ~ '^[a-f0-9]{40}$'),
  line_user_id text not null references crm.line_members (line_user_id),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '30 minutes',
  lookups      int not null default 0,
  used_at      timestamptz
);
create index if not exists gift_tokens_exp on crm.gift_tokens (expires_at);

create table if not exists crm.coupon_gifts (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  from_user  text not null,
  to_user    text not null,
  coupon_ids bigint[] not null,
  title      text not null,
  n          int not null check (n > 0)
);
create index if not exists coupon_gifts_from on crm.coupon_gifts (from_user);
create index if not exists coupon_gifts_to on crm.coupon_gifts (to_user);

alter table crm.gift_tokens enable row level security;
alter table crm.coupon_gifts enable row level security;

-- The whole transfer in one statement-level transaction: any failure raises 'gift:<code>' and nothing moves.
-- p_items = [{"key": <id of any coupon in the stack>, "n": <how many>}]; a stack = same template, title and dates.
create or replace function crm.gift_coupons(p_token text, p_phone text, p_items jsonb)
returns jsonb language plpgsql as $$
declare
  v_from text; v_to text; d date := (now() at time zone 'Asia/Bangkok')::date;
  it jsonb; rep record; ids bigint[]; want int; total int := 0; out jsonb := '[]'::jsonb;
begin
  select line_user_id into v_from from crm.gift_tokens
   where token = p_token and used_at is null and expires_at > now() for update;
  if v_from is null then raise exception 'gift:expired'; end if;
  select line_user_id into v_to from crm.line_members
   where phone = p_phone and linked_at is not null and blocked_at is null;
  if v_to is null then raise exception 'gift:not_member'; end if;
  if v_to = v_from then raise exception 'gift:self'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'gift:nothing'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    want := coalesce((it->>'n')::int, 0);
    if want < 1 or want > 50 then raise exception 'gift:bad_qty'; end if;
    select template_id, title, valid_from, valid_to into rep from crm.coupons
     where id = (it->>'key')::bigint and line_user_id = v_from;
    if not found then raise exception 'gift:not_enough'; end if;
    select array_agg(id) into ids from (
      select id from crm.coupons
       where line_user_id = v_from and template_id = rep.template_id and title = rep.title
         and valid_from = rep.valid_from and valid_to = rep.valid_to
         and rule_id is not null and gifted_from is null and redeemed_at is null and valid_to >= d
       order by id limit want for update) x;
    if coalesce(cardinality(ids), 0) < want then raise exception 'gift:not_enough'; end if;
    update crm.coupons set line_user_id = v_to, gifted_from = v_from, gifted_at = now() where id = any(ids);
    insert into crm.coupon_gifts (from_user, to_user, coupon_ids, title, n) values (v_from, v_to, ids, rep.title, want);
    total := total + want;
    out := out || jsonb_build_object('title', rep.title, 'n', want, 'valid_to', rep.valid_to);
  end loop;
  update crm.gift_tokens set used_at = now() where token = p_token;
  return jsonb_build_object('ok', true, 'n', total, 'items', out, 'to_user', v_to);
end $$;
revoke all on function crm.gift_coupons(text, text, jsonb) from public, anon, authenticated;

insert into crm.settings (key, value) values
  ('coupon_gifts', 'off'),                                                   -- on/off switch (off until Point checks the wording)
  ('gift_form_url', 'https://mamapook-member.itthichet-a.workers.dev/gift')
on conflict (key) do nothing;
