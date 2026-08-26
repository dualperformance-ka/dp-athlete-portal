# Phase 3 — Make it trustworthy offline

You are working in the `dp-athlete-portal` repo. Phases 1 and 2 are done and on main: Sentry,
Vercel Analytics, CI, the derived coach cue, home-screen nudge priority, contact/export, streak and
PB toast. Baseline is **439 tests passing** and `10 functions, 17 shell assets`.

This is the phase where "PWA" becomes "app you can rely on at the gym". Read the whole brief, work
the tasks in order, one commit per task, verification block after each.

---

## Non-negotiable repo rules

**1. Versioned asset ritual.** Editing any `public/js/*.js`, `styles.css`, `desktop.css`,
`icons.css`, `login.js`, `accessibility.js`:

- bump `?v=N` in `public/index.html`
- bump the identical `?v=N` in `APP_SHELL` in `public/sw.js`
- bump `CACHE_NAME` in `public/sw.js`
- run `node scripts/check-portal.mjs --update-versions`

**2. `check-portal.mjs` asserts DOM and source strings.** It requires `#goalsBanner` inside
`.top-shell-priority.week-card` before `#tab-training`, specific ids for volume strips and photo
controls, the Progress card ordering, and literal marker strings inside `js/08-training.js` and
`js/06-nutrition.js`. Read the script before you change structure.

**3. `api/` is at 10 files, hard ceiling 12.** New server behaviour goes in as an action on
`/api/portal-data` (`api/write.js`, `dispatch()`).

**4. Do not touch the reminder scheduler.** `pg_cron` polls it every minute and it works.

**5. Do not reformat or rename.** Many tests assert against source text.

---

## Verification block

```bash
node scripts/check-portal.mjs
node --test
node scripts/check-portal.mjs --update-versions   # only if you touched a versioned asset
```

Baseline: `# pass 439  # fail 0`. Test count only goes up.

---

## Task 1 — Move the offline queue to IndexedDB

**The problem.** `dp_pending_writes_<code>` lives in `localStorage`, which is synchronous, capped
around 5MB, and shared with the run-library cache, drafts, exercise picks and photo state. A failed
write there is silent. For a queue holding an athlete's actual training data, that is the wrong
store.

**Build it:**

- A small IndexedDB wrapper in `public/js/01-core.js` — one store for queued writes, keyed by the
  existing client write id. No library, no npm dependency, plain `indexedDB` with promises.
- Rewrite `readPendingCoachWrites` / `persistPendingCoachWrites` / `queueCoachWrite` /
  `retryPendingCoachWrites` against it. **Keep the function signatures and the existing
  `_unknown` bucket re-homing logic exactly as they are** — that logic handles writes queued before
  an athlete code is known and it is correct.
- **One-time migration on first load:** read any existing `dp_pending_writes_*` keys from
  `localStorage`, move them into IndexedDB, then remove the localStorage keys. This must be
  idempotent and must never drop a write. If IndexedDB is unavailable (private browsing, quota),
  fall back to the current localStorage path rather than failing.
- Move the run-library cache (`dp_run_library_cache_v3`) too — it is the largest single consumer of
  the localStorage budget.

**Tests** — `tests/offline-queue.test.js`. Cover the migration path with pre-seeded localStorage
data, idempotency on a second run, the `_unknown` re-homing, and the fallback when IndexedDB throws.
Use a fake IndexedDB shim or inject the store — do not require a real browser.

---

## Task 2 — Background Sync, with honest expectations

**Read this before you build it.** Background Sync (`SyncManager`) is Chromium-only. Safari and
iOS **do not support it**. A large share of the athletes on this portal are on iPhones, so this task
does not solve the offline problem on the platform that matters most. Build it anyway for
Android and desktop Chrome, but the iOS answer is task 2c, and the real iOS fix is the native shell
in Phase 5.

**2a. Service worker sync listener.** Add a `sync` event listener in `public/sw.js` for tag
`dp-flush-queue`. Register it from the page whenever a write is queued.

**The auth problem, and how to solve it.** The service worker cannot read `localStorage` and has no
session token, so it cannot call `/api/ingest` on its own. Write the current bearer token into the
same IndexedDB database on login and on renewal, and have the sync handler read it from there.

Note explicitly: the token is already stored in `localStorage` today, so moving a copy to IndexedDB
is not a meaningful change in exposure. Do **not** invent a new long-lived credential, do not extend
any token's TTL, and clear the IndexedDB copy on logout in the same place `dp_auth_code` and
`dp_legacy_session` are cleared. If the token is expired when sync fires, let the request fail and
leave the queue intact — it will flush on next open.

**2b. Periodic Background Sync** where available (`periodicsync`, also Chromium-only), at a
conservative interval. Guard on permission; never assume it exists.

**2c. The iOS path — flush aggressively in the foreground.** This is the part that actually helps
most of your athletes:

- Flush on `visibilitychange` when the document becomes visible
- Flush on service worker `activate`
- Flush on `pageshow` including from bfcache
- Keep the existing `online` listener

**2d. Make the pending state loud.** Right now a queued write shows only as a subtle sync pill. Add
an explicit, visible indicator when the queue is non-empty: "2 logs waiting to send", tappable to
retry now. An athlete must never believe their session is with you when it is sitting on their phone.

**Analytics:** `track('queue_pending_shown', {count})`, `track('queue_flush_manual')`, and extend
the existing `offline_queue_flushed` with `{trigger: 'sync'|'visibility'|'online'|'manual'}`.

---

## Task 3 — Playwright journeys in CI

**Why this is here and not later:** Phase 4 rewrites the CSS cascade and splits the largest file in
the codebase. The existing tests assert against source *text*, so they will happily stay green
through a refactor that visually breaks the app. These journeys are the safety net that makes
Phase 4 possible. Do not skip or defer this.

**Setup.** Add `@playwright/test` as a dev dependency. The environment has Chromium preinstalled at
`/opt/pw-browsers` with `PLAYWRIGHT_BROWSERS_PATH` already set — **do not run
`playwright install`**, and if a version mismatch appears, launch with
`executablePath: '/opt/pw-browsers/chromium'` rather than downloading.

**Test against a static server with the API mocked.** Serve `public/` and intercept every
`/api/*` call with `page.route()`, returning fixtures. This keeps CI deterministic, needs no
secrets, no database and no deploy. Do not point these tests at production or a preview URL.

**Journeys — six, no more:**

1. **Code login** → portal renders, today's session visible
2. **Email OTP login** → mocked eligibility + verify, lands on the same portal state
3. **Log a strength session** → enter three sets, submit, values persist across reload
4. **Body check-in** → open quick log, submit, dock button changes state
5. **Offline → online** → go offline mid-submit, confirm the pending indicator appears, come back
   online, confirm the queue drains and the indicator clears
6. **Coach cue states** → with a session override note, the K/A avatars and "Coach cue for today"
   appear; without one, "Today's focus" renders and the avatars do not

Journey 6 exists because it is the one thing in Phase 2 that a text-matching test cannot protect.

**CI.** Extend `.github/workflows/ci.yml` with a second job that runs the Playwright suite after the
existing checks. Keep the existing job untouched and green.

---

## Task 4 — A build step

**Goal:** cut the ~250KB gzipped first load. Nothing is minified today because there is no build at
all.

**The constraint that dictates the design.** `check-portal.mjs` asserts that every `?v=`-referenced
file exists in `public/` and that its SHA matches `scripts/asset-versions.json`. If a build emits
minified files into the repo, every build churns those hashes and the check becomes noise.

**So: minify in place at Vercel build time only, and never commit the output.**

- Add `esbuild` as a dev dependency and a `"buildCommand"` to `vercel.json` that minifies
  `public/js/*.js`, `public/*.js` and the CSS into the same paths in the build output.
- Source files in git stay readable and unminified. `?v=` values and SHAs keep tracking source.
- CI runs `check-portal.mjs` on source, **before** any build. Confirm this ordering holds.
- Do not change filenames, paths or load order. `10-boot.js` must still run last.
- Verify a preview deploy serves minified assets and the portal works identically, including the
  service worker install.

**Then inline the login CSS.** The login screen needs a fraction of the 68KB gzipped stylesheet.
Extract just what `#loginScreen` requires into an inline `<style>` in `<head>` and load
`styles.css` non-render-blocking. Measure before and after; report both numbers.

**Do not** attempt tree-shaking, bundling into one file, or converting to ES modules. Minification
plus critical CSS is the whole scope.

---

## Task 5 — Finish the email migration

**Current state, from the live roster** — 11 active athletes:

| auth_mode | count | has email | OTP-linked |
|---|---|---|---|
| `both` | 8 | 8 | 3 |
| `code` | 3 | 0 | 0 |

So five athletes can use email but haven't yet, and three have no email on file at all.

**Portal-side work only. Do not change any athlete's `auth_mode` or add emails — that is roster
data and it is mine to edit.**

- Make email the visible default on the login screen for anyone who has used it before, with the
  access code demoted to a clearly secondary "Use athlete access code" link. The toggle exists
  already; this is about which one leads.
- For an athlete who signs in with a code but whose roster row has `auth_mode: both` and an email,
  show a one-time, dismissible prompt after login: "Sign in with your email next time" with a
  single button that starts the OTP flow. Never block, never nag more than once.
- Add `track('email_upgrade_prompt_shown')` and `track('email_upgrade_accepted')`.
- Leave the `?code=` link path working. Three athletes still depend on it.

**Report back** the list of athlete codes still on `auth_mode: code` so I can collect their emails.

---

## Out of scope

- No CSS, design token, type scale or colour work — Phase 4
- No `08-training.js` split — Phase 4
- No native shell — Phase 5
- No coaches-dashboard work
- No changes to auth logic, RLS, Strava or reminders
- No new npm dependencies beyond `esbuild` and `@playwright/test`, both dev-only

## Finish by reporting

- Files changed per task
- Final `?v=` numbers and `CACHE_NAME`
- Check + test output with the new counts, and the Playwright run
- Before/after gzipped weight of the first load
- Which of the six journeys, if any, you had to weaken to get passing — and why
- Anything in this brief that turned out to be wrong about the code. The brief loses.
