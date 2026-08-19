import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { nutritionLogs, bootstrapRead } from '../api/write.js';

const root = new URL('..', import.meta.url).pathname;
const checkinSource = readFileSync(join(root, 'public', 'js', '04-checkin.js'), 'utf8');
const coreSource = readFileSync(join(root, 'public', 'js', '01-core.js'), 'utf8');
const indexSource = readFileSync(join(root, 'public', 'index.html'), 'utf8');

// Clearing the form on submit made a saved day look identical to a day nobody
// had touched — the same ambiguity the dock colours were built to remove, only
// one tap deeper. A submitted day must reopen showing what the coaches hold.

test('nutrition values travel, not just the dates', async () => {
  const result = await nutritionLogs('THOMAS', async (table, params) => {
    assert.equal(table, 'daily_nutrition_logs');
    assert.equal(params.athlete_code, 'eq.THOMAS');
    for (const field of ['calories', 'protein', 'carbs', 'fat', 'fibre']) {
      assert.ok(params.select.includes(field), `${field} must come back or the form cannot be repopulated`);
    }
    return [{ log_date: '2026-08-19', calories: 2100, protein: 160 }];
  });
  assert.deepEqual(result.rows, [{ log_date: '2026-08-19', calories: 2100, protein: 160 }]);
});

test('the nutrition window stays small — notes run long and only today is read', async () => {
  await nutritionLogs('THOMAS', async (table, params) => {
    assert.ok(Number(params.limit) <= 30, 'do not drag hundreds of note-bearing rows into every bootstrap');
    return [];
  });
});

test('a nutrition read failure never blocks portal entry', async () => {
  const result = await bootstrapRead('ALVIN', {
    stateRead: async () => ({ rows: [] }),
    bodyLogs: async () => ({ rows: [] }),
    sessionLogsRead: async () => ({ rows: [] }),
    dailyLogDates: async () => ({ body: [], nutrition: [] }),
    nutritionLogs: async () => { throw new Error('Supabase unavailable'); },
  });
  assert.deepEqual(result.nutritionLogs, { rows: [] });
  assert.ok(result.state, 'the rest of the bootstrap still lands');
});

test('nutrition hydration writes the same local key the form reads', () => {
  assert.match(coreSource, /function loadStructuredNutritionData/);
  assert.match(coreSource, /localStorage\.setItem\('dp_daily_nut_'\+code\+'_'\+logDate/);
  // Hydration must not echo back to the cloud as if the athlete just typed it.
  const fn = coreSource.slice(coreSource.indexOf('async function loadStructuredNutritionData'));
  assert.match(fn.slice(0, 1200), /_skipSbSync=true/);
});

// ── Form recall ─────────────────────────────────────────────────────────────

function loadRecall() {
  const start = checkinSource.indexOf('function storedDailyLog');
  const end = checkinSource.indexOf('function openQuickLog(type){');
  assert.ok(start > 0 && end > start, 'recall helpers should exist in 04-checkin.js');

  const fields = {};
  const el = id => (fields[id] = fields[id] || { value: '', textContent: '', style: {}, classList: { add() {}, remove() {} } });
  const context = {
    athlete: { code: 'THOMAS' },
    _confirmedLogDates: { body: {}, nut: {} },
    localStorage: {
      _v: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null; },
      setItem(k, v) { this._v[k] = String(v); },
    },
    document: { getElementById: el, addEventListener: () => {} },
    console,
    todayISO2: () => '2026-08-19',
  };
  context.window = { addEventListener: () => {} };
  vm.createContext(context);
  vm.runInContext(
    checkinSource.slice(start, end) +
    '\nthis.storedDailyLog=storedDailyLog;this.rawBodyNote=rawBodyNote;' +
    'this.prefillQuickBody=prefillQuickBody;this.prefillQuickNut=prefillQuickNut;' +
    'this.applyQuickLogSubmittedState=applyQuickLogSubmittedState;',
    context
  );
  context.field = el;
  return context;
}

test('a submitted day reopens with its values in place', () => {
  const recall = loadRecall();
  recall.localStorage.setItem('dp_daily_nut_THOMAS_2026-08-19',
    JSON.stringify({ calories: '2100', protein: '160', carbs: '210', fat: '70', fibre: '30', notes: 'ate out' }));
  recall.prefillQuickNut('2026-08-19');
  assert.equal(recall.field('qlnCal').value, '2100');
  assert.equal(recall.field('qlnPro').value, '160');
  assert.equal(recall.field('qlnNotes').value, 'ate out');
});

test('switching to a day with no log clears the form rather than carrying values over', () => {
  const recall = loadRecall();
  recall.localStorage.setItem('dp_daily_nut_THOMAS_2026-08-19', JSON.stringify({ calories: '2100' }));
  recall.prefillQuickNut('2026-08-19');
  assert.equal(recall.field('qlnCal').value, '2100');
  recall.prefillQuickNut('2026-08-18');
  assert.equal(recall.field('qlnCal').value, '', 'yesterday must not inherit today\'s macros');
});

test('pain is not folded into the notes box twice', () => {
  const recall = loadRecall();
  // Written by the current client, which keeps the raw note beside the summary.
  assert.equal(recall.rawBodyNote({ pain: '4', painLocation: 'left knee', notes: 'Pain 4/10 · left knee · felt flat', noteText: 'felt flat' }), 'felt flat');
  // Written before noteText existed — rebuild and strip the generated prefix.
  assert.equal(recall.rawBodyNote({ pain: '4', painLocation: 'left knee', notes: 'Pain 4/10 · left knee · felt flat' }), 'felt flat');
  // A note that merely looks like a location must survive intact.
  assert.equal(recall.rawBodyNote({ pain: '4', painLocation: '', notes: 'Pain 4/10 · felt flat' }), 'felt flat');
  // Pain logged with no note at all.
  assert.equal(recall.rawBodyNote({ pain: '4', painLocation: 'left knee', notes: 'Pain 4/10 · left knee' }), '');
  // No pain: the notes field was never rewritten.
  assert.equal(recall.rawBodyNote({ pain: '0', notes: 'felt flat' }), 'felt flat');
});

test('only a server-confirmed day may call itself submitted', () => {
  const recall = loadRecall();
  recall.localStorage.setItem('dp_daily_body_THOMAS_2026-08-19', JSON.stringify({ weight: '72.3' }));
  // Saved on this device, never acknowledged: the wording must not claim it landed.
  assert.equal(recall.applyQuickLogSubmittedState('body', '2026-08-19'), false);
  assert.equal(recall.field('qlbSubmitBtn').textContent, 'Save body check-in');
  assert.equal(recall.field('qlbSubmittedNote').style.display, 'none');

  recall._confirmedLogDates.body['2026-08-19'] = true;
  assert.equal(recall.applyQuickLogSubmittedState('body', '2026-08-19'), true);
  assert.equal(recall.field('qlbSubmitBtn').textContent, 'Update body check-in');
  assert.equal(recall.field('qlbSubmittedNote').style.display, 'block');
  assert.match(recall.field('qlbSubmittedNote').textContent, /coaches have this/);
});

test('submitting no longer wipes the form', () => {
  const submit = checkinSource.slice(
    checkinSource.indexOf('async function submitQuickBody'),
    checkinSource.indexOf('async function submitQuickNut')
  );
  assert.ok(!/qlbWeight'\)\.value=''/.test(submit), 'the weight field must survive a save');
  assert.match(submit, /applyQuickLogSubmittedState\('body'/);
});

test('both modals carry the submitted note element the logic writes to', () => {
  assert.match(indexSource, /id="qlbSubmittedNote"/);
  assert.match(indexSource, /id="qlnSubmittedNote"/);
});
