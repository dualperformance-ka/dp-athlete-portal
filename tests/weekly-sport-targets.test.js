import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { normalisePublishedCoachTarget, weeklySportTargetsRead } from '../api/write.js';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const handbookSource = readFileSync(join(root, 'public', 'js', '05-handbook.js'), 'utf8');
const nutritionSource = readFileSync(join(root, 'public', 'js', '06-nutrition.js'), 'utf8');
const coreSource = readFileSync(join(root, 'public', 'js', '01-core.js'), 'utf8');

const target = (over = {}) => ({
  sport: 'running',
  weekIdentifier: '110e8400-e29b-41d4-a716-446655440000',
  distanceTargetMetres: 45000,
  sessionTarget: null,
  durationTargetMinutes: null,
  coachNote: null,
  source: 'coach',
  locked: true,
  ...over,
});

function clientMetricsHelpers() {
  const start = handbookSource.indexOf('function coachTargetKey');
  const end = handbookSource.indexOf('async function loadProgrammeVolume');
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(handbookSource.slice(start, end), context);
  return context;
}

function targetDisplayHelpers() {
  const start = nutritionSource.indexOf('var COACH_SPORT_LABELS');
  const end = nutritionSource.indexOf('function retryProgrammeVolume');
  assert.ok(start >= 0 && end > start);
  const context = {
    fmtKmVal: (value) => String(Math.round(Number(value) * 10) / 10),
    esc: (value) => String(value).replace(/</g, '&lt;'),
  };
  vm.createContext(context);
  vm.runInContext(nutritionSource.slice(start, end), context);
  return context;
}

test('the proxy forwards only the authenticated bearer and never an athlete code', async () => {
  const oldBase = process.env.COACHES_API_BASE;
  process.env.COACHES_API_BASE = 'https://coach.example/';
  try {
    const result = await weeklySportTargetsRead({ headers: { authorization: 'Bearer signed-session' } }, async (url, options) => {
      assert.equal(url, 'https://coach.example/api/my-logs?resource=weekly-sport-targets');
      assert.equal(options.headers.Authorization, 'Bearer signed-session');
      assert.doesNotMatch(url, /athlete|code/i);
      assert.equal(options.method, 'GET');
      return { ok: true, status: 200, json: async () => ({ ok: true, targets: [target()] }) };
    });
    assert.equal(result.targets.length, 1);
  } finally {
    if (oldBase === undefined) delete process.env.COACHES_API_BASE;
    else process.env.COACHES_API_BASE = oldBase;
  }
});

test('an explicit zero remains a locked coach prescription', () => {
  const result = normalisePublishedCoachTarget(target({ sport: 'swimming', distanceTargetMetres: 0, sessionTarget: 0 }));
  assert.equal(result.distanceTargetMetres, 0);
  assert.equal(result.sessionTarget, 0);
  assert.equal(result.locked, true);
  assert.equal(result.source, 'coach');
});

test('malformed or unlocked dashboard rows fail closed', () => {
  assert.throws(() => normalisePublishedCoachTarget(target({ locked: false })), /lock/i);
  assert.throws(() => normalisePublishedCoachTarget(target({ distanceTargetMetres: -1 })), /distance/i);
  assert.throws(() => normalisePublishedCoachTarget(target({ weekIdentifier: 'Week 4' })), /programme week/i);
});

test('dashboard authentication failures stay authentication failures', async () => {
  const oldBase = process.env.COACHES_API_BASE;
  process.env.COACHES_API_BASE = 'https://coach.example';
  try {
    await assert.rejects(
      weeklySportTargetsRead({ headers: { authorization: 'Bearer expired' } }, async () => ({
        ok: false, status: 401, json: async () => ({ ok: false }),
      })),
      (error) => error.status === 401 && error.message === 'invalid_session',
    );
  } finally {
    if (oldBase === undefined) delete process.env.COACHES_API_BASE;
    else process.env.COACHES_API_BASE = oldBase;
  }
});

test('sport actuals are independent and limited to the exact week', () => {
  const { completedSportMetrics } = clientMetricsHelpers();
  const activities = [
    { sport_type: 'Run', start_date_local: '2026-08-10T07:00:00', distance: 10000, moving_time: 3600 },
    { sport_type: 'Ride', start_date_local: '2026-08-11T07:00:00', distance: 40000, moving_time: 5400 },
    { sport_type: 'Swim', start_date_local: '2026-08-12T07:00:00', distance: 2000, elapsed_time: 1800 },
    { sport_type: 'Run', start_date_local: '2026-08-17T07:00:00', distance: 5000, moving_time: 1500 },
  ];
  const run = completedSportMetrics(activities, 'running', '2026-08-10', '2026-08-16');
  const ride = completedSportMetrics(activities, 'cycling', '2026-08-10', '2026-08-16');
  const swim = completedSportMetrics(activities, 'swimming', '2026-08-10', '2026-08-16');
  assert.deepEqual({ ...run }, { distanceMetres: 10000, sessions: 1, durationMinutes: 60 });
  assert.deepEqual({ ...ride }, { distanceMetres: 40000, sessions: 1, durationMinutes: 90 });
  assert.deepEqual({ ...swim }, { distanceMetres: 2000, sessions: 1, durationMinutes: 30 });
});

test('week matching uses the canonical UUID and not a display label', () => {
  const { targetForProgrammeWeek } = clientMetricsHelpers();
  const rows = [target(), target({ sport: 'cycling', weekIdentifier: '220e8400-e29b-41d4-a716-446655440000' })];
  assert.equal(targetForProgrammeWeek(rows, '110e8400-e29b-41d4-a716-446655440000', 'running').distanceTargetMetres, 45000);
  assert.equal(targetForProgrammeWeek(rows, '220e8400-e29b-41d4-a716-446655440000', 'running'), null);
  assert.equal(targetForProgrammeWeek(rows, 'Week 4', 'running'), null);
});

test('running, cycling and swimming render independently with the correct units', () => {
  const { coachTargetsHtml } = targetDisplayHelpers();
  const week = {
    coachTargets: [
      target(),
      target({ sport: 'cycling', distanceTargetMetres: 120000, sessionTarget: 3 }),
      target({ sport: 'swimming', distanceTargetMetres: 5000, durationTargetMinutes: 90 }),
    ],
    actualBySport: {
      running: { distanceMetres: 32100, sessions: 2, durationMinutes: 160 },
      cycling: { distanceMetres: 78000, sessions: 2, durationMinutes: 140 },
      swimming: { distanceMetres: 3200, sessions: 1, durationMinutes: 52 },
    },
  };
  const html = coachTargetsHtml(week);
  assert.match(html, />32\.1 km</);
  assert.match(html, />\/ 45 km</);
  assert.match(html, />78 km</);
  assert.match(html, />\/ 120 km</);
  assert.match(html, />3200 m</);
  assert.match(html, />\/ 5000 m</);
  assert.match(html, /2 \/ 3 sessions/);
  assert.match(html, /52 \/ 90 min/);
  assert.equal((html.match(/Coach target · Locked/g) || []).length, 3);
});

test('null optional fields are omitted and activity never changes the prescription', () => {
  const { coachTargetsHtml } = targetDisplayHelpers();
  const html = coachTargetsHtml({
    coachTargets: [target({ distanceTargetMetres: 45000, coachNote: '<b>Keep it easy</b>' })],
    actualBySport: { running: { distanceMetres: 80000, sessions: 5, durationMinutes: 300 } },
  });
  assert.match(html, />80 km</, 'actual activity is shown separately');
  assert.match(html, />\/ 45 km</, 'the prescribed distance is unchanged');
  assert.doesNotMatch(html, /sessions| min/);
  assert.match(html, /&lt;b>Keep it easy&lt;\/b>/, 'coach notes are escaped');
});

test('recorded sports remain visible when no weekly target was prescribed', () => {
  const { coachTargetsHtml, coachTargetSummary } = targetDisplayHelpers();
  const week = {
    coachTargets: [],
    actualBySport: {
      running: null,
      cycling: null,
      swimming: { distanceMetres: 1800, sessions: 1, durationMinutes: 42 },
    },
  };
  const html = coachTargetsHtml(week);
  assert.match(html, /Swimming/);
  assert.match(html, />1800 m</);
  assert.match(html, /completed/);
  assert.match(html, /No weekly target/);
  assert.match(html, /1 session/);
  assert.match(html, /42 min/);
  assert.doesNotMatch(html, /Coach target · Locked|role="progressbar"/);
  assert.match(coachTargetSummary(week), /Swim 1800\u00a0m · no target/);
});

test('the planned running total is the weekly target fallback when no coach override exists', () => {
  const { coachTargetsHtml, coachTargetSummary } = targetDisplayHelpers();
  const week = {
    planned: 86,
    coachTargets: [],
    actualBySport: {
      running: { distanceMetres: 11400, sessions: 1, durationMinutes: 62 },
      cycling: null,
      swimming: null,
    },
  };
  const html = coachTargetsHtml(week);
  assert.match(html, /Running/);
  assert.match(html, /Planned target/);
  assert.match(html, />11\.4 km</);
  assert.match(html, />\/ 86 km</);
  assert.match(html, /1 session/);
  assert.match(html, /62 min/);
  assert.match(html, /role="progressbar"/);
  assert.doesNotMatch(html, /No weekly target|Coach target · Locked/);
  assert.match(coachTargetSummary(week), /Run 11\.4\u00a0km\/86\u00a0km planned/);
});

test('targeted and activity-only sports share the weekly dropdown without changing authority', () => {
  const { coachTargetsHtml } = targetDisplayHelpers();
  const html = coachTargetsHtml({
    planned: 86,
    coachTargets: [target({ sport: 'running', distanceTargetMetres: 45000 })],
    actualBySport: {
      running: { distanceMetres: 10000, sessions: 1, durationMinutes: 55 },
      cycling: { distanceMetres: 30000, sessions: 1, durationMinutes: 70 },
      swimming: null,
    },
  });
  assert.match(html, /Running[\s\S]*Coach target · Locked/);
  assert.match(html, /Running[\s\S]*\/ 45 km/);
  assert.doesNotMatch(html, /Planned target/);
  assert.match(html, /Cycling[\s\S]*No weekly target[\s\S]*30 km/);
  assert.equal((html.match(/Coach target · Locked/g) || []).length, 1);
});

test('an empty response and a failed target request produce different UI states', () => {
  const start = nutritionSource.indexOf('function volumeStripHtml');
  const end = nutritionSource.indexOf('// mode drives what a week tap navigates');
  const context = {
    selectedVolumeWeek: () => null,
    volumeWeekDisplay: () => ({ value: '', delta: '', deltaClass: '' }),
    fmtKmVal: String,
    esc: String,
    volumeSportRows: () => [],
    coachTargetSummary: () => '',
    coachTargetsHtml: () => '',
  };
  vm.createContext(context);
  vm.runInContext(nutritionSource.slice(start, end), context);
  assert.equal(context.volumeStripHtml({ weeks: [], targetState: 'empty' }, 'training', true), '');
  assert.match(
    context.volumeStripHtml({ weeks: [], targetState: 'error' }, 'training', true),
    /Coach targets are unavailable[\s\S]*Existing targets stay locked[\s\S]*Retry/,
  );
});

test('the athlete UI contains read-only lock text, escaped notes and no target form controls', () => {
  assert.match(nutritionSource, /Coach target · Locked/);
  assert.match(nutritionSource, /target\.coachNote\?'<div class="sport-target-note">'\+esc\(target\.coachNote\)/);
  assert.doesNotMatch(nutritionSource, /sport-target[^\n]*(?:<input|<select|<textarea)/i);
  assert.match(nutritionSource, /Existing targets stay locked/);
});

test('the browser only reads through the portal gateway and never writes the target table', () => {
  const browserSource = handbookSource + nutritionSource + coreSource;
  assert.match(handbookSource, /portalRequest\('weekly-sport-targets'\)/);
  assert.doesNotMatch(browserSource, /weekly_sport_targets/);
  assert.match(coreSource, /if\(response\.status===401\)\{handleAuthSessionLost\(\)/,
    'target reads inherit the portal gateway session-expiry flow');
});
