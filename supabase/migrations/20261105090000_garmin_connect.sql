-- Garmin Connect integration: connection store + synced data.
--
-- HOW DATA ARRIVES
-- Garmin pushes summaries to /api/garmin-webhook within minutes of an athlete
-- syncing their watch. Unlike Strava, a push carries the data itself, so there
-- is no event queue and no follow-up fetch: the webhook upserts straight into
-- the tables below. History is requested once per connection through Garmin's
-- backfill endpoints, and it arrives through the same webhook.
--
-- WHY A DEDICATED CONNECTION TABLE
-- Strava tokens live in athlete_data under key='strava_tokens', and every read
-- of athlete_data (state-read, the bootstrap, the data export) has to remember
-- to exclude that key. A second credential in the same table would need the
-- same exclusion in every one of those places, and missing one would hand an
-- OAuth token to the browser. A table no browser route ever selects from
-- cannot leak that way.
--
-- ACCESS
-- Service role only. RLS on, no policies, no grants to anon/authenticated.
-- Every read goes through an authenticated server route scoped to the
-- athlete's own code. Garmin's terms, unlike Strava's, allow the coaching team
-- to see what the athlete authorised (dualperformance.au/privacy says so), but
-- that read path is not part of this migration and will be added deliberately.
--
-- DELETION
-- Disconnecting in the portal, a deregistration from Garmin, or a revoked
-- permission all delete the matching rows. Nothing here outlives consent.

begin;

-- ── Connections ──────────────────────────────────────────────────────────────

create table if not exists public.garmin_connections (
  athlete_code        text        primary key,
  -- Garmin's stable user id. Identical across tokens and across apps for the
  -- same Garmin account, and the only identifier a push notification carries.
  garmin_user_id      text        not null,
  access_token        text        not null,
  refresh_token       text        not null,
  -- Already reduced by Garmin's recommended 600s safety margin.
  access_expires_at   timestamptz not null,
  refresh_expires_at  timestamptz,
  scope               text,
  -- What the athlete ticked on Garmin's consent screen, e.g.
  -- {ACTIVITY_EXPORT,HEALTH_EXPORT,WORKOUT_IMPORT,HISTORICAL_DATA_EXPORT}.
  permissions         text[]      not null default '{}',
  connected_at        timestamptz not null default now(),
  -- Stamped once the 30-day history request has been accepted by Garmin, so
  -- it is asked for once per connection rather than on every page load.
  backfill_requested_at timestamptz,
  last_push_at        timestamptz,
  updated_at          timestamptz not null default now()
);

-- One Garmin account belongs to one athlete. Also the lookup every push uses.
create unique index if not exists garmin_connections_user_idx
  on public.garmin_connections (garmin_user_id);

-- ── Activities (Activity API) ────────────────────────────────────────────────

create table if not exists public.garmin_activities (
  athlete_code     text        not null,
  summary_id       text        not null,
  activity_id      bigint,
  start_time       timestamptz not null,
  -- The athlete's local calendar date for the activity, from Garmin's offset.
  local_date       date        not null,
  activity_type    text,
  name             text,
  duration_s       integer,
  distance_m       numeric,
  active_kcal      integer,
  avg_hr           integer,
  max_hr           integer,
  device_name      text,
  manual           boolean,
  -- Whole Garmin summary. New fields are available without a migration; the
  -- promoted columns exist for indexing and the obvious queries.
  summary          jsonb       not null default '{}'::jsonb,
  received_at      timestamptz not null default now(),
  primary key (athlete_code, summary_id)
);

create index if not exists garmin_activities_athlete_start_idx
  on public.garmin_activities (athlete_code, start_time desc);

-- ── Daily summaries (Health API) ─────────────────────────────────────────────
--
-- Garmin re-sends a day's summary as it fills in through the day. One row per
-- athlete per date; the latest delivery wins.

create table if not exists public.garmin_dailies (
  athlete_code     text        not null,
  calendar_date    date        not null,
  summary_id       text,
  active_kcal      integer,
  bmr_kcal         integer,
  steps            integer,
  resting_hr       integer,
  avg_stress       integer,
  summary          jsonb       not null default '{}'::jsonb,
  received_at      timestamptz not null default now(),
  primary key (athlete_code, calendar_date)
);

-- ── Sleep summaries (Health API) ─────────────────────────────────────────────

create table if not exists public.garmin_sleeps (
  athlete_code     text        not null,
  calendar_date    date        not null,
  summary_id       text,
  duration_s       integer,
  deep_s           integer,
  light_s          integer,
  rem_s            integer,
  awake_s          integer,
  summary          jsonb       not null default '{}'::jsonb,
  received_at      timestamptz not null default now(),
  primary key (athlete_code, calendar_date)
);

-- ── Lock down ────────────────────────────────────────────────────────────────

alter table public.garmin_connections enable row level security;
alter table public.garmin_activities  enable row level security;
alter table public.garmin_dailies     enable row level security;
alter table public.garmin_sleeps      enable row level security;

revoke all on public.garmin_connections from anon, authenticated;
revoke all on public.garmin_activities  from anon, authenticated;
revoke all on public.garmin_dailies     from anon, authenticated;
revoke all on public.garmin_sleeps      from anon, authenticated;

comment on table public.garmin_connections is 'Garmin OAuth credentials per athlete. Service role only; never selected by a browser-facing route.';
comment on table public.garmin_activities  is 'Garmin activity summaries pushed by the Activity API. Service role only; deleted on disconnect, deregistration or revoked ACTIVITY_EXPORT.';
comment on table public.garmin_dailies     is 'Garmin daily wellness summaries (energy expenditure, steps, resting HR, stress). Deleted on disconnect, deregistration or revoked HEALTH_EXPORT.';
comment on table public.garmin_sleeps      is 'Garmin sleep summaries. Deleted on disconnect, deregistration or revoked HEALTH_EXPORT.';

commit;
