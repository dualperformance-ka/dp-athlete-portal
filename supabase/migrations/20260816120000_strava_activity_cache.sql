-- Strava activity cache + webhook event queue.
--
-- WHY THIS EXISTS
-- The portal used to call Strava live on every page render and throw the
-- response away. That capped history at the last 100 activities, made the app's
-- shared rate limit (200 req/15min, 2,000/day for the WHOLE app, not per
-- athlete) scale with how often athletes opened the PWA, and made per-activity
-- endpoints (detail, laps, streams) impossible to ever use.
--
-- Activities now arrive once, by webhook, and are stored here. Reads are local.
--
-- COMPLIANCE BOUNDARY (deliberate, do not loosen)
-- The Strava API Agreement permits a user's data to be displayed back to THAT
-- USER only. So:
--   * no grants to anon or authenticated — the browser can never read this
--     table directly, not even with a valid athlete JWT;
--   * every read goes through GET /api/strava, which authenticates the athlete
--     and scopes the query to their own athlete_code;
--   * the coaches dashboard must NOT read this table. Coaches see the athlete's
--     SUBMITTED log in training_session_logs, which is Dual Performance's own
--     data, not Strava's.

begin;

-- ── Activity cache ───────────────────────────────────────────────────────────

create table if not exists public.strava_activities (
  athlete_code       text        not null,
  strava_activity_id bigint      not null,
  start_date_local   timestamptz not null,
  sport_type         text,
  name               text,
  distance_m         numeric,
  moving_time_s      integer,
  elapsed_time_s     integer,
  -- Strava's REST field for what the UI calls "Relative Effort". Heart-rate
  -- derived, so legitimately null for athletes running without a strap —
  -- null means "unknown", never "easy".
  suffer_score       numeric,
  gear_id            text,
  -- Whole summary payload. New Strava fields become available without a
  -- migration; the promoted columns above exist only for indexing and filtering.
  summary            jsonb       not null default '{}'::jsonb,
  -- Phase 2: laps, splits_metric, best_efforts from GET /activities/{id}.
  detail             jsonb,
  synced_at          timestamptz not null default now(),
  primary key (athlete_code, strava_activity_id)
);

-- The hot query: "this athlete's runs, newest first, since date X".
create index if not exists strava_activities_athlete_start_idx
  on public.strava_activities (athlete_code, start_date_local desc);

-- ── Webhook event queue ──────────────────────────────────────────────────────
--
-- Strava requires a 200 within two seconds and retries three times otherwise.
-- Fetching the activity inline risks blowing that budget, so the webhook does
-- one insert here and acks. Processing happens straight after the ack
-- (best effort) and, if the function dies first, on the next drain.

create table if not exists public.strava_webhook_events (
  id             bigserial primary key,
  subscription_id bigint,
  owner_id       bigint      not null,   -- Strava athlete id
  object_type    text        not null,   -- 'activity' | 'athlete'
  object_id      bigint      not null,
  aspect_type    text        not null,   -- 'create' | 'update' | 'delete'
  updates        jsonb       not null default '{}'::jsonb,
  event_time     timestamptz,
  athlete_code   text,                   -- resolved at drain time; null until then
  processed_at   timestamptz,
  attempts       integer     not null default 0,
  last_error     text,
  received_at    timestamptz not null default now()
);

-- Drain query: unprocessed, oldest first, with a retry ceiling.
create index if not exists strava_webhook_events_pending_idx
  on public.strava_webhook_events (processed_at, received_at)
  where processed_at is null;

create index if not exists strava_webhook_events_owner_idx
  on public.strava_webhook_events (owner_id, processed_at);

-- ── Strava athlete id → athlete_code lookup ──────────────────────────────────
--
-- Webhook events identify the athlete by owner_id (their Strava id). The mapping
-- lives in athlete_data.value->>'strava_athlete_id' on the strava_tokens row.
-- Without this index every event costs a full table scan of athlete_data.

create index if not exists athlete_data_strava_athlete_id_idx
  on public.athlete_data ((value ->> 'strava_athlete_id'))
  where key = 'strava_tokens';

-- ── Lock down ────────────────────────────────────────────────────────────────

alter table public.strava_activities     enable row level security;
alter table public.strava_webhook_events enable row level security;

-- No grants to anon/authenticated: these tables are service-role only. With RLS
-- on and no policy, even a leaked athlete JWT reads nothing. This is the
-- compliance boundary described at the top of the file — leave it closed.
revoke all on public.strava_activities     from anon, authenticated;
revoke all on public.strava_webhook_events from anon, authenticated;

commit;
