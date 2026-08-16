# Strava Integration — Current State & Change Plan

_Audit date: 16 Aug 2026 · repo: `dp-athlete-portal-main`_

> **Status: Phases 0 and 1 are built.** See `docs/strava-runbook.md` to deploy
> them. §1 and §2 below describe the state this work replaced — kept because the
> reasoning is what justifies the architecture, and it is the thing that gets
> forgotten first.
>
> | | |
> |---|---|
> | ✅ §3 Phase 0 | all six items; §3.2 deferred to Jan 2027 by design (env var, no code change) |
> | ✅ §4 Phase 1 | cache table, event queue, webhook, read flip, catch-up backfill, disconnect |
> | ✅ §6 Compliance | confirmed-log boundary, enforced in RLS **and** route scoping, with tests |
> | ⬜ §5 Phase 2 | laps, best efforts, streams, zones |
> | ⬜ §7 Phase 3 | shoe mileage, athlete stats, non-run matching, strength upload |
>
> Phase 2 is now cheap: the webhook already fetches `GET /activities/{id}`, which
> returns `DetailedActivity` — laps, `splits_metric` and `best_efforts` are
> already landing in `strava_activities.summary`. Phase 2 is reading them, not
> fetching them. `profile:read_all` is also already requested, so §5.3 needs no
> second re-consent.

---

## 1. What the portal uses today

| | |
|---|---|
| **Endpoints called** | `POST /oauth/token` (exchange + refresh), `GET /athlete/activities?per_page=100` |
| **Scope requested** | `activity:read_all` only |
| **Fields consumed** | `id`, `name`, `distance`, `moving_time`, `elapsed_time`, `type` / `sport_type`, `start_date` / `start_date_local`, `relative_effort` (see 3.1 — likely always `undefined`) |
| **Persistence** | None. Tokens only, in `athlete_data` (`key = 'strava_tokens'`). Activities are never stored. |
| **What it drives** | Run→session matching (`strava-match.js`), auto-complete of run logs (`09-logging.js`), weekly km actuals for the programme volume chart (`05-handbook.js`), the km ring source label (`06-nutrition.js`) |

That is **one read endpoint and six fields**, out of an API that exposes activity detail, laps, splits, best efforts, streams, zones, gear, athlete stats, segments, routes, uploads and webhooks.

**Verdict: no, we are nowhere near the ceiling** — but the gap is not "we forgot to call some endpoints." It is one architectural decision (§2) that makes every richer endpoint unreachable.

---

## 2. The structural limit

The integration is a **read-through pull on page render**. Every portal open calls Strava live, uses the response for one job, and throws it away.

Five consequences, all of which disappear together:

1. **History is capped at the last 100 activities.** No `after`/`before`, no paging. For a high-volume athlete an 18-week block exceeds 100 activities, so `deriveCompletedKmFromStrava` reports `null` for the oldest weeks and the volume chart silently goes blank.
2. **Rate limit scales with athletes × portal opens.** 200 req/15min and 2,000/day are shared across the *whole app*, not per athlete. With ~10 athletes opening the PWA several times a day, the `strava_rate_limited` fallback isn't defensive — it's load-bearing.
3. **No trend analysis is possible.** Nothing is retained, so there is no week-over-week, no fitness curve, no "compared to their last block."
4. **Richer endpoints can't be used at all.** Detail, laps and streams are *per-activity* calls. Fetching them for 100 activities on page render is impossible on latency and on rate limit. They only become viable if activities arrive once, in the background.
5. **The coaches dashboard is locked out.** It has no path to this data without holding the athlete's token.

**The one change that unlocks everything else: stop pulling on render, start persisting on event.**

---

## 3. Phase 0 — correctness fixes

Small, independent, no architecture change. Do these first.

### 3.1 `relative_effort` is almost certainly always `undefined`

`public/js/strava-match.js`:

```js
function classifyExecutedIntensity(activity, threshold) {
  var effort = Number(activity && activity.relative_effort);   // ← this field
  ...
  if (!Number.isFinite(effort) || effort <= 0 || ...) return null;
```

REST v3 `SummaryActivity` returns **`suffer_score`**. "Relative Effort" is the *UI* name for it — it's what Strava's own MCP returns, but not what `/athlete/activities` sends.

If that's right, `classifyExecutedIntensity` returns `null` on every activity, so `prescribed === 'quality' && executed === 'easy'` never fires, and both `intensity_below_prescription` and `ran_above_prescription` are dead code — including the "This looks easier than the session you had planned" prompt and the `ranAbovePrescription` flag written to every log payload.

**Confirm before changing:** one `console.log(JSON.stringify(activities[0]))` in `api/strava.js` settles it.

**Fix:** read `activity.suffer_score ?? activity.relative_effort`. Note `suffer_score` is HR-derived — it is `null` for athletes running without a HR strap, so the `null` path must stay a valid "unknown", not a failure.

### 3.2 Base URL migration

```js
const STRAVA_API = 'https://www.strava.com/api/v3';   // api/strava.js:23
```

Strava is moving to `https://api-v3.strava.com`, available 4 Jan 2027. One constant, one line. Do it when it opens rather than on a deadline.

### 3.3 Pagination and a date window

`fetchActivities(accessToken, perPage = 100)` takes no `after`. Add `after=<programme start, epoch seconds>` and loop pages until short. Combined with §4 this runs once in the background, not on render.

### 3.4 Deauthorization endpoint

New as of June 2026. Gives the portal a real **Disconnect Strava** control instead of leaving orphaned tokens in `athlete_data` forever. Pairs with the webhook deauth event (§4.4).

### 3.5 Store the granted scope

OAuth token responses now include a space-delimited `scope` field. Store it alongside the tokens. Then `strava_access_denied` in `10-boot.js` can name the missing scope instead of inferring intent from a bare 403.

### 3.6 Check the app's athlete capacity

New apps cap at 1 athlete; self-service upgrade takes it to 10; beyond that needs app review. The cohort is at ~10 — this will bite mid-block, not conveniently. Also: standard API access now requires an active Strava subscription for the developer account (since 1 June 2026).

---

## 4. Phase 1 — persist + webhook

This is the change that matters.

### 4.1 New table

```sql
create table if not exists public.strava_activities (
  athlete_code       text not null,
  strava_activity_id bigint not null,
  start_date_local   timestamptz not null,
  sport_type         text,
  name               text,
  distance_m         numeric,
  moving_time_s      integer,
  elapsed_time_s     integer,
  suffer_score       numeric,
  gear_id            text,
  summary            jsonb not null,   -- full payload, so new fields need no migration
  detail             jsonb,            -- Phase 2: laps, splits, best_efforts
  synced_at          timestamptz not null default now(),
  primary key (athlete_code, strava_activity_id)
);
create index on public.strava_activities (athlete_code, start_date_local desc);
```

RLS: service-role write only, athlete-scoped read — same shape as the `20260727085203` lockdown.

Also needs a fast Strava-athlete-id → `athlete_code` lookup. Webhook events identify the athlete by `owner_id`, and today that lives inside `athlete_data.value->>'strava_athlete_id'`. Either add an expression index or promote it to a column.

### 4.2 The webhook endpoint — no new serverless function

`api/` currently holds **10 functions against the Hobby cap of 12**. The repo already has the pattern for this: `bookings.js` serves `?mode=webhook` behind a rewrite. Do the same.

```json
{ "source": "/api/strava-webhook", "destination": "/api/strava?mode=webhook" }
```

Handler, mirroring the existing `mode === 'callback'` branch:

- **GET** — validation handshake. Echo `hub.challenge` as `{"hub.challenge": "..."}` with a 200, after checking `hub.verify_token` against an env var. Must answer within 2 seconds.
- **POST** — event. `{ object_type, object_id, aspect_type, updates, owner_id, subscription_id, event_time }`. **Ack 200 immediately, then process.** Strava retries 3× on anything else, and 2s is the budget.

Subscription is created once, out of band: `POST /push_subscriptions` with `client_id`, `client_secret`, `callback_url`, `verify_token`. **One subscription per application** — it covers every authorised athlete, so this is a one-time setup, not per-athlete.

### 4.3 Read path flips

`GET /api/strava` stops calling Strava and reads `strava_activities` instead. It keeps its existing response shape, so `10-boot.js`, `09-logging.js`, `05-handbook.js` and `06-nutrition.js` need no changes. `activitiesAvailable: false` stays as the fallback for "connected but nothing synced yet."

Keep one live pull: a backfill on first connect (the OAuth callback fires a paged fetch from the block start date).

### 4.4 What this fixes immediately

- Rate limit stops scaling with portal opens — it scales with *actual training volume*, which is roughly 1–2 events per athlete per day.
- The match is computed **before the athlete opens the app**, so it can fire a push notification (`api/notify.js` already exists) rather than waiting to be discovered.
- An athlete renaming or correcting a run on Strava updates the match — `aspect_type: 'update'` carries `title`, `type`, `private`.
- Deleting a run on Strava un-matches the session instead of leaving a phantom log.
- Revocation arrives as `updates.authorized === 'false'` — the portal learns immediately instead of discovering it on the next failed refresh.
- Full history, not last-100.
- The coaches dashboard can read the table server-to-server (subject to §6).

---

## 5. Phase 2 — the data that makes it a coaching tool

Only viable after Phase 1, because these are per-activity calls.

### 5.1 `GET /activities/{id}` — detail

Returns `laps`, `splits_metric`, `best_efforts`, `calories`, `description`, `perceived_exertion`, `private_note`, `device_name`.

- **Properly fixes the intensity check.** A 6×1km prescription can be verified against actual laps — six reps with recoveries — instead of inferred from an effort-per-km ratio. `classifyExecutedIntensity` becomes a real comparison rather than a heuristic.
- **`best_efforts` gives automatic PB detection** for 400m / 1k / 5k / 10k / half. "You set a 5k PB inside that tempo" is both a retention feature and content.
- **`description` and `private_note`** are where athletes actually write how a session felt — currently invisible to the portal, which asks them to retype it into the RPE/notes form.

Fetch on `aspect_type: 'create'`, one call per activity. At cohort volume that's a rounding error against the daily budget.

### 5.2 `GET /activities/{id}/streams` — heartrate, velocity, cadence, altitude, grade, time

Unlocks the analysis that doesn't exist anywhere in the portal today:

- **Aerobic decoupling** on long runs (first-half vs second-half HR:pace ratio) — the single best marker of whether the aerobic base is actually building.
- **Negative split detection** — did they execute the progression as prescribed.
- **Time in zone** per session.
- **Cadence trend** across a block.

Store the derived metrics, not the raw streams — a stream response is large and the value is in the four or five numbers you compute from it.

### 5.3 `GET /athlete/zones` — requires adding `profile:read_all` to scope

HR zones and run pace zones from the athlete's own Strava, plus `sample_race_pace` (the reference race used to derive pace zones). Combined with 5.2 this gives an honest polarisation check: *prescribed 80% easy, executed 62%*. That's a coaching conversation the portal currently can't start.

Scope change means every athlete re-authorises — worth batching with any other scope change rather than doing twice.

---

## 6. Compliance — resolve before Phase 2

The API agreement states Strava data from a user may only be displayed back to **that user**. The OAuth success page currently says _"Your coach can now view your activity data"_, and there is a coaches dashboard.

Two workable paths:

- **Apply for extended access** and describe the coaching use case explicitly, or
- **Draw the line at the confirmed log.** The athlete's *submitted* portal log is DP's own data — the coach sees that. The raw Strava feed stays athlete-only. In practice this changes very little of what the coach actually needs, and it makes the boundary defensible. It also argues for keeping `strava_activities` athlete-scoped in RLS and having the coaches dashboard read `training_session_logs`, not the Strava table.

Separately: **no training AI/ML models on API data.** Derived per-athlete analysis for that athlete is fine; a model trained across the cohort's Strava data is not.

---

## 7. Phase 3 — features that fall out cheaply

| Feature | Endpoint | Note |
|---|---|---|
| **Shoe mileage nudge** | `GET /gear/{id}` | Activities already carry `gear_id`. Warn at 600–800 km. Genuine injury prevention, and nobody in this space ships it. |
| **YTD / all-time totals** | `GET /athlete/stats` | One call replaces paging activities for the km rings. |
| **Cross-training + gym matching** | already in the payload | The matcher filters `type.indexOf('run')`. `sport_type` covers `WeightTraining`, `Workout`, `Ride`, `Swim` — the same matching logic extends to non-run sessions. Directly relevant to hybrid athletes. |
| **Push strength sessions *to* Strava** | `POST /uploads` | New since May 2026: FIT `set` messages and a JSON upload format carry exercise type, reps, weight, duration. The strength tracker could write gym sessions back to the athlete's Strava. Two-way, and a real differentiator. Needs `activity:write`. |

**Do not build on:** Club Activities / Club Members / Club Admins (retired 1 Sep 2026), or Explore Segments (Extended Access only from the same date).

---

## 8. Suggested order

| | Work | Effort | Unlocks |
|---|---|---|---|
| 1 | §3.1 confirm + fix `suffer_score` | ~1h | Repairs a silently dead feature |
| 2 | §3.6 athlete capacity + subscription check | ~30m | Prevents a mid-block outage |
| 3 | §4 table + webhook + read flip | 1–2 days | Everything below |
| 4 | §6 decide the compliance line | — | Blocks 5 |
| 5 | §5.1 detail: laps, best efforts, PBs | ~1 day | Real session verification + PB cards |
| 6 | §5.2 streams: decoupling, time in zone | ~1–2 days | The coaching layer |
| 7 | §7 shoe mileage, stats, non-run matching | ~half day each | Visible wins, low risk |
| 8 | §3.2 base URL | ~5m | Jan 2027 |

Steps 1 and 2 are worth doing this week regardless of whether the rest goes ahead.

---

## Sources

- [Strava API v3 Reference](https://developers.strava.com/docs/reference/)
- [Strava V3 API Changelog](https://developers.strava.com/docs/changelog/)
- [Webhook Events API](https://developers.strava.com/docs/webhooks/)
- [Rate Limits](https://developers.strava.com/docs/rate-limits/)
- [Strava API Agreement](https://www.strava.com/legal/api)
- [Strava developer program changes, 2026](https://appsforstrava.com/blog/strava-developer-program-changes-2026)
