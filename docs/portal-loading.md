# Portal loading: critical path, deadlines and failure handling

Written 20 Oct 2026. The static shell paints in 0.2-0.4s; the delays athletes
saw came from authenticated Supabase reads. This is what the portal does now.

## Critical path on a cold login

1. **Auth** (`/api/auth-athlete`, 9s deadline). A slow or failing server is
   reported as `unavailable`, not as an expired session: an athlete who has
   signed in on this device before opens the portal from the device copy
   (`cachedRosterFromProfile`) with every data request still authenticated
   server-side. Only a 401/403 signs anyone out. Server-side,
   `getRequestAthlete()` now throws a 503 `auth_unavailable` when the database
   or Supabase Auth cannot answer; before, it returned null and the API
   answered 401, which signed athletes out whenever the project stalled.
2. **Bootstrap** (`portal-data` `bootstrap`, 9s) and **the current week**
   (`training-read`, 9s, `scope: 'range'`) in parallel.
   * The range read returns sessions in the visible week, sessions the athlete
     moved INTO it (from `athlete_data.reschedules` plus ids the browser
     sends), the next session after it, and prescriptions for exactly those.
     It used to read up to 1,000 programme rows and prescriptions for 200
     sessions to render Today.
   * Clients built before this change send no `scope` and still get the whole
     programme.
3. Today and the week render. **Only then** does secondary work start, in
   three idle-time stages (`startPortalSecondary` in `02-login-goals.js`):
   * `today` (0ms): Strava status and matches, this week's nutrition targets
   * `history` (700ms): the whole-programme index (`programme-sessions`,
     no prescriptions, cached 10 min in memory / 24h on device) for streaks,
     exercise history, PB dates and Strava matching; library revision check
   * `sync` (1.8s): retry queue, booked-call state, push subscription,
     notification inbox
   While the shared backoff window is open each stage waits it out first.

Sign-in no longer triggers `loadNutrition()` (and with it `programme-data`)
from `switchTab('today')` before the week has loaded.

## Deadlines and failure classes

`portalFetchJson()` / `portalRequest()` in `01-core.js` abort the fetch (body
included) at the deadline: 9s for critical reads, 6s for secondary work, 20s
for the explicit GoHighLevel booking sync. Server-side, every PostgREST call in
`api/_lib/supabase-rest.js` aborts at 8s (`SUPABASE_TIMEOUT_MS`), Supabase Auth
at 8s, GoHighLevel at 8s, web-push at 8s.

| Class | From | What the portal does |
|---|---|---|
| `timeout` | deadline, 504, 408 | keep cached data, stale notice, back off |
| `offline` | `navigator.onLine === false` | same, "Offline" wording |
| `network` | fetch failed | same |
| `server` | 5xx, 429, 503 `auth_unavailable` | same; never signs out |
| `auth` | 401/403 | renew an access-code session once, else sign in again |
| `unsupported` | 404, 501, `Unknown portal action` | the legacy compatibility reads |
| `client` | other 4xx | report the error |

Nothing retries in a loop. Writes are never replayed by `portalRequest`
(the outbox owns that); the one replay is after a 401 renewal, when the server
provably did nothing. Transient failures open a shared backoff window
(exponential, base 2s, cap 60s, equal jitter). Background refreshes and
focus/visibility handlers skip while it is open, and each handler is throttled
(`portalResumeAllowed`): bookings 5 min, programme volume 5 min, confirmed log
dates 60s, outbox drain 30s.

## No fan-out on failure

* `bootstrap` failing with a timeout or 5xx no longer turns into five legacy
  reads. The device copy that already rendered stays, the sync pill says
  "Connection slow · showing saved plan", and one delayed retry chain runs
  (≈4s, 8s, 16s with jitter).
* `training-read` failing the same way, or returning a failed section, uses
  the last saved copy of that week even past its 24h freshness, the cached
  library only, and schedules the same kind of retry. If there is no saved
  copy, the retryable "couldn't load" state shows within the 9s deadline
  instead of a spinner.
* Only `unsupported` gets the compatibility reads.

## Bookings

Bookings reach Supabase through the GHL webhook and the daily
`/api/bookings?mode=sync` cron. The portal now READS that copy on entry
(`booking-read`, one indexed query) and runs the full GoHighLevel
reconciliation (`booking-sync`: three GHL calendar reads, contact lookups and
writes) only when this device's last sync is over six hours old, when a
placeholder booking has no time yet, or when the athlete opens the booking
sheet. One request at a time; focus and visibility can no longer start two.

## Other narrowed reads

* Session library revision: a trigger-maintained counter
  (`cache_revisions`), one primary-key read. Unchanged libraries are never
  selected or hashed.
* Strava acknowledgement banner: read from the bootstrap's state rows instead
  of a second full `state-read`.
* Push subscription: re-posted at most once a day per device on start-up
  (or when the endpoint or timezone changes). Taps on Enable notifications
  always post.
* Notification inbox (`GET /api/reminders?portal=1`): returns the inbox only.
  It used to compute the athlete's whole reminder state (nine reads) that the
  portal never rendered; `?due=1` still returns it.

## Telemetry

Privacy-safe timing for named operations. Never athlete codes, names, tokens,
request bodies, programme or health content.

* **Server:** one JSON log line per operation (`"evt":"perf"`): `op`, `ms`,
  `status`, `timedOut`, `dbCalls`, numeric counts. Cron ops always log;
  request ops log on failure, timeout or >2s, plus a sample of healthy ones
  (`PERF_LOG_SAMPLE_RATE`, default 0.05). Ops: `auth.request`,
  `portal.<action>` (`portal.bootstrap`, `portal.training-read`,
  `portal.booking-sync`, ...), `strava.read`, `portal.notificationInbox`,
  `reminders.lease`, `reminders.roster`, `reminders.inputs`,
  `reminders.compute`, `reminders.dedupe`, `reminders.send`, `reminders.run`.
* **Browser:** `window.__dpPerf` keeps the last 60 operations
  (`auth.resolve`, `auth.validate`, `portal.bootstrap`,
  `portal.trainingRead`, `portal.bookingRead`/`bookingSync`,
  `strava.refresh`, `push.subscribe`, `portal.notificationInbox`,
  `secondary.<stage>`) and writes `performance.measure` entries. With
  `SENTRY_TRACES_SAMPLE_RATE` above 0 in `config.js` (default 0.02, capped at
  0.2) they are also sent as sampled `dp.portal` spans; the athlete tag, user
  and URL are stripped from every span.
