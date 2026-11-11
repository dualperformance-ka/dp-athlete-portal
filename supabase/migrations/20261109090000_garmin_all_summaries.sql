-- Every Garmin data type, not just activities, dailies and sleep.
--
-- garmin_summaries holds one row per Garmin summary for every type without a
-- dedicated table: activity details (per-second samples and laps), epochs,
-- body composition, HRV, stress detail, respiration, pulse ox, health
-- snapshot, skin temperature, user metrics (VO2 max, fitness age), blood
-- pressure, Move IQ and activity file records. The whole Garmin payload is
-- kept in `summary`, so a field Garmin adds later is stored without a
-- migration; the other columns only key, date and index it.
--
-- garmin-activity-files is a private bucket for the FIT/TCX/GPX file of each
-- activity, at <ATHLETE_CODE>/<summaryId>.<fit|tcx|gpx>.
--
-- Women's Health (menstrual cycle, pregnancy) is never stored: the webhook
-- refuses those keys before anything reaches this table.
--
-- Same boundary as the other garmin_* tables: service role only, deleted on
-- disconnect, on deregistration, and per type when the athlete unticks the
-- permission that covered it.

begin;

create table if not exists public.garmin_summaries (
  athlete_code   text        not null,
  summary_type   text        not null,
  summary_id     text        not null,
  calendar_date  date,
  start_time     timestamptz,
  duration_s     integer,
  activity_id    bigint,
  summary        jsonb       not null default '{}'::jsonb,
  received_at    timestamptz not null default now(),
  primary key (athlete_code, summary_type, summary_id),
  constraint garmin_summaries_type_known check (summary_type in (
    'activityDetails', 'activityFiles', 'epochs', 'bodyComps', 'hrv',
    'stressDetails', 'allDayRespiration', 'pulseox', 'healthSnapshot',
    'skinTemp', 'userMetrics', 'bloodPressures', 'moveIQActivities'
  ))
);

create index if not exists garmin_summaries_athlete_type_date_idx
  on public.garmin_summaries (athlete_code, summary_type, calendar_date desc);

create index if not exists garmin_summaries_activity_idx
  on public.garmin_summaries (athlete_code, activity_id)
  where activity_id is not null;

alter table public.garmin_summaries enable row level security;
revoke all on public.garmin_summaries from anon, authenticated;

comment on table public.garmin_summaries is 'Every Garmin summary type without a dedicated table, whole payload in summary. Service role only; deleted on disconnect, deregistration, or revoked permission. Women''s Health data is never stored.';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'garmin-activity-files',
  'garmin-activity-files',
  false,
  52428800,
  array['application/vnd.ant.fit', 'application/vnd.garmin.tcx+xml', 'application/gpx+xml', 'application/octet-stream']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

commit;
