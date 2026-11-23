-- 0028: the coupon's own on/off is a switch on the page (Point 2026-11-23). Switching a coupon back ON must not
-- give coupons for bills paid while it was off, so its live rules start counting from that moment.
create or replace function crm.template_rearm() returns trigger language plpgsql as $$
begin
  if new.active and not old.active then
    update crm.coupon_rules set armed_at = now(), updated_at = now() where template_id = new.id and active;
  end if;
  return new;
end $$;
drop trigger if exists coupon_templates_rearm on crm.coupon_templates;
create trigger coupon_templates_rearm after update of active on crm.coupon_templates
  for each row execute function crm.template_rearm();
