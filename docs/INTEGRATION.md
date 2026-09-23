# Integration

How the athlete portal and the coaches dashboard share data.

## Shared Supabase contract (portal ↔ coaches dashboard)

Both apps use one Supabase project. The athlete portal (`dp-athlete-portal`)
writes athlete data; the coaches dashboard (`dp-coaches-dashboard`) reads it with
the service role through `api/coach-data.js` and changes only coach-owned state
through `api/athletes.js`. Browsers never touch Supabase directly.

Contract tests: dashboard `tests/portal-contract.test.js` (every coach-relevant
column below is surfaced by a mapper), `tests/coach-weekly-summary.test.js` and
portal `tests/coach-summary-mirror.test.js` (shared weekly-summary rules pinned
by hash), portal `tests/notification-type-constraint.test.js` (every emitted
notification type is allowed by the database).

| Table / column | Owning repo (migration) | Writer | Dashboard reader | Fallback while rolling out |
|---|---|---|---|---|
| `daily_body_logs.pain`, `pain_location`, `coach_alert` | portal `20260923090000_daily_body_pain_typed_columns` | portal `api/ingest.js` `daily_body` (`projectBodyPain`) | `coach-data` triage + `mapBody` (`Pain`, `Pain Location`, `Coach Alert`) | derived from `raw_payload.pain / painLocation / coachAlert`; ingest drops the typed columns (not the log) if absent |
| `daily_body_logs.raw_payload.noteText` | portal | portal ingest | `mapBody` → `Athlete Note` | generated `notes` string |
| `weekly_checkins.call_decision` | portal `20260905040000_weekly_checkin_call_decision` | portal ingest `weekly_checkin` | `mapWeekly` → `Call Decision`; weekly fingerprint; call prep "Ask" | null renders nothing |
| `athlete_goals.strength_intent`, `strength_priorities`, `strength_lift`, `strength_current_load`, `strength_target_load`, `strength_reps` | portal `20260812210000_athlete_goals_strength_columns` | portal ingest `goals` | `mapGoal`; Goals panel in the athlete Overview | empty fields are hidden |
| `athlete_goals.why`, `milestone_w4/8/12` | portal | portal ingest `goals` | `mapGoal`; client profile or Goals panel | hidden when empty |
| `training_session_logs.distance_km`, `duration_min`, `pace`, `rpe`, `feel`, `raw_sets` | portal `202606240001_structured_athlete_ingest` | portal ingest (Run / Strength) | `mapSession` → `Distance KM`, `Duration Min`, `Pace`, `RPE`, `Feel`, `Raw Sets` (numeric set fields only; never `raw_payload`) | analysis falls back to the `logs` blob, then the `Exercise Log` text parser |
| `contact_messages` (+ `read_by`) | portal `20260826060000_contact_messages`; `read_by` dashboard `20260923100000_coach_inbox_attribution` | portal `contact-coach`; dashboard `message_read` / `message_unread` | `coach-data` `contactMessages`; Today rail "Athlete messages" | `read_by` optional; failed read is reported in `dataQuality.missingSources` |
| `data_requests` (+ `acknowledged_by`, `completed_by`) | portal `20260827230000_data_requests`; attribution dashboard `20260923100000_coach_inbox_attribution` | portal data-rights request; dashboard `data_request_acknowledge` / `_complete` / `_reopen` | `coach-data` `dataRequests` (30-day due state); Today rail "Data requests" | attribution optional; failed read named as missing |
| `notify_status` (view) | portal `20260820150000_notify_status_managed` | derived | `coach-data` `notifyStatus`; Notify tab "Notification health"; athlete Overview | failed read named as missing, never "no devices" |
| `athlete_notifications.type` includes `weekly_review` | portal `20260923091000_notification_type_weekly_review` | portal `api/reminders.js` | (not read) | reminder loop records a failed inbox write in `errors` and continues |
| Weekly review (coach) | dashboard `server/coach-weekly-summary.js` + `server/performance-summary-core.js` (copy of portal rules) | derived | `coach-data?mode=weekly_summary&code=&programmeWeekId=` | optional sources degrade to `null` and `dataQuality.partial` |

Boundaries that do not move:

- `strava_activities` is athlete-only. The dashboard never reads it; the coach
  weekly review uses confirmed `training_session_logs` and consented
  `athlete_activity_uploads` (`coach_access_granted_at` set), one source per
  sport-day, and labels every endurance figure with `actualSource`.
- `null` means unavailable, `0` means a verified zero, on both sides.
- `raw_payload` never leaves the server.

### Production order for the 2026-09-23 parity change

1. Apply migrations (all idempotent): portal
   `20260923090000_daily_body_pain_typed_columns`,
   `20260923091000_notification_type_weekly_review`; dashboard
   `20260923100000_coach_inbox_attribution`.
2. Deploy the portal (ingest writes typed pain; reminder loop hardening).
3. Verify writes: a new body log with pain has `pain`, `pain_location`,
   `coach_alert` set. Re-run the pain migration once after the deploy: it
   back-fills any row written between steps 1 and 2.
4. Deploy the dashboard (reads, UI, queue actions, weekly review).
5. Run the production smoke checks in the PR description.
