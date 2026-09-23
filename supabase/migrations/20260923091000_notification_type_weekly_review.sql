-- Allow the Sunday weekly-review reminder into the notification inbox.
--
-- api/_lib/notification-rules.js buildWeeklyReviewMessage() emits
-- type 'weekly_review', but athlete_notifications_type_check (from
-- 20260820115252_integrated_notification_inbox_and_storage.sql) only allows
-- sessions, logging, checkins, photos, calls, coach and custom. The inbox
-- upsert therefore fails at 7pm Sunday.
--
-- The allowed list below is the single source of truth mirrored by
-- NOTIFICATION_TYPES in api/_lib/notification-rules.js;
-- tests/notification-type-constraint.test.js fails if the two drift.
--
-- Idempotent: the constraint is replaced only when its definition does not
-- already allow weekly_review. Every existing value is preserved.

do $$
declare
  current_def text;
begin
  select pg_get_constraintdef(oid) into current_def
  from pg_constraint
  where conname = 'athlete_notifications_type_check'
    and conrelid = 'public.athlete_notifications'::regclass;

  if current_def is null or position('weekly_review' in current_def) = 0 then
    if current_def is not null then
      alter table public.athlete_notifications
        drop constraint athlete_notifications_type_check;
    end if;
    alter table public.athlete_notifications
      add constraint athlete_notifications_type_check
      check (type in (
        'sessions', 'logging', 'checkins', 'photos', 'calls', 'coach', 'custom',
        'weekly_review'
      ));
  end if;
end
$$;
