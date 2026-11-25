-- 0032 (Point 2026-11-25): per-coupon gift switch. crm.settings coupon_gifts stays the master switch; a coupon can be
-- passed on only when the master is on AND its template's giftable is true (edit form, under "ใช้คูปองได้เวลา").
alter table crm.coupon_templates add column if not exists giftable boolean not null default true;

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
      select c.id from crm.coupons c join crm.coupon_templates t on t.id = c.template_id and t.giftable
       where c.line_user_id = v_from and c.template_id = rep.template_id and c.title = rep.title
         and c.valid_from = rep.valid_from and c.valid_to = rep.valid_to
         and c.rule_id is not null and c.gifted_from is null and c.redeemed_at is null and c.valid_to >= d
       order by c.id limit want for update of c) x;
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
