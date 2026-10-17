import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  aggregatePlannedEndurance,
  aggregateTraining,
  applyWeeklyTargets,
  classifySession,
  coachTargetsFromRows,
  isWeeklyTotalRow,
  manualRunKmForWeek,
  performanceSummary,
} from '../api/_lib/performance-summary.js';

// The weekly review's "planned" must be the same figure the Week tab dials
// show. The Week tab (js/05-handbook.js loadProgrammeVolume) takes, per sport:
// a published coach target for the programme week, then for running the
// nutrition plan's weekly km, then the planned sessions (with a "Weekly KM
// Total" row as a floor). The review used to sum the session rows only, so an
// athlete saw 23.2 km on one screen and 19.5 km "planned" on the next.

const WEEK_ID = 'a28d9ed7-db4f-4930-9a46-cde01a5b3c58';
const PROGRAMME_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const START = '2026-10-12';
const classify = (row) => classifySession(row, {});

// Karl's real week 3 (12–18 Oct 2026), as stored: two run sessions carry a
// typed distance (10.5 + 9.0), the Brick has none, one ride has 85 km, no swim
// has a distance. The coach published 23.2 km / 153 km / 4050 m.
let n = 0;
const session = (title, sessionType, date, distanceKm = null) => ({
  id: `p${++n}`, notion_page_id: `k${n}`, title, session_type: sessionType, planned_date: date,
  status: 'Planned', distance_km: distanceKm, library_id: null, week_label: 'Week 3', prescription_mode: null,
});
const WEEK_3 = [
  session('Gym: Upper', 'Strength', '2026-10-12'),
  session('Swim: Technique', 'Swim', '2026-10-12'),
  session('Gym: Lower A', 'Strength', '2026-10-13'),
  session('Run: VO2', 'VO2', '2026-10-13', '10.5'),
  session('Ride: Aerobic', 'Cycling', '2026-10-14'),
  session('Ride: Easy', 'Cycling', '2026-10-15'),
  session('Upper B (2 days / wk)', 'Strength', '2026-10-15'),
  session('Swim: CSS', 'Swim', '2026-10-15'),
  session('Run: Easy', 'Easy Effort', '2026-10-16', '9.0'),
  session('Gym: Lower B', 'Strength', '2026-10-16'),
  session('Ride: Easy', 'Cycling', '2026-10-17'),
  session('Swim: Continuous', 'Swim', '2026-10-17'),
  session('Run: Brick', 'Brick', '2026-10-18'),
  session('Ride: Long', 'Cycling', '2026-10-18', '85'),
];
const PUBLISHED = [
  { sport: 'running', distance_target_metres: 23200, session_target: 3, duration_target_minutes: 123, publish_state: 'published', removed_at: null },
  { sport: 'cycling', distance_target_metres: 153000, session_target: 4, duration_target_minutes: 390, publish_state: 'published', removed_at: null },
  { sport: 'swimming', distance_target_metres: 4050, session_target: 3, duration_target_minutes: 135, publish_state: 'published', removed_at: null },
];

function tables(over = {}) {
  return {
    athlete_programmes: [{ id: PROGRAMME_ID }],
    athlete_programme_weeks: [{ id: WEEK_ID, programme_id: PROGRAMME_ID, week_number: 3, week_label: 'Week 3', start_date: START }],
    planned_sessions: WEEK_3,
    session_logs: [], training_session_logs: [], daily_body_logs: [], weekly_checkins: [],
    strava_activities: [], workout_splits: [], session_exercises: [], run_steps: [],
    weekly_sport_targets: PUBLISHED,
    nutrition_plans: [],
    ...over,
  };
}
function deps(map, failures = new Set(), seen = []) {
  return {
    select: async (table, query) => {
      seen.push({ table, query });
      if (failures.has(table)) throw new Error(`relation "${table}" blew up`);
      const value = map[table];
      return typeof value === 'function' ? value(query) : (value || []);
    },
    now: () => new Date('2026-10-17T07:00:00.000Z'),
  };
}
const summaryFor = (map, failures, seen) => performanceSummary('KARL', { period: 'week', programmeWeekId: WEEK_ID }, deps(map, failures, seen));

test('the review reports the coach’s published weekly targets, matching the Week tab', async () => {
  const before = aggregatePlannedEndurance({ plannedRows: WEEK_3, classify });
  assert.equal(before.running.plannedDistanceKm, 19.5, 'the session sum the review used to show');
  assert.equal(before.cycling.plannedDistanceKm, 85);
  assert.equal(before.swimming.plannedDistanceKm, null);

  const { summary } = await summaryFor(tables());
  const { running, cycling, swimming } = summary.endurance;
  assert.equal(running.plannedDistanceKm, 23.2);
  assert.equal(running.plannedDistanceMetres, 23200);
  assert.equal(running.plannedDistanceSource, 'coach');
  assert.equal(running.sessionTarget, 3);
  assert.equal(running.durationTargetMinutes, 123);
  assert.equal(cycling.plannedDistanceKm, 153);
  assert.equal(cycling.sessionTarget, 4);
  assert.equal(swimming.plannedDistanceMetres, 4050, 'swim keeps exact metres, as the Week tab shows it');
  assert.equal(swimming.plannedDistanceKm, 4.05);
  assert.equal(swimming.plannedDistanceSource, 'coach');
  assert.deepEqual(summary.dataQuality.missingSources, []);
  // Completion counting is untouched by targets: 14 sessions were planned.
  assert.equal(summary.training.plannedSessions, 14);
  assert.equal(summary.training.byType.running.planned, 3);
});

test('only published, unremoved targets for this athlete and week are read', async () => {
  const seen = [];
  await summaryFor(tables(), new Set(), seen);
  const read = seen.find((entry) => entry.table === 'weekly_sport_targets');
  assert.ok(read, 'targets are read');
  assert.equal(read.query.athlete_code, 'eq.KARL');
  assert.equal(read.query.programme_week_id, `eq.${WEEK_ID}`);
  assert.equal(read.query.publish_state, 'eq.published');
  assert.equal(read.query.removed_at, 'is.null');
  // And the mapper ignores a draft or a removed row even if one slipped through.
  const mapped = coachTargetsFromRows([
    { sport: 'running', distance_target_metres: 30000, publish_state: 'draft', removed_at: null },
    { sport: 'cycling', distance_target_metres: 90000, publish_state: 'published', removed_at: '2026-10-01T00:00:00Z' },
    { sport: 'Swimming', distance_target_metres: 3000, session_target: null, duration_target_minutes: null, publish_state: 'published', removed_at: null },
  ]);
  assert.deepEqual(mapped, [{ sport: 'swimming', distanceTargetMetres: 3000, sessionTarget: null, durationTargetMinutes: null }]);
});

test('a coach target of zero is a prescription, not a missing value', () => {
  const planned = aggregatePlannedEndurance({ plannedRows: WEEK_3, classify });
  const out = applyWeeklyTargets(planned, { coachTargets: [{ sport: 'running', distanceTargetMetres: 0, sessionTarget: 0 }] });
  assert.equal(out.running.plannedDistanceKm, 0);
  assert.equal(out.running.plannedDistanceSource, 'coach');
  assert.equal(out.running.sessionTarget, 0);
  // Absent fields stay absent rather than becoming zero.
  const none = applyWeeklyTargets(planned, { coachTargets: [], manualRunKm: null });
  assert.equal(none.running.plannedDistanceKm, 19.5);
  assert.equal(none.running.plannedDistanceSource, 'typed');
  assert.equal(none.running.sessionTarget, null);
});

test('without a coach running target the nutrition plan’s weekly km wins, as on the Week tab', async () => {
  const nutrition = [{ week_label: 'Week 2', weekly_km_target: 18 }, { week_label: 'Week 3', weekly_km_target: 25 }];
  assert.equal(manualRunKmForWeek(nutrition, 3), 25);
  assert.equal(manualRunKmForWeek(nutrition, 4), null);
  assert.equal(manualRunKmForWeek([{ week_label: 'Week 3', weekly_km_target: null }], 3), null);
  const noRunTarget = PUBLISHED.filter((row) => row.sport !== 'running');
  const { summary } = await summaryFor(tables({ weekly_sport_targets: noRunTarget, nutrition_plans: nutrition }));
  assert.equal(summary.endurance.running.plannedDistanceKm, 25);
  assert.equal(summary.endurance.running.plannedDistanceSource, 'manual');
  // A published coach target still outranks it.
  const { summary: withTarget } = await summaryFor(tables({ nutrition_plans: nutrition }));
  assert.equal(withTarget.endurance.running.plannedDistanceKm, 23.2);
});

test('a "Weekly KM Total" row is a floor under running, never a session', () => {
  const total = { ...session('Weekly KM Total: 30km', 'Weekly KM Total', START), id: 'tot', notion_page_id: 'tot' };
  assert.equal(isWeeklyTotalRow(total), true);
  assert.equal(isWeeklyTotalRow(session('Run: Easy', 'Easy Effort', START)), false);
  const rows = WEEK_3.concat([total]);
  const training = aggregateTraining({ plannedRows: rows, loggedKeys: new Set(), todayISO: '2026-10-17', classify });
  assert.equal(training.plannedSessions, 14, 'it cannot be completed, so it is not a planned session');
  assert.equal(training.missedSessions.some((s) => s.title.includes('KM Total')), false);
  const planned = aggregatePlannedEndurance({ plannedRows: rows, classify });
  assert.equal(planned.running.plannedDistanceKm, 30, 'the declared total is a floor, not added on top');
  assert.equal(planned.running.plannedDistanceSource, 'declared');
  const low = aggregatePlannedEndurance({ plannedRows: WEEK_3.concat([{ ...total, title: 'Weekly KM Total: 12km' }]), classify });
  assert.equal(low.running.plannedDistanceKm, 19.5, 'sessions above the floor still win');
});

test('a failed target read falls back to the sessions and says the review is partial', async () => {
  const { summary } = await summaryFor(tables(), new Set(['weekly_sport_targets']));
  assert.equal(summary.endurance.running.plannedDistanceKm, 19.5);
  assert.equal(summary.endurance.running.plannedDistanceSource, 'typed');
  assert.deepEqual(summary.dataQuality.missingSources, ['weekly_sport_targets']);
  assert.equal(summary.dataQuality.partial, true);
});

test('a calendar-only week has no programme week, so no target read is attempted', async () => {
  const seen = [];
  await performanceSummary('KARL', { period: 'week', weekStart: START }, deps(tables(), new Set(), seen));
  assert.equal(seen.some((entry) => entry.table === 'weekly_sport_targets'), false);
  assert.equal(seen.some((entry) => entry.table === 'nutrition_plans'), false);
});

test('the Week tab and the review apply the same order of authority', () => {
  // The browser side of the contract: coach target, then nutrition km, then the
  // sessions with a declared total as a floor. If this changes, the shared rule
  // in api/_lib/performance-summary.js must change with it.
  const handbook = readFileSync(new URL('../public/js/05-handbook.js', import.meta.url), 'utf8');
  assert.match(handbook, /coachRun\?coachRun\.distanceTargetMetres\/1000:\(manual\[wk\]!=null\?manual\[wk\]:\(auto>0\?auto:null\)\)/);
  assert.match(handbook, /var auto=Math\.round\(Math\.max\(p\.sum,p\.declared\)\*10\)\/10;/);
});
