-- The Calls tab carried three free-text "prep" questions that duplicated the
-- weekly check-in (wins, niggles) and synced through a state key that never
-- reached the database. Two of the three are dropped as duplicates. The third,
-- "one thing to decide with your coaches", is the only genuinely new prompt and
-- moves into the check-in's final step, which needs a column of its own.
--
-- Deliberately NOT upcoming_impact: that asks what is coming up that will
-- affect training, which is a different question, and conflating them would
-- corrupt the field coaches already read.
alter table public.weekly_checkins
  add column if not exists call_decision text;

comment on column public.weekly_checkins.call_decision is
  'Athlete-nominated decision to make on the coaching call. Added 2026-09-05 when the Calls tab prep questions were folded into the weekly check-in.';
