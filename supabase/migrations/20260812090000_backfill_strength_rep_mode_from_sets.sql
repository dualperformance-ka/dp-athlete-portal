-- Recover the rep mode from the set shape already stored in Supabase.
--
-- Older portal builds wrote repsLeft/repsRight into raw_sets before rep_mode
-- had its own column. The coach dashboard can therefore display the sides, but
-- cannot reliably filter or aggregate unilateral work until rep_mode is filled.
-- This backfill uses only the recorded JSON keys; it never guesses from an
-- exercise name and never converts a historical shared-reps set into two sides.

update public.training_session_logs as log
set
  rep_mode = 'left_right',
  raw_payload = jsonb_set(
    coalesce(log.raw_payload, '{}'::jsonb),
    '{repMode}',
    '"left_right"'::jsonb,
    true
  ),
  updated_at = now()
where log.session_category = 'Strength'
  and log.rep_mode is null
  and jsonb_typeof(log.raw_sets) = 'array'
  and exists (
    select 1
    from jsonb_array_elements(log.raw_sets) as strength_set
    where nullif(trim(strength_set->>'repsLeft'), '') is not null
       or nullif(trim(strength_set->>'repsRight'), '') is not null
  );

update public.training_session_logs as log
set
  rep_mode = 'reps',
  raw_payload = jsonb_set(
    coalesce(log.raw_payload, '{}'::jsonb),
    '{repMode}',
    '"reps"'::jsonb,
    true
  ),
  updated_at = now()
where log.session_category = 'Strength'
  and log.rep_mode is null
  and jsonb_typeof(log.raw_sets) = 'array'
  and exists (
    select 1
    from jsonb_array_elements(log.raw_sets) as strength_set
    where nullif(trim(strength_set->>'reps'), '') is not null
  );
