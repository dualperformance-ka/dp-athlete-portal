# Garmin running workouts

Athlete flow: open a programmed run, select **Review for Garmin**, check its
steps and date, then select **Send to Garmin**. The server creates a structured
workout and schedules it in Garmin Connect. The athlete syncs Garmin Connect
with a compatible watch. A portal receipt confirms Garmin Connect delivery,
not receipt on the watch.

## Activate

1. Upload the workout ZIP to a new branch from current main and open a new PR.
   PR #122's activity-display change is already merged; this ZIP adds workouts.
2. Let GitHub CI pass, then merge and deploy.
3. Set Production `GARMIN_WORKOUTS_ENABLED=true` and redeploy. Keep the existing
   `GARMIN_ALLOWED_ATHLETES` test allowlist. `CRON_SECRET` must be present for
   token maintenance; the hourly route is `/api/garmin?mode=refresh`.
4. Confirm the Garmin developer app has the Training API enabled. Reconnect
   Garmin from the workout preview and grant `WORKOUT_IMPORT` if missing.
5. In the existing coach session builder, programme a **structured Run** and
   publish it to the test athlete. Include warm-up/cool-down, distance or time
   steps, intervals, recoveries and repeat blocks. The data lives in the shared
   `planned_sessions` and `run_steps` tables, so no separate workout editor is
   added to the athlete portal.
6. Review/send the session, check the scheduled workout in Garmin Connect,
   sync the watch and compare its steps and pace targets with the prescription.
7. Tap again or change the coach prescription/date and send again. Confirm the
   existing workout/calendar entry updates without creating another copy.

Running session types (Run, Easy Effort, Tempo, Speed, Long Run, Recovery,
race, Threshold, VO2, Intervals, Fartlek, Hills, MP, Time Trial) can be sent.
Mixed or admin rows (Brick, Run + Strength, Optional, Weekly KM Total) and
untyped sessions cannot. The list is GARMIN_RUN_SESSION_TYPES in
api/_lib/garmin-workouts.js and must match the coaches dashboard builder.

Older free-text/library sessions require structured coach steps before sending.
The converter does not infer interval durations or pace targets from prose.
RPE/effort remain instructions; Garmin gets an open target for these steps.
A step with no distance/time uses a lap-button end. Invalid or ambiguous step
values stop delivery with a useful message. Workouts are limited to 100 steps
including expanded repeats. The scheduled date includes saved portal reschedules.

Coach edits and reschedules are sent on the athlete's next explicit send;
this version does not silently publish changes or remove cancelled workouts.

## Reliability and permissions

- Server reads are scoped to the signed-in athlete and published sessions.
  Request bodies cannot override workout contents, athlete or scheduled date.
- Delivery receipts use an athlete/session key and a database lease shared by
  all instances. The canonical planned-session ID prevents alias-based races.
- The workout ID is saved before calendar scheduling. Re-sends update known
  workout and schedule IDs, rather than posting another copy.
- If a POST response is lost or lacks an ID, delivery is marked uncertain.
  The portal blocks blind retries. Inspect Garmin Connect and reconcile the
  receipt before resetting it. Do not delete a receipt simply to retry: that
  could create duplicates in Garmin Connect.
- Token refreshes use a separate per-athlete lease and re-read saved tokens
  after acquiring it. The hourly job processes up to 25 expired/near-expiry
  connections with a 40-second budget. Failed rows move to the back of the
  queue. Watch cron failures; revoked/expired consent needs reconnection.
- Delivery receipts have RLS enabled, no public/anon/authenticated grants and
  service-role access only. They cascade away when the connection is deleted.
  They are included in the athlete export; OAuth tokens remain excluded.
- The receipt migration is already applied to production. Its repository
  timestamp follows the original Garmin migration so fresh installs replay in
  dependency order.
- No Garmin measurements are added to coach logs or AI review inputs.

## API contract and remaining live test

Built against Garmin's Training API V2 2.0, published 22 October 2026:
https://developerportal.garmin.com/developer-programs/programs-docs

The documented create route is `/workoutportal/workout/v2`; retrieve/update
routes use `/training-api/workout/v2/{id}`. Schedule routes use
`/training-api/schedule/`. Pace ranges are converted from min/km to m/s, with
slow pace as the low speed and fast pace as the high speed.

Garmin Starter currently includes Training API access, but historical backfill
is not included. The earlier 30-day-history claim does not apply to Starter.

A 390×844 preview with test data was inspected in the connected browser. Review
and simulated-send confirmation passed with zero captured console errors.
The full Playwright suite cannot launch Chrome in this local environment.
GitHub CI and an actual Garmin Connect/watch test remain required. No workout
was sent to a real Garmin account during this build.
