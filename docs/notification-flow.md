# Athlete notification flow — redesign

Status: proposal. Section 8 is already shipped.
Written 20 Aug 2026, against the live portal and Supabase data.

---

## 1. What's actually wrong

Not opinions — this is what the production data says.

### Every reminder fires once per stale endpoint

36 subscription rows across 10 athletes. All iOS. None had gone stale.

| Athlete | Rows | Physical devices |
|---|---|---|
| KARL | 13 | 1 iPhone |
| NATE | 4 | 1 iPhone |
| ALEX, JACOB, KHANG | 3 each | 1 iPhone each |
| ALVIN, JOJO, THOMAS | 2 each | 1 iPhone each |

Every row carried the *same* user agent. One handset, thirteen endpoints. Each
reinstall of the home-screen app, each re-granted permission and each Safari
point release mints a new endpoint; the old row only dies when Apple returns
404/410, and Apple wasn't returning it. iOS collapses the *banner* by `tag`, so
athletes saw one notification — and felt three to thirteen buzzes.

Worse, `last_sent` lives per row. A freshly minted endpoint starts at `{}` and
replays whatever the athlete already saw that morning.

### Athletes are already muting

Two of ten have started switching categories off on their current device:

- **JOJO** — `{sessions: true, checkins: false, photos: false, coach: false}`
- **NATE** — check-ins and sessions only

Because `prefs` also lived per row, their *older* rows kept shipping the
categories they'd just turned off. And once a category is off it's off forever:
there's no snooze, no digest, no middle setting.

### The labels don't describe what arrives

| Toggle says | Athlete actually gets |
|---|---|
| Training sessions — *Before planned training* | 5am, regardless of session time |
| Coach replies — *When coaching feedback arrives* | Any programme edit, never a reply |

Athletes toggle off based on what they think they signed up for.

### Bulk programming is indistinguishable from a real change

On 17 Aug, 174 `coach_change_log` rows landed for 2 athletes; 81 on 16 Aug; 82
on 15 Aug. `coachBody()` names changes only when there are three or fewer, so
every one of those days produced the generic *"Your coach made changes: 174
training changes — see the portal."*

The detail itself is fine — `{item: "Long Run - 16km", action: "updated", date:
"2026-09-20"}`. The problem is that a change to a session five weeks out is
treated exactly like moving tomorrow's tempo run. Most of that volume is a block
being published, which is one event, not 174.

(Also: every `coach_change_log` entry appears exactly twice. Worth chasing the
duplicate trigger separately.)

### Everything is a chore

Four categories, four nags. Nothing acknowledges work done, so the notification
channel only ever costs the athlete attention.

### 5am is a guess

`planned_sessions` already stores `part_of_day` and `estimated_minutes`. None of
it reaches the reminder.

---

## 2. Principles

1. **One athlete, one decision.** Delivery state belongs to the athlete, not to
   a subscription row.
2. **The toggle label is a promise.** If the label says "before training", it
   fires before training.
3. **Ping on what's actionable today.** A change to a session five weeks out is
   not news.
4. **Never spend a notification on something the portal can say quietly.** The
   home nudge strips already carry the low-urgency state.
5. **Push is a courtesy copy, not the record.** Anything worth a push is also
   in the in-app inbox, so a missed or blocked notification loses nothing.

---

## 3. The category set

Six categories. **Athletes do not choose between them** — reminders are part of
the coaching, not a feature to opt into. Preferences lists them read-only, as a
description of what arrives.

The exception is per-athlete and lives in the database
(`athletes.notifications_managed = false`), for cases agreed directly with the
athlete. JOJO is currently the only one.

This raises the bar on everything below rather than lowering it. The per-category
toggles were a pressure valve on a channel firing four separate nags plus every
bulk edit; with the valve gone, an athlete who finds the volume intolerable has
exactly one lever left — muting the portal in iOS Settings, which is invisible to
us and unrecoverable without asking them face to face. **Sections 4 and 7 are no
longer optional polish. They are what makes section 3 safe.**

| key | Label | Sub-label (honest) | Fires |
|---|---|---|---|
| `sessions` | Today's training | Each morning you have a session | 05:30 local |
| `logging` | Session not logged | Evening, if today's training is unlogged | 19:30 local |
| `checkins` | Weekly check-in | Sunday morning, until you submit | 05:30 Sun |
| `photos` | Progress photos | Monday morning on photo weeks | 05:30 Mon |
| `calls` | Coaching calls | Morning of, and 2 hours before | event-driven |
| `coach` | Programme changes | When we change your plan for the week ahead | batched |

Renames doing real work: **Coach replies → Programme changes** (it was never a
reply), and **Training sessions → Today's training** (it was never "before").

Adding a category is a one-line change to `MANAGED_CATEGORIES` in
`api/reminders.js` — every managed athlete receives it with no migration and no
re-consent. That is convenient and it is also the risk: nothing in the system
now pushes back on adding one. The daily cap in section 4 is the only brake.

---

## 4. Timing

Morning moves **05:00 → 05:30**. 5am is early enough to wake the athletes who
*aren't* training at 5am, and the 5am trainers are up either way.

`part_of_day` shapes the body rather than adding a second push:

> **Today's training**
> Threshold (AM) · Lower B (PM) — 75 min total

One morning push carrying every category due, rather than up to three stacked:

> **Today's training**
> Long Run - 12km (AM) · Weekly check-in due · Progress photo week

Merging the morning categories into a single notification is the single largest
volume cut available, and it's free — they already fire in the same minute.

**Quiet hours: 21:00 – 05:30 local, hard.** Coach updates currently run to
23:30. Nothing is urgent enough at 11pm to be worth the mute.

**Cap: 3 pushes per athlete per day.** Above the cap everything rolls into the
inbox and, if anything was dropped, one summary push the next morning.

---

## 5. New: session not logged (`logging`)

The highest-value one for coaching, because it directly feeds the compliance
data you work from.

**Fires at 19:30 local when all of:**

- a `planned_sessions` row exists for today, `status` not in
  (done/completed/complete/skipped/missed)
- no `training_session_logs` row for `(athlete_code, session_date = today)`
- no `strava_activities` row matched to today — a run logged via Strava counts;
  don't nag someone who already ran
- not already sent today (`last_sent.logging !== today`)

**Copy — lead with the work, not the failure:**

> **Threshold still open**
> Two minutes to log it and it's in your week's numbers.

Two sessions:

> **2 sessions still open**
> Long Run - 12km · Upper A — tap to log.

Deep-link `url` straight to today's session, not `/`.

**Do not fire** on a rest day, on a day with no planned session, or if the
athlete opened and logged anything at all today. Silence when there's nothing to
say is what keeps the toggle on.

---

## 6. New: coaching call reminders (`calls`)

The portal already knows about calls — `getCallBookedState()` reads the booking
into the home nudge, `/api/bookings?mode=sync` pulls from GHL — but no push has
ever been wired to it. It's the one notification where being missed has a
concrete cost.

**Two fires per booking:**

1. **Morning of**, folded into the 05:30 morning notification:
   *"Call with Karl & Alex today, 6:30 pm."*
2. **2 hours before**, standalone:
   > **Call in 2 hours**
   > 6:30 pm with Karl & Alex — anything you want to cover, jot it now.

Needs booking start times server-side where the cron can see them. They're
already synced into the booking rows the portal reads; the reminder should
select on `starts_at` rather than the ISO-week key.

Also fire a **"no call booked"** nudge into the Sunday morning notification when
the current week has no booking — that's demand generation, and it's one line in
copy the athlete is already receiving:
*"No call booked this week — grab a slot."*

---

## 7. Coach updates that say something (`coach`)

Split one category into two behaviours by **how soon the change lands**.

### Near-term changes (today → +7 days) — push, named

Filter `coach_change_log` on `detail.date` within the next 7 local days, dedupe
on `(action, item, date)`, then name up to three:

> **Thursday's session changed**
> Threshold (Thu 21 Aug) updated · Lower C (Wed 26 Aug) added

Four or more near-term changes in one batch:

> **Your week ahead changed**
> 5 sessions updated between Thu 21 and Wed 26 Aug — tap to review.

Deep-link to the affected day, not the home tab.

### Future changes (+8 days and beyond) — no push

A block being published is one event. It goes to the inbox, and surfaces in the
Monday morning notification as one line:
*"Your next 4 weeks are live."*

This is what kills the "174 training changes" message. Of the 174 rows on 17
Aug, only a handful touched the week ahead.

### Nutrition and gym-plan changes

Currently lumped into the same push. Give them their own line rather than a
count: *"Nutrition targets updated for Week 28."*

### Raise the naming threshold

`coachBody()` names up to 3 changes and gives up past that. Once the near-term
filter is in place, batches are small enough that 3 is generous — but raise the
140-character body cap to 180 so two sessions with dates actually fit.

---

## 8. Shipped: one decision per athlete

*(This part is done — code in this repo.)*

`api/_lib/push-devices.js` (new) plus a rewritten send path in
`api/reminders.js`:

- `deviceKey(ua)` fingerprints platform + browser family with version numbers
  stripped, so a Safari point release is the same phone.
- `selectLiveDevices(rows)` keeps the most recently active row per device, then
  the 3 most recent devices. Everything else is retired on the spot rather than
  waiting for a 410 that never comes.
- `mergeLastSent(rows)` merges delivery history across an athlete's rows, so a
  reinstalled phone inherits it instead of replaying the morning.
- `newestPrefs(rows)` makes preferences athlete-level — JOJO's older row can no
  longer keep shipping coach updates they switched off.
- The cron loop now iterates athletes, not rows: one decision, one payload, sent
  once per live device.
- `last_sent` is only written once a send actually reached a device. Previously
  a total failure still burned the athlete's one reminder for the day.
- On subscribe, `reconcileAthleteDevices()` retires the rows the device left
  behind on earlier installs and gives survivors one shared history.

Migration `20260820103000_collapse_duplicate_push_subscriptions.sql` clears the
existing backlog in one pass (36 rows → 10, one per athlete) and adds the
`timezone` column that exists in production but was never captured in a
migration.

Tests: `tests/push-devices.test.js`, 13 cases, including the thirteen-row iPhone
and JOJO's preference divergence as regression fixtures.

---

## 9. The in-app inbox

The piece that makes everything above safe to tune down.

A push is best-effort: permission may be denied, the PWA may not be installed,
iOS may drop it. Right now a missed push is lost — there's no record anywhere in
the portal. That's why every category currently feels like it has to fire.

**Schema**

```sql
create table public.athlete_notifications (
  id          uuid primary key default gen_random_uuid(),
  athlete_code text not null,
  type        text not null,          -- sessions | logging | checkins | photos | calls | coach
  title       text not null,
  body        text not null,
  url         text not null default '/',
  created_at  timestamptz not null default now(),
  read_at     timestamptz,
  pushed_at   timestamptz             -- null = inbox only, never pushed
);
create index on public.athlete_notifications (athlete_code, created_at desc);
```

**Rules**

- Every decision the cron makes writes a row here, whether or not it pushes.
  Suppressed-by-quiet-hours, over-cap, and future-dated coach changes all land
  here with `pushed_at` null.
- The portal shows a bell in the header with an unread count, reading from
  `/api/reminders?portal=1` (the endpoint already exists for due-checks).
- Tapping an item marks it read and follows `url`.
- Athletes can clear one item or the whole visible inbox. Clearing stamps
  `dismissed_at` rather than deleting the row, so delivery history and the
  dedupe key remain authoritative while the item disappears from the inbox,
  unread badge and missed-update summaries.
- 30-day retention, purged by the same pg_cron job that trims
  `coach_change_log`.

Once this exists, a category can be **quiet by default** — written to the inbox
and never pushed. That is now a *coaching* decision rather than an athlete
setting: it lets a low-urgency category (future-dated programme changes, photo
week) stay visible without spending a notification, which is how the daily cap
in section 4 gets honoured without anything going missing.

It also gives back the visibility the toggles used to provide. With no in-app
control, an athlete who is drowning has no signal to send us except silence.
Two things worth watching once this ships:

- **Delivery failures per athlete.** A run of 404/410s, or an athlete whose
  `last_sent` stops advancing, is the closest thing to a mute signal we get.
- **Inbox reads.** An athlete who stops opening the bell has disengaged from
  the channel whether or not the pushes are still landing.

Neither replaces asking them on a call. Both beat finding out three months late.

---

## 10. Onboarding — a note

Every subscribed athlete is on iOS, which means the portal must be installed to
the home screen before push exists at all. `maybePromptPwaNotifications()` only
runs when `isInstalledPortalPwa()` is already true — so an athlete browsing in
Safari never sees the prompt, and never learns the install is what unlocks it.

This matters more now that reminders are mandatory. The choice an athlete has
left is binary and it is made once, at the OS prompt — so that prompt is the
whole funnel. An athlete who never installs the PWA, or who taps *Don't Allow*
because the ask arrived cold, is unreachable and there is no in-app setting to
recover them with.

Worth measuring before anything else: count athletes with zero rows in
`push_subscriptions`. If that number is large, the notification volume is not
the constraint — the permission prompt is.

---

## 11. Order of work

1. ~~One decision per athlete + backlog migration~~ — **done**
2. ~~Managed categories, toggles removed, read-only Preferences~~ — **done**
3. Merge the morning categories into one notification, move to 05:30, add quiet
   hours and the daily cap — pure volume reduction, no new data needed
4. Near-term filter on coach updates — kills the "174 changes" message
5. The `logging` category — highest coaching value
6. In-app inbox, plus the delivery-failure and inbox-read signals in section 9
7. Call reminders — needs booking start times server-side

Steps 3 and 4 are the ones that make step 2 safe, and neither needs a schema
change. They should not sit behind anything else.
