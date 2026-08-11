import assert from 'node:assert/strict';
import test from 'node:test';
import { upsertTolerant, OPTIONAL_COLUMNS } from '../api/ingest.js';

// The swap columns and their migration ship together, and whichever lands first
// would otherwise reject every strength log written in between. Losing an
// athlete's session to deploy ordering is not an acceptable failure mode, so
// the write drops what the schema cannot take yet and keeps going.

const strengthRow = {
  client_write_id: 'w1',
  athlete_code: 'ATHLETE1',
  exercise_log: 'T-Bar Row: Set 1: 40kg × 10reps',
  exercise_name: 'T-Bar Row',
  programmed_exercise: 'Low Machine Row',
  muscle_group: 'Upper back — horizontal row',
  is_swap: true,
  rep_mode: 'reps',
  raw_payload: { exerciseName: 'T-Bar Row', programmedExercise: 'Low Machine Row', repMode: 'reps' },
};

function missingColumnError(column) {
  return new Error(`Could not find the '${column}' column of 'training_session_logs' in the schema cache`);
}

test('a schema that already has the columns is written in one pass', async () => {
  const calls = [];
  const result = await upsertTolerant('training_session_logs', strengthRow, 'client_write_id', async (table, row) => {
    calls.push(row);
    return [{ id: 'row-1' }];
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(result, [{ id: 'row-1' }]);
  for (const column of OPTIONAL_COLUMNS) assert.ok(Object.hasOwn(calls[0], column));
});

test('a log still lands when the migration has not been applied yet', async () => {
  const calls = [];
  const result = await upsertTolerant('training_session_logs', strengthRow, 'client_write_id', async (table, row) => {
    calls.push(row);
    const missing = OPTIONAL_COLUMNS.find((column) => Object.hasOwn(row, column));
    if (missing) throw missingColumnError(missing);
    return [{ id: 'row-1' }];
  });
  assert.deepEqual(result, [{ id: 'row-1' }]);
  const final = calls[calls.length - 1];
  for (const column of OPTIONAL_COLUMNS) assert.ok(!Object.hasOwn(final, column));
  // The session itself survives intact, and raw_payload keeps the full
  // submission — including the programmed slot — for later backfill.
  assert.equal(final.athlete_code, 'ATHLETE1');
  assert.match(final.exercise_log, /^T-Bar Row: Set 1:/);
  assert.equal(final.raw_payload.programmedExercise, 'Low Machine Row');
});

test('a partial migration only drops the columns that are actually absent', async () => {
  const calls = [];
  await upsertTolerant('training_session_logs', strengthRow, 'client_write_id', async (table, row) => {
    calls.push(row);
    if (Object.hasOwn(row, 'is_swap')) throw missingColumnError('is_swap');
    return [{ id: 'row-1' }];
  });
  const final = calls[calls.length - 1];
  assert.ok(!Object.hasOwn(final, 'is_swap'));
  assert.equal(final.muscle_group, 'Upper back — horizontal row');
  assert.equal(final.programmed_exercise, 'Low Machine Row');
  assert.equal(final.rep_mode, 'reps');
});

test('the fixture covers every optional column, so new ones cannot ship untested', () => {
  for (const column of OPTIONAL_COLUMNS) {
    assert.ok(Object.hasOwn(strengthRow, column), `add ${column} to the test fixture`);
  }
});

test('a real database failure is never swallowed as a missing column', async () => {
  await assert.rejects(
    upsertTolerant('training_session_logs', strengthRow, 'client_write_id', async () => {
      throw new Error('duplicate key value violates unique constraint');
    }),
    /duplicate key/
  );
});

test('the caller row is not mutated', async () => {
  const row = { ...strengthRow };
  await upsertTolerant('training_session_logs', row, 'client_write_id', async (table, candidate) => {
    const missing = OPTIONAL_COLUMNS.find((column) => Object.hasOwn(candidate, column));
    if (missing) throw missingColumnError(missing);
    return [];
  });
  assert.deepEqual(row, strengthRow);
});
