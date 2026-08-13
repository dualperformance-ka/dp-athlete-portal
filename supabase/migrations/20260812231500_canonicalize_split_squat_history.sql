-- Canonicalize the historic dumbbell split-squat labels without dropping any
-- training data. The portal now treats both old labels as Bulgarian Split
-- Squat, while Barbell Split Squat remains a separate movement and progression.
--
-- The write-id update prevents a resubmitted historic session from inserting a
-- parallel row. It skips any target id that already exists, preserving both
-- rows in the unlikely event that an environment already has a collision.

with canonical_ids as (
  select
    log.id,
    case
      when log.client_write_id ~* '_dumbbell-bulgarian-split-squat$'
        then regexp_replace(log.client_write_id, '_dumbbell-bulgarian-split-squat$', '_bulgarian-split-squat', 'i')
      when log.client_write_id ~* '_dumbbell-split-squat$'
        then regexp_replace(log.client_write_id, '_dumbbell-split-squat$', '_bulgarian-split-squat', 'i')
      else log.client_write_id
    end as canonical_client_write_id
  from public.training_session_logs as log
  where lower(coalesce(log.session_category, '')) = 'strength'
    and log.client_write_id ~* '_(dumbbell-bulgarian|dumbbell)-split-squat$'
)
update public.training_session_logs as log
set
  client_write_id = ids.canonical_client_write_id,
  updated_at = now()
from canonical_ids as ids
where log.id = ids.id
  and ids.canonical_client_write_id is distinct from log.client_write_id
  and not exists (
    select 1
    from public.training_session_logs as existing
    where existing.client_write_id = ids.canonical_client_write_id
      and existing.id <> log.id
  );

with source_names as (
  select
    log.id,
    regexp_replace(lower(trim(coalesce(
      log.exercise_name,
      log.raw_payload->>'exerciseName',
      case when log.exercise_log like '%: Set %' then split_part(log.exercise_log, ': Set ', 1) end,
      ''
    ))), '[^a-z0-9]+', ' ', 'g') as exercise_key,
    regexp_replace(lower(trim(coalesce(
      log.programmed_exercise,
      log.raw_payload->>'programmedExercise',
      ''
    ))), '[^a-z0-9]+', ' ', 'g') as programmed_key
  from public.training_session_logs as log
  where lower(coalesce(log.session_category, '')) = 'strength'
),
aliases as (
  select *
  from source_names
  where exercise_key in ('bulgarian split squat', 'dumbbell split squat', 'dumbbell bulgarian split squat')
     or programmed_key in ('bulgarian split squat', 'dumbbell split squat', 'dumbbell bulgarian split squat')
)
update public.training_session_logs as log
set
  exercise_name = case
    when aliases.exercise_key in ('bulgarian split squat', 'dumbbell split squat', 'dumbbell bulgarian split squat')
      then 'Bulgarian Split Squat'
    else log.exercise_name
  end,
  programmed_exercise = case
    when aliases.programmed_key in ('bulgarian split squat', 'dumbbell split squat', 'dumbbell bulgarian split squat')
      then 'Bulgarian Split Squat'
    else log.programmed_exercise
  end,
  exercise_log = case
    when aliases.exercise_key in ('bulgarian split squat', 'dumbbell split squat', 'dumbbell bulgarian split squat')
      then regexp_replace(
        log.exercise_log,
        '^[[:space:]]*(dumbbell[[:space:]]+bulgarian|dumbbell|bulgarian)[[:space:]]+split[[:space:]]+squat:[[:space:]]+Set[[:space:]]+',
        'Bulgarian Split Squat: Set ',
        'i'
      )
    else log.exercise_log
  end,
  is_swap = case
    when aliases.exercise_key in ('bulgarian split squat', 'dumbbell split squat', 'dumbbell bulgarian split squat')
     and aliases.programmed_key in ('bulgarian split squat', 'dumbbell split squat', 'dumbbell bulgarian split squat')
      then false
    else log.is_swap
  end,
  raw_payload = coalesce(log.raw_payload, '{}'::jsonb)
    || case
      when aliases.exercise_key in ('bulgarian split squat', 'dumbbell split squat', 'dumbbell bulgarian split squat')
        then jsonb_build_object(
          'exerciseName', 'Bulgarian Split Squat',
          'exerciseLog', case
            when log.exercise_log is null then null
            else regexp_replace(
              log.exercise_log,
              '^[[:space:]]*(dumbbell[[:space:]]+bulgarian|dumbbell|bulgarian)[[:space:]]+split[[:space:]]+squat:[[:space:]]+Set[[:space:]]+',
              'Bulgarian Split Squat: Set ',
              'i'
            )
          end
        )
      else '{}'::jsonb
    end
    || case
      when aliases.programmed_key in ('bulgarian split squat', 'dumbbell split squat', 'dumbbell bulgarian split squat')
        then jsonb_build_object('programmedExercise', 'Bulgarian Split Squat')
      else '{}'::jsonb
    end
    || case
      when log.raw_payload ? 'name'
        then jsonb_build_object(
          'name', regexp_replace(
            log.raw_payload->>'name',
            'dumbbell([[:space:]]+bulgarian)?[[:space:]]+split[[:space:]]+squat',
            'Bulgarian Split Squat',
            'gi'
          )
        )
      else '{}'::jsonb
    end
    || case
      when log.raw_payload ? 'clientWriteId'
        then jsonb_build_object('clientWriteId', log.client_write_id)
      else '{}'::jsonb
    end
    || case
      when aliases.exercise_key in ('bulgarian split squat', 'dumbbell split squat', 'dumbbell bulgarian split squat')
       and aliases.programmed_key in ('bulgarian split squat', 'dumbbell split squat', 'dumbbell bulgarian split squat')
        then jsonb_build_object('isSwap', false)
      else '{}'::jsonb
    end,
  updated_at = now()
from aliases
where log.id = aliases.id;
