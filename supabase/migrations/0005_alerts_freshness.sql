-- 0005: alert evaluation + data freshness. Scheduled via pg_cron; a Supabase
-- Edge Function drains ops.alert_queue and pushes via LINE Messaging API
-- (LINE Notify is discontinued — use an OA channel access token).

-- Enqueue helper with per-rule x entity cooldown dedup
create or replace function ops.enqueue_alert(p_rule text, p_entity text, p_message text)
returns void language plpgsql as $$
declare v_cooldown int;
begin
  select cooldown_hours into v_cooldown from ops.alert_rules
   where rule_key = p_rule and enabled;
  if not found then return; end if;

  if exists (
    select 1 from ops.alert_queue
    where rule_key = p_rule and entity_key = p_entity
      and created_at > now() - make_interval(hours => v_cooldown)
  ) then return; end if;

  insert into ops.alert_queue (rule_key, entity_key, message)
  values (p_rule, p_entity, p_message);
end $$;

-- 1. Data freshness: POS late
create or replace function ops.check_freshness()
returns void language plpgsql as $$
declare v_last timestamptz; v_threshold numeric;
begin
  select threshold into v_threshold from ops.alert_rules where rule_key = 'pos_data_late';
  select max(finished_at) into v_last from ops.ingestion_log
   where source = 'pos' and status = 'success';
  if v_last is null or v_last < now() - make_interval(hours => v_threshold::int) then
    perform ops.enqueue_alert('pos_data_late', 'pos',
      '⚠️ POS data is late: last successful load ' ||
      coalesce(to_char(v_last, 'YYYY-MM-DD HH24:MI'), 'never') ||
      '. Dashboard numbers may be stale.');
  end if;
end $$;

-- 2. Sales anomaly vs baseline (yesterday, per branch)
create or replace function ops.check_sales_anomaly()
returns void language plpgsql as $$
declare r record; v_low numeric; v_high numeric;
begin
  select threshold into v_low  from ops.alert_rules where rule_key = 'sales_anomaly_low';
  select threshold into v_high from ops.alert_rules where rule_key = 'sales_anomaly_high';
  for r in
    select * from marts.v_sales_vs_baseline
    where date_key = current_date - 1 and baseline_sales is not null
  loop
    if r.sales < r.baseline_sales * v_low then
      perform ops.enqueue_alert('sales_anomaly_low', r.branch_code,
        '🔻 ' || r.branch_code || ' sales yesterday ' || to_char(r.sales, 'FM999,999,990') ||
        ' THB, ' || r.pct_vs_baseline || '% vs 4-week baseline (' ||
        to_char(r.baseline_sales, 'FM999,999,990') || ' THB).');
    elsif r.sales > r.baseline_sales * v_high then
      perform ops.enqueue_alert('sales_anomaly_high', r.branch_code,
        '🔺 ' || r.branch_code || ' sales yesterday ' || to_char(r.sales, 'FM999,999,990') ||
        ' THB, +' || r.pct_vs_baseline || '% vs baseline. Check what worked!');
    end if;
  end loop;
end $$;

-- 3. Bad review (checks reviews ingested in the last day)
create or replace function ops.check_bad_reviews()
returns void language plpgsql as $$
declare r record; v_threshold numeric;
begin
  select threshold into v_threshold from ops.alert_rules where rule_key = 'bad_review';
  for r in
    select * from core.fact_review
    where is_competitor = false and rating <= v_threshold
      and review_ts > now() - interval '2 days'
  loop
    perform ops.enqueue_alert('bad_review', r.platform_code || ':' || coalesce(r.source_review_id, r.review_key::text),
      '⭐ ' || r.rating || ' review on ' || r.platform_code ||
      coalesce(' (' || r.branch_code || ')', '') || ': "' ||
      left(coalesce(r.review_text, ''), 200) || '"');
  end loop;
end $$;

-- 4. Listing rating drop
create or replace function ops.check_rating_drop()
returns void language plpgsql as $$
declare r record; v_threshold numeric;
begin
  select threshold into v_threshold from ops.alert_rules where rule_key = 'rating_drop';
  for r in
    select * from marts.v_ratings_trend
    where is_competitor = false and snapshot_date >= current_date - 1
      and rating_change <= -v_threshold
  loop
    perform ops.enqueue_alert('rating_drop', r.platform_code || ':' || coalesce(r.branch_code,''),
      '📉 ' || r.platform_code || coalesce(' ' || r.branch_code, '') ||
      ' rating dropped to ' || r.avg_rating || ' (' || r.rating_change || ').');
  end loop;
end $$;

-- 5. Competitor promo detected (posts flagged by enrichment)
create or replace function ops.check_competitor_promo()
returns void language plpgsql as $$
declare r record;
begin
  for r in
    select * from core.fact_social_post
    where is_competitor and is_promo and posted_at > now() - interval '2 days'
  loop
    perform ops.enqueue_alert('competitor_promo', r.platform_code || ':' || r.post_id,
      '👀 Competitor promo — ' || coalesce(r.competitor_code, r.account_handle) ||
      ' on ' || r.platform_code || ': "' || left(coalesce(r.caption,''), 150) ||
      '" ' || coalesce(r.url, ''));
  end loop;
end $$;

-- 6. Daily digest (09:00): yesterday per branch vs baseline + MTD spend/ROI
create or replace function ops.build_daily_digest()
returns void language plpgsql as $$
declare v_msg text;
begin
  select '📊 Daily digest ' || to_char(current_date - 1, 'DD Mon') || E'\n' ||
         coalesce(string_agg(
           b.branch_code || ': ' || to_char(b.sales, 'FM999,999,990') || ' THB (' ||
           coalesce(b.pct_vs_baseline::text, 'n/a') || '% vs baseline)', E'\n'
           order by b.branch_code), 'No sales data for yesterday!')
    into v_msg
  from marts.v_sales_vs_baseline b
  where b.date_key = current_date - 1;

  perform ops.enqueue_alert('daily_digest', to_char(current_date, 'YYYY-MM-DD'), v_msg);
end $$;

create or replace function ops.run_all_checks()
returns void language plpgsql as $$
begin
  perform ops.check_freshness();
  perform ops.check_sales_anomaly();
  perform ops.check_bad_reviews();
  perform ops.check_rating_drop();
  perform ops.check_competitor_promo();
end $$;

-- pg_cron schedules — enable the extension in Supabase (Database > Extensions)
-- then run once:
--   select cron.schedule('marketing-checks', '30 * * * *', $$select ops.run_all_checks()$$);
--   select cron.schedule('marketing-digest', '0 2 * * *',  $$select ops.build_daily_digest()$$);  -- 09:00 Asia/Bangkok = 02:00 UTC
-- The Edge Function `send-line-alerts` (invoked by cron via pg_net or scheduled
-- externally) reads pending rows from ops.alert_queue and pushes via LINE.
