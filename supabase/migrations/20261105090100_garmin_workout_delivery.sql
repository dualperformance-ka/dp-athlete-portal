-- Delivery receipts contain only app programme references and Garmin IDs.
-- Measurements and OAuth tokens never enter this table.
create table if not exists public.garmin_workout_deliveries (
  athlete_code text not null references public.garmin_connections(athlete_code) on delete cascade,
  planned_session_id uuid not null references public.planned_sessions(id) on delete cascade,
  garmin_user_id text not null,
  workout_id text,
  owner_id text,
  schedule_id text,
  scheduled_date date,
  fingerprint text,
  state text not null check (state in ('creating','retryable','ready','scheduling','sent')),
  sent_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (athlete_code,planned_session_id)
);
alter table public.garmin_workout_deliveries enable row level security;
revoke all on public.garmin_workout_deliveries from public,anon,authenticated;
grant select,insert,update,delete on public.garmin_workout_deliveries to service_role;
