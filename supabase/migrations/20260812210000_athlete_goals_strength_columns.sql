-- Promote the Strength Goals card out of raw_payload.
-- Applied to production 2026-08-12 via Supabase MCP.
--
-- athlete_goals maps field by field into typed columns, so anything the mapping
-- misses lands only inside raw_payload. Every strength field the Goals page
-- collects was in that position: coaches could not see an athlete's lifting
-- intent, priority areas or key lift without a JSON dig, which defeats the
-- point of asking for them.
--
-- strength_priorities stays a comma-separated text list rather than text[] to
-- match how the portal submits it and how goal_race is already stored. Reps is
-- numeric, not integer, so a hand-typed half rep can never fail the whole write.
--
-- Nullable and optional: api/ingest.js drops any column the schema cannot take
-- yet and retries, so deploy order does not matter.

alter table public.athlete_goals
  add column if not exists strength_intent text,
  add column if not exists strength_priorities text,
  add column if not exists strength_lift text,
  add column if not exists strength_current_load numeric,
  add column if not exists strength_target_load numeric,
  add column if not exists strength_reps numeric;

comment on column public.athlete_goals.strength_intent is
  'What the athlete wants lifting to do for their running: Injury Resilience, Get Stronger, Build Muscle or Keep Muscle. Single choice — drives rep ranges and how hard load is pushed.';

comment on column public.athlete_goals.strength_priorities is
  'Up to two priority areas (e.g. ''Glutes, Calves & Achilles''), comma separated in the order the athlete picked them. Everything is still trained; these get the extra work.';

comment on column public.athlete_goals.strength_lift is
  'The one lift the athlete tracks over the block, e.g. trap-bar deadlift.';

comment on column public.athlete_goals.strength_current_load is
  'kg for a normal working set of strength_lift at strength_reps. Not a one-rep max.';

comment on column public.athlete_goals.strength_target_load is
  'kg target for the same working set at the end of the 12 weeks, with good form.';

comment on column public.athlete_goals.strength_reps is
  'Reps per set, held constant so current and target load stay comparable.';

create index if not exists athlete_goals_strength_intent_idx
  on public.athlete_goals (strength_intent)
  where strength_intent is not null;
