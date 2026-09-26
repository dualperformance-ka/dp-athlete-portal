-- Backfill athlete_programme_weeks.start_date for weeks created without one.
--
-- WHY
-- The 2026-08-17 "Migrated coach programme" import created programme weeks from
-- the old week labels but never set start_date. Both weekly reviews (coach
-- dashboard server/coach-weekly-summary.js and portal
-- api/_lib/performance-summary.js) drop any week without a start date, so for
-- these athletes there is no current week and the card reads
-- "Programme week not found" (Alvin, Nate, and older blocks for Jacob, Khang,
-- Shaun and Thomas).
--
-- WHAT IT FILLS, and only when the evidence is unambiguous
--   1. sessions:   every planned session linked to the week falls in one
--                  Monday-to-Sunday week -> start_date is that Monday.
--   2. neighbours: a week with no linked sessions (or sessions split across
--                  two weeks) whose nearest dated weeks in the same programme,
--                  below AND above, both place it on the same Monday at
--                  7 days per week number.
--   A proposed date that would give two weeks of one programme the same start
--   date is skipped. Weeks that already have a start_date are never touched.
--
-- WHAT IT LEAVES BLANK (checked 2026-09-26, 18 weeks)
--   CHUNG weeks 0-12 of the second, empty "Coach programme" (no sessions, no
--   dated weeks), BENNY week 2 and KARL week 6 (single empty weeks), and NATE
--   weeks 1, 4 and 6, whose linked sessions span several weeks and whose
--   numbering does not leave a clean slot. These need a coach decision, not a
--   guess. None of them is anyone's current week.
--
-- Dry run on production 2026-09-26: 101 weeks filled
--   ALVIN 21, JACOB 20, KHANG 16, NATE 21, SHAUN 12, THOMAS 11.
--   ALVIN and NATE current week becomes 2026-09-21.
--
-- Idempotent: a second run finds nothing to fill.

begin;

create temporary table _week_start_backfill on commit drop as
with nullw as (
  select w.id, w.programme_id, w.week_number
  from public.athlete_programme_weeks w
  where w.start_date is null
),
per_week as (
  select n.id, n.programme_id, n.week_number,
    date_trunc('week', min(s.planned_date))::date as mon_first,
    date_trunc('week', max(s.planned_date))::date as mon_last,
    count(s.id) as n_sessions
  from nullw n
  left join public.planned_sessions s on s.programme_week_id = n.id
  group by n.id, n.programme_id, n.week_number
),
direct as (
  select id, programme_id, week_number, mon_first as start_date
  from per_week
  where n_sessions > 0 and mon_first = mon_last
),
known as (
  select programme_id, week_number, start_date
  from public.athlete_programme_weeks where start_date is not null
  union all
  select programme_id, week_number, start_date from direct
),
gap as (
  select p.id, p.programme_id, p.week_number,
    (select k.start_date + (p.week_number - k.week_number) * 7 from known k
      where k.programme_id = p.programme_id and k.week_number < p.week_number
      order by k.week_number desc limit 1) as from_below,
    (select k.start_date - (k.week_number - p.week_number) * 7 from known k
      where k.programme_id = p.programme_id and k.week_number > p.week_number
      order by k.week_number asc limit 1) as from_above
  from per_week p
  where p.id not in (select id from direct)
),
proposed as (
  select id, programme_id, start_date, 'sessions'::text as how from direct
  union all
  select id, programme_id, from_below, 'neighbours' from gap
  where from_below is not null and from_above is not null and from_below = from_above
)
select pr.id, pr.start_date, pr.how
from proposed pr
where not exists (
    select 1 from proposed o
    where o.programme_id = pr.programme_id and o.id <> pr.id and o.start_date = pr.start_date)
  and not exists (
    select 1 from public.athlete_programme_weeks e
    where e.programme_id = pr.programme_id and e.id <> pr.id and e.start_date = pr.start_date);

update public.athlete_programme_weeks w
set start_date = b.start_date,
    updated_at = now()
from _week_start_backfill b
where w.id = b.id
  and w.start_date is null;

-- Safety: no programme may end up with two weeks on the same start date.
do $$
begin
  if exists (
    select 1 from public.athlete_programme_weeks
    where start_date is not null
    group by programme_id, start_date having count(*) > 1
  ) then
    raise exception 'backfill would duplicate a programme week start date; rolled back';
  end if;
end $$;

commit;

-- Check afterwards (read only):
-- select p.athlete_code, count(*) filter (where w.start_date is null) still_blank,
--        max(w.start_date) filter (where w.start_date <= current_date) current_week
-- from athlete_programme_weeks w join athlete_programmes p on p.id = w.programme_id
-- group by 1 order by 1;
