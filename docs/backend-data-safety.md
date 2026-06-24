# Backend Data Safety

The athlete portal now uses a layered save path:

1. Browser saves immediately to local storage and existing Supabase `athlete_data` fallbacks.
2. Browser sends every coach-facing write to `/api/ingest`.
3. `/api/ingest` writes structured data into Supabase first.
4. `/api/ingest` mirrors the same payload into the coach-readable Notion endpoint.
5. If Notion fails, the payload is stored in `coach_write_outbox`.
6. `/api/sync-outbox` retries queued coach writes on a Vercel Cron schedule.

Supabase is the source of truth. Notion is the coach-readable mirror.

## Required Environment Variables

```text
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
NOTION_TOKEN=
CRON_SECRET=
```

`SUPABASE_SERVICE_KEY` must only exist server-side in Vercel environment variables. Do not expose it in `public/index.html`.

## Database Setup

Apply:

```text
supabase/migrations/202606240001_structured_athlete_ingest.sql
```

The migration creates:

- `athlete_goals`
- `weekly_checkins`
- `daily_body_logs`
- `daily_nutrition_logs`
- `training_session_logs`
- `coach_write_outbox`

RLS is enabled on every table, and `anon` / `authenticated` table access is revoked. Serverless functions write with the service role key.

## Retry Worker

`vercel.json` schedules:

```text
/api/sync-outbox
*/10 * * * *
```

That cadence requires a Vercel plan that supports sub-daily cron jobs. On Hobby, change the schedule to once per day, or run `/api/sync-outbox` manually after deploying.

When `CRON_SECRET` is set, `/api/sync-outbox` requires:

```text
Authorization: Bearer <CRON_SECRET>
```

## Coach Dashboard Rule

Coach dashboards should read from Supabase first:

- weekly reviews from `weekly_checkins`
- daily body trends from `daily_body_logs`
- daily nutrition from `daily_nutrition_logs`
- training compliance and history from `training_session_logs`
- profile targets from `athlete_goals`

Notion can still be used for coach workflow views, but it should not be the only place to look for athlete submissions.
