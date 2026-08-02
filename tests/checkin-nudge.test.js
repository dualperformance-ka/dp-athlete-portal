import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateRead } from '../api/write.js';

const root = new URL('..', import.meta.url).pathname;
const navSource = readFileSync(join(root, 'public', 'js', '03-nav-nudges.js'), 'utf8');
const coreSource = readFileSync(join(root, 'public', 'js', '01-core.js'), 'utf8');
const apiSource = readFileSync(join(root, 'api', 'write.js'), 'utf8');

function checkinKeys(code) {
  const start = navSource.indexOf('function checkinWeekSuffix');
  const end = navSource.indexOf('function initCheckinNudge', start);
  assert.ok(start >= 0 && end > start, 'check-in key helpers should remain discoverable');
  const context = { athlete: { code } };
  vm.createContext(context);
  vm.runInContext(navSource.slice(start, end), context);
  return context;
}

test('weekly check-in completion cache is scoped to the active athlete', () => {
  const monday = new Date(2026, 7, 3, 5, 54);
  assert.equal(checkinKeys('KARL').checkinWeekKey(monday), 'dp_checkin_KARL_2026_31');
  assert.equal(checkinKeys('ALEX').checkinWeekKey(monday), 'dp_checkin_ALEX_2026_31');
});

test('Monday and Tuesday retain the previous-week grace window', () => {
  const keys = checkinKeys('KARL');
  assert.equal(keys.checkinWeekSuffix(new Date(2026, 7, 3)), '2026_31');
  assert.equal(keys.checkinWeekSuffix(new Date(2026, 7, 4)), '2026_31');
  assert.equal(keys.checkinWeekSuffix(new Date(2026, 7, 5)), '2026_32');
});

test('cloud hydration uses structured check-ins, not legacy cache rows', async () => {
  assert.match(apiSource, /selectRows\('weekly_checkins'/);
  assert.match(apiSource, /filter\(\(row\) => !String\(row\.key \|\| ''\)\.startsWith\('checkin_'\)\)/);
  assert.match(coreSource, /var structuredCheckins=result\.checkins\|\|\[\]/);
  assert.doesNotMatch(coreSource, /row\.key\.startsWith\('checkin_'\).*lsKey=/);

  const queries = [];
  const result = await stateRead('KARL', async (table, params) => {
    queries.push({ table, params });
    if (table === 'athlete_data') return [
      { key: 'goals', value: { goal: '5k' } },
      { key: 'checkin_2026_31', value: { stale: true } },
    ];
    if (table === 'weekly_checkins') return [
      { week_key: 'week_ending_2026-08-02', week_ending: '2026-08-02', submitted_at: '2026-08-02T09:00:00Z' },
    ];
    return [];
  });
  assert.equal(queries.find((query) => query.table === 'weekly_checkins').params.athlete_code, 'eq.KARL');
  assert.deepEqual(result.rows, [{ key: 'goals', value: { goal: '5k' } }]);
  assert.equal(result.checkins[0].week_ending, '2026-08-02');
});
