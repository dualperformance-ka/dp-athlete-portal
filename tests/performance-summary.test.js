import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SUMMARY_VERSION,
  addDaysISO,
  aggregateBodyweight,
  aggregateCheckIn,
  aggregateReadiness,
  aggregateStrength,
  aggregateTraining,
  buildSummary,
  classifySession,
  dailyReadiness,
  detectPersonalBests,
  isUuid,
  performanceSummary,
  plannedKmFromRow,
  programmeWeekLabel,
  safeKm,
  sanitise,
  titleKmFromName,
  volumeForRow,
  weekRangeFromStart,
  weekState,
} from '../api/_lib/performance-summary.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const WEEK_ID = '0f30b419-62ad-4bef-80e2-35eb71eb8ccb';
const OTHER_WEEK_ID = '11111111-2222-4333-8444-555555555555';
const PROGRAMME_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const START = '2026-09-21';
const END = '2026-09-27';

const classify = (row) => classifySession(row, {});

function planned(over = {}) {
  return {
    id: over.id || 'p1',
    notion_page_id: over.notion_page_id !== undefined ? over.notion_page_id : null,
    title: 'Easy Run',
    planned_date: START,
    session_type: 'Run',
    status: 'Planned',
    library_id: null,
    distance_km: null,
    week_label: 'Week 8',
    prescription_mode: null,
    ...over,
  };
}

function strengthRow(over = {}) {
  return {
    session_name: 'Upper A',
    session_category: 'Strength',
    session_date: START,
    exercise_name: 'Back Squat',
    programmed_exercise: 'Back Squat',
    raw_sets: [],
    ...over,
  };
}

// A stub `select` that answers from a table -> rows map, and can be told to
// throw for named tables so optional-source degradation is exercised for real.
function stubSelect(tables, failures = new Set()) {
  return async (table, query) => {
    if (failures.has(table)) throw new Error(`relation "${table}" blew up`);
    const value = tables[table];
    return typeof value === 'function' ? value(query) : (value || []);
  };
}

function summaryDeps(tables, failures) {
  return { select: stubSelect(tables, failures), now: () => new Date('2026-09-24T02:00:00.000Z') };
}

const BASE_TABLES = {
  athlete_programmes: [{ id: PROGRAMME_ID }],
  athlete_programme_weeks: [{
    id: WEEK_ID, programme_id: PROGRAMME_ID, week_number: 8, week_label: 'Week 8', start_date: START,
  }],
  planned_sessions: [],
  session_logs: [],
  training_session_logs: [],
  daily_body_logs: [],
  weekly_checkins: [],
  strava_activities: [],
  workout_splits: [],
  session_exercises: [],
  run_steps: [],
};

// ── 1. Malformed programme-week ids ──────────────────────────────────────────

test('a malformed programme-week id is rejected before any read', async () => {
  let reads = 0;
  const deps = { select: async () => { reads += 1; return []; }, now: () => new Date() };
  for (const bad of ['', 'not-a-uuid', '0f30b419-62ad-4bef-80e2', '../../etc/passwd', null]) {
    await assert.rejects(
      () => performanceSummary('KARL', { period: 'week', programmeWeekId: bad }, deps),
      (error) => error.status === 400,
    );
  }
  assert.equal(reads, 0, 'validation must happen before the database is touched');
  assert.equal(isUuid(WEEK_ID), true);
});

test('only the week period is accepted', async () => {
  await assert.rejects(
    () => performanceSummary('KARL', { period: 'month', programmeWeekId: WEEK_ID }, summaryDeps(BASE_TABLES)),
    (error) => error.status === 400,
  );
});

// ── 2. Another athlete's programme week ──────────────────────────────────────

test('a valid programme week belonging to another athlete returns 404, not data', async () => {
  const tables = {
    ...BASE_TABLES,
    // The week row exists, but the ownership join is scoped to this athlete's
    // programmes, so the query returns nothing.
    athlete_programme_weeks: (query) => (
      String(query.programme_id || '').includes(PROGRAMME_ID)
        ? []
        : [{ id: OTHER_WEEK_ID, programme_id: 'someone-else', week_number: 3, start_date: START }]
    ),
  };
  await assert.rejects(
    () => performanceSummary('KARL', { period: 'week', programmeWeekId: OTHER_WEEK_ID }, summaryDeps(tables)),
    (error) => error.status === 404 && /not found/i.test(error.message),
  );
});

test('an athlete with no programme gets the same 404 as an unknown week', async () => {
  const tables = { ...BASE_TABLES, athlete_programmes: [] };
  await assert.rejects(
    () => performanceSummary('KARL', { period: 'week', programmeWeekId: WEEK_ID }, summaryDeps(tables)),
    (error) => error.status === 404 && /not found/i.test(error.message),
  );
});

test('the athlete code is taken from the caller and never from the body', async () => {
  const seen = [];
  const deps = {
    select: async (table, query) => {
      seen.push(String(query.athlete_code || ''));
      return stubSelect(BASE_TABLES)(table, query);
    },
    now: () => new Date('2026-09-24T02:00:00.000Z'),
  };
  await performanceSummary('KARL', {
    period: 'week', programmeWeekId: WEEK_ID, athleteCode: 'SOMEONE', code: 'SOMEONE',
  }, deps);
  const scoped = seen.filter(Boolean);
  assert.ok(scoped.length > 0);
  assert.ok(scoped.every((value) => value === 'eq.KARL'), scoped.join(','));
});

// ── 3. Discovery week ────────────────────────────────────────────────────────

test('discovery week is week number 0 and labelled Discovery Week', async () => {
  const tables = {
    ...BASE_TABLES,
    athlete_programme_weeks: [{
      id: WEEK_ID, programme_id: PROGRAMME_ID, week_number: 0, week_label: 'Week 0', start_date: START,
    }],
  };
  const { summary } = await performanceSummary('KARL', { period: 'week', programmeWeekId: WEEK_ID }, summaryDeps(tables));
  assert.equal(summary.period.weekNumber, 0);
  assert.equal(summary.period.label, 'Discovery Week');
  // The stored label varies by athlete ("Week 0" / "Discovery Week"); the
  // number is the authority.
  assert.equal(programmeWeekLabel(0, 'Discovery Week'), 'Discovery Week');
  assert.equal(programmeWeekLabel(0, 'Week 0'), 'Discovery Week');
});

// ── 4. Week boundaries and UTC ───────────────────────────────────────────────

test('week boundaries do not shift under any process timezone', () => {
  const original = process.env.TZ;
  try {
    for (const zone of ['UTC', 'Australia/Adelaide', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      process.env.TZ = zone;
      assert.deepEqual(weekRangeFromStart('2026-09-21'), { startDate: '2026-09-21', endDate: '2026-09-27' });
      // Across a DST change and a month/year boundary.
      assert.deepEqual(weekRangeFromStart('2026-10-01'), { startDate: '2026-10-01', endDate: '2026-10-07' });
      assert.deepEqual(weekRangeFromStart('2026-12-28'), { startDate: '2026-12-28', endDate: '2027-01-03' });
      assert.equal(addDaysISO('2026-03-01', -1), '2026-02-28');
      assert.equal(addDaysISO('2028-03-01', -1), '2028-02-29');
    }
  } finally {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
});

test('week state is decided against the Adelaide local date', () => {
  assert.equal(weekState(START, END, '2026-09-24'), 'current');
  assert.equal(weekState(START, END, '2026-09-21'), 'current');
  assert.equal(weekState(START, END, '2026-09-27'), 'current');
  assert.equal(weekState(START, END, '2026-09-28'), 'past');
  assert.equal(weekState(START, END, '2026-09-20'), 'future');
});

// ── 5. Drafts and rest sessions ──────────────────────────────────────────────

test('draft sessions never reach the summary and rest days are not counted', async () => {
  const tables = {
    ...BASE_TABLES,
    planned_sessions: (query) => {
      // The draft guarantee is the query filter, so assert it is asked for.
      assert.equal(query.publish_state, 'eq.published');
      return [
        planned({ id: 'run', title: 'Easy Run 8km' }),
        planned({ id: 'rest', title: 'Rest', session_type: 'Rest' }),
        planned({ id: 'free', title: 'Free Day' }),
        planned({ id: 'recovery', title: 'Recovery day' }),
      ];
    },
  };
  const { summary } = await performanceSummary('KARL', { period: 'week', programmeWeekId: WEEK_ID }, summaryDeps(tables));
  assert.equal(summary.training.plannedSessions, 1);
});

// ── 6 & 7. Completion keys ───────────────────────────────────────────────────

test('an exact session key completes the session, and notion_page_id wins over id', () => {
  const rows = [
    planned({ id: 'db-id-1', notion_page_id: 'notion-1', title: 'Easy Run' }),
    planned({ id: 'db-id-2', notion_page_id: null, title: 'Long Run' }),
  ];
  const result = aggregateTraining({
    plannedRows: rows,
    loggedKeys: new Set(['notion-1', 'db-id-2']),
    todayISO: '2026-09-24',
    classify,
  });
  assert.equal(result.completedSessions, 2);

  // Keying on the database id when a notion_page_id exists must NOT complete it.
  const wrongKey = aggregateTraining({
    plannedRows: [rows[0]],
    loggedKeys: new Set(['db-id-1']),
    todayISO: '2026-09-24',
    classify,
  });
  assert.equal(wrongKey.completedSessions, 0);
});

test('an activity on the same day does not complete an unrelated planned session', () => {
  const result = aggregateTraining({
    plannedRows: [planned({ id: 'session-a', notion_page_id: 'key-a', planned_date: '2026-09-22' })],
    // A different session was logged on the same date.
    loggedKeys: new Set(['key-b']),
    todayISO: '2026-09-24',
    classify,
  });
  assert.equal(result.completedSessions, 0);
  assert.equal(result.missedSessions.length, 1);
  assert.equal(result.missedSessions[0].date, '2026-09-22');
});

// ── 8 & 9. Missed sessions ───────────────────────────────────────────────────

test('a future session is never missed', () => {
  const result = aggregateTraining({
    plannedRows: [planned({ id: 'future', notion_page_id: 'k', planned_date: '2026-09-26' })],
    loggedKeys: new Set(),
    todayISO: '2026-09-24',
    classify,
  });
  assert.deepEqual(result.missedSessions, []);
  assert.equal(result.completionPercent, 0);
});

test("today's session is not missed while the day is still in progress", () => {
  const result = aggregateTraining({
    plannedRows: [
      planned({ id: 'today', notion_page_id: 'k1', planned_date: '2026-09-24' }),
      planned({ id: 'yesterday', notion_page_id: 'k2', planned_date: '2026-09-23' }),
    ],
    loggedKeys: new Set(),
    todayISO: '2026-09-24',
    classify,
  });
  assert.deepEqual(result.missedSessions.map((item) => item.id), ['yesterday']);
});

// ── 10. No planned sessions ──────────────────────────────────────────────────

test('no planned sessions produces a null completion percent, not 0 and not 100', () => {
  const result = aggregateTraining({ plannedRows: [], loggedKeys: new Set(), todayISO: '2026-09-24', classify });
  assert.equal(result.plannedSessions, 0);
  assert.equal(result.completedSessions, 0);
  assert.equal(result.completionPercent, null);
});

// ── 11. Strength session counting ────────────────────────────────────────────

test('one training_session_logs row per exercise does not inflate the session count', () => {
  const rows = ['Back Squat', 'Leg Press', 'Leg Curl', 'Calf Raise'].map((name) => strengthRow({
    exercise_name: name,
    raw_sets: [{ weight: '60', reps: '10' }],
  }));
  const result = aggregateStrength({
    trainingLogs: rows,
    startDate: START,
    endDate: END,
    plannedStrength: 2,
    completedPlannedStrength: 1,
  });
  // Completed strength SESSIONS come from the planned-session completion pass,
  // never from counting exercise rows.
  assert.equal(result.completedSessions, 1);
  assert.equal(result.plannedSessions, 2);
  assert.equal(result.exercisesLogged, 4);
  assert.equal(result.workingSets, 4);
});

// ── 12, 13, 14, 15. Volume ───────────────────────────────────────────────────

test('bilateral volume is weight times reps', () => {
  const volume = volumeForRow(strengthRow({
    raw_sets: [{ weight: '100', reps: '5' }, { weight: '90', reps: '8' }],
  }));
  assert.equal(volume.volumeKg, 100 * 5 + 90 * 8);
  assert.equal(volume.measured, 2);
});

test('left/right reps are summed before multiplying by the load', () => {
  const volume = volumeForRow(strengthRow({
    exercise_name: 'Bulgarian Split Squat',
    raw_sets: [{ weight: '20', repsLeft: '8', repsRight: '7' }],
  }));
  assert.equal(volume.volumeKg, 20 * 15);
  assert.equal(volume.workingSets, 1);
});

test('an invalid or empty set is not a zero-volume set', () => {
  const volume = volumeForRow(strengthRow({
    raw_sets: [
      { weight: '100', reps: '5' },      // measured
      { weight: '', reps: '' },          // untouched row — not a set at all
      { weight: 'abc', reps: '10' },     // unparseable load — work, not tonnage
      { weight: '', reps: '12' },        // bodyweight — work, no measurable load
    ],
  }));
  assert.equal(volume.volumeKg, 500);
  assert.equal(volume.workingSets, 3, 'the empty row is not work; the other three are');
  assert.equal(volume.measured, 1);
  assert.equal(volume.excluded, 2, 'unmeasured sets are reported, not silently zeroed');
});

test('bodyweight work raises the set count without changing measurable volume', () => {
  const result = aggregateStrength({
    trainingLogs: [strengthRow({
      exercise_name: 'Push Up',
      raw_sets: [{ reps: '20' }, { reps: '18' }],
    })],
    startDate: START,
    endDate: END,
  });
  assert.equal(result.workingSets, 2);
  assert.equal(result.measurableVolumeKg, 0);
  assert.equal(result.volumeCoverage.eligibleSets, 2);
  assert.equal(result.volumeCoverage.measuredSets, 0);
});

test('assisted movements are excluded from tonnage', () => {
  const result = aggregateStrength({
    trainingLogs: [
      strengthRow({ exercise_name: 'Assisted Pull Up', raw_sets: [{ weight: '30', reps: '10' }] }),
      strengthRow({ exercise_name: 'Back Squat', raw_sets: [{ weight: '100', reps: '5' }] }),
    ],
    startDate: START,
    endDate: END,
  });
  assert.equal(result.measurableVolumeKg, 500, 'assistance supplied is not load lifted');
  assert.equal(result.workingSets, 2, 'the assisted set is still work the athlete did');
  assert.equal(result.volumeCoverage.eligibleSets, 1);
});

test('a historic row with no structured sets is excluded and reported, not guessed at', () => {
  const result = aggregateStrength({
    trainingLogs: [strengthRow({ raw_sets: null, exercise_log: 'Back Squat: Set 1: 100kg x 5' })],
    startDate: START,
    endDate: END,
  });
  assert.equal(result.workingSets, 0);
  assert.equal(result.volumeCoverage.unparsedRows, true);
  assert.equal(result.measurableVolumeKg, null, 'nothing measurable is null, not zero');
});

// ── 16 & 17. Personal bests ──────────────────────────────────────────────────

test('a first-ever strength entry seeds history without claiming a PB', () => {
  const hits = detectPersonalBests({
    historyRows: [strengthRow({ raw_sets: [{ weight: '100', reps: '5' }] })],
    startDate: START,
    endDate: END,
  });
  assert.deepEqual(hits, []);
});

test('a PB this week is measured against all prior history, not only this week', () => {
  const history = [
    strengthRow({ session_date: '2026-09-07', session_name: 'Lower A', raw_sets: [{ weight: '100', reps: '5' }] }),
    strengthRow({ session_date: '2026-09-14', session_name: 'Lower A', raw_sets: [{ weight: '105', reps: '5' }] }),
    strengthRow({ session_date: '2026-09-23', session_name: 'Lower A', raw_sets: [{ weight: '110', reps: '5' }] }),
  ];
  const hits = detectPersonalBests({ historyRows: history, startDate: START, endDate: END });
  const load = hits.find((hit) => hit.type === 'load');
  assert.ok(load, 'the heavier set is a load PB');
  assert.equal(load.value, 110);
  assert.equal(load.previous, 105, 'compared with the best prior week, not the first');
  assert.equal(load.date, '2026-09-23');
});

test('history after the requested week never influences that week', () => {
  const history = [
    strengthRow({ session_date: '2026-09-14', session_name: 'Lower A', raw_sets: [{ weight: '100', reps: '5' }] }),
    strengthRow({ session_date: '2026-09-23', session_name: 'Lower A', raw_sets: [{ weight: '110', reps: '5' }] }),
    strengthRow({ session_date: '2026-10-05', session_name: 'Lower A', raw_sets: [{ weight: '130', reps: '5' }] }),
  ];
  const hits = detectPersonalBests({ historyRows: history, startDate: START, endDate: END });
  assert.equal(hits.filter((hit) => hit.type === 'load').length, 1);
  assert.equal(hits.find((hit) => hit.type === 'load').value, 110);
});

test('assisted movements never produce a PB', () => {
  const history = [
    strengthRow({ exercise_name: 'Assisted Pull Up', session_date: '2026-09-14', session_name: 'Upper A', raw_sets: [{ weight: '40', reps: '8' }] }),
    strengthRow({ exercise_name: 'Assisted Pull Up', session_date: '2026-09-23', session_name: 'Upper A', raw_sets: [{ weight: '60', reps: '12' }] }),
  ];
  assert.deepEqual(detectPersonalBests({ historyRows: history, startDate: START, endDate: END }), []);
});

test('PB output carries only the achieved facts the card needs', () => {
  const history = [
    strengthRow({ session_date: '2026-09-14', session_name: 'Lower A', raw_sets: [{ weight: '100', reps: '5' }] }),
    strengthRow({ session_date: '2026-09-23', session_name: 'Lower A', raw_sets: [{ weight: '110', reps: '5' }] }),
  ];
  const hits = detectPersonalBests({ historyRows: history, startDate: START, endDate: END });
  hits.forEach((hit) => {
    assert.deepEqual(
      Object.keys(hit).sort(),
      ['date', 'delta', 'exercise', 'previous', 'type', 'unit', 'value'],
    );
  });
});

test('PB status is explicitly unavailable when the history read fails', async () => {
  const tables = { ...BASE_TABLES, planned_sessions: [planned({ notion_page_id: 'k' })] };
  // Every training_session_logs read fails, which includes the history read.
  const { summary } = await performanceSummary(
    'KARL', { period: 'week', programmeWeekId: WEEK_ID },
    summaryDeps(tables, new Set(['training_session_logs'])),
  );
  assert.equal(summary.strength.personalBestsStatus, 'not_calculated');
  assert.deepEqual(summary.strength.personalBests, []);
  assert.equal(summary.dataQuality.partial, true);
  assert.ok(summary.dataQuality.missingSources.includes('strength_history'));
});

// ── 18, 19, 20. Readiness ────────────────────────────────────────────────────

test('partial readiness inputs average only the components that were logged', () => {
  // Sleep 7 -> 70, stress 3 -> 80. Energy and soreness are absent.
  assert.equal(dailyReadiness({ sleep: 7, stress: 3 }), 75);
  // All four: 70, 60, (11-4)*10 = 70, (11-2)*10 = 90 -> 72.5 -> 73
  assert.equal(dailyReadiness({ sleep: 7, energy: 6, soreness: 4, stress: 2 }), 73);
  assert.equal(dailyReadiness({}), null);
  assert.equal(dailyReadiness(null), null);
});

test('a missing readiness component is omitted, never treated as zero', () => {
  const withEnergy = dailyReadiness({ sleep: 8, energy: 8 });
  const withoutEnergy = dailyReadiness({ sleep: 8 });
  assert.equal(withEnergy, 80);
  assert.equal(withoutEnergy, 80, 'a missing energy score must not drag the day to 40');
});

test('unlogged days do not become zero-readiness days', () => {
  const result = aggregateReadiness({
    weekLogs: [{ sleep: 8, energy: 8 }, { sleep: 8, energy: 8 }],
    previousWeekLogs: [],
  });
  assert.equal(result.daysLogged, 2, 'only days with a valid score are counted');
  assert.equal(result.average, 80, 'five unlogged days must not average the week down');
});

test('the previous-week readiness comparison is the difference of the two averages', () => {
  const result = aggregateReadiness({
    weekLogs: [{ sleep: 7, energy: 7 }],                 // 70
    previousWeekLogs: [{ sleep: 8, energy: 8 }],         // 80
  });
  assert.equal(result.average, 70);
  assert.equal(result.previousWeekAverage, 80);
  assert.equal(result.changeFromPreviousWeek, -10);
});

test('with no previous week logged the comparison is null rather than a fabricated change', () => {
  const result = aggregateReadiness({ weekLogs: [{ sleep: 7 }], previousWeekLogs: [] });
  assert.equal(result.previousWeekAverage, null);
  assert.equal(result.changeFromPreviousWeek, null);
});

test('component averages come back to one decimal place and readiness as whole numbers', () => {
  const result = aggregateReadiness({
    weekLogs: [{ sleep: 7, energy: 6, soreness: 5, stress: 8 }, { sleep: 6, energy: 7, soreness: 6, stress: 7 }],
    previousWeekLogs: null,
  });
  assert.equal(result.sleepAverage, 6.5);
  assert.equal(result.stressAverage, 7.5);
  assert.equal(Number.isInteger(result.average), true);
});

// ── 21. Bodyweight ───────────────────────────────────────────────────────────

test('one bodyweight entry is a reading, not a change', () => {
  const result = aggregateBodyweight([{ log_date: START, weight: '86.4' }]);
  assert.equal(result.entries, 1);
  assert.equal(result.firstKg, 86.4);
  assert.equal(result.lastKg, 86.4);
  assert.equal(result.changeKg, null);
});

test('bodyweight change is first to last in date order', () => {
  const result = aggregateBodyweight([
    { log_date: '2026-09-27', weight: '85.9' },
    { log_date: '2026-09-21', weight: '86.4' },
    { log_date: '2026-09-24', weight: '86.0' },
  ]);
  assert.equal(result.entries, 3);
  assert.equal(result.firstDate, '2026-09-21');
  assert.equal(result.lastDate, '2026-09-27');
  assert.equal(result.changeKg, -0.5);
});

test('no bodyweight entries leaves every figure null', () => {
  assert.deepEqual(aggregateBodyweight([]), {
    entries: 0, firstKg: null, lastKg: null, changeKg: null, firstDate: null, lastDate: null,
  });
});

// ── 22, 23, 24. What must never be returned ──────────────────────────────────

test('check-in free text is never returned', async () => {
  const tables = {
    ...BASE_TABLES,
    weekly_checkins: (query) => {
      // Only the two fields the summary needs may even be projected.
      assert.equal(query.select, 'week_ending,submitted_at');
      return [{ week_ending: END, submitted_at: '2026-09-27T09:42:18.000Z' }];
    },
  };
  const { summary } = await performanceSummary('KARL', { period: 'week', programmeWeekId: WEEK_ID }, summaryDeps(tables));
  assert.deepEqual(Object.keys(summary.checkIn).sort(), ['submitted', 'submittedAt', 'weekEnding']);
  assert.equal(summary.checkIn.submitted, true);

  // And the aggregator itself drops text even when handed it.
  const withText = aggregateCheckIn({
    rows: [{ week_ending: END, submitted_at: 'x', run_wins: 'felt strong', run_niggles: 'left knee', testimonial: 'great block' }],
    startDate: START,
    endDate: END,
  });
  assert.equal(JSON.stringify(withText).includes('knee'), false);
  assert.equal(JSON.stringify(withText).includes('strong'), false);
});

test('raw sets never reach the response', async () => {
  const tables = {
    ...BASE_TABLES,
    planned_sessions: [planned({ notion_page_id: 'k', title: 'Upper A', session_type: 'Strength' })],
    training_session_logs: [strengthRow({
      raw_sets: [{ weight: '100', reps: '5', rpe: '8', secretNote: 'do-not-leak' }],
    })],
  };
  const { summary } = await performanceSummary('KARL', { period: 'week', programmeWeekId: WEEK_ID }, summaryDeps(tables));
  const serialised = JSON.stringify(summary);
  assert.equal(serialised.includes('do-not-leak'), false);
  assert.equal(serialised.includes('raw_sets'), false);
  assert.equal(serialised.includes('rawSets'), false);
  assert.equal(summary.strength.workingSets, 1);
});

test('raw Strava rows never reach the response, only aggregates', async () => {
  const tables = {
    ...BASE_TABLES,
    planned_sessions: [planned({ notion_page_id: 'k', title: 'Easy Run 10km' })],
    strava_activities: (query) => {
      // The raw payload column must not even be asked for.
      assert.equal(query.select.includes('summary'), false);
      assert.equal(query.select.includes('detail'), false);
      return [
        { sport_type: 'Run', start_date_local: '2026-09-22T06:00:00+09:30', distance_m: 10200, moving_time_s: 3000, elapsed_time_s: 3100 },
        { sport_type: 'Run', start_date_local: '2026-09-25T06:00:00+09:30', distance_m: 8000, moving_time_s: 2400, elapsed_time_s: 2500 },
      ];
    },
  };
  const { summary } = await performanceSummary('KARL', { period: 'week', programmeWeekId: WEEK_ID }, summaryDeps(tables));
  const serialised = JSON.stringify(summary);
  assert.equal(serialised.includes('strava_activity_id'), false);
  assert.equal(serialised.includes('start_date_local'), false);
  assert.equal(serialised.includes('sport_type'), false);
  assert.deepEqual(summary.endurance.running, {
    plannedDistanceKm: 10,
    plannedDistanceSource: 'title',
    actualSessions: 2,
    actualDistanceKm: 18.2,
    actualDurationMinutes: 90,
    actualSource: 'strava',
  });
});

test('Strava and portal logs are never added together for the same metric', async () => {
  const tables = {
    ...BASE_TABLES,
    planned_sessions: [planned({ notion_page_id: 'k' })],
    strava_activities: [
      { sport_type: 'Run', start_date_local: '2026-09-22T06:00:00+09:30', distance_m: 10000, moving_time_s: 3000 },
    ],
    training_session_logs: [
      { session_name: 'Easy Run', session_category: 'Run', session_date: '2026-09-22', distance_km: 10, duration_min: 50, raw_sets: null },
    ],
  };
  const { summary } = await performanceSummary('KARL', { period: 'week', programmeWeekId: WEEK_ID }, summaryDeps(tables));
  assert.equal(summary.endurance.running.actualDistanceKm, 10, 'one run, counted once');
  assert.equal(summary.endurance.running.actualSessions, 1);
  assert.equal(summary.endurance.running.actualSource, 'strava');
});

test('without Strava the confirmed portal logs are used and the source says so', async () => {
  const tables = {
    ...BASE_TABLES,
    planned_sessions: [planned({ notion_page_id: 'k' })],
    training_session_logs: [
      { session_name: 'Easy Run', session_category: 'Run', session_date: '2026-09-22', distance_km: 9.5, duration_min: 52, raw_sets: null },
    ],
  };
  const { summary } = await performanceSummary(
    'KARL', { period: 'week', programmeWeekId: WEEK_ID },
    summaryDeps(tables, new Set(['strava_activities'])),
  );
  assert.equal(summary.endurance.running.actualSource, 'portal_logs');
  assert.equal(summary.endurance.running.actualDistanceKm, 9.5);
  assert.ok(summary.dataQuality.missingSources.includes('strava_activities'));
});

// ── 25 & 26. Partial data ────────────────────────────────────────────────────

test('an optional source failure returns the rest of the summary as a partial', async () => {
  const tables = { ...BASE_TABLES, planned_sessions: [planned({ notion_page_id: 'k', title: 'Easy Run 10km' })] };
  const { summary } = await performanceSummary(
    'KARL', { period: 'week', programmeWeekId: WEEK_ID },
    summaryDeps(tables, new Set(['daily_body_logs', 'strava_activities'])),
  );
  assert.equal(summary.training.plannedSessions, 1, 'the training section still renders');
  assert.equal(summary.dataQuality.partial, true);
  assert.deepEqual(summary.dataQuality.missingSources, ['daily_body_logs', 'daily_body_logs_previous', 'strava_activities']);
  assert.equal(summary.readiness.average, null);
  assert.equal(summary.readiness.daysLogged, 0);
  assert.equal(summary.bodyweight.changeKg, null);
});

test('a raw database error message never reaches the response', async () => {
  const tables = { ...BASE_TABLES, planned_sessions: [planned({ notion_page_id: 'k' })] };
  const { summary } = await performanceSummary(
    'KARL', { period: 'week', programmeWeekId: WEEK_ID },
    summaryDeps(tables, new Set(['daily_body_logs'])),
  );
  assert.equal(JSON.stringify(summary).includes('blew up'), false);
  assert.equal(JSON.stringify(summary).includes('relation'), false);
});

test('every unavailable metric is null and every verified count is a number', async () => {
  const tables = { ...BASE_TABLES, planned_sessions: [] };
  const { summary } = await performanceSummary(
    'KARL', { period: 'week', programmeWeekId: WEEK_ID },
    summaryDeps(tables, new Set(['strava_activities', 'daily_body_logs'])),
  );
  // Unavailable → null.
  assert.equal(summary.training.completionPercent, null);
  assert.equal(summary.readiness.average, null);
  assert.equal(summary.bodyweight.firstKg, null);
  assert.equal(summary.endurance.running.actualDistanceKm, null);
  assert.equal(summary.endurance.running.actualSource, 'unavailable');
  // Verified → a real number.
  assert.equal(summary.training.plannedSessions, 0);
  assert.equal(summary.training.completedSessions, 0);
  assert.equal(summary.strength.workingSets, 0);
  // Arrays are always arrays.
  assert.ok(Array.isArray(summary.training.missedSessions));
  assert.ok(Array.isArray(summary.strength.personalBests));
  assert.ok(Array.isArray(summary.attention));
  assert.ok(Array.isArray(summary.dataQuality.missingSources));
  assert.ok(Array.isArray(summary.dataQuality.warnings));
});

// ── 27. Nothing non-finite ───────────────────────────────────────────────────

test('the response contains no NaN, Infinity or undefined', async () => {
  const tables = {
    ...BASE_TABLES,
    planned_sessions: [
      planned({ id: 'a', notion_page_id: 'ka', title: 'Easy Run — not a number km' }),
      planned({ id: 'b', notion_page_id: 'kb', title: 'Upper A', session_type: 'Strength' }),
    ],
    training_session_logs: [strengthRow({ raw_sets: [{ weight: 'x', reps: 'y' }] })],
    daily_body_logs: [{ log_date: START, weight: 'not-a-number', sleep: 'nope', energy: 7 }],
    strava_activities: [{ sport_type: 'Run', start_date_local: '2026-09-22T06:00:00+09:30', distance_m: 'bad', moving_time_s: null }],
  };
  const { summary } = await performanceSummary('KARL', { period: 'week', programmeWeekId: WEEK_ID }, summaryDeps(tables));
  const walk = (value, path) => {
    if (value === undefined) assert.fail(`undefined at ${path}`);
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `non-finite at ${path}: ${value}`);
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`));
    else if (value && typeof value === 'object') Object.keys(value).forEach((key) => walk(value[key], `${path}.${key}`));
  };
  walk(summary, 'summary');
  assert.equal(JSON.stringify(summary).includes('null'), true, 'nulls are expected and explicit');
  assert.equal(/NaN|Infinity/.test(JSON.stringify(summary)), false);
});

test('the sanitiser converts non-finite values and reports where they were', () => {
  const warnings = [];
  const clean = sanitise({ a: NaN, b: Infinity, c: undefined, d: [1, NaN], e: 'text' }, 'root', warnings);
  assert.deepEqual(clean, { a: null, b: null, c: null, d: [1, null], e: 'text' });
  assert.deepEqual(warnings, ['root.a', 'root.b', 'root.c', 'root.d[1]']);
});

// ── Classification and distance ──────────────────────────────────────────────

test('session classification is centralised and covers every contract type', () => {
  assert.equal(classify(planned({ title: 'Easy Run 10km', session_type: 'Run' })), 'running');
  assert.equal(classify(planned({ title: 'Upper A', session_type: 'Strength' })), 'strength');
  assert.equal(classify(planned({ title: 'Lower B', session_type: '' })), 'strength');
  assert.equal(classify(planned({ title: 'Easy Ride 40km', session_type: 'Ride' })), 'cycling');
  assert.equal(classify(planned({ title: 'Swim 1500m', session_type: 'Swim' })), 'swimming');
  assert.equal(classify(planned({ title: 'Programme notes', session_type: 'note' })), 'other');
  // A coach-built session with exercises and no run steps is strength.
  const structured = new Map([['s1', { exercises: 8, runSteps: 0 }]]);
  assert.equal(classifySession(planned({ id: 's1', title: 'Session', prescription_mode: 'structured' }), { structured }), 'strength');
  // One that also carries run steps stays run-led.
  const mixed = new Map([['s2', { exercises: 3, runSteps: 4 }]]);
  assert.equal(classifySession(planned({ id: 's2', title: 'Session', prescription_mode: 'structured' }), { structured: mixed }), 'running');
});

test('interval notation is never read as weekly distance', () => {
  assert.equal(titleKmFromName('5x1km Threshold'), 0);
  assert.equal(titleKmFromName('3km pace'), 0);
  assert.equal(titleKmFromName('8 x 400m reps'), 0);
  assert.equal(titleKmFromName('Easy Run — 12km'), 12);
  assert.equal(titleKmFromName('Long Run 18km'), 18);
});

test('durations and absurd distances are rejected', () => {
  assert.equal(safeKm('45min'), 0);
  assert.equal(safeKm('1 hour'), 0);
  assert.equal(safeKm('90 sec'), 0);
  assert.equal(safeKm('250'), 0, 'over 200km is not a session');
  assert.equal(safeKm('0'), 0);
  assert.equal(safeKm('12,5'), 12.5);
});

test('planned distance reports which source produced it', () => {
  assert.deepEqual(plannedKmFromRow({ distance_km: '14' }), { km: 14, source: 'typed' });
  assert.deepEqual(
    plannedKmFromRow({ library_id: 'lib-1' }, { 'lib-1': { distance: '10' } }),
    { km: 10, source: 'library' },
  );
  assert.deepEqual(plannedKmFromRow({ title: 'Easy Run 8km' }), { km: 8, source: 'title' });
  assert.deepEqual(plannedKmFromRow({ title: '5x1km Threshold' }), { km: 0, source: 'none' });
});

// ── Attention items ──────────────────────────────────────────────────────────

test('attention items are factual, deduplicated and ordered by severity', () => {
  const summary = buildSummary({
    programmeWeek: { id: WEEK_ID, weekNumber: 8, weekLabel: 'Week 8', startDate: START },
    plannedRows: [
      planned({ id: 'a', notion_page_id: 'ka', planned_date: '2026-09-21' }),
      planned({ id: 'b', notion_page_id: 'kb', planned_date: '2026-09-22' }),
      planned({ id: 'c', notion_page_id: 'kc', planned_date: '2026-09-23' }),
    ],
    loggedKeys: new Set(),
    bodyLogs: [
      { log_date: '2026-09-21', sleep: 3, energy: 2, soreness: 9, stress: 9, raw_payload: { pain: 6, painLocation: 'Knee' } },
      { log_date: '2026-09-22', sleep: 3, energy: 2, soreness: 9, stress: 9, raw_payload: { pain: 7, painLocation: 'Knee' } },
    ],
    todayISO: '2026-09-24',
    generatedAt: '2026-09-24T02:00:00.000Z',
  });
  const codes = summary.attention.map((item) => item.code);
  assert.deepEqual(new Set(codes).size, codes.length, 'no duplicates');
  assert.equal(summary.attention[0].severity, 'high');
  assert.ok(codes.includes('pain_reported'));
  assert.ok(codes.includes('sessions_not_logged'));
  assert.ok(codes.includes('high_stress'));
  assert.ok(codes.includes('low_energy'));

  const pain = summary.attention.find((item) => item.code === 'pain_reported');
  assert.equal(pain.message, 'Knee pain was recorded on 2 days.');
  // Factual only: nothing diagnoses, advises or congratulates.
  summary.attention.forEach((item) => {
    assert.equal(/should|try|push through|great|well done|keep it up|injur/i.test(item.message), false, item.message);
  });
});

test('a missing check-in is only flagged once the week has finished', () => {
  const base = {
    programmeWeek: { id: WEEK_ID, weekNumber: 8, weekLabel: 'Week 8', startDate: START },
    plannedRows: [],
    loggedKeys: new Set(),
    generatedAt: '2026-09-24T02:00:00.000Z',
  };
  const current = buildSummary({ ...base, todayISO: '2026-09-24' });
  assert.equal(current.attention.some((item) => item.code === 'checkin_missing'), false);
  const past = buildSummary({ ...base, todayISO: '2026-10-05' });
  assert.equal(past.attention.some((item) => item.code === 'checkin_missing'), true);
});

// ── Contract shape ───────────────────────────────────────────────────────────

test('the response carries its contract version and generation timestamp', async () => {
  const { summary } = await performanceSummary('KARL', { period: 'week', programmeWeekId: WEEK_ID }, summaryDeps(BASE_TABLES));
  assert.equal(summary.version, SUMMARY_VERSION);
  assert.equal(summary.generatedAt, '2026-09-24T02:00:00.000Z');
  assert.deepEqual(Object.keys(summary.period).sort(), [
    'endDate', 'label', 'programmeWeekId', 'startDate', 'state', 'type', 'weekNumber',
  ]);
  assert.equal(summary.period.programmeWeekId, WEEK_ID);
  // A past week is never described as final or approved — nothing is persisted.
  assert.equal(/final|approved|locked/i.test(JSON.stringify(summary.period)), false);
});

test('the top-level sections are exactly the documented contract', async () => {
  const { summary } = await performanceSummary('KARL', { period: 'week', programmeWeekId: WEEK_ID }, summaryDeps(BASE_TABLES));
  assert.deepEqual(Object.keys(summary).sort(), [
    'attention', 'bodyweight', 'checkIn', 'dataQuality', 'endurance', 'generatedAt',
    'period', 'readiness', 'strength', 'training', 'version',
  ]);
  assert.deepEqual(Object.keys(summary.training.byType).sort(), ['cycling', 'other', 'running', 'strength', 'swimming']);
});
