-- 0013: demo/test points (Point 2026-11-18). crm-points-sync replaces crm.pos_points every ~30 min,
-- so test balances live here and are re-applied after each sync until they expire.
-- Overrides the ERS balance for that phone while active — use only for staff/owner test numbers.
create table if not exists crm.test_points (
  phone       text primary key check (phone ~ '^0[689][0-9]{8}$'),
  points      numeric not null,
  note        text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '3 days'
);
alter table crm.test_points enable row level security;
