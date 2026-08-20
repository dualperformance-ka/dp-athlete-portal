-- Coaching reminders are part of the service, not a feature athletes opt into.
-- The portal no longer offers per-category toggles; every athlete receives
-- every category. Exemptions are agreed case by case and recorded here rather
-- than in the portal UI, so they survive reinstalls and device changes.
--
-- The default must be true: an athlete missing from this column has to receive
-- everything, or a newly onboarded athlete would silently get nothing.

alter table public.athletes
  add column if not exists notifications_managed boolean not null default true;

comment on column public.athletes.notifications_managed is
  'true (default): athlete receives every reminder category, ignoring any stored per-device prefs. false: api/reminders.js honours the prefs on their newest push_subscriptions row.';

-- JOJO switched everything except training off before the toggles were removed;
-- that choice was agreed and stands.
update public.athletes
set notifications_managed = false
where upper(code) = 'JOJO';
