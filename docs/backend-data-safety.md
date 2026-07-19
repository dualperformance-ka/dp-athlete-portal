# Backend Data Safety

The athlete portal uses a Supabase-only save path. The Notion sync (mirror
endpoint + retry outbox) was removed on 2026-07-20 — Supabase is now the single
source of truth for every piece of portal data.

1. Browser saves immediately to local storage and the Supabase `athlete_data` compatibility table.
2. Browser sends every coach-facing write to `/api/ingest`.
3. `/api/ingest` writes structured data straight into the Supabase source-of-truth tables.
4. On a weekly check-in, `/api/ingest` also adds the `checkin_done` GHL tag (best-effort, never blocks the write).
5. If the Supabase write itself fails, the browser keeps the payload in its own local retry queue and replays it to `/api/ingest` when back online.

There is no external mirror and no `coach_write_outbox` queue in the write path.

## Required Environment Variables

```text
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
GHL_API_KEY=        # optional — enables the weekly check-in GHL tag
```

`SUPABASE_SERVICE_KEY` must only exist server-side in Vercel environment variables. Do not expose it in `public/index.html`. `NOTION_TOKEN` and `CRON_SECRET` are no longer used and can be deleted from the Vercel project.

## Database Setup

Apply:

```text
supabase/migrations/202606240001_structured_athlete_ingest.sql
```

The migration creates:

- `athlete_data`
- `session_logs`
- `athlete_goals`
- `weekly_checkins`
- `daily_body_logs`
- `daily_nutrition_logs`
- `training_session_logs`

RLS is enabled on every table. The structured source-of-truth tables revoke `anon` / `authenticated` access and are written by serverless functions with the service role key. The compatibility tables `athlete_data` and `session_logs` keep limited `select`, `insert`, and `update` access for the browser because the portal syncs drafts, photos, completion markers, Strava tokens, and exercise picks directly from the client. Athletes read their own structured logs back through `/api/my-logs` (service key, scoped to their code).

The legacy `coach_write_outbox` table is no longer written to and can be dropped once any remaining rows have been reviewed.

## Coach Dashboard Rule

Coach dashboards read entirely from Supabase:

- weekly reviews from `weekly_checkins`
- daily body trends from `daily_body_logs`
- daily nutrition from `daily_nutrition_logs`
- training compliance and history from `training_session_logs`
- profile targets from `athlete_goals`
