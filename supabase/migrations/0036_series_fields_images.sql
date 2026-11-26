-- 0036 (Point 2026-11-26): (1) ERS series fields needed to write the code file in ERS's own import layout
-- (CouponCardList.xls: CouponNumber, ExpireDate, CouponSeriesName, CouponType, IsPercentDiscount, DiscountPercent,
-- DiscountAmount, CashAmount). (2) public Storage bucket for images uploaded from the CRM (LINE coupon / promotion
-- pictures need an https link; the CRM uploads through crm-admin op image_upload with the service role).
alter table crm.ers_coupon_series add column if not exists coupon_type int;
alter table crm.ers_coupon_series add column if not exists is_percent boolean;
alter table crm.ers_coupon_series add column if not exists discount_percent numeric;
alter table crm.ers_coupon_series add column if not exists discount_amount numeric;
alter table crm.ers_coupon_series add column if not exists cash_amount numeric;
alter table crm.ers_coupon_series add column if not exists expire_at text;   -- ERS wall clock 'YYYY-MM-DD HH24:MI:SS'

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('crm-images', 'crm-images', true, 1048576, array['image/jpeg', 'image/png'])
on conflict (id) do update set public = true, file_size_limit = 1048576, allowed_mime_types = array['image/jpeg', 'image/png'];
