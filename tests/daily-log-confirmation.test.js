import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { dailyLogDates, bootstrapRead } from '../api/write.js';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const indexSource = readFileSync(join(root, 'public', 'index.html'), 'utf8');
const stylesSource = readFileSync(join(root, 'public', 'styles.css'), 'utf8');
const checkinSource = readFileSync(join(root, 'public', 'js', '04-checkin.js'), 'utf8');
const loggingSource = readFileSync(join(root, 'public', 'js', '09-logging.js'), 'utf8');

// The quick-log dock used to tick from a local key written before the request
// was even sent. A submission that never left the phone looked exactly like one
// that landed: the athlete saw a tick, the coach saw nothing, and nobody could
// tell the difference — which is how two days of Thomas's nutrition went
// missing while he believed he had logged it.
//
// So "logged" has to mean the server holds it, and the state in between —
// written here, not yet acknowledged — has to be visible rather than silent.

test('confirmation reads dates from structured and legacy Supabase records', async () => {
  const asked = [];
  const rows = (table, params) => {
    asked.push([table, params]);
    if (table === 'daily_body_logs') {
      return [{ log_date: '2026-08-11' }, { log_date: '2026-08-10' }];
    }
    if (table === 'daily_nutrition_logs') return [{ log_date: '2026-08-09' }];
    if (params.key === 'like.daily_body_*') return [{ key: 'daily_body_2026-08-08' }];
    return [{ key: 'daily_nut_2026-08-07' }];
  };
  const result = await dailyLogDates('THOMAS', async (table, params) => {
    assert.equal(params.athlete_code, 'eq.THOMAS');
    assert.ok(['log_date', 'key'].includes(params.select), 'never pull whole log rows for confirmation');
    return rows(table, params);
  });
  assert.equal(asked.filter(([table]) => table === 'athlete_data').length, 2);
  assert.deepEqual(result, {
    body: ['2026-08-11', '2026-08-10', '2026-08-08'],
    nutrition: ['2026-08-09', '2026-08-07'],
  });
});

test('timestamps are trimmed to plain dates so the client can compare them', async () => {
  const result = await dailyLogDates('ALVIN', async (table) => table === 'daily_body_logs'
    ? [{ log_date: '2026-08-10T00:00:00+00:00' }]
    : []);
  assert.deepEqual(result.body, ['2026-08-10']);
});

test('one failed confirmation source does not hide dates from the others', async () => {
  const result = await dailyLogDates('ALVIN', async (table, params) => {
    if (table === 'daily_body_logs') throw new Error('temporary table read failure');
    if (table === 'athlete_data' && params.key === 'like.daily_body_*') {
      return [{ key: 'daily_body_2026-08-10' }];
    }
    return [];
  });
  assert.deepEqual(result.body, ['2026-08-10']);
});

test('a confirmation failure never blocks portal entry', async () => {
  const result = await bootstrapRead('ALVIN', {
    stateRead: async () => ({ rows: [] }),
    bodyLogs: async () => ({ rows: [] }),
    sessionLogsRead: async () => ({ rows: [] }),
    dailyLogDates: async () => { throw new Error('Supabase unavailable'); },
  });
  assert.deepEqual(result.dailyLogged, { body: [], nutrition: [] });
  assert.ok(result.state, 'the rest of the bootstrap still lands');
});

// ── Dock state resolution ───────────────────────────────────────────────────

function loadDock() {
  const source = loggingSource;
  const start = source.indexOf('// Days the SERVER has confirmed');
  const end = source.indexOf('document.addEventListener(\'DOMContentLoaded\',function(){try{syncQuickLogDock();}catch(e){}});', start);
  assert.ok(start > 0 && end > start, 'dock state block should exist in 09-logging.js');

  const context = {
    athlete: { code: 'THOMAS' },
    localStorage: {
      _v: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null; },
      setItem(k, v) { this._v[k] = String(v); },
    },
    document: { getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' },
    addEventListener: () => {},
    console,
    todayISO2: () => '2026-08-10',
  };
  // The browser is NOT `window === globalThis` for this code. `athlete` is a
  // `let` in 01-core.js, so it is a script-scoped binding that never lands on
  // window. The old harness aliased window to the whole context, which handed
  // the dock a `window.athlete` that does not exist in production — the suite
  // passed while every athlete saw a permanently grey dock. Model the real
  // split: `athlete` reachable lexically, absent from window.
  context.window = { addEventListener: () => {} };
  vm.createContext(context);
  vm.runInContext(
    source.slice(start, end) +
    '\nthis.quickLogState=quickLogState;this.hydrateConfirmedLogDates=hydrateConfirmedLogDates;' +
    'this.markLogConfirmed=markLogConfirmed;this.quickLogDoneToday=quickLogDoneToday;',
    context
  );
  return context;
}

const dock = loadDock();
const localKey = kind => 'dp_daily_' + kind + '_THOMAS_2026-08-10';

test('a day the server holds reads as logged', () => {
  dock.hydrateConfirmedLogDates({ body: ['2026-08-10'], nutrition: ['2026-08-09'] });
  assert.equal(dock.quickLogState('body'), 'logged');
  assert.equal(dock.quickLogState('nut'), 'none', 'nutrition landed for the 9th, not today');
});

test('written on this device but never acknowledged reads as sending, not logged', () => {
  dock.hydrateConfirmedLogDates({ body: [], nutrition: [] });
  dock.localStorage.setItem(localKey('nut'), '{"calories":"1851"}');
  assert.equal(dock.quickLogState('nut'), 'sending');
  assert.notEqual(dock.quickLogState('nut'), 'logged', 'this is the bug — a local key is not proof the coaches have it');
});

test('a confirmed write promotes sending to logged', () => {
  dock.hydrateConfirmedLogDates({ body: [], nutrition: [] });
  dock.localStorage.setItem(localKey('nut'), '{"calories":"1851"}');
  assert.equal(dock.quickLogState('nut'), 'sending');
  dock.markLogConfirmed('nut', '2026-08-10');
  assert.equal(dock.quickLogState('nut'), 'logged');
});

test('server confirmation wins even with no local key — the athlete may be on another device', () => {
  dock.localStorage._v = {};
  dock.hydrateConfirmedLogDates({ body: ['2026-08-10'], nutrition: ['2026-08-10'] });
  assert.equal(dock.quickLogState('body'), 'logged');
  assert.equal(dock.quickLogState('nut'), 'logged');
});

test('nothing anywhere reads as not logged', () => {
  dock.localStorage._v = {};
  dock.hydrateConfirmedLogDates({ body: [], nutrition: [] });
  assert.equal(dock.quickLogState('body'), 'none');
  assert.equal(dock.quickLogState('nut'), 'none');
});

test('done-today only counts confirmed logs', () => {
  dock.localStorage._v = {};
  dock.hydrateConfirmedLogDates({ body: [], nutrition: [] });
  dock.localStorage.setItem(localKey('body'), '{"weight":"72.3"}');
  assert.equal(dock.quickLogDoneToday('body'), false, 'an unsent log is not a done log');
  dock.markLogConfirmed('body', '2026-08-10');
  assert.equal(dock.quickLogDoneToday('body'), true);
});

test('hydrating replaces prior state rather than accumulating it', () => {
  dock.localStorage._v = {};
  dock.hydrateConfirmedLogDates({ body: ['2026-08-10'], nutrition: [] });
  assert.equal(dock.quickLogState('body'), 'logged');
  dock.hydrateConfirmedLogDates({ body: [], nutrition: [] });
  assert.equal(dock.quickLogState('body'), 'none', 'a deleted log must not linger as confirmed');
});

test('the two daily actions keep distinct, purpose-led names', () => {
  // These are the Log sheet's Body and Fuel tabs now. They kept their ids and
  // their names: the dock's three-state vocabulary is the part worth preserving,
  // and syncQuickLogDock() still writes it to exactly these elements.
  assert.match(indexSource, /id="qlDockBody"[\s\S]*?<span>Body check-in<\/span>/);
  assert.match(indexSource, /id="qlDockNut"[\s\S]*?<span>Nutrition log<\/span>/);
  assert.match(indexSource, /id="qlbSubmitBtn"[^>]*>Save body check-in<\/button>/);
  assert.match(indexSource, /id="qlnSubmitBtn"[^>]*>Save nutrition log<\/button>/);
  assert.match(loggingSource, /logged:'Body checked in'/);
  assert.match(loggingSource, /logged:'Nutrition logged'/);
});

test('a confirmed daily log becomes an unmistakable green button', () => {
  assert.match(stylesSource, /\.quicklog-btn\.is-done\{[^}]*background:var\(--ok\)[^}]*border-color:var\(--ok\)/);
  assert.match(stylesSource, /\.quicklog-btn\.is-done \.icon\{color:var\(--ink-success\)\}/);
  assert.match(stylesSource, /\.quicklog-btn\.is-done \.ql-icon-done\{display:inline-block\}/);
  assert.match(stylesSource, /\.quicklog-btn\.ql-body\.is-done,.quicklog-btn\.ql-nut\.is-done\{[\s\S]*?background:var\(--ok\)/);
  assert.match(stylesSource, /\.btn\.is-success,\.btn\.saved,\.savebtn\.saved,\.save-run-btn\.saved,\.quicklog-btn\.is-done\{[\s\S]*?background:var\(--done\)/);
  assert.doesNotMatch(stylesSource, /\.outdoor-mode \.quicklog-btn/);
});

test('an unconfirmed daily log stays amber rather than looking successful', () => {
  assert.match(stylesSource, /\.quicklog-btn\.is-sending\{[^}]*background:rgba\(240,173,78/);
  assert.doesNotMatch(stylesSource, /\.quicklog-btn\.is-sending\{[^}]*background:var\(--ok\)/);
});

test('logging is one sheet with three tabs, not a dock plus two overlays', () => {
  // The regression this guards: body and fuel logging used to be a dock hidden
  // on five of six screens, opening two separate overlays, with session logging
  // somewhere else again.
  assert.doesNotMatch(indexSource, /quicklog-strip/, 'the dock must be gone');
  assert.doesNotMatch(indexSource, /id="qlBodyModal"|id="qlNutModal"/, 'the two overlays must be gone');
  assert.doesNotMatch(stylesSource, /quicklog-strip/, 'no dock placements may survive in styles.css');
  assert.match(indexSource, /id="logSheet"/);
  for (const id of ['logTabSession', 'qlDockBody', 'qlDockNut', 'logPanelSession', 'logPanelBody', 'logPanelFuel']) {
    assert.match(indexSource, new RegExp(`id="${id}"`), `Log sheet is missing ${id}`);
  }
  // One copy of each form: a second set of these ids would make every
  // getElementById in 04-checkin.js bind to whichever copy came first.
  for (const id of ['qlbDate', 'qlbWeight', 'qlbSubmitBtn', 'qlnDate', 'qlnCal', 'qlnSubmitBtn']) {
    assert.equal(indexSource.split(`id="${id}"`).length - 1, 1, `${id} must appear exactly once`);
  }
});

test('an unsent draft says so, and a seeded fuel form does not pose as a record', () => {
  assert.match(checkinSource, /function restoreLogDraft/);
  assert.match(checkinSource, /function saveLogDraft/);
  // A draft is this device's unfinished work and must never read as submitted.
  assert.match(checkinSource, /has not been sent to your coaches yet/);
  // A confirmed day is the coaches' record; an older draft must not paint over it.
  assert.match(checkinSource, /if\(confirmed\)\{clearLogDraft\(kind,date\);return false;\}/);
  // Yesterday's totals seed a blank day only, and stay marked until edited.
  assert.match(checkinSource, /function seedFuelFromYesterday/);
  assert.match(checkinSource, /if\(storedDailyLog\('nut',date\)\)return false;/);
  assert.match(checkinSource, /el\.classList\.add\('is-seeded'\)/);
  // A seeded value is not the athlete's number, so it must not enter the draft.
  assert.match(checkinSource, /if\(el\.classList\.contains\('is-seeded'\)\)return;/);
});

test('the Session tab reuses the existing logging path instead of repeating it', () => {
  assert.match(checkinSource, /function renderLogSessionPanel/);
  // The one run/strength logging implementation stays in 08-training.js.
  assert.match(checkinSource, /startFocusedSession\(i\)/);
  // And the Strava one-tap confirm is the session card's own component.
  assert.match(checkinSource, /stravaMatchHtml\(s,row\.index,'log-sheet'\)/);
  assert.doesNotMatch(checkinSource, /function saveRunLog|function submitRunLog/, 'no second run log implementation');
});

test('the form submit button shows its delivery colour before the modal closes', () => {
  assert.match(stylesSource, /\.ql-modal \.savebtn\.saved\{background:var\(--ok\)/);
  assert.match(stylesSource, /\.ql-modal \.savebtn\.is-sending\{background:var\(--amber\)/);
  assert.match(checkinSource, /await showQuickLogSubmitFeedback\(btn,'body',[^;]+\);[\s\S]*closeQuickLog\('body'\)/);
  assert.match(checkinSource, /await showQuickLogSubmitFeedback\(btn,'nut',[^;]+\);[\s\S]*closeQuickLog\('nut'\)/);
});

test('returning to an installed app refreshes Supabase confirmation state', () => {
  assert.match(loggingSource, /document\.addEventListener\('visibilitychange',refreshConfirmedLogDatesOnResume\)/);
  assert.match(loggingSource, /window\.addEventListener\('focus',refreshConfirmedLogDatesOnResume\)/);
  assert.match(loggingSource, /loadConfirmedLogDates\(\)/);
});

// The regression that shipped a green tick nobody could ever see: the dock
// guarded on `window.athlete`, which is undefined for a `let` binding, so
// quickLogState returned 'none' for a day the server had already confirmed.
test('dock state survives athlete living outside window, as it does in a browser', () => {
  assert.equal(dock.window.athlete, undefined, 'production has no window.athlete — do not reintroduce it');
  dock.localStorage._v = {};
  dock.hydrateConfirmedLogDates({ body: ['2026-08-10'], nutrition: [] });
  assert.equal(dock.quickLogState('body'), 'logged', 'a server-confirmed day must read as logged');
});

test('no dock guard reads athlete off window', () => {
  const guarded = loggingSource.slice(
    loggingSource.indexOf('// Days the SERVER has confirmed'),
    loggingSource.indexOf("document.addEventListener('DOMContentLoaded',function(){try{syncQuickLogDock();}catch(e){}});")
  );
  const code = guarded.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  assert.ok(!/window\.athlete/.test(code), 'window.athlete is always undefined here — use the lexical binding');
});
