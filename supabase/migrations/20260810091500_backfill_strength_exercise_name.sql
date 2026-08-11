-- Backfill exercise_name for strength logs written before the column existed.
-- Applied to production 2026-08-10 via Supabase MCP (782 of 783 strength rows;
-- the one remaining row has a null exercise_log, so there is nothing to recover).
--
-- Newer rows carry the name in raw_payload; older ones only have the
-- "Name: Set 1: ..." prefix of exercise_log, which has been a stable format.
-- programmed_exercise is deliberately left null on history: the portal did not
-- record which slot a log filled before this release, and inferring it would
-- misreport past swaps as prescriptions.

update public.training_session_logs
set exercise_name = nullif(trim(raw_payload->>'exerciseName'), '')
where session_category = 'Strength'
  and exercise_name is null
  and nullif(trim(raw_payload->>'exerciseName'), '') is not null;

update public.training_session_logs
set exercise_name = nullif(trim(split_part(exercise_log, ': Set ', 1)), '')
where session_category = 'Strength'
  and exercise_name is null
  and exercise_log like '%: Set %'
  and exercise_log not like '%(swapped for %'
  and length(split_part(exercise_log, ': Set ', 1)) between 2 and 120;
