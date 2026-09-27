-- Allow the three new automated reminders into the notification inbox:
--   strava    - a run, ride or swim synced from Strava (once per activity)
--   readiness - 10am nudge when today's body check is not logged
--   fuel      - 8:30pm nudge when nothing is logged against the athlete's macros
--
-- The allowed list below is mirrored by NOTIFICATION_TYPES in
-- api/_lib/notification-rules.js; tests/notification-type-constraint.test.js
-- fails if the two drift. Every existing type is preserved.
--
-- Idempotent: the constraint is replaced only when it does not already allow
-- all three.

do $$
declare
  current_def text;
begin
  select pg_get_constraintdef(oid) into current_def
  from pg_constraint
  where conname = 'athlete_notifications_type_check'
    and conrelid = 'public.athlete_notifications'::regclass;

  if current_def is null
     or position('''strava''' in current_def) = 0
     or position('''readiness''' in current_def) = 0
     or position('''fuel''' in current_def) = 0 then
    if current_def is not null then
      alter table public.athlete_notifications
        drop constraint athlete_notifications_type_check;
    end if;
    alter table public.athlete_notifications
      add constraint athlete_notifications_type_check
      check (type in (
        'sessions', 'logging', 'checkins', 'photos', 'calls', 'coach', 'custom',
        'weekly_review', 'strava', 'readiness', 'fuel'
      ));
  end if;
end
$$;
