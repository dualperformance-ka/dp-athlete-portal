-- Durable notification record. Push is a best-effort delivery copy; this table
-- is the source of truth used by the athlete inbox and coach dashboard.
create table if not exists public.athlete_notifications (
  id uuid primary key default gen_random_uuid(),
  athlete_code text not null references public.athletes(code) on update cascade on delete cascade,
  type text not null check (type in ('sessions', 'logging', 'checkins', 'photos', 'calls', 'coach', 'custom')),
  title text not null check (char_length(title) between 1 and 120),
  body text not null check (char_length(body) <= 1000),
  url text not null default '/',
  dedupe_key text not null,
  local_date date not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  pushed_at timestamptz,
  unique (athlete_code, dedupe_key)
);

alter table public.athlete_notifications enable row level security;
revoke all on table public.athlete_notifications from anon, authenticated;
grant select, insert, update, delete on table public.athlete_notifications to service_role;

create index if not exists athlete_notifications_inbox_idx
  on public.athlete_notifications (athlete_code, created_at desc);
create index if not exists athlete_notifications_unread_idx
  on public.athlete_notifications (athlete_code, read_at, created_at desc);
create index if not exists athlete_notifications_daily_push_idx
  on public.athlete_notifications (athlete_code, local_date, pushed_at);

comment on table public.athlete_notifications is
  'Durable athlete notification inbox. Server routes scope every read/write to the authenticated athlete; no browser-direct table access.';

-- Keep the coach dashboard on the same source of truth. New columns are
-- appended so create-or-replace never changes the existing view contract.
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

-- Notification history is operational data, not a permanent athlete record.
select cron.schedule(
  'purge-athlete-notifications',
  '5 16 * * *',
  $$delete from public.athlete_notifications where created_at < now() - interval '30 days';$$
);

-- Progress photos now live in the same Supabase project as every other athlete
-- record. The bucket is private; signed URLs are minted only by the
-- authenticated athlete route using the server-side service role.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'progress-photos',
  'progress-photos',
  false,
  12582912,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.progress_photos (
  id uuid primary key default gen_random_uuid(),
  athlete_code text not null references public.athletes(code) on update cascade on delete cascade,
  week_number integer not null check (week_number between 1 and 80),
  slot text not null check (slot in ('front', 'side', 'back', 'front_flexed', 'back_flexed')),
  storage_path text not null unique,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes bigint not null check (size_bytes between 1 and 12582912),
  width integer,
  height integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (athlete_code, week_number, slot)
);

alter table public.progress_photos enable row level security;
revoke all on table public.progress_photos from anon, authenticated;
grant select, insert, update, delete on table public.progress_photos to service_role;
create index if not exists progress_photos_athlete_week_idx
  on public.progress_photos (athlete_code, week_number, slot);

comment on table public.progress_photos is
  'Private Supabase Storage object metadata for athlete progress photos. Access only through the authenticated server route.';
