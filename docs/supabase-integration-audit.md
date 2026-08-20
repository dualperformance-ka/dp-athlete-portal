# Supabase integration audit

Audited 20 August 2026 against project `rugdupplsswxmpoudhpv` and this portal release.

Supabase is the durable system of record. Browser storage remains a fast/offline
cache only; authenticated server routes scope every athlete read and write by
the session-resolved `athlete_code`. External providers (Strava and GHL) are
ingestion sources, not recall stores: the portal and dashboard read their
normalised copies from Supabase.

| Domain | Supabase source of truth | Athlete recall | Dashboard / operations sync |
|---|---|---|---|
| Identity and access | `auth.users` + `athletes` | `/api/auth-athlete` | `athletes`, `coaches`, `coach_athletes` |
| Portal compatibility/offline state | `athlete_data` | `/api/portal-data` bootstrap | server-scoped reads where needed |
| Planned training | `planned_sessions`, programme and prescription tables | `/api/portal-data` training snapshot | coaches dashboard writes same project |
| Strength/run completion | `training_session_logs`, `session_logs` | bootstrap and log reads | structured log tables |
| Body and nutrition logs | `daily_body_logs`, `daily_nutrition_logs` | bootstrap and progress reads | same structured tables |
| Weekly check-ins and goals | `weekly_checkins`, `athlete_goals` | bootstrap / state hydration | same structured tables |
| Progress photos | private Storage bucket `progress-photos` + `progress_photos` metadata | signed URLs from `/api/progress-photos` | metadata is directly queryable; bytes stay private |
| Push devices | `push_subscriptions` | `/api/reminders` subscription flow | `notify_status` reachability |
| Notification record | `athlete_notifications` | bell/inbox via `/api/reminders?portal=1` | `notify_status` unread and delivery timestamps |
| Programme-change queue | `coach_change_log` | near-term pushes + durable inbox | `notify_status.queued` |
| Strava | `strava_activities` and private token/event tables | `/api/strava` | same cached activities |
| Coaching calls | GHL events normalised into `athlete_data.call_booked_*` | booking nudge and notification cron | same stored booking timestamp |
| Weekly sport targets | `weekly_sport_targets` | authenticated server gateway | coaches dashboard owns published rows |

## Closed gaps in this release

- Morning session, check-in, photo, call and missed-message content is merged
  into one 05:30 local notification.
- Quiet hours are hard from 21:00 to 05:30 and pushes are capped at three per
  athlete per local day; suppressed messages remain in the inbox.
- Programme changes more than seven days away no longer spend a push.
- A 19:30 unlogged-session reminder checks structured logs and cached Strava
  activity before firing.
- Call timestamps already stored by the GHL sync now drive morning-of and
  two-hours-before reminders.
- Custom coach messages and automated reminders share the same durable table,
  read state, retention and dashboard status.
- Progress photo bytes and metadata move into Supabase. Historic Cloudinary
  objects are copied forward on first authenticated recall. Partial transfers
  retry on the next recall without taking the gallery down; new uploads and
  deletes use Supabase only.

## Live verification

- Applied migrations `20260820115252`, `20260820115718` and `20260820115933`
  to the production Supabase project.
- Verified the notification and progress-photo tables have RLS enabled, the
  Storage bucket is private, the dashboard exposes unread/last-delivery state,
  the queue uses the same seven-day rule as push delivery, and exactly one
  30-day retention job is scheduled.
- Supabase's performance advisor now reports no warnings. The security pass
  fixed the older trigger-RPC grants and mutable function search paths found
  during this audit.
- The portal validation and all 336 automated tests pass.

## Advisor notes that are intentional or console-owned

- `athlete_notifications` and `progress_photos` appear as informational
  "RLS enabled, no policy" notices by design. Browser roles have no grants;
  authenticated athlete-scoped server routes are the only access path.
- `current_athlete_code()` remains a `SECURITY DEFINER` helper because two
  established RLS policies depend on it. It returns only the signed-in
  athlete's own code and is not executable by `anon`; changing its execution
  model without an auth regression rollout would be riskier than retaining it.
- The project-installed `pg_net` extension is non-relocatable and its objects
  already live in the dedicated `net` schema, so the generic extension-schema
  warning is retained.
- Supabase's leaked-password protection is a project dashboard setting. This
  portal uses email OTP as its primary sign-in; enable that setting in Auth if
  password sign-in is introduced or retained elsewhere in the project.

## Deliberately device-local state

Rest-timer countdowns, wake-lock state, the indoor/outdoor display choice and
PWA permission-prompt dismissal do not affect coaching history or another
device. Keeping those values local is intentional. Training drafts, logs,
reschedules, goals, substitutions, booking timestamps and retry queues are
mirrored to Supabase and reconciled on login.
