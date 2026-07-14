-- 0001: schemas, raw landing tables, operational tables
create schema if not exists raw;
create schema if not exists core;
create schema if not exists marts;
create schema if not exists ops;

-- ---------------------------------------------------------------- raw: POS
-- Append-only. `payload` keeps the original record so core can be rebuilt
-- when mapping rules change.
create table raw.pos_bills (
  id            bigint generated always as identity primary key,
  source_bill_id text not null,            -- POS receipt id
  branch_code   text not null,
  channel_code  text not null,             -- dine_in / take_away / delivery
  bill_ts       timestamptz not null,
  gross_amount  numeric(12,2),
  discount      numeric(12,2) default 0,
  net_amount    numeric(12,2) not null,
  payload       jsonb,
  ingested_at   timestamptz not null default now(),
  unique (source_bill_id, branch_code)
);

create table raw.pos_bill_lines (
  id             bigint generated always as identity primary key,
  source_bill_id text not null,
  branch_code    text not null,
  line_no        int,
  item_name_raw  text not null,            -- raw POS item name, mapped in core
  modifier_raw   text,                     -- e.g. noodle type
  qty            numeric(10,2) not null default 1,
  net_amount     numeric(12,2) not null,
  payload        jsonb,
  ingested_at    timestamptz not null default now()
);
create index on raw.pos_bill_lines (source_bill_id, branch_code);

-- ------------------------------------------------------- raw: accounting
create table raw.accounting_expenses (
  id           bigint generated always as identity primary key,
  expense_date date not null,
  account_name text,
  description  text,
  amount       numeric(12,2) not null,
  cost_type_hint text,                     -- mapped to core.dim_cost_type
  payload      jsonb,
  ingested_at  timestamptz not null default now()
);

-- --------------------------------------------- raw: social / listings / reviews
create table raw.social_profile_snapshots (
  id            bigint generated always as identity primary key,
  platform      text not null,             -- facebook / instagram / tiktok / line_oa
  account_handle text not null,
  is_competitor boolean not null default false,
  snapshot_date date not null,
  followers     int, following_count int, posts_count int, total_likes bigint,
  payload       jsonb,
  ingested_at   timestamptz not null default now(),
  unique (platform, account_handle, snapshot_date)
);

create table raw.social_posts (
  id            bigint generated always as identity primary key,
  platform      text not null,
  account_handle text not null,
  is_competitor boolean not null default false,
  post_id       text not null,
  posted_at     timestamptz,
  post_type     text,                      -- reel / photo / video / carousel
  caption       text,
  url           text,
  reach bigint, impressions bigint, views bigint,
  likes int, comments int, shares int, saves int,
  metrics_as_of timestamptz,
  payload       jsonb,
  ingested_at   timestamptz not null default now(),
  unique (platform, post_id)
);

create table raw.listing_snapshots (
  id            bigint generated always as identity primary key,
  platform      text not null,             -- google_maps / grab / line_man / wongnai
  branch_code   text,
  is_competitor boolean not null default false,
  competitor_name text,
  snapshot_date date not null,
  avg_rating    numeric(3,2),
  rating_count  int,
  payload       jsonb,
  ingested_at   timestamptz not null default now()
);

create table raw.reviews (
  id            bigint generated always as identity primary key,
  platform      text not null,
  branch_code   text,
  is_competitor boolean not null default false,
  competitor_name text,
  source_review_id text,
  review_ts     timestamptz,
  rating        numeric(2,1),
  review_text   text,
  ordered_items text[],
  topic_tag     text,                      -- platform-provided topic (e.g. Packaging)
  payload       jsonb,
  ingested_at   timestamptz not null default now(),
  unique (platform, source_review_id)
);

-- ------------------------------------------------------------ raw: LINE OA
create table raw.line_events (
  id          bigint generated always as identity primary key,
  event_type  text not null,               -- message / follow / unfollow / postback ...
  line_user_id text,
  event_ts    timestamptz not null,
  payload     jsonb not null,
  ingested_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ ops
create table ops.ingestion_log (
  id          bigint generated always as identity primary key,
  source      text not null,               -- pos / accounting / social / listings / reviews / line
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running',  -- running / success / failed
  rows_loaded int,
  error_msg   text
);
create index on ops.ingestion_log (source, started_at desc);

create table ops.alert_rules (
  rule_key    text primary key,            -- pos_data_late / sales_anomaly / ...
  description text,
  severity    text not null default 'urgent',   -- urgent / info / digest
  threshold   numeric,
  cooldown_hours int not null default 12,
  enabled     boolean not null default true
);

create table ops.alert_queue (
  id          bigint generated always as identity primary key,
  rule_key    text not null references ops.alert_rules,
  entity_key  text not null default '',   -- e.g. branch code, review id (dedup scope)
  message     text not null,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  status      text not null default 'pending'   -- pending / sent / suppressed / failed
);
create index on ops.alert_queue (status, created_at);

insert into ops.alert_rules (rule_key, description, severity, threshold, cooldown_hours) values
  ('pos_data_late',    'No POS ingest for more than N hours',                       'urgent', 26,  12),
  ('sales_anomaly_low','Branch daily sales below baseline * threshold',            'urgent', 0.7, 20),
  ('sales_anomaly_high','Branch daily sales above baseline * threshold',           'info',   1.5, 20),
  ('bad_review',       'New review with rating <= threshold',                      'urgent', 2,   0),
  ('rating_drop',      'Listing avg rating dropped by >= threshold since last snapshot', 'urgent', 0.2, 48),
  ('competitor_promo', 'Competitor post classified as promotion / new menu',       'info',   null, 24),
  ('daily_digest',     'Morning summary of yesterday vs baseline',                 'digest', null, 20);
