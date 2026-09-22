# Weekly Performance Summary

The athlete-facing weekly review on the Progress tab, and the server contract
behind it.

Status: shipped 2026-09-23. Contract version `1`.

---

## Purpose

An athlete opens Progress mid-block to answer one question: *what did this week
actually contain?* Before this, the answer was scattered across the calendar,
the volume strip and their own memory, and most of it was computed in the
browser from `localStorage` — which is a partial mirror of whatever one device
happened to cache, not the truth.

The weekly review answers that question from Supabase, server-side, in one
authenticated read. The wording is factual on purpose. It does not congratulate,
motivate, diagnose, advise, or narrate. Every sentence in it is either a number
or a statement of what was recorded.

This phase **supersedes** the "monthly report first" sequencing in
`docs/phase-5-prompt.md`. The weekly primitive is built first; the monthly report
aggregates it (see [Monthly reporting](#monthly-reporting) below).

---

## Request contract

The browser calls the existing authenticated gateway. There is no new API route.

```js
portalRequest('performance-summary', {
  period: 'week',
  programmeWeekId: '<uuid>'
})
```

which produces:

```http
POST /api/portal-data
Authorization: Bearer <existing athlete session>
Content-Type: application/json
Cache-Control: no-store
```

```json
{
  "action": "performance-summary",
  "period": "week",
  "programmeWeekId": "0f30b419-62ad-4bef-80e2-35eb71eb8ccb"
}
```

`/api/portal-data` rewrites to `api/write.js?mode=portal`; `dispatch()` routes
the action to `performanceSummary()` in `api/_lib/performance-summary.js`.

### What the client may send

Only `action`, `period` and `programmeWeekId`. That is the entire input surface.

The client **never** sends an athlete code, a date, a week label, a total or any
calculated metric. `write.js` resolves identity with `getRequestAthlete(req)`
and passes the code down; a code in the body is ignored, and a unit test asserts
every scoped query carries the authenticated code and not the body's.

### Validation and authorisation

| Condition | Result |
| --- | --- |
| `period !== 'week'` | `400`, before any database read |
| `programmeWeekId` is not a UUID | `400`, before any database read |
| No authenticated session | `401` from the handler |
| Athlete has no programme | `404` "Programme week not found" |
| Week belongs to another athlete | `404` "Programme week not found" |
| Week row has no usable `start_date` | `502` |

Ownership is resolved by asking for **this athlete's** programmes first and then
looking the week up scoped to those programme ids. A valid UUID belonging to
someone else takes exactly the same path as one that does not exist, so the
response never reveals which — the request cannot be used to probe for other
athletes' programme weeks.

### Dates

- The week runs from `athlete_programme_weeks.start_date` to six calendar days
  later, inclusive. The client's label is never trusted for this.
- All date maths goes through `addDaysISO()`, which parses the `YYYY-MM-DD`
  string, works in UTC at noon, and reads back with UTC getters. Building a
  local `Date` from an ISO date and reading it with local getters is how a week
  silently shifts a day: Vercel runs in UTC, the athlete lives in UTC+9:30.
  A unit test runs the range maths under four process timezones.
- Where a local "today" is needed — is this session missed? is this week past? —
  it is resolved in `Australia/Adelaide`, the product timezone, matching the
  portal's own `localISO()`.
- Discovery week is week number `0` and displays as `Discovery Week`. The stored
  label varies by athlete (`"Week 0"` for some, `"Discovery Week"` for others);
  the **number** is the authority.

---

## Response contract

```jsonc
{
  "ok": true,
  "summary": {
    "version": 1,
    "generatedAt": "2026-09-27T10:15:00.000Z",
    "period": {
      "type": "week",
      "programmeWeekId": "0f30b419-62ad-4bef-80e2-35eb71eb8ccb",
      "weekNumber": 8,
      "label": "Week 8",
      "startDate": "2026-09-21",
      "endDate": "2026-09-27",
      "state": "current"                    // current | past | future
    },
    "training": {
      "plannedSessions": 6,
      "completedSessions": 5,
      "completionPercent": 83,              // null when nothing was planned
      "byType": {
        "running":  { "planned": 4, "completed": 3 },
        "cycling":  { "planned": 0, "completed": 0 },
        "swimming": { "planned": 0, "completed": 0 },
        "strength": { "planned": 2, "completed": 2 },
        "other":    { "planned": 0, "completed": 0 }
      },
      "missedSessions": [
        { "id": "…", "title": "Easy Run", "date": "2026-09-24", "type": "running" }
      ]
    },
    "endurance": {
      "running": {
        "plannedDistanceKm": 42,
        "plannedDistanceSource": "typed",   // typed | title | none
        "actualSessions": 3,
        "actualDistanceKm": 39.6,
        "actualDurationMinutes": 228,
        "actualSource": "strava"            // strava | portal_logs | unavailable
      },
      "cycling":  { "…": "same shape" },
      "swimming": { "…": "same shape" }
    },
    "strength": {
      "plannedSessions": 2,
      "completedSessions": 2,
      "exercisesLogged": 9,
      "workingSets": 31,
      "measurableVolumeKg": 5240,
      "volumeCoverage": { "eligibleSets": 31, "measuredSets": 27, "excludedSets": 4 },
      "personalBestsStatus": "calculated",  // calculated | not_calculated
      "personalBests": [
        { "exercise": "Back Squat", "type": "load", "value": 110,
          "unit": "kg", "previous": 105, "delta": 5, "date": "2026-09-23" }
      ]
    },
    "readiness": {
      "daysLogged": 6,
      "average": 72,
      "previousWeekAverage": 78,
      "changeFromPreviousWeek": -6,
      "sleepAverage": 6.8,
      "energyAverage": 6.4,
      "sorenessAverage": 5.2,
      "stressAverage": 7.1
    },
    "bodyweight": {
      "entries": 4, "firstKg": 86.4, "lastKg": 85.9, "changeKg": -0.5,
      "firstDate": "2026-09-21", "lastDate": "2026-09-27"
    },
    "checkIn": { "submitted": true, "submittedAt": "…", "weekEnding": "2026-09-27" },
    "attention": [
      { "code": "high_stress", "severity": "medium",
        "message": "Average stress was 8.1 this week.", "value": 8.1 }
    ],
    "dataQuality": { "partial": false, "missingSources": [], "warnings": [] }
  }
}
```

The numbers above are illustrative. Nothing in the implementation is hard-coded.

### Guarantees

- Arrays are always arrays, never `null`.
- Every number is finite. `NaN`, `Infinity` and `undefined` never serialise:
  `sanitise()` converts them to `null` at the response boundary, logs where they
  were, and adds a warning to `dataQuality`.
- Rounding happens only at that boundary. Readiness scores are whole numbers;
  component averages and distances are one decimal place; volume is whole
  kilograms.
- A past week is **never** described as final, approved or locked. Nothing is
  persisted, so nothing is final.

### What is never returned

Check-in free text. Daily-log notes. Raw sets. Raw Strava rows or any Strava
identifier. Internal join keys. Database error messages. Credentials.

Those are read for the arithmetic where needed and dropped; several are not even
projected in the `select`, so they cannot leak through a later change that
starts echoing rows. Unit tests assert each one by name.

---

## Source of truth, per metric

| Metric | Table | Fields read | Rule |
| --- | --- | --- | --- |
| Programme week | `athlete_programme_weeks` | `id, programme_id, week_number, week_label, start_date` | Scoped to `athlete_programmes.id` for this athlete |
| Planned sessions | `planned_sessions` | `id, notion_page_id, title, planned_date, session_type, status, library_id, distance_km, week_label, prescription_mode` | `publish_state = published`, `programme_week_id = <week>` |
| Session type | — | — | `classifySession()`; see [Classification](#classification) |
| Completion | `session_logs` | `session_key` | Exact match on `notion_page_id \|\| id` |
| Planned distance | `planned_sessions` | `distance_km`, `library_id`, `title` | `plannedKmFromRow()`, parity-tested against the browser |
| Actual endurance | `strava_activities` | `sport_type, start_date_local, distance_m, moving_time_s, elapsed_time_s` | Aggregates only; one source per sport |
| Actual endurance (fallback) | `training_session_logs` | `session_category, session_name, session_date, distance_km, duration_min` | Used only when Strava has nothing for that sport |
| Strength volume | `training_session_logs` | `raw_sets, exercise_name, programmed_exercise, session_category, session_date, session_name` | Structured `raw_sets` only |
| Personal bests | `training_session_logs` | as above, `session_date <= endDate` | Portal PB rules, walked chronologically |
| Readiness | `daily_body_logs` | `log_date, sleep, energy, stress, soreness` | `calculateDailyReadiness()` formula |
| Pain | `daily_body_logs` | `raw_payload.pain`, `raw_payload.painLocation` | Threshold `>= 5` |
| Bodyweight | `daily_body_logs` | `log_date, weight` | First and last valid entry in the week |
| Check-in | `weekly_checkins` | `week_ending, submitted_at` | Matched on the server-held date range |
| Gym split names | `workout_splits` | `name` | Extends the base `GYM_KEYS` for classification |
| Structured sessions | `session_exercises`, `run_steps` | `planned_session_id` | Counts only — decides strength vs run-led |

No new tables, no new columns, no migration. The whole feature is a read.

---

## Aggregation rules

### Classification

One pure helper, `classifySession()`. It follows the browser's `getType()`
(`public/js/01-core.js`) and then extends it:

1. `swim` in the type or title → `swimming`
2. `ride`, `bike` or `cycl` → `cycling`
3. `note`/`notes`/`general`/`discovery`/`custom` type → `other`
4. A coach-built (`prescription_mode: structured`) session with exercises and no
   run steps → `strength`. One that also carries run steps stays run-led, as the
   calendar decides it.
5. `strength`/`gym` type, or a `GYM_KEYS` name in the title → `strength`
6. Otherwise → `running`

Rest days and the placeholder titles the calendar treats as "nothing programmed"
(`rest`, `free`, `free day`, `open`, `open day`, `recovery day`) are excluded
before any counting.

> **Known limit.** `planned_sessions` carries no sport column, so a planned
> cycling or swimming session is only recognised when the coach types it as one.
> An untyped endurance session classifies as running — exactly as it does in the
> calendar today. In practice today almost every planned endurance session lands
> in `running`. Fixing this needs a schema change on the coaches' dashboard, not
> a smarter regular expression here.

### Completion

The authority is an exact `session_logs.session_key` match on
`notion_page_id || id` — the same key the browser has always used for logs,
drafts and reschedules. A `Completed` status on the planned row is a documented
compatibility fallback for sessions marked done before the portal wrote
`session_logs`.

Nothing else completes a session. An activity on the same date does not, and a
test asserts it.

A session is `missed` only when its date is strictly before the Adelaide local
date. Today's session is still in progress; a future session has not been asked
for yet.

### Planned distance

Parity port of `safeKm` / `titleKmFromName` / `plannedKmFromRow` from
`public/js/05-handbook.js`, in the same order of trust: explicit `distance_km`,
then the linked library entry, then the title. Durations (`45min`, `1 hour`) and
absurd values (`> 200 km`, `<= 0`) are rejected. Interval notation is not weekly
distance — `5x1km Threshold` and `3km pace` both parse to nothing.

`plannedDistanceSource` reports where the figure came from, so a title guess is
never presented with the confidence of a prescription.

### Actual endurance

One source per sport, never two. Strava wins when it has activity for that sport
because it measures the work; the athlete's confirmed `training_session_logs`
are the fallback. **They are never added together** — a run logged in both
places is one run — and `actualSource` says which won.

### Strength

A strength *session* is a training day, not a row. The portal writes one
`training_session_logs` row per exercise, so counting rows would report nine
completed sessions for one gym visit. Completed strength sessions come from the
planned-session completion pass; the log rows supply exercises, sets and volume.

```
bilateral   volume = weight × reps
left_right  volume = weight × (repsLeft + repsRight)
```

- Assisted movements (`/\bassist(ed|ance)?\b/i`, the client's own expression) are
  excluded from tonnage and from every PB type. The recorded number there is help
  supplied by the machine, not load lifted. The sets still count as work.
- A set with no load or no reps is **not** a zero-volume set. It counts in
  `eligibleSets` and not in `measuredSets`, and the difference is reported as
  `excludedSets`.
- Bodyweight work raises `workingSets` while leaving `measurableVolumeKg`
  unchanged. That is correct, not a bug.
- `exercise_log` is never parsed. A historic row without structured `raw_sets`
  cannot be calculated reliably, so it is excluded and the shortfall surfaces
  through `volumeCoverage` and a `dataQuality` warning.

### Personal bests

**Strategy used: option 1 — the portal's rules reproduced as a pure server
helper, with parity tests against the browser's own implementation.**

`tests/performance-summary-parity.test.js` loads `detectExercisePBs`, `pbFold`,
`pbCleanSets`, `pbE1rm`, `exerciseHistoryKey` and `_isAssistedExercise` out of
`public/js/` with `node:vm` and runs both implementations over 400 generated
cases plus a set of hand-picked edges. Editing either side without the other
fails the suite. The mutation checks that prove it bites are recorded in the PR.

The rules, unchanged from `public/js/09-logging.js`:

1. **Load** — a single set heavier than the stored best, at any rep count.
2. **Rep** — more reps at the same or greater weight than the stored record.
3. **e1RM** — Brzycki `w × 36 / (37 − r)`, valid for 1–10 reps only.
4. **Volume** — session total `Σ w × r`, sets over `PB_REP_CAP` (12) excluded.

Guards: load/rep/volume cap at 12 reps; e1RM caps at 10; a set below 60% of the
stored load PB never flags (the portal captures no RPE, so the "no RPE" branch
of that guard always applies); a first-ever entry seeds history silently;
assisted movements are excluded entirely; a purely unilateral set
(`repsLeft`/`repsRight` with no `reps`) drops out of `pbCleanSets` and never
produces a PB, because a per-side rep count is not comparable to a bilateral one.

> **One deliberate divergence.** The browser's `pbComputeStored(exName,
> excludeId)` folds every *other* session, including ones logged **after** the
> one being judged, so a back-filled session is compared against work done later.
> The server walks strictly forward in time up to the end of the requested week.
> "A PB this week" has to mean "better than everything before it", and a report
> is the wrong place to inherit that quirk. The rules are identical; only the
> ordering differs, and only for back-filled history.

When the history read fails, `personalBestsStatus` is `not_calculated` and
`personalBests` is `[]`. It is never a silent empty list — measuring a PB against
an empty past would make every set look like a record.

### Readiness

Parity port of `calculateDailyReadiness()`:

```
sleep    × 10
energy   × 10
(11 − soreness) × 10
(11 − stress)   × 10
```

Only the components present on that day are averaged; a missing component is
omitted, never treated as zero. A day with no valid component scores `null` and
does not count towards `daysLogged`. Unlogged days never drag the week's average
down. The weekly figure is the mean of the valid daily scores.

### Attention items

Deterministic facts with a stable `code`, a `severity`, an athlete-facing
sentence and, where it means something, a `value`. Deduplicated by code and
ordered by severity then code.

All thresholds are the portal's existing ones. **No new clinical numbers are
invented here.**

| Code | Threshold | Source |
| --- | --- | --- |
| `sessions_not_logged` | any past planned session not logged | this module |
| `pain_reported` | `pain >= 5` | `getHomeInsights`, `public/js/08-training.js` |
| `low_readiness` | `readiness < 40` | `public/js/08-training-focus.js` |
| `high_stress` | `stress >= 8` | `getHomeInsights` |
| `high_soreness` | `soreness >= 8` | `getHomeInsights` |
| `low_energy` | `energy <= 3` | `getHomeInsights` |
| `checkin_missing` | week `state === 'past'` and not submitted | this module |

The copy states what was recorded — "Knee pain was recorded on 2 days." — and
nothing else. It does not diagnose, does not recommend, and never suggests
training through anything. A test asserts the absence of advisory language.

---

## Null versus zero

This is the single most important rule in the contract.

| Value | Meaning |
| --- | --- |
| `0` | A verified count of zero. The athlete did none of this, and we know. |
| `null` | Unavailable, unmeasurable, or not applicable. We do not know. |

Concretely:

- No sessions planned → `completionPercent: null`, not `0` and not `100`.
- No readiness logged → `average: null`, `daysLogged: 0`.
- One weigh-in → `changeKg: null`, `entries: 1`.
- Strava unreachable → `actualDistanceKm: null`, `actualSource: "unavailable"`.
- Strava reachable with no rides → `actualSessions: 0`, `actualDistanceKm: null`.
  Zero sessions is a fact; "0 km" would read as a judgement.
- Nothing measurable in the gym → `measurableVolumeKg: null`; measurable sets
  present but all bodyweight → `0`.

An optional source that fails must never become a zero. A silent zero reads to an
athlete as *"you did nothing this week."*

The client honours the same rule: it renders `null` as "Not recorded",
"Not measurable" or "Activity data unavailable", never as `0`.

---

## Athlete / Strava privacy boundary

Non-negotiable, and the reason the Strava aggregation lives here rather than in
anything coach-facing.

- The Strava API Agreement permits a user's data to be displayed back to **that
  user only**. This summary is served exclusively to the authenticated athlete
  it belongs to, so it may read their own cached activities.
- `strava_activities` grants nothing to `anon` or `authenticated`. The browser
  cannot read it directly; this module and `api/strava.js` are the only paths.
- The `select` here projects **aggregate columns only** — `sport_type`,
  `start_date_local`, `distance_m`, `moving_time_s`, `elapsed_time_s`. The
  `summary` and `detail` JSONB payloads are not requested, so a raw Strava object
  cannot reach the response even through a later change that starts echoing rows.
  A test asserts the projection.
- Only counts, distances, durations and a source label are returned. No activity
  id, no name, no start time, no gear, no polyline.
- **Nothing in this feature adds Strava data to a coach-facing table.** A future
  coach-facing report must use the athlete's confirmed portal logs
  (`training_session_logs`), which are Dual Performance's own data, unless a
  separate compliance decision is made.

---

## Partial-data behaviour

Mandatory reads fail the request through the existing safe-error path:
authentication, programme ownership, request validation, and the programme-week
lookup.

Every other source degrades independently. When one fails:

- the rest of the summary is returned;
- the affected metrics become `null` or an explicit unavailable status;
- `dataQuality.partial` becomes `true`;
- a stable source name is appended to `dataQuality.missingSources`;
- the raw database message is logged server-side with the source name and never
  returned.

Stable source names: `session_logs`, `training_session_logs`,
`strength_history`, `daily_body_logs`, `daily_body_logs_previous`,
`weekly_checkins`, `strava_activities`, `workout_splits`, `session_exercises`,
`run_steps`.

Two failures get an extra warning rather than a silent downgrade:

- `session_logs` unavailable → completion falls back to planned-session status
  alone, and `dataQuality.warnings` says so.
- `strength_history` unavailable → `personalBestsStatus: "not_calculated"`.

`selectTolerant()` handles the narrower case of a column that does not exist yet
in production: PostgREST names the missing column, so the projection is retried
without it rather than losing the whole read. Same idea as `upsertTolerant` in
`api/ingest.js`, applied to selects. `training_session_logs.distance_km`,
`duration_min`, `exercise_name` and `programmed_exercise` are treated as optional
for this reason — they are written by `api/ingest.js` but have no migration in
this repo.

---

## Client behaviour

The card is the first thing on Progress, above the photo check-in. That order is
asserted in `scripts/check-portal.mjs` and was changed deliberately.

- One request per programme week per page session, cached **in memory only**.
  The summary is derived data about the athlete's body and training; persisting
  it to `localStorage` would leave a second, staler copy on the device with no
  way to revoke it. Reloading the app always gets the current server answer.
  `check-portal.mjs` asserts the cache never touches `localStorage`.
- A retry clears the failed cache entry so it genuinely goes back to the server.
- Duplicate concurrent requests for the same week are collapsed into one.
- A late response for a week the athlete has already navigated away from is
  discarded rather than painted over the week they are looking at.
- The request is fired when Progress first opens and is **not awaited** by
  `loadProgress()`; portal boot never waits on it at all.
- Loading shows a skeleton and a `role="status"` line, never the previous week's
  numbers under a new label.
- Failure shows "Weekly review unavailable", a short explanation and a real
  `<button>` retry, inside the card. The rest of Progress stays usable.
- Partial data renders normally with a quiet notice.
- Navigation into a week that has not started is disabled, in the control and in
  the controller.
- `weekly_summary_opened` fires once per selected week per page session;
  `weekly_summary_week_changed` fires on each change. Neither carries an athlete
  code, a note, an injury location or a raw health value.

Accessibility: 44px touch targets, `aria-label`s on both week controls,
`aria-live="polite"` and `aria-busy` on the body, severity carried as a word
("Flagged", "Worth noting", "For the record") as well as an edge colour, no
horizontal overflow at 320px, and `prefers-reduced-motion` respected by the
skeleton. All asserted in `tests/e2e/weekly-review.spec.js` at 320, 390, 768 and
1280px in both themes.

---

## Known unverified assumptions

Everything here is tested against a stubbed `select` or a stubbed `fetch`.
**Nothing in this feature has been executed against the real Supabase project.**
These are the specific places where production could disagree with the tests:

| Assumption | If it's wrong | How it fails |
| --- | --- | --- |
| `daily_body_logs.raw_payload.pain` / `.painLocation` carry the pain score | `pain_reported` never fires | Quiet. No attention item; everything else is unaffected. |
| `planned_sessions.programme_week_id` is populated for current weeks | The date fallback runs instead | Visible: a week with no `programme_week_id` rows falls back to the date range, which is what the fallback is for. |
| PostgREST accepts `and=(col.gte.X,col.lte.Y)` as built here | That read 500s | Safe: the source degrades, `dataQuality.partial` goes true and the card says so. Asserted at the URL level in `performance-summary-integration.test.js`. |
| `strava_activities.start_date_local` is `timestamptz` | The prefilter window is wider than needed | Harmless: `aggregateActualEndurance()` enforces the exact boundary on the local date string regardless. |

The first production read is the real test of all four. A failure in any of them
degrades rather than breaks, which is the reason the partial-data path exists.

## Current limitations

1. Planned cycling and swimming are only recognised when the coach types them
   that way (see [Classification](#classification)).
2. Strength rows without structured `raw_sets` are excluded from volume. They are
   counted in neither `workingSets` nor `measurableVolumeKg`, and the shortfall
   is reported rather than estimated.
3. PB ordering diverges from the browser for back-filled sessions, deliberately.
4. Nothing is persisted. Re-opening a past week recomputes it, so a summary can
   change if the underlying rows change. No snapshot, no approval, no immutability.
5. The previous-week readiness comparison uses the seven days before this week's
   start date, not the previous *programme week* row. They are the same thing for
   a contiguous programme and differ only if a coach leaves a gap between weeks.
6. `missedSessions` is unbounded in the response; the card shows the first three.
7. The client and the server are never exercised together: the browser tests stub
   `/api/portal-data`, and the integration tests stub `fetch` below the handler.
   The seam between them is covered by asserting the exact `{ ok, summary }`
   envelope on both sides, not by a round trip.

---

## Monthly reporting

The monthly implementation must **not** independently reinvent these metrics.
Two supported routes, in order of preference:

**1. Reuse the pure layer.** Everything above the `── DATABASE ──` divider in
`api/_lib/performance-summary.js` is pure: same inputs, same output, no I/O and
no clock unless a date is handed in. `buildSummary()` takes already-fetched rows
plus `todayISO` and `generatedAt` and returns the whole contract. A monthly
action can fetch a month's rows once and call the same aggregators per week,
which keeps one definition of "completed session", "measurable volume" and
"readiness" across both reports.

**2. Aggregate the weekly contract.** Call the weekly summary for each programme
week in the month and combine the version-`1` objects. If this route is taken,
the combining code must respect the null/zero rule: summing `null` as `0` is the
exact failure this contract exists to prevent, and a month containing one
unavailable week is a partial month, not a smaller one.

Either way:

- Read `summary.version` and fail loudly on an unexpected value rather than
  guessing at the shape.
- Carry `dataQuality` upward. A month is partial if any week in it was.
- Do not re-derive PBs per month from scratch. A monthly PB is the set of weekly
  PBs, deduplicated by exercise and type, keeping the best.
- `completionPercent` does not average. Recompute it from the summed planned and
  completed counts, and keep it `null` when nothing was planned all month.

When the monthly report lands, the contract version goes to `2` only if the
weekly shape itself changes. Adding a monthly action does not change this one.

---

## Related

- `api/_lib/performance-summary.js` — the implementation
- `api/write.js` — `dispatch()` registration, one line
- `public/js/07-progress.js` — the card
- `tests/performance-summary.test.js` — contract and aggregation
- `tests/performance-summary-parity.test.js` — parity with the browser's rules
- `tests/e2e/weekly-review.spec.js` — the browser journey
- `docs/backend-data-safety.md` — the authentication and identity rules this follows
- `docs/strava-roadmap.md` — the Strava cache and its compliance boundary
- `docs/strength-progression.md` — the strength engine this shares exercise rules with
