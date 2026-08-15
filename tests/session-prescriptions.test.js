import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionPrescriptions } from '../api/write.js';

// A coach-built session carries its own exercise list. The serialiser has one
// job: hand the browser something indistinguishable in shape from a
// workout_splits entry, so every strength screen keeps working through
// getSplit() without being rewritten.

const structured = {
  id: '11111111-1111-4111-8111-111111111111',
  notion_page_id: null,
  planned_date: '2026-08-17',
  prescription_mode: 'structured',
  title: 'Upper A',
};

const legacy = {
  id: '22222222-2222-4222-8222-222222222222',
  notion_page_id: 'notion-abc',
  planned_date: '2026-08-18',
  prescription_mode: 'legacy',
  title: 'Lower A',
};

function benchRow(overrides = {}) {
  return {
    id: 'ex-1',
    planned_session_id: structured.id,
    exercise_name: 'Bench Press',
    position: 0,
    superset_group: null,
    circuit_group: null,
    sets: 4,
    warmup_sets: 2,
    working_sets: 4,
    rep_min: 6,
    rep_max: 8,
    rep_mode: 'reps',
    target_load: null,
    percent_1rm: null,
    rpe: null,
    rir: null,
    tempo: null,
    rest_seconds: 180,
    progression_rule: 'Add 2.5kg once all working sets hit 8',
    alternatives: ['Dumbbell Bench Press'],
    left_right_exercises: [],
    athlete_notes: 'Keep one rep in reserve',
    technique_cues: 'Elbows tucked',
    ...overrides,
  };
}

test('no structured sessions means no database call at all', async () => {
  let called = false;
  const result = await sessionPrescriptions([legacy], async () => {
    called = true;
    return [];
  });
  assert.equal(called, false, 'must not query prescriptions when nothing is structured');
  assert.deepEqual(result, { exercises: {}, runSteps: {} });
});

test('a structured exercise serialises into the workout_splits shape', async () => {
  const result = await sessionPrescriptions([structured, legacy], async (table) => {
    if (table === 'session_exercises') return [benchRow()];
    return [];
  });

  const list = result.exercises[structured.id];
  assert.ok(Array.isArray(list) && list.length === 1);
  const ex = list[0];

  // The exact field names every strength screen already reads.
  assert.equal(ex.exercise, 'Bench Press');
  assert.equal(ex.sets, '4');
  assert.equal(ex.repRange, '6-8');
  assert.equal(ex.rest, '180s');
  assert.equal(ex.warmupSets, '2');
  assert.equal(ex.workingSets, '4');
  assert.equal(ex.repMode, 'reps');
  assert.deepEqual(ex.alts, ['Dumbbell Bench Press']);
  assert.deepEqual(ex.leftRightExercises, []);

  // String-typed like the existing split data, because consumers do
  // esc(ex.sets) and parseInt(ex.workingSets, 10).
  for (const field of ['sets', 'reps', 'repRange', 'rest', 'warmupSets', 'workingSets']) {
    assert.equal(typeof ex[field], 'string', `${field} must be a string`);
  }
});

// The single most important test in this file.
test('coach-only notes never reach the athlete payload', async () => {
  let requestedColumns = '';
  const result = await sessionPrescriptions([structured], async (table, params) => {
    if (table === 'session_exercises') {
      requestedColumns = params.select;
      // Simulate a database that returns coach_notes anyway — a view change, a
      // careless join, anything. The serialiser must still not pass it on.
      return [benchRow({ coach_notes: 'Shoulder is cooked, do not tell him' })];
    }
    return [];
  });

  assert.ok(
    !requestedColumns.includes('coach_notes'),
    'coach_notes must not appear in the requested column list'
  );

  const serialised = JSON.stringify(result);
  assert.ok(
    !serialised.includes('do not tell him') && !serialised.includes('coach_notes'),
    'coach_notes must not survive serialisation'
  );

  // The athlete-facing note does come through.
  assert.equal(result.exercises[structured.id][0].notes, 'Keep one rep in reserve');
});

test('prescription extras render as one compact line', async () => {
  const result = await sessionPrescriptions([structured], async (table) => {
    if (table === 'session_exercises') {
      return [benchRow({ superset_group: 'A', tempo: '2-0-X-0', rpe: 8, rir: null })];
    }
    return [];
  });
  assert.equal(
    result.exercises[structured.id][0].prescriptionLine,
    'Superset A · Tempo 2-0-X-0 · RPE 8'
  );
});

test('a single target rep renders without a range', async () => {
  const result = await sessionPrescriptions([structured], async (table) =>
    table === 'session_exercises' ? [benchRow({ rep_min: 5, rep_max: 5 })] : []
  );
  assert.equal(result.exercises[structured.id][0].repRange, '5');
});

test('prescriptions are keyed the way the client keys sessions', async () => {
  // loadPlannedSessions uses `notion_page_id || id`. A prescription keyed by
  // the raw uuid on a session that has a notion_page_id would silently never
  // be found.
  const migrated = { ...legacy, prescription_mode: 'structured' };
  const result = await sessionPrescriptions([migrated], async (table) =>
    table === 'session_exercises'
      ? [benchRow({ planned_session_id: migrated.id, exercise_name: 'Back Squat' })]
      : []
  );
  assert.ok(result.exercises['notion-abc'], 'must key by notion_page_id when present');
  assert.equal(result.exercises['notion-abc'][0].exercise, 'Back Squat');
  assert.equal(result.exercises[migrated.id], undefined, 'must not also key by raw uuid');
});

test('a run session serialises its step tree, repeat blocks included', async () => {
  const result = await sessionPrescriptions([structured], async (table) => {
    if (table === 'run_steps') {
      return [
        { id: 's1', planned_session_id: structured.id, parent_step_id: null, step_order: 0, step_type: 'warmup', repeat_count: null, distance_km: 2, duration_sec: null, intensity_type: 'effort', pace_min: null, pace_max: null, hr_zone: null, rpe: null, effort: 'easy', instructions: null },
        { id: 's2', planned_session_id: structured.id, parent_step_id: null, step_order: 1, step_type: 'repeat', repeat_count: 5, distance_km: null, duration_sec: null, intensity_type: null, pace_min: null, pace_max: null, hr_zone: null, rpe: null, effort: null, instructions: null },
        { id: 's3', planned_session_id: structured.id, parent_step_id: 's2', step_order: 0, step_type: 'interval', repeat_count: null, distance_km: 1, duration_sec: null, intensity_type: 'pace_range', pace_min: '3:55', pace_max: '4:00', hr_zone: null, rpe: null, effort: null, instructions: null },
        { id: 's4', planned_session_id: structured.id, parent_step_id: 's2', step_order: 1, step_type: 'recovery', repeat_count: null, distance_km: null, duration_sec: 90, intensity_type: 'effort', pace_min: null, pace_max: null, hr_zone: null, rpe: null, effort: 'jog', instructions: null },
      ];
    }
    return [];
  });

  const steps = result.runSteps[structured.id];
  assert.equal(steps.length, 4);
  const repeat = steps.find((s) => s.type === 'repeat');
  assert.equal(repeat.repeat, 5);
  const children = steps.filter((s) => s.parentId === repeat.id);
  assert.equal(children.length, 2, 'the repeat block owns its two children');
  assert.equal(children[0].distanceKm, 1);
  assert.equal(children[0].paceMin, '3:55');
  assert.equal(children[1].durationSec, 90);
});

test('a prescription read failure degrades to the legacy split, never to an error', async () => {
  const result = await sessionPrescriptions([structured], async () => {
    throw new Error('supabase unavailable');
  });
  // Empty means "no structured prescription", and the client falls back to
  // resolving the session by title exactly as it did before this feature.
  assert.deepEqual(result, { exercises: {}, runSteps: {} });
});

test('session ids come only from the athlete-scoped rows', async () => {
  // The id list is built here, never accepted from the request body. This
  // asserts the filter is an `in.(...)` over exactly the structured sessions
  // handed in — nothing wider.
  let filter = '';
  await sessionPrescriptions([structured, legacy], async (table, params) => {
    if (table === 'session_exercises') filter = params.planned_session_id;
    return [];
  });
  assert.equal(filter, `in.(${structured.id})`);
  assert.ok(!filter.includes(legacy.id), 'legacy sessions are not queried');
});
