-- 0035 (Point 2026-11-26): unique one-use coupon codes keyed into ERS.
-- Flow: CRM generates a batch for a coupon -> Excel -> Point imports into the coupon's ERS series -> the Mac sync pushes
-- ERS CouponSeries + CouponCard every 30 min (crm.ers_coupon_series / crm.ers_coupon_cards, replaced each run) ->
-- a code is handed out only if it is in OUR batch for that coupon AND ERS has it, active and unused, in the coupon's
-- linked series. The code is taken at the staff tap (ยืนยัน), never at issue, so gifts / take-backs need no code handling.
-- Codes: 8 digits, first digit 1-9, unique across everything forever (primary key).

alter table crm.coupon_templates add column if not exists ers_series_id int;          -- ERS CouponSeriesId
alter table crm.coupon_templates add column if not exists use_codes boolean not null default false;

create table if not exists crm.ers_coupon_series (
  series_id int primary key, name text, code text, active boolean, inside boolean,
  start_date date, expire_date date, branch_ids int[], synced_at timestamptz not null default now());
create table if not exists crm.ers_coupon_cards (
  card_id int primary key, series_id int, number text not null, active boolean, expire_date date,
  used boolean not null default false, used_at timestamptz, used_branch_id int, used_order_id text, used_bill_no text,
  inserted_at timestamptz, synced_at timestamptz not null default now());
create index if not exists ers_coupon_cards_number on crm.ers_coupon_cards (number);

create table if not exists crm.code_batches (
  id bigint generated always as identity primary key,
  template_id bigint references crm.coupon_templates(id) on delete set null,
  title text, ers_series_id int, n int not null check (n between 1 and 5000),
  actor text, created_at timestamptz not null default now());

create table if not exists crm.coupon_codes (
  code text primary key check (code ~ '^[1-9][0-9]{7}$'),
  template_id bigint references crm.coupon_templates(id) on delete set null,
  batch_id bigint not null references crm.code_batches(id),
  created_at timestamptz not null default now(),
  coupon_id bigint unique references crm.coupons(id) on delete set null,
  shown_at timestamptz);
create index if not exists coupon_codes_free on crm.coupon_codes (template_id) where shown_at is null;

alter table crm.ers_coupon_series enable row level security;
alter table crm.ers_coupon_cards enable row level security;
alter table crm.code_batches enable row level security;
alter table crm.coupon_codes enable row level security;

-- the coupon's code state for the CRM: one row per code we generated
create or replace view crm.coupon_code_state with (security_invoker = true) as
select c.code, c.template_id, c.batch_id, c.created_at, c.coupon_id, c.shown_at, t.ers_series_id,
       e.card_id, e.series_id ers_series_seen, e.active ers_active, e.used ers_used, e.used_at, e.used_branch_id, e.used_order_id, e.used_bill_no,
       case when e.card_id is null then 'pending'                                   -- not (yet) in ERS
            when e.series_id is distinct from t.ers_series_id then 'wrong_series'     -- imported into another series
            when c.shown_at is null and e.used then 'fraud'                         -- used in ERS, never shown in LINE
            when c.shown_at is null and not coalesce(e.active, false) then 'off'      -- switched off in ERS
            when c.shown_at is null then 'ready'
            when e.used then 'used'
            else 'shown' end state
from crm.coupon_codes c
left join crm.coupon_templates t on t.id = c.template_id
left join lateral (select * from crm.ers_coupon_cards x where x.number = c.code order by (x.series_id = t.ers_series_id) desc, x.card_id limit 1) e on true;

-- staff ยืนยัน on a code coupon: use the coupon and take one ready code in one statement-level transaction.
-- raises 'code:gone' (coupon already used / not valid today) or 'code:empty' (no ready code: coupon NOT used).
create or replace function crm.redeem_with_code(p_coupon bigint, p_user text)
returns table (code text, used_at timestamptz, valid_to date) language plpgsql as $$
declare d date := (now() at time zone 'Asia/Bangkok')::date; cp record; k text;
begin
  select c.id, c.template_id, c.valid_to into cp from crm.coupons c
   where c.id = p_coupon and c.line_user_id = p_user and c.redeemed_at is null and d between c.valid_from and c.valid_to
   for update;
  if not found then raise exception 'code:gone'; end if;
  select cc.code into k from crm.coupon_codes cc
    join crm.coupon_templates t on t.id = cc.template_id
    join crm.ers_coupon_cards e on e.number = cc.code and e.series_id = t.ers_series_id and e.active and not e.used
   where cc.template_id = cp.template_id and cc.shown_at is null and cc.coupon_id is null
   order by cc.created_at, cc.code limit 1 for update of cc skip locked;
  if k is null then raise exception 'code:empty'; end if;
  update crm.coupons set redeemed_at = now() where id = cp.id;
  update crm.coupon_codes set coupon_id = cp.id, shown_at = now() where coupon_codes.code = k;
  return query select k, now(), cp.valid_to;
end $$;
revoke all on function crm.redeem_with_code(bigint, text) from public, anon, authenticated;

insert into crm.settings (key, value) values ('code_low_warn', '50') on conflict (key) do nothing;
