-- Keep the dashboard queue aligned with delivery rules: training edits more
-- than seven days away are durable inbox publications, not pending pushes.
create or replace view public.notify_status
with (security_invoker = true)
as
with subs as (
  select
    push_subscriptions.athlete_code,
    count(*) as devices,
    bool_or(coalesce((push_subscriptions.prefs ->> 'coach')::boolean, false)) as stored_coach_pref,
    max((push_subscriptions.last_sent ->> 'coach')::timestamptz) as last_coach_sent
  from public.push_subscriptions
  group by push_subscriptions.athlete_code
), inbox as (
  select
    athlete_notifications.athlete_code,
    count(*) filter (where athlete_notifications.read_at is null) as unread,
    max(athlete_notifications.created_at) as last_notification,
    max(athlete_notifications.pushed_at) as last_push
  from public.athlete_notifications
  group by athlete_notifications.athlete_code
)
select
  a.code as athlete_code,
  coalesce(s.devices, 0::bigint) as devices,
  (coalesce(s.devices, 0::bigint) > 0
    and (a.notifications_managed or coalesce(s.stored_coach_pref, false))) as coach_pref,
  s.last_coach_sent,
  coalesce((
    select count(*)
    from public.coach_change_log c
    where c.athlete_code = a.code
      and c.changed_at > now() - interval '24 hours'
      and c.changed_at > coalesce(s.last_coach_sent, '-infinity'::timestamptz)
      and (
        c.source <> 'training'
        or (
          coalesce(c.detail ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$'
          and (c.detail ->> 'date')::date between current_date and current_date + 7
        )
      )
  ), 0::bigint) as queued,
  a.notifications_managed,
  coalesce(i.unread, 0::bigint) as unread,
  i.last_notification,
  i.last_push
from public.athletes a
left join subs s on s.athlete_code = a.code
left join inbox i on i.athlete_code = a.code;

revoke all on table public.notify_status from anon, authenticated;
grant select on table public.notify_status to service_role;
