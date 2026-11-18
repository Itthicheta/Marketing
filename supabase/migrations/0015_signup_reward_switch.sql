-- 0015: on/off switch for the sign-up gift (Point 2026-11-18: "remove the free เก๊กฮวย when register for now").
-- off = new sign-ups get no coupon and no gift wording (button, form, confirmation). Coupons already issued stay.
-- Editable in the sales site's CRM area › Settings.
insert into crm.settings (key, value) values ('signup_reward', 'off')
on conflict (key) do update set value = 'off', updated_at = now();
