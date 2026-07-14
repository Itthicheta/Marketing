-- 0006: enable RLS on all tables. No policies are defined on purpose:
-- anon/authenticated roles get no access at all. Ingestion (Edge Functions
-- with service role), pg_cron checks, and the dashboard's Worker proxy all
-- use elevated roles that bypass RLS. If the dashboard ever reads Supabase
-- directly with the anon key, add explicit read-only policies on marts
-- views' underlying tables instead of removing this.
do $$
declare t record;
begin
  for t in
    select schemaname, tablename from pg_tables
    where schemaname in ('raw','core','marts','ops')
  loop
    execute format('alter table %I.%I enable row level security', t.schemaname, t.tablename);
  end loop;
end $$;
