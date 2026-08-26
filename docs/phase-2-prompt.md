# Phase 2 — Make it feel coached

You are working in the `dp-athlete-portal` repo. Phase 1 (Sentry, Vercel Analytics, CI,
read-on-tap, one-liners) is done and on main. Read this whole brief before touching anything,
then work the tasks in order. One commit per task. Run the verification block after every one.

This phase is **portal-only**. Nothing here touches the coaches dashboard repo.

---

## Non-negotiable repo rules

`scripts/check-portal.mjs` enforces these and CI will fail on any violation.

**1. Versioned assets have a three-step ritual.** Editing any of `public/js/*.js`, `styles.css`,
`desktop.css`, `icons.css`, `login.js`, `accessibility.js` means:

- bump `?v=N` in `public/index.html`
- bump the identical `?v=N` in `APP_SHELL` in `public/sw.js`
- bump `CACHE_NAME` in `public/sw.js` (currently `dp-athlete-v162`)
- run `node scripts/check-portal.mjs --update-versions`

**2. `check-portal.mjs` asserts the home-screen DOM layout.** This one will bite you on Task 2.
It requires `#goalsBanner` to appear **inside** `.top-shell-priority.week-card` and **before**
`#tab-training` in `index.html`. It also asserts the presence of `#trainingVolumeStrip`,
`#weeklyVolumeStrip`, the Progress card ordering, and several photo control ids. Do not restructure
that markup. Where this brief asks for reordering, do it in **JavaScript at runtime**, not by moving
DOM nodes in the HTML source.

**3. `api/` is at 10 files with a hard ceiling of 12.** Do not add API route files. New server
behaviour goes in as an **action on the existing `/api/portal-data`** route (`api/write.js`,
dispatched in the `dispatch()` function around line 671).

**4. Do not touch the reminder scheduler.** `api/reminders.js` is polled every minute by Supabase
`pg_cron` and works. Leave `minuteMatches()`, `MORNING_HOUR`, `LOGGING_HOUR` and the cron config alone.

**5. Third-party and network failures must never block the UI.** Everything degrades quietly.

**6. Don't reformat, rename, or tidy.** 31 of 40 test files assert against source code as *text*.

**7. Add tests for new pure functions.** The repo convention is a file per concern in `tests/`,
using `node:test` and `node:assert/strict`. Tasks 1 and 4 create pure functions — they get real
behavioural tests, not source-text assertions.

---

## Verification block

```bash
node scripts/check-portal.mjs
node --test
node scripts/check-portal.mjs --update-versions   # only if you touched a versioned asset
```

Baseline before you start: `10 functions, 17 shell assets` and `# pass 352  # fail 0`.
The test count should only ever go **up**.

---

## Task 1 — An honest coach cue

**The problem.** `renderCoachMoment()` in `public/js/08-training.js` (~line 931) renders a card
headed "Coach cue for today" with Karl and Alex's initials next to it. The text defaults to a
hardcoded string — *"Keep today simple: hit the intended effort and leave enough in the tank to
train well again."* — and is only replaced when a coach happens to have written a note on a session
override. For most athletes on most days it is the same sentence forever, presented as if a human
wrote it that morning.

**The decision (already made, do not revisit).** We are **not** building a coach-authoring surface.
The cue becomes derived from data the portal already holds, and it stops pretending to be human.

**Two distinct states:**

| Condition | Label | Avatars | Content |
|---|---|---|---|
| A coach override note exists for a session today | `Coach cue for today` | Yes, K/A | The note, verbatim, escaped |
| No coach note | `Today's focus` | **No** | Derived text, visually quieter |

The avatars are the signal that a human wrote it. They must never appear on generated text. Never
generate anything in a coach's voice — no "Karl says", no first-person plural coaching.

**Build `deriveTodayFocus(ctx)` as a pure function** in `08-training.js`, taking a plain context
object and returning a string. Pure means: no DOM, no globals, no `Date.now()` inside it — pass
the date in. This is what makes it testable.

Context available from the existing call site (`renderTodayView`, which already computes
`insights` and `todaySessions`): today's session names and types, `insights.planned`,
`insights.completed`, `insights.compliance`, `insights.readiness`, `insights.kmDone`,
`insights.kmTarget`, the current programme week, and recent logged session dates from `logs`.

**Derivation rules, evaluated in priority order — first match wins:**

1. No session today → recovery framing, point at what's next
2. Readiness logged and low (< 40) → today's target is completion, not intensity
3. Third-or-more consecutive training day → quality over volume, protect the next key session
4. Session is a key/interval/long run → the specific intent of that session type
5. Behind the weekly km target with ≤ 2 days left → what closing the gap looks like
6. Week already complete → consolidation framing
7. First session of the programme week → set the tone for the week
8. Fallback → a plain, non-coachy statement of what today is

Write these as short, direct, factual sentences. No hype, no exclamation marks, no "let's crush it".
The tone target is a training log entry, not a motivational poster. If a rule can't be evaluated
because the data is missing, skip to the next rule rather than guessing.

**Tests** — new file `tests/coach-cue.test.js`. Cover: each rule fires on its own inputs; priority
order holds when two rules could match; missing data falls through cleanly; the function never
returns an empty string; and the output never contains a coach name.

**Analytics:** fire `track('coach_cue_shown', {source: 'coach'|'derived'})` once per render.

---

## Task 2 — One nudge, not five

**The problem.** `.top-shell-priority.week-card` in `index.html` can stack five things above
today's session: `#strava-ack-banner`, `#goalsBanner`, `#callNudge`, `#checkinNudge`,
`#callConfirmedNudge`, `#photoNudge`. On a first login an athlete's opening impression of a premium
product is five things you want *from them* before one thing you're giving them.

**Constraint (repo rule 2):** you may not move these nodes in the HTML. `check-portal.mjs` asserts
`#goalsBanner`'s position and will fail. Do this entirely in `public/js/03-nav-nudges.js`.

**Behaviour.** After the existing nudge visibility logic has run, apply a priority pass:

- Show **at most one** due nudge in place, chosen by this order:
  `goalsBanner` → `checkinNudge` → `callNudge` → `photoNudge`
- Collapse every other *due* nudge into a single summary row: "2 more things this week ›",
  which expands in place to reveal them. Collapsed state is the default on every load.
- `#callConfirmedNudge` is a **done** state, not a demand — it is not part of the priority stack
  and should render below the summary row, or be left where it is.
- `#strava-ack-banner` is a one-off confirmation — leave its behaviour alone.
- When only one nudge is due, show it with no summary row at all.
- When nothing is due, the whole card hides, as it does today.

Use the existing `.is-due` / `.is-done` class conventions. Add CSS to `styles.css` for the summary
row only — no other visual changes in this phase.

**Verify by hand:** on a 390px viewport with all nudges due, today's session card must be reachable
without scrolling past more than one call to action.

**Analytics:** `track('nudge_summary_expanded', {hidden: n})`.

---

## Task 3 — Contact, data rights, and a private line to you

**3a. Fix the addresses.** Four Discord links in `index.html`:

| Line | Current | Change to |
|---|---|---|
| ~153 | "Message Coach" on the login/paused screen | Opens the note composer (3c) |
| ~1158 | Floating action button | Opens the note composer (3c) |
| ~1174 | "Join the Discord" in the Contact tab | **Leave as-is.** Discord stays the community channel. |
| ~1226 | "Request account deletion" | `mailto:privacy@dualperformance.au` |

Also add `support@dualperformance.au` as a visible support contact in the Contact tab, alongside
the Discord link rather than replacing it.

**3b. Server-side data export.** `exportAthleteData()` in `03-nav-nudges.js` currently serialises
`localStorage` and calls it the athlete's data. It isn't — it's a partial device mirror.

Add an `export-data` action to `api/write.js` (via `dispatch()`, **not** a new route file) that
returns everything held for the authenticated athlete code: profile, goals, body logs, nutrition
logs, session logs, weekly check-ins, progress photo references. Derive the code from the session
as every other action does; never accept a code from the client. Have the client call it and save
the response as JSON, falling back to the current local export if the request fails.

**3c. Private note to coach.** A small composer, not a messaging system. Rationale: Discord covers
community and general questions, but an athlete will not post "I'm injured" or "I'm thinking of
quitting" in a group channel, and those are the messages worth catching.

- Add a `contact-coach` action to `api/write.js`. Again: no new route file.
- Create a Supabase table via a migration in `supabase/migrations/` following the existing
  `YYYYMMDDHHMMSS_description.sql` convention: athlete code, body, created_at, read_at. RLS enabled
  with **no policies**, matching every other table in this project — server-only access via the
  service role. **Write the migration, show me the SQL, do not apply it.**
- The message always persists to the table first. Notification is best-effort on top.
- For the notification: `GHL_API_TOKEN` and `GHL_LOCATION_ID` already exist in env, and GHL already
  sends from `mail.dualperformance.au`. Try that route first. **If GHL's scopes don't permit
  transactional email, stop and tell me — do not add a new email vendor or npm dependency on your
  own initiative.**
- Client side: a plain modal with a textarea, a character limit, the existing draft-save pattern,
  and clear confirmation that it sent. Escape on render. Rate-limit to a sensible number per day
  server-side.

**Analytics:** `track('contact_opened')`, `track('contact_message_sent')`, `track('export_requested')`.

---

## Task 4 — Mark the consistency

Scoped down from the original audit item. PB detection already exists and is good — load, rep,
e1RM and volume PBs, rep caps, assisted-machine exclusion, first-log seeding, live inline badges.
Do **not** rebuild any of it.

**4a. Name the lifts in the PB toast.** `09-logging.js` line ~934 currently shows
`"3 new PBs!"`. `pbHits` already carries `exercise`, `badge`, `value`, `unit` and `delta` for each
hit. Use them: name the lift and the delta for one or two PBs, and fall back to the count above
that. This is the best moment in the app and it's currently thrown away.

**4b. Add a streak.** There is no streak anywhere in the codebase. Define it as **consecutive weeks
containing at least one logged session** — weeks, not days, because the programme is 8-9 sessions a
week and a day-streak would punish planned rest.

Write `computeLoggingStreak(sessionDates, today)` as a pure function in `01-core.js`. It takes an
array of ISO dates and returns a week count. Week boundaries must match the portal's existing
Monday-start convention — find it in the code, don't invent one. The current week counts as live if
it already has a logged session, and must not break the streak before it has ended.

Surface it on the hero next to the week number, only when the streak is 2 or more. One line, no
flame emoji, no animation.

**Tests** — new file `tests/streak.test.js`. Cover: zero and one-session cases; a clean multi-week
run; a gap week breaking it; the current week not yet logged leaving the prior streak intact; week
boundaries at year end.

**Analytics:** `track('streak_shown', {weeks: n})`.

---

## Out of scope for this phase

- No coaches-dashboard work
- No new API route files
- No design system, CSS token, type scale or colour work — that's Phase 4
- No changes to the weekly check-in. It is already five steps with draft-save, and the testimonial
  field stays by the owner's decision
- No refactoring of `08-training.js`
- No changes to auth, RLS, Strava, or reminders
- No new npm dependencies

## Finish by reporting

- Files changed, grouped by task
- Final `?v=` numbers and the new `CACHE_NAME`
- Check + test output, with the new test count
- The `contact_messages` migration SQL, unapplied, for me to review
- Anything in this brief that turned out to be wrong about the code — the brief loses, tell me
  plainly rather than working around it
