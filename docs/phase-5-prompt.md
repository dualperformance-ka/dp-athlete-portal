# Phase 5 — From portal to product (revised)

You are working in the `dp-athlete-portal` repo. Phases 1-4 are done: instrumentation, the derived
coach cue, IndexedDB queue and service-worker sync, Playwright in CI, an esbuild build step, and a
consolidated design system (one `:root`, no Barlow, nothing below 12px).

**This revision supersedes the earlier Phase 5 brief.** Two things changed: the wearable APIs have
not been applied for yet, and the Vercel plan is now Pro.

Work the tasks in order. One commit per task. Verification block after each.

---

## Repo rules

**1. Versioned asset ritual** — `?v=N` in `index.html`, the same in `APP_SHELL` in `sw.js`, bump
`CACHE_NAME`, then `node scripts/check-portal.mjs --update-versions`.

**2. `check-portal.mjs` asserts DOM structure and literal source strings.** Phase 4 modified it
during the `08-training.js` split. **Read the current version before changing structure.**

**3. There is a self-imposed budget of 24 API functions, currently at 10.** Vercel Pro has no
platform cap; the budget is deliberate and enforced in two places (`scripts/check-portal.mjs` and
`tests/strava.test.js`). The repo convention still stands: prefer a `?mode=` branch or an
`/api/portal-data` action over a new function file.

**4. Do not touch the reminder scheduler.** `pg_cron` polls it every minute.

**5. Playwright must stay green.** Native wrapping in particular can break it.

**6. Do not reformat or rename.** Many tests assert against source text.

---

## Verification block

```bash
node scripts/check-portal.mjs
node --test
npx playwright test
```

Baseline: `# pass 469`, **none failing**. The test count only goes up.

---

## Task 0 — Housekeeping · ALREADY DONE

**Do not redo this.** It was completed on 27 Aug 2026. Recorded here so you know the current state.

- `tests/interval-rest-parser.test.js` built its root path from `new URL(...).pathname` without
  decoding, so a checkout path containing a space arrived as `%20` and `readFileSync` threw. Now
  wrapped in `decodeURIComponent()`, matching `scripts/check-portal.mjs`.
  *(An earlier draft of this brief claimed four test files had this bug. Only one did —
  `female-priority`, `notification-inbox` and `strava` pass URL objects directly to `readFileSync`
  or use `fileURLToPath()`, both of which handle spaces correctly.)*
- The 12-function cap was enforced in **two** places: `scripts/check-portal.mjs` and a test in
  `tests/strava.test.js`. Both now use `API_FUNCTION_BUDGET = 24`, with comments stating this is a
  self-imposed budget rather than a Vercel Pro limit, and that the convention is still to add a
  `?mode=` branch or an `/api/portal-data` action rather than a new function file.

**Current baseline: 469 tests passing, none failing, `check-portal.mjs` clean at 10 functions.**

If you add a route in this phase and cross 24, raise the budget in **both** places deliberately and
say so in your report — do not silently bump it.

---

## Task 1 — The monthly report · START HERE

**Do this before the native app.** It has no external dependency, no account, no review queue, and
it is the item most directly tied to renewal. The native track is gated on Apple enrolment, which
has lead time — so this is what gets built while that processes.

**1a. Server.** Add a `monthly-report-data` action to `/api/portal-data` (`api/write.js`,
`dispatch()`). Now that the ceiling is raised you *could* add a route file; don't. This is a read
that belongs with the other reads.

It takes a month and returns everything a report needs for the authenticated athlete: sessions
planned and completed, strength volume, distance planned vs actual by week, PBs achieved in the
period, readiness and check-in trends, bodyweight trend, and progress photo references. Derive the
athlete code from the session as every other action does. Never accept a code from the client.

**1b. Do not build a PDF renderer here.** Karl runs a Python and Playwright HTML-to-PDF pipeline for
the Carbon Ice check-in documents. That pipeline renders the report. **Do not add a PDF library to
this repo, do not build a second renderer in JavaScript.** Your job ends at the data plus a
documented JSON shape the pipeline can consume. Write that shape into `docs/`.

**1c. Surface it.** Add finished reports to the Progress tab as downloadable items, and send one
notification through the existing inbox when a new one lands. Reuse the notification path from
`api/reminders.js` — do not invent a second one.

**Content rule, and hold to it:** the report states what happened. It does not congratulate. Numbers,
trends, and the two or three things that changed. If you find yourself generating praise strings,
stop — that is the coach cue mistake from Phase 2 in a new costume.

**Analytics:** `track('monthly_report_opened')`, `track('monthly_report_downloaded')`.

---

## Task 2 — Native shell

**Gated on Karl completing Apple Developer enrolment. If he has not confirmed that, say so and stay
on Task 1.**

Decision already made: **Capacitor, wrapping the existing PWA, both platforms built, iOS shipped
first, Android submission held.** Do not propose React Native, Flutter, or a rewrite.

**2a. Scaffold.** Add Capacitor with `ios` and `android` platforms, `webDir` pointing at the esbuild
output from `scripts/build-vercel.mjs`. The web build stays the single source of truth — there must
be no forked native copy of the UI. Commit the Capacitor config; gitignore only what the tooling
regenerates.

**2b. Push — the decision is made, implement it as specified.**

All ten live subscriptions are on `web.push.apple.com`. Do **not** migrate to FCM. Run both
transports side by side:

- `api/reminders.js` keeps its existing `web-push` path completely untouched for PWA clients
- Add an APNs path for native iOS clients
- `push_subscriptions` gains a transport/platform column so delivery is keyed on how each client
  registered. Migration follows the existing convention — **write it, show Karl, do not apply**
- An athlete who installs the native app registers on the new transport; their old row is retired
  only once the new one is confirmed working. Never leave an athlete with zero live subscriptions
  mid-transition
- Web Push is retired only when the table says nobody is on it

**2c. Native polish**, after push works: status bar and splash on `#070a0d`, safe-area insets (the
portal already sets `viewport-fit=cover`), Android hardware back mapped to the portal's own
navigation rather than exiting the app, and haptics on set completion.

**2d. Store readiness.** Produce the data-collection disclosure **by reading the code**, not by
guessing. It must cover Strava, Cloudinary, Supabase and Sentry. List what is collected, why, and
where it goes, and hand it to Karl. Apple will ask about the Strava integration specifically.

**Do not submit to either store.** Build, verify on a device, hand over the checklist.

**Android:** build the project so no migration is needed later, but do not prepare a Play Store
submission. Zero athletes are on Android, and Google's 12-tester / 14-day closed-test requirement
for new accounts is two weeks of work for no users.

---

## Task 3 — Wearables

**Blocked. Karl has not submitted the Garmin or COROS applications yet.**

Do not start this. Do not scaffold "ready for later" code. Do not build against undocumented or
scraped endpoints, and do not use an unofficial library to work around a pending approval — that is
how the integration gets refused permanently.

When approval lands, the pattern is `api/strava.js` and `api/_lib/strava-client.js`: token store,
webhook path, cache table. Mirror it. And the Strava data rule holds for every provider — **an
athlete's raw wearable feed is shown back to that athlete only; coaches see the confirmed portal
log, not the raw feed.**

---

## Task 4 — Coach review loop

**Blocked on the `dp-coaches-dashboard` repo, which is not connected to this session.**

Do not build the portal half speculatively. The two sides must agree on a schema and a gateway, and
guessing produces two implementations that disagree.

**What you may do now:** read `docs/` in this repo, establish exactly what the portal already expects
from the coaches gateway (the weekly sport targets flow through `COACHES_API_BASE` is the existing
server-to-server precedent), and write a one-page interface proposal — tables, fields, gateway
contract, and how a coach-authored cue would reach the slot the Phase 2 work already built and left
waiting. **Proposal only. No implementation.**

---

## Out of scope

- No store submissions
- No rewrite off Capacitor
- No unofficial or undocumented wearable APIs
- No second PDF pipeline, no PDF library in this repo
- No speculative coach-dashboard code
- No changes to auth, RLS, reminders or the offline queue
- No new npm dependencies beyond Capacitor and its platform packages

## Finish by reporting

- What you built, and what you skipped because its dependency was unmet
- The `push_subscriptions` transport migration SQL, unapplied
- The JSON shape for the report pipeline, written into `docs/`
- The store disclosure list, derived from actual code
- The coaches-gateway interface proposal
- Verification output — all 466+ passing with none failing, and Playwright still green after any
  native wrapping
- Anything in this brief that turned out to be wrong about the code. The brief loses.
