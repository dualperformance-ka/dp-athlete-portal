-- One canonical discovery week: week_number 0, labelled "Discovery Week".
--
-- The coaches' dashboard has written the same week two ways:
--
--   athlete_programme_weeks
--     BENNY · "Benny — 13-Week Gym Foundation"  week_number 1, "Discovery Week"
--     CHUNG · "Coach programme"                 week_number 0, "Week 0"
--
--   planned_sessions.week_label
--     "Week 0"          ALVIN (8), SHAUN (1)
--     "Discovery Week"  BENNY (10), CHUNG (7), KARL (1), THOMAS (7)
--
-- The portal tolerates both (public/js/05-handbook.js weekLabelCandidates, and
-- the nutritionWeek fallback in api/write.js), so nothing breaks either way.
-- This makes the stored data say one thing.
--
-- NOT APPLIED. Review, then run.
--
-- Note on the gap this leaves: Benny's gym programme numbers its weeks
-- 1 (Discovery), 2, 3 … 13, and its labels already read "Week 2" … "Week 13".
-- Moving Discovery to 0 leaves no week_number 1 in that programme, which is
-- correct — there is no week called "Week 1" in it. Do NOT renumber 2-13 down:
-- nutrition_plans.week_label holds "Week 2" … "Week 13" for this athlete and
-- is matched by label, so shifting the numbers would orphan every one of them.

begin;

-- 1 · The programme week itself.
update athlete_programme_weeks
   set week_number = 0,
       week_label  = 'Discovery Week',
       updated_at  = now()
 where lower(trim(week_label)) in ('discovery', 'discovery week', 'week 0')
    or week_number = 0;

-- 2 · The sessions hanging off it.
update planned_sessions
   set week_label = 'Discovery Week'
 where lower(trim(week_label)) in ('discovery', 'week 0');

-- 3 · nutrition_plans is deliberately NOT touched. Its week_label is the key
--     the portal builds from the week number ("Week " || n) for every week, and
--     the coaches' dashboard writes it the same way. Renaming it to "Discovery
--     Week" would break that lookup for the one week this migration is about.

commit;

-- Revert
-- begin;
--   update athlete_programme_weeks set week_number = 1, week_label = 'Discovery Week'
--    where id = 'f3cb00cc-4384-4bfd-8f6e-a16625d92789';            -- BENNY
--   update athlete_programme_weeks set week_label = 'Week 0'
--    where id = (select id from athlete_programme_weeks
--                 where programme_id = 'd5dfb610-66fc-4574-b472-cada4c931eb6'
--                   and week_number = 0);                          -- CHUNG
--   update planned_sessions set week_label = 'Week 0'
--    where athlete_code in ('ALVIN','SHAUN') and week_label = 'Discovery Week';
-- commit;
