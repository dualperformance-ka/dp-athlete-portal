# Reminder scheduling, single-flight and rollout

Written 20 Oct 2026 for the loading-time fix. Covers the reminder cron
(`api/reminders.js`, `api/_lib/reminder-plan.js`, `api/_lib/job-lease.js`),
the three migrations that ship with it, and the production rollout.

## Why

Over 24 hours in October production recorded 143 statement-timeout
cancellations, simple queries taking 15-20s and REST calls across unrelated
tables taking 110-191s, on Free/Nano shared compute. The worst periods lined up
with the 05:30 morning reminder and Monday's midday check-in.

The reminder job was the main load:

* pg_cron called `/api/reminders` **every minute** (job
  `send-athlete-reminders`), defined only in the dashboard, with the bearer
  secret written in plain text into `cron.job.command`.
* pg_net does not wait for a call to finish, so a slow run overlapped the next
  one, which slowed the database further, which slowed the next run.
* Every run, for every timezone, re-read planned sessions, session logs,
  Strava activities, bookings, coach changes and held messages, and then asked
  `athlete_notifications` for each athlete's daily push count
  (`pushedToday`) whether or not anything was due. That last read alone was
  ~8.7 reads a minute in production.

## How a run works now

```
pg_cron */5  ──►  GET /api/reminders (Bearer from Vault)
                    │
                    ├─ acquire_job_lease('send-athlete-reminders', owner, 120s)
                    │     false  → 200 {skipped:'lease_held'}      (no reminder queries)
                    │     timeout/5xx → 200 {skipped:'lease_unavailable'}
                    │
                    ├─ roster: push_subscriptions + active athletes          2 reads
                    ├─ place athletes in their local time; open windows?     0 reads
                    ├─ inputs, batched, only for athletes in an open window:
                    │     planned sessions / logs / check-ins / body / fuel   per local date
                    │     bookings, coach changes, Strava, held messages     1 read each
                    ├─ candidate messages (pure)                             0 reads
                    ├─ ONE athlete_notifications read for all candidates:
                    │     existing rows for the candidate dedupe keys
                    │     + today's capped push count
                    ├─ write + push only what is new
                    └─ finally: release_job_lease(owner, outcome, counts)
```

* **Single flight.** `acquire_job_lease()` is one
  `INSERT ... ON CONFLICT (job_name) DO UPDATE ... WHERE expires_at <= now()`.
  Postgres serialises it on the row, so exactly one caller wins. Verified
  against Postgres 16 with 40 simultaneous connections, five rounds: one winner
  each time. The lease expires after 120s, longer than the function's
  `maxDuration` of 60s (`vercel.json`), so a crashed run frees it by itself and
  a live run can never lose it. Release only succeeds for the current owner.
* **Five-minute cadence, fifteen-minute windows.** Each time-of-day reminder
  (05:30 plan, 10:00 body check, 19:30 log nudge, 20:30 fuel, Monday 07:00
  review, Monday 12:00 check-in) is eligible for 15 minutes, so it gets three
  runs and one skipped run cannot lose it. "Call in 2 hours" fires 110-125
  minutes before the call. Tests cover every zone offset in use (including
  +10:30, +5:45 and +13:45) and lag between pg_cron's tick and the request.
* **No duplicates.** The batched dedupe read finds any existing inbox row for
  a candidate key: pushed or dismissed rows are skipped, stored-but-unpushed
  rows are pushed as they are (no second insert), and the unique
  `(athlete_code, dedupe_key)` constraint is still the last line of defence.
  `push_subscriptions.last_sent` is still updated on delivery.
* **Unchanged rules.** Quiet hours (21:00-05:30), the daily cap of five
  automated pushes, cap-exempt types, held coach messages, Monday check-ins,
  coach-change batching (two-minute settle, near / next week / future),
  Strava freshness and managed preferences all behave as before.

### Measured

Same in-memory data, ten athletes, one Adelaide day (a Monday, so the
Monday-only reminders fire), old code every minute vs new code every five
minutes including the lease calls:

| | old | new | change |
|---|---:|---:|---:|
| runs | 1,440 | 288 | |
| requests | 27,895 | 2,470 | -91% |
| reads | 26,878 | 1,834 | -93% |
| `athlete_notifications` reads | 15,350 | 370 | -98% |
| `athlete_notifications` writes | 1,017 | 60 | -94% |
| `planned_sessions` reads | 1,440 | 6 | |
| notifications produced | 60 | 60 | identical keys |

The old figure of ~10.7 notification reads a minute for ten athletes matches
the ~8.7 a minute seen in production. `tests/reminder-load.test.js` keeps a
daily read budget so this cannot drift back.

## Migrations

| File | What | Safe to apply |
|---|---|---|
| `20261020090000_job_leases.sql` | `job_leases`, `job_runs`, `acquire_job_lease()`, `release_job_lease()`, `strava_activities(synced_at)` index, daily `purge-job-runs` cron | any time, before or after the code |
| `20261020091000_session_library_revision.sql` | `cache_revisions` + statement trigger on `session_library` | any time |
| `20261020092000_reminder_schedule_every_five_minutes.sql` | reschedules `send-athlete-reminders` to `*/5`, secret from Vault | **only after** the code is deployed and the Vault secret exists. It refuses to run without the secret. |

The code degrades safely without the first two: no lease function means the
run proceeds without overlap protection (exactly as before) and the library
falls back to the old hash.

## Production rollout (in this order)

Nothing below has been run against production. Each step needs explicit go-ahead.

1. **Merge and deploy** the PR. Vercel deploys on merge. Still on the old
   every-minute schedule at this point, which the new code handles: the lease
   stops overlap as soon as step 2 lands, and the wider window plus dedupe
   means repeated eligible runs send nothing twice.
2. **Apply the lease and revision migrations** (SQL editor, or
   `supabase db push` if the CLI is linked):
   `20261020090000_job_leases.sql`, then `20261020091000_session_library_revision.sql`.
3. **Check the lease is working** before changing the schedule (one run a
   minute still, so within two or three minutes):
   ```sql
   select job_name, last_outcome, last_duration_ms, last_finished_at, contended_runs
   from public.job_leases;
   select started_at, duration_ms, outcome, counts from public.job_runs
   order by started_at desc limit 10;
   ```
4. **Create the Vault secret** with the same value as `REMINDERS_CRON_SECRET`
   (or `CRON_SECRET`) in Vercel. In the SQL editor:
   ```sql
   select vault.create_secret('<the secret>', 'reminders_cron_secret',
     'Bearer token pg_cron sends to /api/reminders');
   ```
5. **Apply** `20261020092000_reminder_schedule_every_five_minutes.sql`. Confirm:
   ```sql
   select jobname, schedule, position('Bearer ' in command) > 0 as uses_bearer,
          command like '%vault.decrypted_secrets%' as reads_vault
   from cron.job where jobname = 'send-athlete-reminders';
   ```
   `schedule` should be `*/5 * * * *` and the command must not contain the
   secret itself.
6. **Rotate the cron secret** afterwards: the old one sat in plain text in
   `cron.job`. Set a new value in Vercel, redeploy, then
   `select vault.update_secret((select id from vault.secrets where name = 'reminders_cron_secret'), '<new secret>');`

## Rollback

Code and schedule roll back independently.

* **Code:** Vercel → Deployments → previous production deployment → Promote
  (or `vercel rollback`). The old code runs fine with the lease tables present.
* **Schedule back to every minute** (only with the old code; the new code is
  happy at either cadence):
  ```sql
  select cron.schedule('send-athlete-reminders', '* * * * *', $job$
    select net.http_get(
      url := 'https://portal.dualperformance.au/api/reminders',
      headers := jsonb_build_object('Authorization', 'Bearer ' ||
        (select decrypted_secret from vault.decrypted_secrets where name = 'reminders_cron_secret' limit 1)),
      timeout_milliseconds := 30000);
  $job$);
  ```
* **Stop reminders entirely** in an emergency: `select cron.unschedule('send-athlete-reminders');`
  (the daily Vercel cron at 06:30 UTC remains as a backstop).
* **Remove the new objects** (not needed for a code rollback):
  ```sql
  select cron.unschedule('purge-job-runs');
  drop trigger if exists session_library_cache_revision on public.session_library;
  drop function if exists public.bump_cache_revision();
  drop function if exists public.acquire_job_lease(text, text, integer);
  drop function if exists public.release_job_lease(text, text, text, jsonb);
  drop table if exists public.job_runs, public.job_leases, public.cache_revisions;
  drop index if exists public.strava_activities_synced_at_idx;
  ```

## Post-deployment checklist

Run for the first hour, then at the next 05:30 morning window and the Monday
07:00 and 12:00 windows.

* **Cron duration and outcome:** `job_runs` durations should sit well under 5s;
  `outcome` should be `ok` (`partial` means the 45s budget was hit).
* **Lock contention:** `job_leases.contended_runs` should stay at or near 0
  after the move to five minutes. A rising number means runs are still taking
  longer than the cadence.
* **No overlap:** `select count(*) from public.job_runs a join public.job_runs b
  on a.id < b.id and a.started_at < b.finished_at and b.started_at < a.finished_at;`
  should be 0.
* **Delivery:** `select type, count(*), count(pushed_at) from athlete_notifications
  where created_at > now() - interval '1 day' group by type;` should look like a
  normal day; no duplicate `(athlete_code, dedupe_key)` is possible, but check
  `notify_status` on the coaches dashboard for anyone with zero pushes.
* **Query latency:** Supabase → Query Performance: the reminder queries should
  drop out of the top statements; statement timeouts (Logs → Postgres,
  `canceling statement due to statement timeout`) should fall to ~0.
* **REST 5xx and timeouts:** Vercel → Logs, filter `"evt":"perf"`:
  `status` other than `ok`, and `timedOut:true`, by `op`.
* **Cold portal load:** `window.__dpPerf` in the browser console on a phone
  (op `portal.trainingRead`, `portal.bootstrap`, `auth.validate`) and, if
  `SENTRY_TRACES_SAMPLE_RATE` is above 0, `dp.portal.*` spans in Sentry.
  Target p95 under 2s to a usable Today; under 1s for the reads themselves.

## Compute sizing

The code change removes most of the load the reminder job generated, which is
the primary fix. Free/Nano is still shared compute with a small connection pool,
and one slow coach-dashboard query can starve everything else. Moving to
**Pro with Micro compute** is cheap headroom and worth doing for a paid
coaching product; **Small** if the dashboard's heavier views (`notify_status`,
performance summaries) stay slow after this lands. Treat it as headroom, not
the fix: on Nano the change above should already be enough to stop the
timeouts. Measure a week of `job_runs` and statement timeouts before deciding.
