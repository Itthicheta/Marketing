-- 0018: promotion card look set from the sales site CRM › โปรโมชั่น (Point 2026-11-19: "for the look of the card can
-- we config in the page, and the preview show live"). promo_style = one JSON for every card (size, picture ratio,
-- top band + text, accent colour, title colour, dates, branch label); each promotion may add one button.
alter table crm.promotions add column if not exists button_label text, add column if not exists button_url text;
insert into crm.settings (key, value) values ('promo_style',
  '{"size":"kilo","ratio":"20:13","band":false,"band_text":"โปรโมชั่น","color":"#C8102E","title_color":"#1D1D1F","dates":"end","branch":true}')
on conflict (key) do nothing;
