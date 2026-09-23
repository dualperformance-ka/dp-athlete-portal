-- Typed pain / coach-alert columns on daily_body_logs, plus a backfill.
--
-- Why: the portal body log has sent pain, painLocation and coachAlert since the
-- quick-log redesign, but api/ingest.js only kept them inside raw_payload. The
-- coaches dashboard Today queue reads the typed pain and coach_alert columns,
-- and those columns were defined in the dashboard repo
-- (20260805011628_coach_triage_signals.sql) but never applied to the live
-- project. So a 7/10 pain report was saved and never became a triage row.
--
-- This migration is additive and idempotent. It is safe to run more than once
-- and safe to run whether or not the dashboard's triage migration already ran:
-- every statement is guarded.
--
-- Owning repo: dp-athlete-portal (writer: api/ingest.js daily_body).
-- Reader: dp-coaches-dashboard api/coach-data.js (triage + mapBody).

alter table public.daily_body_logs
  add column if not exists pain smallint,
  add column if not exists pain_location text,
  add column if not exists coach_alert boolean not null default false;

comment on column public.daily_body_logs.pain is
  'Athlete-reported pain from 0 (none) to 10 (severe). Null means not reported.';
comment on column public.daily_body_logs.pain_location is
  'Free-text pain location as the athlete typed it (e.g. "left knee").';
comment on column public.daily_body_logs.coach_alert is
  'Explicit safety flag that always places the athlete at the top of coach triage.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'daily_body_logs_pain_range'
      and conrelid = 'public.daily_body_logs'::regclass
  ) then
    alter table public.daily_body_logs
      add constraint daily_body_logs_pain_range
      check (pain is null or pain between 0 and 10);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'daily_body_logs_pain_location_length'
      and conrelid = 'public.daily_body_logs'::regclass
  ) then
    alter table public.daily_body_logs
      add constraint daily_body_logs_pain_location_length
      check (pain_location is null or char_length(pain_location) <= 200);
  end if;
end
$$;

-- Backfill from raw_payload. Strings are validated before any cast so one
-- malformed historical row ("7/10", "", "abc", 12) cannot abort the migration:
-- anything that is not a whole number 0-10 stays null.
with parsed as (
  select
    id,
    case
      when jsonb_typeof(raw_payload -> 'pain') in ('number', 'string')
        and btrim(raw_payload ->> 'pain') ~ '^[0-9]{1,2}(\.0+)?$'
        and btrim(raw_payload ->> 'pain')::numeric between 0 and 10
      then btrim(raw_payload ->> 'pain')::numeric::smallint
    end as pain_value,
    nullif(left(btrim(coalesce(raw_payload ->> 'painLocation', '')), 200), '') as location_value,
    case
      when jsonb_typeof(raw_payload -> 'coachAlert') = 'boolean'
        then (raw_payload ->> 'coachAlert')::boolean
      when jsonb_typeof(raw_payload -> 'coachAlert') = 'string'
        and lower(btrim(raw_payload ->> 'coachAlert')) in ('true', 'false')
        then lower(btrim(raw_payload ->> 'coachAlert'))::boolean
    end as alert_value
  from public.daily_body_logs
  where raw_payload is not null
    and jsonb_typeof(raw_payload) = 'object'
    and (raw_payload ? 'pain' or raw_payload ? 'painLocation' or raw_payload ? 'coachAlert')
)
update public.daily_body_logs as logs
set
  pain = coalesce(logs.pain, parsed.pain_value),
  pain_location = coalesce(logs.pain_location, parsed.location_value),
  coach_alert = logs.coach_alert
    or coalesce(parsed.alert_value, parsed.pain_value >= 5, false)
from parsed
where logs.id = parsed.id
  and (
    (logs.pain is null and parsed.pain_value is not null)
    or (logs.pain_location is null and parsed.location_value is not null)
    or (logs.coach_alert is false and coalesce(parsed.alert_value, parsed.pain_value >= 5, false))
  );

-- The seven-day pain queue only needs rows that can become urgent.
create index if not exists daily_body_logs_coach_triage_idx
  on public.daily_body_logs (log_date desc, athlete_code)
  where coach_alert is true or pain >= 5;

-- No anon/authenticated grants. The dashboard reads with the service role.
grant select, insert, update on table public.daily_body_logs to service_role;
