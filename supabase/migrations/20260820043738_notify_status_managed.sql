-- notify_status is the coaches' view of who can actually be reached. It derived
-- coach_pref from push_subscriptions.prefs, which was correct while athletes
-- chose their own categories.
--
-- That assumption is now wrong in two ways:
--   1. The portal no longer sends prefs at all, so every newly created
--      subscription row carries the '{}' default. Left as-is, coach_pref would
--      read false for athletes who ARE receiving coach updates — the dashboard
--      would report the whole roster as opted out.
--   2. Delivery is decided by athletes.notifications_managed, so that is what
--      the view has to reflect.
--
-- coach_pref now answers the question the coaches are actually asking: will a
-- coach update reach this athlete? That needs a live device AND either managed
-- status or an explicit stored preference.
--
-- Must run after 20260820043715_managed_athlete_notifications.sql.
--
-- notifications_managed is appended as the LAST column deliberately. Postgres
-- refuses `create or replace view` when it would rename or reorder an existing
-- output column, so inserting it mid-list would force a drop-and-recreate and a
-- window where anything reading the view fails.

create or replace view public.notify_status as
with subs as (
  select
    push_subscriptions.athlete_code,
    count(*) as devices,
    bool_or(coalesce((push_subscriptions.prefs ->> 'coach')::boolean, false)) as stored_coach_pref,
    max((push_subscriptions.last_sent ->> 'coach')::timestamptz) as last_coach_sent
  from push_subscriptions
  group by push_subscriptions.athlete_code
)
select
  a.code as athlete_code,
  coalesce(s.devices, 0::bigint) as devices,
  (coalesce(s.devices, 0::bigint) > 0
    and (a.notifications_managed or coalesce(s.stored_coach_pref, false))) as coach_pref,
  s.last_coach_sent,
  coalesce((
    select count(*)
    from coach_change_log c
    where c.athlete_code = a.code
      and c.changed_at > (now() - '24:00:00'::interval)
      and c.changed_at > coalesce(s.last_coach_sent, '-infinity'::timestamptz)
  ), 0::bigint) as queued,
  -- Surfaced so an exemption reads as a decision in the dashboard rather than
  -- looking like a delivery fault.
  a.notifications_managed
from athletes a
left join subs s on s.athlete_code = a.code;
