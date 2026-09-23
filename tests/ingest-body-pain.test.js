import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {
  parsePainScore,
  projectBodyPain,
  buildDailyBodyRow,
  persistStructured,
  BODY_OPTIONAL_COLUMNS,
} from '../api/ingest.js';

// The coach Today queue reads daily_body_logs.pain / coach_alert. The portal
// used to keep them only inside raw_payload, so a serious pain report was saved
// and never triaged. These tests hold the typed projection in place.

const highPain = {
  type: 'daily_body',
  athleteCode: 'ATHLETE1',
  athleteName: 'Athlete One',
  date: '2026-09-23',
  weight: '80.4',
  sleep: '7',
  energy: '6',
  stress: '4',
  soreness: '6',
  pain: '7',
  painLocation: ' left knee ',
  coachAlert: true,
  notes: 'Pain 7/10 · left knee · sharp on stairs',
  noteText: 'sharp on stairs',
};

test('a high-pain submission writes typed pain, location and alert', async () => {
  const writes = [];
  await persistStructured(highPain, {
    upsert: async (table, row, onConflict) => { writes.push({ table, row, onConflict }); return [{ id: 'b1' }]; },
  });
  assert.equal(writes.length, 1);
  const { table, row, onConflict } = writes[0];
  assert.equal(table, 'daily_body_logs');
  assert.equal(onConflict, 'athlete_code,log_date');
  assert.equal(row.pain, 7);
  assert.equal(row.pain_location, 'left knee');
  assert.equal(row.coach_alert, true);
  // raw_payload is unchanged and still carries the athlete's own note.
  assert.equal(row.raw_payload.pain, '7');
  assert.equal(row.raw_payload.noteText, 'sharp on stairs');
  assert.equal(row.weight, 80.4);
});

test('zero and low pain do not raise an alert', () => {
  assert.deepEqual(projectBodyPain({ pain: '0', painLocation: '', coachAlert: false }),
    { pain: 0, pain_location: null, coach_alert: false });
  assert.deepEqual(projectBodyPain({ pain: 3 }), { pain: 3, pain_location: null, coach_alert: false });
  // No pain field at all is "not reported", not zero.
  assert.deepEqual(projectBodyPain({ weight: 80 }), { pain: null, pain_location: null, coach_alert: false });
});

test('without an explicit alert, a valid score of 5+ raises one', () => {
  assert.equal(projectBodyPain({ pain: 5 }).coach_alert, true);
  assert.equal(projectBodyPain({ pain: '6' }).coach_alert, true);
  assert.equal(projectBodyPain({ pain: '4' }).coach_alert, false);
});

test('an explicit coachAlert wins over the score rule', () => {
  assert.equal(projectBodyPain({ pain: 2, coachAlert: true }).coach_alert, true);
  assert.equal(projectBodyPain({ pain: 2, coachAlert: 'true' }).coach_alert, true);
  assert.equal(projectBodyPain({ pain: 7, coachAlert: 'false' }).coach_alert, false);
});

test('malformed pain values are stored as not reported, never guessed', () => {
  for (const value of ['7/10', '', '  ', 'abc', '12', 11, -1, 6.5, '6.5', null, undefined, {}, [], true]) {
    assert.equal(parsePainScore(value), null, `pain ${JSON.stringify(value)}`);
  }
  assert.equal(parsePainScore('5.0'), 5);
  assert.equal(parsePainScore(' 8 '), 8);
  assert.equal(parsePainScore(10), 10);
  // An alert string that is not a boolean falls back to the score rule.
  assert.equal(projectBodyPain({ pain: '7/10', coachAlert: 'yes' }).coach_alert, false);
  assert.equal(projectBodyPain({ pain: 9, coachAlert: 'yes' }).coach_alert, true);
  assert.equal(buildDailyBodyRow({ athleteCode: 'A', painLocation: 'x'.repeat(500) }).pain_location.length, 200);
});

test('missing pain columns degrade without losing the base body log', async () => {
  const attempts = [];
  const result = await persistStructured(highPain, {
    upsert: async (table, row) => {
      attempts.push({ ...row });
      const missing = BODY_OPTIONAL_COLUMNS.find((column) => Object.hasOwn(row, column));
      if (missing) throw new Error(`Could not find the '${missing}' column of 'daily_body_logs' in the schema cache`);
      return [{ id: 'b1' }];
    },
  });
  assert.deepEqual(result, [{ id: 'b1' }]);
  const final = attempts.at(-1);
  for (const column of BODY_OPTIONAL_COLUMNS) assert.ok(!Object.hasOwn(final, column));
  assert.equal(final.weight, 80.4);
  assert.equal(final.energy, 6);
  assert.equal(final.raw_payload.pain, '7');
});

test('an unrelated write failure still surfaces instead of being swallowed', async () => {
  await assert.rejects(
    persistStructured(highPain, { upsert: async () => { throw new Error('permission denied for table daily_body_logs'); } }),
    /permission denied/
  );
});

test('the backfill migration applies the same validation and alert rule', () => {
  const sql = fs.readFileSync(new URL('../supabase/migrations/20260923090000_daily_body_pain_typed_columns.sql', import.meta.url), 'utf8');
  assert.match(sql, /add column if not exists pain smallint/);
  assert.match(sql, /add column if not exists pain_location text/);
  assert.match(sql, /add column if not exists coach_alert boolean not null default false/);
  // Validates before casting.
  assert.match(sql, /~ '\^\[0-9\]\{1,2\}\(\\\.0\+\)\?\$'/);
  // Explicit alert first, then score >= 5.
  assert.match(sql, /coalesce\(parsed\.alert_value, parsed\.pain_value >= 5, false\)/);
});
