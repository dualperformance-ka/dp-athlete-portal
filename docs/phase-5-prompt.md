# Phase 5 — From portal to product

You are working in the `dp-athlete-portal` repo. Phases 1-4 are done: instrumentation, the derived
coach cue, IndexedDB queue and Background Sync, Playwright in CI, a build step, and a consolidated
design system.

This phase is different from the previous four. Those were repairs to a thing that existed. These
are new products, each with an external dependency — an app store, a wearable API approval, a second
repo. **Treat each task as independently shippable and do not start one until its dependency is
actually resolved.** If a dependency is not met, say so and move to the next task rather than
building around it.

---

## Non-negotiable repo rules

**1. Versioned asset ritual** — `?v=N` in `index.html` and `APP_SHELL`, bump `CACHE_NAME`, run
`node scripts/check-portal.mjs --update-versions`.

**2. `check-portal.mjs` asserts DOM structure and literal source strings.** Read it before changing
structure. Note that Phase 4 may have modified it during the `08-training.js` split — read the
current version, not the one you remember.

**3. `api/` is at 10 files with a hard ceiling of 12.** This phase legitimately needs new server
capability. Budget those two slots deliberately: prefer actions on `/api/portal-data` and only spend
a slot where a genuinely separate route is required (a wearable OAuth callback is a fair use; a
monthly report generator is not).

**4. Do not touch the reminder scheduler.**

**5. Playwright journeys must stay green.** Native wrapping in particular can break them.

---

## Verification block

```bash
node scripts/check-portal.mjs
node --test
npx playwright test
```

---

## Task 1 — Native shell, iOS and Android

**Decision already made: both platforms, via Capacitor, wrapping the existing PWA.** Do not propose
React Native, Flutter or a rewrite.

**Why this is task 1:** it is also the real fix for the iOS offline problem Phase 3 could only work
around. Background Sync is Chromium-only, so on iPhone the queue currently drains only when the app
is foregrounded. A native shell gets background execution and proper APNs push.

**1a. Scaffold.** Add Capacitor to the repo with `ios` and `android` platforms, pointing its
`webDir` at the built `public/`. Keep the web build as the single source of truth — there must be
no forked native copy of the UI. Add the native projects to `.gitignore` only where the tooling
regenerates them; commit the config.

**1b. Push is the hard part, and it needs a decision from me before you build it.** The portal
currently uses Web Push with VAPID keys, and `api/reminders.js` sends through `web-push`. Native
iOS needs APNs and native Android needs FCM. Those are different transports with different tokens.

**Stop and present me with options before writing any push code.** At minimum cover: running both
transports side by side keyed off which client registered, versus migrating everything to FCM which
can reach all three. Include what happens to the eleven athletes already holding Web Push
subscriptions, and what `push_subscriptions` would need to store. **Do not begin until I choose.**

**1c. Native niceties, only after push is settled:** status bar and splash matching `#070a0d`,
safe-area insets (the portal already uses `viewport-fit=cover`), hardware back button on Android
mapping to the portal's own navigation rather than exiting, and haptics on set completion.

**1d. Store readiness.** Both stores will require a privacy policy URL, data-collection disclosures
and screenshots. Produce the disclosure content from what the app *actually* collects — read the
code, do not guess — and list it for me. Apple in particular will ask about the Strava integration
and health-adjacent data.

**Do not submit anything to either store.** Build, test on a device, and hand me the checklist.

---

## Task 2 — Wearable ingestion

**Dependency: Garmin and COROS API approvals. If they have not come through, skip this task
entirely and tell me.** Do not build against undocumented or scraped endpoints, and do not use an
unofficial library to work around a pending approval.

The goal is calories *out*, so nutrition targets stop being derived from self-reported intake alone.

If approvals are in:

- Follow the existing Strava integration as the pattern — `api/strava.js` and
  `api/_lib/strava-client.js` are well built, with a token store, a webhook path and a cache table.
  Mirror that structure rather than inventing a new one.
- One OAuth callback route may spend a function slot. Consolidate providers behind a single
  `/api/wearables` route with a `?provider=` mode, the way `bookings` and `strava` already use modes.
- **Respect the same data-sharing rule the Strava work established:** an athlete's raw wearable feed
  is shown back to that athlete only. Coaches see the athlete's confirmed portal log, not the raw
  feed. This was a deliberate decision and it holds for every provider.
- Migration for the cache table follows the existing convention. **Write it, show me, do not apply.**

---

## Task 3 — Monthly athlete report

The single best retention artefact available, and the one that most directly proves the service is
worth paying for.

- Generate a per-athlete monthly PDF in the **Carbon Ice light variant** — the same treatment as the
  weekly check-in documents: white paper, black ink, baby blue accent, amber for watch points.
- I already run a Python/Playwright HTML-to-PDF pipeline for these. **Reuse it. Do not build a
  second PDF path in JavaScript, and do not add a PDF library to this repo.** The portal's job is to
  expose the data; the pipeline's job is to render it.
- So: add a `monthly-report-data` action to `/api/portal-data` returning everything a month's report
  needs — sessions planned and completed, volume, distance, PBs, readiness and check-in trends,
  bodyweight, photo references. No new route file.
- Surface the finished report in the portal as a downloadable item in Progress, and send one
  notification when a new one lands, through the existing inbox.

**Content rule:** the report states what happened. It does not congratulate. Numbers, trends, and
the two or three things that changed. The athlete supplies the pride.

---

## Task 4 — Coach weekly review loop

**Dependency: the `dp-coaches-dashboard` repo, which is not connected to this session yet.**

This closes the loop that Phase 2's derived coach cue deliberately left open. The cue is honest
right now precisely because it does not pretend a coach wrote it. This task is what lets a coach
actually write one.

**Do not build the portal side speculatively.** The two sides have to agree on a schema and a
gateway, and guessing the dashboard's half is how you end up with two incompatible implementations.

When the dashboard repo is available, the shape is roughly:

- A coach writes a weekly note and an optional daily cue per athlete in the dashboard
- Stored in Supabase, read by the portal through the existing authenticated
  `COACHES_API_BASE` server gateway — the same server-to-server pattern already used for weekly
  sport targets
- The portal surfaces it in the existing coach-cue slot, which already has the "coach wrote this"
  state built and waiting, avatars and all
- A check-in submitted by an athlete surfaces in the dashboard as something needing a response,
  and the response reaches the athlete through the notification inbox

**For now: read `docs/` in this repo, confirm what the portal already expects from the coaches
gateway, and write me a one-page interface proposal — tables, fields, and the gateway contract.
Nothing more.** I will connect the dashboard repo and we will build both sides together.

---

## Sequencing

1 and 3 are independent and can ship in either order. 2 is gated on approvals that may never arrive.
4 is gated on a repo you cannot see. **Start with 1, and only after I have answered the push
question in 1b.**

## Out of scope

- No store submissions
- No rewrite off Capacitor
- No unofficial wearable APIs
- No second PDF pipeline
- No speculative coach-dashboard code
- No changes to auth, RLS, reminders or the offline queue

## Finish by reporting

- What you built, and what you skipped because its dependency was not met
- The push transport options for 1b, before any push code exists
- The store disclosure list derived from actual code, not assumption
- The coaches-gateway interface proposal
- Verification output, including Playwright still green after native wrapping
