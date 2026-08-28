# Standalone — Align the portal with the public support page

You are working in the `dp-athlete-portal` repo. This is a small, self-contained piece of work that
ships on its own, **before** the Phase 5 native shell and before the Garmin and COROS API
applications are submitted.

Baseline: **469 tests passing, none failing**, `check-portal.mjs` clean at 10 functions.

---

## Why this exists

`https://dualperformance.au/support` is live and public. It is what Garmin, COROS and Strava
reviewers read, and what both app stores will require as a support URL. It currently makes three
promises the portal does not keep:

| The support page states | The portal actually does |
|---|---|
| Account deletion goes to `delete@dualperformance.au` | Sends to `privacy@dualperformance.au` |
| Wearable data deletion goes to `data@dualperformance.au` | No path exists |
| "Users may delete via the Athlete Portal's account-deletion option" | A `mailto:` link, not an option |

A reviewer who reads that page and then opens the portal finds a described flow that does not exist.
That is a common reason wearable API applications stall. Fix it before submitting, not after.

**The governing principle: information lives on the public support page, actions live in the
portal.** Do not copy the support page's policy text into the portal — duplicated policy drifts, and
it has already drifted once. The portal links out to it and implements the controls it describes.

---

## Repo rules

**1. Versioned asset ritual** — editing any `public/js/*.js`, `styles.css`, `desktop.css`,
`icons.css`, `login.js`, `accessibility.js` means: bump `?v=N` in `index.html`, bump the identical
`?v=N` in `APP_SHELL` in `sw.js`, bump `CACHE_NAME`, then
`node scripts/check-portal.mjs --update-versions`.

**2. `check-portal.mjs` asserts DOM structure and literal source strings.** Read it before changing
markup.

**3. Self-imposed budget of 24 API functions, currently 10.** Prefer an action on
`/api/portal-data` (`api/write.js`, `dispatch()`) over a new route file.

**4. Do not touch the reminder scheduler.**

**5. Do not reformat or rename.** Many tests assert against source text.

---

## Verification block

```bash
node scripts/check-portal.mjs
node --test
npx playwright test
```

---

## Task 1 — Make the addresses match

Currently in `public/index.html`:

- line ~1250: account deletion points at `privacy@dualperformance.au` → change to
  `delete@dualperformance.au`
- line ~1198: Contact tab shows `support@dualperformance.au` → correct, leave it
- line ~158: the paused-access screen uses `support@dualperformance.au` → correct, leave it

`privacy@` remains the right address for general privacy enquiries; it is specifically **account
deletion** that the support page routes to `delete@`. Do not consolidate them — the separation is
deliberate and the wearable reviewers look for a dedicated data contact.

Add a **"Support and data" link to `https://dualperformance.au/support`** in two places: the Contact
tab, beneath the existing support email, and the Preferences modal's data-controls block. External
link, `rel="noopener"`, opens in a new tab.

---

## Task 2 — Make the in-portal deletion option real

This is the task that makes the support page's sentence true.

**Server.** Add a `data-request` action to `/api/portal-data` (`api/write.js`, `dispatch()`).
**Model it directly on the existing `contactCoach()` function** — it already has the right shape:
derive the code from the session, validate, rate-limit server-side, persist first, notify
best-effort. Do not invent a second pattern.

It takes a `kind` of `account_deletion` or `wearable_deletion` and an optional note.

**Table.** A migration in `supabase/migrations/` following the `YYYYMMDDHHMMSS_description.sql`
convention, creating `data_requests`: id, athlete_code, kind, note, requested_at, acknowledged_at,
completed_at. RLS enabled with **no policies**, matching every other table in this project —
server-only access through the service role. **Write it, show me the SQL, do not apply it.**

**Why the timestamps matter, and do not drop them:** the support page commits to completing verified
deletion requests within 30 days. Right now a request arrives as an email in an inbox and there is no
record of when it came in, so that commitment cannot be demonstrated to a reviewer or a regulator.
`requested_at` and `completed_at` are the evidence. Build them in from the start.

**Client.** Replace the `mailto:` in the Preferences data-controls block with a real control:

- A confirmation step — deletion is destructive and must not be one tap
- Plain copy stating what happens: the request is logged, Karl is notified, and it is actioned
  within 30 days, with a link to the support page for the full policy
- Clear confirmation once submitted, and a visible "request received on <date>" state afterwards so
  the athlete is not left wondering
- Do not delete anything client-side. This raises a request; a human actions it.

**Notification.** Reuse whatever transport `contactCoach()` settled on. Send to
`delete@dualperformance.au`. If that function's notification path is unavailable, the request must
still persist — never lose it because an email failed.

---

## Task 3 — Wearable data deletion and disconnect

**3a.** Add a wearable data-deletion action using the same `data-request` endpoint with
`kind: 'wearable_deletion'`, notifying `data@dualperformance.au`. Surface it in Preferences near the
Strava controls, not buried in the account-deletion flow — they are different requests with
different scopes, and the support page treats them separately.

**3b. Verify the existing Strava disconnect actually works end to end.** `disconnectStrava()` in
`public/js/10-boot.js` calls `/api/strava-disconnect`. A reviewer will test this. Confirm that after
disconnecting: the token is revoked at Strava's end, the local token store is cleared, cached
activities are handled per the data rule, and the UI returns to a connectable state. **If any part
of that is incomplete, report it rather than patching around it** — Strava's API agreement is strict
about disconnect and this is exactly what gets checked.

**3c.** Confirm the portal still honours the established rule: an athlete's raw wearable feed is
shown back to that athlete only; coaches see the confirmed portal log, not the raw feed. Do not
change this, just confirm it and say so in your report.

---

## Task 4 — Read the support page and check every claim

Fetch `https://dualperformance.au/support` and go through it line by line against the portal.

For every statement the page makes about what an athlete can do in the portal, or about how data is
handled, confirm the portal matches. **Report any remaining mismatch as a list — do not silently fix
copy on the public page, which lives in a different system and is not yours to edit.**

Pay particular attention to the "Connect Your Wearable", "Disconnect or Delete" and "How We Handle
Your Data" sections, since those are the ones the Garmin and COROS reviewers assess.

---

## Tests

Add `tests/data-rights.test.js`. Cover: `data-request` rejects an unauthenticated call; it derives
the athlete code from the session and ignores any client-supplied code; both `kind` values validate
and an unknown kind is rejected; the rate limit fires; the row persists even when notification
throws. Follow the existing `contact-coach.test.js` structure.

---

## Out of scope

- No copying support page policy text into the portal
- No editing the public support page — it lives elsewhere
- No native shell, no wearable API integration work, no monthly report
- No changes to auth, RLS on existing tables, reminders or the offline queue
- No new npm dependencies

## Finish by reporting

- Files changed
- Final `?v=` numbers and `CACHE_NAME`
- The `data_requests` migration SQL, unapplied
- The Task 4 mismatch list — every remaining discrepancy between the support page and the portal
- Your findings from 3b on the Strava disconnect, honestly, including anything incomplete
- Verification output, all green
