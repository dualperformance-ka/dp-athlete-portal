-- Collapse duplicate push subscriptions down to one live row per device.
--
-- Every reinstall of the home-screen portal, every re-granted permission and
-- every Safari point release mints a brand-new endpoint, while the previous row
-- survives until Apple returns 404/410 — which in practice it often never does.
-- The result: one athlete's single iPhone accumulated thirteen rows, and every
-- reminder buzzed the handset thirteen times.
--
-- api/reminders.js now decides delivery per athlete and retires leftovers on
-- each run, so the backlog would drain on its own. This migration clears it in
-- one pass so athletes stop being spammed the moment it lands.
--
-- Note: the `timezone` column this table has in production was never captured
-- in a migration. It is added here (idempotently) so a fresh environment
-- matches what api/reminders.js expects.

alter table public.push_subscriptions
  add column if not exists timezone text not null default 'Australia/Adelaide';

-- Same fingerprint as deviceKey() in api/_lib/push-devices.js: platform plus
-- browser family, with every version number ignored.
create temporary table dp_push_survivors on commit drop as
with normalised as (
  select
    id,
    upper(athlete_code) as code,
    coalesce(updated_at, created_at) as active_at,
    case
      when coalesce(user_agent, '') = '' then 'unknown'
      else
        (case
          when user_agent ilike '%iPad%' then 'ipad'
          when user_agent ilike '%iPhone%' or user_agent ilike '%iPod%' then 'iphone'
          when user_agent ilike '%Android%' then 'android'
          when user_agent ilike '%Macintosh%' or user_agent ilike '%Mac OS X%' then 'mac'
          when user_agent ilike '%Windows%' then 'windows'
          when user_agent ilike '%Linux%' then 'linux'
          else 'other'
        end)
        || '|' ||
        -- Order matters: Edge and Chrome both carry "Safari/" in their UA.
        (case
          when user_agent ~ 'Edg(A|iOS)?/' then 'edge'
          when user_agent ~ '(FxiOS|Firefox/)' then 'firefox'
          when user_agent ~ '(CriOS|Chrome/)' then 'chrome'
          when user_agent ~ 'Safari/' then 'safari'
          else 'other'
        end)
    end as device_key
  from public.push_subscriptions
),
-- One row per physical device: the most recently active endpoint wins.
per_device as (
  select id, code, active_at,
         row_number() over (partition by code, device_key order by active_at desc nulls last, id) as device_rank
  from normalised
),
-- Then at most three devices per athlete, newest first (MAX_DEVICES_PER_ATHLETE).
per_athlete as (
  select id, code,
         row_number() over (partition by code order by active_at desc nulls last, id) as athlete_rank
  from per_device
  where device_rank = 1
)
select id, code from per_athlete where athlete_rank <= 3;

-- Carry the retired rows' delivery history onto the survivors, so a surviving
-- endpoint never replays a reminder the athlete has already been shown.
-- Within a key the values are ISO dates or ISO timestamps, so the lexicographic
-- max is the most recent send.
with history as (
  select upper(s.athlete_code) as code, h.key, max(h.value) as value
  from public.push_subscriptions s
  cross join lateral jsonb_each_text(coalesce(s.last_sent, '{}'::jsonb)) as h(key, value)
  where h.value <> ''
  group by 1, 2
),
merged as (
  select code, jsonb_object_agg(key, value) as last_sent
  from history
  group by code
)
update public.push_subscriptions s
set last_sent = merged.last_sent
from merged
join dp_push_survivors v on v.code = merged.code
where s.id = v.id
  and s.last_sent is distinct from merged.last_sent;

-- Retire everything that is not a live device.
delete from public.push_subscriptions
where id not in (select id from dp_push_survivors);

create index if not exists push_subscriptions_updated_at_idx
  on public.push_subscriptions (athlete_code, updated_at desc);
