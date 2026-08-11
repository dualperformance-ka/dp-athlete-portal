-- Give rep_mode its own column.
-- Applied to production 2026-08-10 via Supabase MCP.
--
-- The portal has always told the backend whether an exercise was logged as a
-- single reps figure ('reps') or per side ('left_right'), but the value only
-- ever landed inside raw_payload. Promoting it to a column makes unilateral
-- work directly queryable — "how much single-leg volume has this athlete
-- actually done?" stops needing a JSON dig.
--
-- Nullable and optional: api/ingest.js drops any column the schema cannot take
-- yet and retries, so deploy order does not matter.

alter table public.training_session_logs
  add column if not exists rep_mode text;

comment on column public.training_session_logs.rep_mode is
  '''left_right'' for unilateral work logged per side, ''reps'' for bilateral. Sent by the portal since launch; promoted out of raw_payload so single-leg volume is queryable.';

create index if not exists training_session_logs_rep_mode_idx
  on public.training_session_logs (athlete_code, rep_mode, session_date desc)
  where rep_mode is not null;
