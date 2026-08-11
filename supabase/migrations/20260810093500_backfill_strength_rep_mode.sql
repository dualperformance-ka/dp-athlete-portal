-- Backfill rep_mode from raw_payload.
-- Applied to production 2026-08-10 via Supabase MCP (186 of 783 strength rows:
-- 178 'reps', 8 'left_right').
--
-- The remaining 597 rows predate the field entirely and are deliberately left
-- null rather than defaulted to 'reps': inferring bilateral from a missing
-- value would quietly misclassify any single-leg work in that history.

update public.training_session_logs
set rep_mode = nullif(trim(raw_payload->>'repMode'), '')
where session_category = 'Strength'
  and rep_mode is null
  and raw_payload->>'repMode' in ('reps', 'left_right');
