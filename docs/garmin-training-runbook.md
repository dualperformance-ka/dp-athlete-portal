# Garmin running workouts

Athlete flow: open a coach-published run, select **Review for Garmin**, check
the steps and the Garmin calendar date, then select **Send to Garmin**. The
server re-reads the published prescription, refuses the send if it no longer
matches what the athlete reviewed, creates one structured workout and puts one
entry on the Garmin Connect calendar. The athlete then syncs their watch.

The portal reports **saved to Garmin Connect** once Garmin confirms the
calendar entry. It never reports the workout as on the watch: nothing in the
Training API confirms a watch sync, so that is only ever checked by hand.

## Contract

Built against Garmin's **Training API V2 2.0** (revision dated 15 October
2026, posted to the developer portal 22 October 2026, Program Docs → Training
API V2 2.0.zip). Checked against the PDF on 6 November 2026.

| Action | Route |
|---|---|
| Create workout | `POST /workoutportal/workout/v2` |
| Update workout | `PUT /training-api/workout/v2/{workoutId}`, full object + `ownerId` |
| Retrieve workout | `GET /training-api/workout/v2/{workoutId}` |
| Create schedule | `POST /training-api/schedule/` `{workoutId, date}` |
| Update schedule | `PUT /training-api/schedule/{scheduleId}` full object |
| Retrieve schedule | `GET /training-api/schedule/{scheduleId}` |
| Schedules by date | `GET /training-api/schedule?startDate=&endDate=` |

- PACE targets are speeds in m/s. The slower pace is `targetValueLow`, the
  faster pace `targetValueHigh`. 4:30–4:45/km is 3.509–3.704 m/s.
- HEART_RATE uses `targetValue` 1–5, the athlete's own Garmin zones.
- `durationType` TIME (seconds), DISTANCE (metres) or OPEN (lap button).
- Repeats are `WorkoutRepeatStep` with `REPEAT_UNTIL_STEPS_CMPLT`.
- Single-sport workouts hold at most 100 steps; step descriptions 512 chars;
  `workoutProvider` and `workoutSourceId` 20 chars ("Dual Performance").
- 412 is a user permission error, 401 a missing token, 429 rate limiting.
- Starter rate limits: 100 calls per app per minute, 200 calls per user per
  day. A first send costs 3 calls (permissions, workout, schedule).

RPE and effort travel as step instructions with an open target. Text-only
(legacy) sessions, unsupported targets and invalid steps are refused with the
step number and what the coach needs to change. The converter never infers
steps or targets from prose.

Running session types that can be sent: Run, Running, Easy, Easy Effort,
Recovery, Long, Long Run, Tempo, Threshold, Speed, Interval, Intervals, VO2,
Fartlek, Hills, MP, Race, Time Trial. Brick, Run + Strength and admin rows
cannot. The list is `GARMIN_RUN_SESSION_TYPES` in
`api/_lib/garmin-workouts.js`, mirrored in `public/js/garmin-workouts.js` and
the coaches dashboard's `public/run-workout.js`; a test keeps the portal pair
identical.

## Delivery receipts

One row per athlete and canonical planned-session id in
`garmin_workout_deliveries`. Each state is saved before the next Garmin call.

| State | Meaning | Next send |
|---|---|---|
| `creating` | Workout POST in flight or its answer was lost | **Blocked.** See "Uncertain create" |
| `retryable` | Garmin definitively refused the create (4xx) | Creates again |
| `ready` | Workout id saved, no confirmed calendar entry | Schedules with the saved id |
| `scheduling` | Calendar POST in flight for `scheduled_date` | Lists that day's schedules, adopts an entry for this workout, otherwise posts |
| `sent` | Workout and calendar entry confirmed | Unchanged: checks the entry still exists. Changed: PUTs both |

- The send is single-flight per athlete and session (database lease), so a
  double tap, a second device or a network retry gets "already being sent".
- The athlete must send the fingerprint of the preview they reviewed. If the
  coach changed the steps or the date (including a saved reschedule) the send
  is refused and the new version is shown for review.
- A 404 on a saved workout or schedule id means the athlete deleted it in
  Garmin Connect. An explicit send recreates it once.
- Coach changes and reschedules are **not** pushed automatically. The athlete
  sees "Update in Garmin Connect" when the sent version is out of date.
- Cancellation: if the coach deletes the session the receipt is deleted with
  it and the Garmin entry stays; if the coach unpublishes it the portal stops
  showing it. Either way the athlete is told when they send that the Garmin
  calendar will not change by itself and to delete a cancelled run in Garmin
  Connect.
- Disconnecting Garmin deletes the receipts with the connection. Workouts
  already in Garmin Connect stay there. Reconnecting and sending again creates
  a new copy, so the athlete should delete the old one in Garmin Connect.

### Uncertain create

The Training API has no "list workouts" call, so a workout POST whose answer
was lost cannot be checked automatically. The portal blocks further sends for
that session and tells the athlete to check Garmin Connect and contact the
coach. To clear it:

1. With the athlete, open Garmin Connect → Training & Planning → Workouts and
   look for the session's workout name (provider "Dual Performance").
2. If it is there, delete it in Garmin Connect (or keep it and ask the athlete
   to schedule it by hand; do not do both).
3. Reset the receipt so the next send creates exactly one workout. In the
   coaches dashboard, open the run: its status reads **Needs coach check**;
   select **Clear the block** (it only ever touches a `creating` receipt).
   Without the dashboard, the same reset in SQL:

```sql
update public.garmin_workout_deliveries
   set state = 'retryable', workout_id = null, owner_id = null,
       schedule_id = null, scheduled_date = null, fingerprint = null,
       updated_at = now()
 where athlete_code = '<CODE>' and planned_session_id = '<SESSION UUID>'
   and state = 'creating';
```

Never delete a receipt simply to retry: that is how duplicates are made.

## Credentials

- Tokens stay in `garmin_connections` (service role only) and never reach the
  browser. The browser only sends a session id and a preview fingerprint.
- Every token refresh, from a send, a portal load, a webhook or the hourly
  cron (`/api/garmin?mode=refresh`, needs `CRON_SECRET`), runs under one
  per-athlete lease and re-reads the saved token after acquiring it, so a
  rotated refresh token is never overwritten by an older one.
- `WORKOUT_IMPORT` is re-checked with Garmin on every send. A dead refresh
  token, a 401 or a 412 asks the athlete to reconnect with a fresh link.
- Disconnect deregisters with Garmin and deletes the connection and receipts.
  A Garmin deregistration webhook does the same. No send is possible after
  either.
- No Garmin activity or health data reaches AI inputs: the portal makes no AI
  calls, and the coaches dashboard's `api/analyse.js` reads none of the
  `garmin_*` tables.

## Activity import and the activity source

Starter access (Garmin Developer Program Start Guide 2.0, 15 Oct 2026, §2.1
and §2.3): up to 1,000 connected users, **push-only** delivery, **no
historical data**, one client ID. So:

- Only activities synced after an athlete connects arrive; the backfill
  endpoint answers 412 and the portal no longer calls it.
- A push Garmin never sends cannot be re-requested. Garmin retries a failed
  push hourly for up to 7 days when our endpoint does not answer 200
  (Activity API 2.1 §4); the webhook returns 500 on a storage failure so that
  retry happens.
- Every webhook call is logged as "Garmin notification applied" with
  `saved`, `ignoredTypes` and, since v263, `ignoredKeys` (summary type names
  only). A missing activity with no log line at all means Garmin never called
  us.

If a Garmin-recorded activity is missing, check in Garmin's endpoint tool
(https://apis.garmin.com/tools/endpoints, signed in with the app's client ID
and secret, which only the account owner should enter):

1. **Activities** and **Manually Updated Activities** are enabled, set to
   PUSH, URL `https://portal.dualperformance.au/api/garmin-webhook`.
2. Neither is **On Hold**.
3. Summary types the portal does not store (Activity Details, Activity Files,
   Epochs, Stress, etc.) can be unticked; they only produce `ignoredKeys`.
   Tick **Dailies** and **Sleeps** if daily calories and sleep should arrive
   (none have so far).
4. Then email connect-support@developer.garmin.com with the athlete's Garmin
   user ID, the activity start time (UTC) and the endpoint URL, asking whether
   a push was attempted.

Weekly review and reminders: for an athlete in `GARMIN_ALLOWED_ATHLETES`
**who is connected**, the weekly review's actual km and the evening "not
logged" nudge and "synced" push also read `garmin_activities`. A recording
both services hold (same sport, start within 10 minutes, distance within 3%)
counts once, as Garmin; the card says "from Garmin", "from Garmin and Strava"
or "from Strava". Everyone else makes no Garmin read and gets exactly the
review and reminders they had. The rules block shared with the coach card is
unchanged, and no Garmin data reaches any AI input.

## Deploy

1. Merge the portal PR (CI green). Production then serves cache `v264`.
2. Vercel → dp-athlete-portal → Settings → Environment Variables
   (Production). Confirm these exist, without opening their values:
   `GARMIN_CLIENT_ID`, `GARMIN_CLIENT_SECRET`, `CRON_SECRET`, `PORTAL_URL`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `GARMIN_ALLOWED_ATHLETES=KARL`.
   Add `GARMIN_WORKOUTS_ENABLED=true` if it is missing, then redeploy.
3. No database migration is needed. `garmin_workout_deliveries`,
   `acquire_job_lease` and the dashboard's `replace_run_steps` and
   `save_run_session` are live.

## Pilot (test athlete KARL only)

1. Coaches dashboard → KARL → Programming. On a running day in the next week
   create an **Intervals** session in the structured run builder:
   10 min warm-up; Repeat 6 × (1 km Interval, pace 4:30 to 4:45; 90 s
   Recovery); 10 min cool-down. Publish it.
2. Portal on your phone → open the session → **Review for Garmin**. Check:
   Warm-up · 10 min, Repeat 6 times, Interval · 1 km · 4:30–4:45 /km,
   Recovery · 90 s, Cool-down · 10 min, and the right calendar date.
3. **Send to Garmin**. Expect "Saved to your Garmin Connect calendar for …".
4. Garmin Connect app → Calendar: one workout on that date, named as in the
   portal, provider Dual Performance. Open it and compare steps and paces.
5. Sync the watch. Training → Workouts (or Today's suggested/calendar) →
   open the workout. Compare: 6 repeats, order warm-up → interval → recovery →
   cool-down, recovery 1:30, pace alert 4:30–4:45 /km.
6. Back in the portal, **Review for Garmin** → **Send again**. Expect "Still in
   your Garmin Connect calendar". Garmin Connect must still show one entry.
7. Move the session one day in the portal, wait for it to save, review and
   **Update in Garmin Connect**. Garmin Connect: one entry, on the new date.
8. Record evidence: screenshots of steps 2, 4, 5, 6 and 7, and the row
   `select state, scheduled_date, workout_id is not null, schedule_id is not
   null from garmin_workout_deliveries where athlete_code = 'KARL';`
   (`sent`, the new date, true, true).

## Evidence gates

**Gate A, before widening `GARMIN_ALLOWED_ATHLETES` for activity import:**
seven consecutive days in which every Garmin-recorded KARL activity (Strava
rows whose device is "Garmin …") also arrived in `garmin_activities`, with any
delay explained, and KARL's weekly review km matching between Garmin and
Strava for that week.

**Gate B, before enabling Send to Garmin for clients:**

- Pilot steps 1–8 passed on the test watch, with the evidence recorded.
- The calendar entry was confirmed in Garmin Connect **and** the workout was
  opened on the watch with matching repeats, order, recovery and pace range.
- An explicit re-send and a date change each left exactly one entry.
- Seven days of Vercel logs show no `Garmin workout not confirmed` warnings
  that were not explained, and the hourly refresh cron is returning 200.
- The coach has published structured runs (not text-only) for the athletes
  being added (the dashboard's "Garmin · next 14 days" line shows them as
  Garmin-ready); each athlete connects Garmin and ticks workout import.

Also before inviting clients: the privacy page still describes Garmin as not
yet live, and Garmin's Starter terms require a published privacy policy and
compliance with its integration and UX requirements (Start Guide §2.1).

Then add athlete codes one or two at a time, comma separated, and redeploy.
Use `*` only after a full training week with no unexplained failures.
