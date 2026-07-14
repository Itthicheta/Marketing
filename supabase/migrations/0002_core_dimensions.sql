-- 0002: core dimensions + seeds (values extracted from the agency report)

-- ------------------------------------------------------------- branches
create table core.dim_branch (
  branch_code  text primary key,
  branch_name  text not null,
  open_date    date,                       -- OCC opened mid-period: per-day averages divide by open days
  close_date   date,
  has_delivery boolean not null default true,
  google_place_id text,
  active       boolean not null default true
);

insert into core.dim_branch (branch_code, branch_name, has_delivery) values
  ('rama9',   'Rama9',   true),
  ('silom',   'Silom',   true),
  ('gaysorn', 'Gaysorn', true),
  ('occ',     'OCC',     false);

-- ------------------------------------------------------------- channels
create table core.dim_channel (
  channel_code text primary key,
  channel_name text not null
);
insert into core.dim_channel values
  ('dine_in','Dine-In'), ('take_away','Take Away'), ('delivery','Delivery');

-- ------------------------------------------------------------- calendar
-- The "extra factors": day of week, day type, day of month, month,
-- Thai holidays, payday window, custom events. Populated 2024-2030.
create table core.dim_date (
  date_key     date primary key,
  year         int  not null,
  month        int  not null,
  day_of_month int  not null,
  day_of_week  int  not null,              -- ISO: 1=Mon .. 7=Sun
  day_name     text not null,
  day_type     text not null,              -- weekday / weekend
  is_holiday   boolean not null default false,
  holiday_name text,
  is_payday_window boolean not null default false,  -- 1st, 15th, last 2 days of month
  event_tags   text[] not null default '{}'
);

insert into core.dim_date (date_key, year, month, day_of_month, day_of_week, day_name, day_type, is_payday_window)
select d::date,
       extract(year from d)::int,
       extract(month from d)::int,
       extract(day from d)::int,
       extract(isodow from d)::int,
       to_char(d, 'Dy'),
       case when extract(isodow from d) in (6,7) then 'weekend' else 'weekday' end,
       extract(day from d) in (1, 15)
         or d::date >= (date_trunc('month', d) + interval '1 month - 2 days')::date
from generate_series('2024-01-01'::date, '2030-12-31'::date, interval '1 day') d;

-- Thai public holidays are loaded separately (update yearly):
-- update core.dim_date set is_holiday = true, holiday_name = ... where date_key = ...

-- ------------------------------------------------------------- menu
create table core.dim_category (
  category_code text primary key,
  category_name_th text,
  category_name_en text not null,
  is_main_dish  boolean not null default false,  -- deck p.19: Signature, Noodles, Rice, Gaolao
  is_addon      boolean not null default false
);
insert into core.dim_category values
  ('signature','Signature','Signature',              true,  false),
  ('noodles',  'ก๋วยเตี๋ยว','Noodles',                true,  false),
  ('rice',     'ข้าว','Rice',                        true,  false),
  ('gaolao',   'เกาเหลา','Gaolao (soup, no noodles)', true,  false),
  ('snacks',   'ของทานเล่น','Snacks / Appetizers',    false, true),
  ('beverages','เครื่องดื่ม','Beverages',             false, true),
  ('desserts', 'ขนม','Desserts',                     false, true),
  ('set',      'Set','Set Menu',                     false, false);  -- excluded from add-on analyses

-- Add-on subcategories used in the attachment tables (deck p.20-26)
create table core.dim_addon_subcategory (
  subcategory_code text primary key,
  category_code    text not null references core.dim_category,
  name_en          text not null
);
insert into core.dim_addon_subcategory values
  ('soft_drink_water','beverages','Soft drinks / water'),
  ('brewed_drink',    'beverages','Brewed drinks'),
  ('fried',           'snacks',   'Fried'),
  ('general',         'snacks',   'General snacks'),
  ('sides',           'snacks',   'Side dishes'),
  ('share',           'snacks',   'Sharing items'),
  ('dessert',         'desserts', 'Desserts');

-- Menu master: SKU + normalized name + flags. Costs/prices arrive with the
-- owner's detailed menu file; margin fields nullable until then.
create table core.dim_menu_item (
  sku            text primary key,          -- S1, N3, A2 ... (deck p.14)
  name_th        text,
  name_en        text,
  name_normalized text not null,
  category_code  text not null references core.dim_category,
  addon_subcategory text references core.dim_addon_subcategory,
  is_signature   boolean not null default false,
  is_set         boolean not null default false,
  price          numeric(10,2),
  unit_cost      numeric(10,2),
  active         boolean not null default true
);

-- Raw POS name -> SKU mapping ("Menu (normalized)" layer, deck p.14).
-- Unmapped names surface in ops views for manual mapping.
create table core.map_item_name (
  item_name_raw text primary key,
  sku           text not null references core.dim_menu_item
);

-- Noodle-type modifiers (deck p.15, 17)
create table core.dim_noodle_type (
  noodle_code text primary key,
  name_th     text not null,
  name_en     text not null
);
insert into core.dim_noodle_type values
  ('sen_yai',    'เส้นใหญ่','Wide rice noodle'),
  ('sen_mee',    'เส้นหมี่','Rice vermicelli'),
  ('sen_lek',    'เส้นเล็ก','Thin rice noodle'),
  ('bamee_flat', 'บะหมี่แบน','Flat egg noodle'),
  ('bamee_round','บะหมี่กลม','Round egg noodle');

create table core.map_modifier (
  modifier_raw text primary key,
  noodle_code  text references core.dim_noodle_type
);

-- ------------------------------------------------- marketing dimensions
create table core.dim_cost_type (
  cost_type_code text primary key,
  cost_type_name text not null
);
insert into core.dim_cost_type values
  ('influencer_fee',    'Influencer management fee'),
  ('influencer_budget', 'Influencer budget'),
  ('ads_social',        'Ads - Social media'),
  ('ads_google',        'Ads - Google'),
  ('ads_delivery',      'Ads - Delivery platform'),
  ('other',             'Other marketing cost');

create table core.dim_platform (
  platform_code text primary key,
  platform_name text not null,
  platform_kind text not null              -- social / delivery / maps / messaging
);
insert into core.dim_platform values
  ('facebook','Facebook','social'), ('instagram','Instagram','social'),
  ('tiktok','TikTok','social'),     ('line_oa','LINE OA','messaging'),
  ('grab','GrabFood','delivery'),   ('line_man','LINE MAN','delivery'),
  ('google_maps','Google Maps','maps'), ('wongnai','Wongnai','maps');

-- Content pillars (deck p.64)
create table core.dim_content_pillar (
  pillar_code text primary key,
  pillar_name text not null,
  objective   text
);
insert into core.dim_content_pillar values
  ('local_bold_taste',  'Local Bold Taste',        'Brand recall as original, bold-flavored local noodle shop'),
  ('appetite_appeal',   'Menu Appetite Appeal',    'Stimulate craving via appetizing presentation'),
  ('made_like_family',  'Made Like Family',        'Trust: food made with care as if for family'),
  ('variety_value',     'Variety & Value',         'Varied menu, filling and worthwhile'),
  ('everyday_occasion', 'Everyday Meal Occasion',  'Part of daily eating: lunch, rush, after-work, delivery'),
  ('customer_proof',    'Customer Proof',          'Credibility via real customer visits/testimonials'),
  ('decision_support',  'Purchase Decision Support','Order channels, branches, hours, sets, offers');

create table core.dim_competitor (
  competitor_code text primary key,
  competitor_name text not null,
  google_place_id text,
  social_handles  jsonb,                   -- {facebook: "...", instagram: "...", tiktok: "..."}
  notes           text,
  active          boolean not null default true
);
