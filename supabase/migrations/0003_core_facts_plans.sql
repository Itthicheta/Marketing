-- 0003: core facts (rebuilt from raw) and planning tables (manual input)

-- ------------------------------------------------------------ POS facts
create table core.fact_bill (
  bill_id      bigint generated always as identity primary key,
  source_bill_id text not null,
  branch_code  text not null references core.dim_branch,
  channel_code text not null references core.dim_channel,
  bill_ts      timestamptz not null,
  date_key     date not null references core.dim_date,
  hour_of_day  int  not null,
  net_amount   numeric(12,2) not null,
  discount     numeric(12,2) default 0,
  -- denormalized basket stats, set by core.rebuild_bill_stats():
  main_dish_qty int,                       -- Σ qty of main-dish lines (deck p.19)
  addon_units   int,                       -- Σ qty of add-on lines, Sets excluded (deck p.20-21)
  has_addon     boolean,
  combo_pattern text,                      -- e.g. 'signature x1 + noodles x1' (deck p.19)
  unique (source_bill_id, branch_code)
);
create index on core.fact_bill (date_key, branch_code, channel_code);

create table core.fact_bill_line (
  line_id     bigint generated always as identity primary key,
  bill_id     bigint not null references core.fact_bill on delete cascade,
  sku         text references core.dim_menu_item,        -- null => unmapped raw name
  item_name_raw text not null,
  noodle_code text references core.dim_noodle_type,
  qty         numeric(10,2) not null,
  net_amount  numeric(12,2) not null
);
create index on core.fact_bill_line (bill_id);
create index on core.fact_bill_line (sku);

-- Transform raw -> core. Idempotent: re-runnable for a date range (backfill-safe).
create or replace function core.load_pos(p_from date, p_to date)
returns int language plpgsql as $$
declare v_count int;
begin
  delete from core.fact_bill
   where date_key between p_from and p_to;

  insert into core.fact_bill (source_bill_id, branch_code, channel_code, bill_ts,
                              date_key, hour_of_day, net_amount, discount)
  select b.source_bill_id, b.branch_code, b.channel_code, b.bill_ts,
         b.bill_ts::date, extract(hour from b.bill_ts)::int, b.net_amount, b.discount
  from raw.pos_bills b
  where b.bill_ts::date between p_from and p_to;

  insert into core.fact_bill_line (bill_id, sku, item_name_raw, noodle_code, qty, net_amount)
  select fb.bill_id, m.sku, l.item_name_raw, mm.noodle_code, l.qty, l.net_amount
  from raw.pos_bill_lines l
  join core.fact_bill fb
    on fb.source_bill_id = l.source_bill_id and fb.branch_code = l.branch_code
  left join core.map_item_name m  on m.item_name_raw = l.item_name_raw
  left join core.map_modifier  mm on mm.modifier_raw = l.modifier_raw
  where fb.date_key between p_from and p_to;
  get diagnostics v_count = row_count;

  perform core.rebuild_bill_stats(p_from, p_to);
  return v_count;
end $$;

-- Basket stats per bill: main-dish count, add-on units (Sets excluded), combo pattern.
create or replace function core.rebuild_bill_stats(p_from date, p_to date)
returns void language sql as $$
  with per_cat as (                        -- qty per bill x category
    select fb.bill_id,
           c.category_code,
           c.is_main_dish,
           c.is_addon and not coalesce(mi.is_set, false) as counts_as_addon,
           sum(l.qty)::int as qty
    from core.fact_bill fb
    join core.fact_bill_line l on l.bill_id = fb.bill_id
    left join core.dim_menu_item mi on mi.sku = l.sku
    left join core.dim_category c on c.category_code = mi.category_code
    where fb.date_key between p_from and p_to
    group by fb.bill_id, c.category_code, c.is_main_dish, counts_as_addon
  ),
  agg as (
    select bill_id,
           coalesce(sum(qty) filter (where is_main_dish), 0)     as main_dish_qty,
           coalesce(sum(qty) filter (where counts_as_addon), 0)  as addon_units,
           string_agg(category_code || ' x' || qty, ' + ' order by qty desc, category_code)
             filter (where is_main_dish)                         as combo_pattern
    from per_cat group by bill_id
  )
  update core.fact_bill fb
     set main_dish_qty = a.main_dish_qty,
         addon_units   = a.addon_units,
         has_addon     = a.addon_units > 0,
         combo_pattern = coalesce(a.combo_pattern, 'no main dish')
  from agg a where a.bill_id = fb.bill_id;
$$;

-- ------------------------------------------------------ marketing facts
create table core.fact_marketing_spend (
  id            bigint generated always as identity primary key,
  spend_date    date not null references core.dim_date,
  cost_type_code text not null references core.dim_cost_type,
  platform_code text references core.dim_platform,
  campaign_id   bigint,                    -- fk added after plan_campaign
  amount        numeric(12,2) not null,
  description   text,
  source        text not null default 'accounting'   -- accounting / manual / ads_api
);

create table core.fact_ad_performance (
  id            bigint generated always as identity primary key,
  perf_date     date not null references core.dim_date,
  platform_code text not null references core.dim_platform,
  campaign_id   bigint,
  audience_group text,                     -- for A/B tests (deck p.59)
  spend         numeric(12,2),
  impressions   bigint, reach bigint, clicks int,
  attributed_orders int,
  attributed_sales  numeric(12,2)
);

-- --------------------------------------- social / reputation facts
create table core.fact_social_snapshot (
  id            bigint generated always as identity primary key,
  platform_code text not null references core.dim_platform,
  account_handle text not null,
  is_competitor boolean not null default false,
  competitor_code text references core.dim_competitor,
  snapshot_date date not null references core.dim_date,
  followers int, posts_count int, total_likes bigint,
  unique (platform_code, account_handle, snapshot_date)
);

create table core.fact_social_post (
  post_key      bigint generated always as identity primary key,
  platform_code text not null references core.dim_platform,
  post_id       text not null,
  account_handle text not null,
  is_competitor boolean not null default false,
  competitor_code text references core.dim_competitor,
  posted_at     timestamptz,
  date_key      date references core.dim_date,
  post_type     text,
  caption       text,
  url           text,
  reach bigint, impressions bigint, views bigint,
  likes int, comments int, shares int, saves int,
  -- enrichment (Claude API):
  pillar_code   text references core.dim_content_pillar,
  focus_skus    text[] not null default '{}',   -- menu items featured -> content-to-sales link
  is_promo      boolean,                        -- competitor promo detector
  content_plan_id bigint,                       -- fk added after plan_content
  unique (platform_code, post_id)
);

create table core.fact_listing_snapshot (
  id            bigint generated always as identity primary key,
  platform_code text not null references core.dim_platform,
  branch_code   text references core.dim_branch,
  is_competitor boolean not null default false,
  competitor_code text references core.dim_competitor,
  snapshot_date date not null references core.dim_date,
  avg_rating    numeric(3,2),
  rating_count  int
);

create table core.fact_review (
  review_key    bigint generated always as identity primary key,
  platform_code text not null references core.dim_platform,
  branch_code   text references core.dim_branch,
  is_competitor boolean not null default false,
  competitor_code text references core.dim_competitor,
  source_review_id text,
  review_ts     timestamptz,
  date_key      date references core.dim_date,
  rating        numeric(2,1),
  review_text   text,
  ordered_items text[],
  -- enrichment (Claude API):
  sentiment     text,                      -- positive / neutral / negative
  themes        text[] not null default '{}',  -- taste_sweet, off_smell, portion_value, consistency, packaging, service, wait_time...
  unique (platform_code, source_review_id)
);

-- ------------------------------------------------------ planning tables
create table core.plan_budget (
  id            bigint generated always as identity primary key,
  month_start   date not null,
  cost_type_code text not null references core.dim_cost_type,
  planned_amount numeric(12,2) not null,
  unique (month_start, cost_type_code)
);

create table core.plan_campaign (
  campaign_id  bigint generated always as identity primary key,
  name         text not null,
  campaign_type text,                      -- promo / set_menu / ads / influencer / event
  channel_codes text[] not null default '{}',
  branch_codes  text[] not null default '{}',
  platform_codes text[] not null default '{}',
  start_date   date not null,
  end_date     date,
  budget       numeric(12,2),
  target       text,
  status       text not null default 'planned',  -- planned / live / done / cancelled
  notes        text
);
alter table core.fact_marketing_spend
  add constraint fk_spend_campaign foreign key (campaign_id) references core.plan_campaign;
alter table core.fact_ad_performance
  add constraint fk_adperf_campaign foreign key (campaign_id) references core.plan_campaign;

-- Content calendar: spec sheet + creative brief (deck p.66-75 schema)
create table core.plan_content (
  content_id   bigint generated always as identity primary key,
  plan_month   date not null,
  seq_no       int,
  topic        text not null,
  platform_codes text[] not null default '{}',
  target       text,
  pillar_codes text[] not null default '{}',
  content_type text,                       -- reels / photo / carousel ...
  brief_type   text,
  objective    text,
  size_spec    text,                       -- e.g. 1080x1920 (9:16)
  tone         text,
  branch_scope text not null default 'all',
  focus_skus   text[] not null default '{}',   -- menu focus -> sales correlation
  key_concept  text,
  key_messages text[],
  voiceover    text,
  key_format   text[],
  reference_urls text[],
  status       text not null default 'planned',  -- planned / briefed / produced / posted
  campaign_id  bigint references core.plan_campaign
);
alter table core.fact_social_post
  add constraint fk_post_content foreign key (content_plan_id) references core.plan_content;

-- CRM link (future): customers land here when the CRM goes live
create table core.dim_customer (
  customer_id  bigint generated always as identity primary key,
  crm_id       text unique,
  line_user_id text unique,
  phone        text,
  first_seen   date,
  segment      text                        -- office_weekday / family_weekend / ...
);
alter table core.fact_bill add column customer_id bigint references core.dim_customer;
