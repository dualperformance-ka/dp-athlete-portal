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
const css = readFileSync(join(root, 'public', 'styles.css'), 'utf8');

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
  // The dial states what is left to do; the record line underneath carries both
  // absolute numbers, in the sport's own unit, for every dialled sport.
  assert.match(html, /<strong>12\.9<\/strong><span>km to go<\/span>/);
  assert.match(html, />32\.1 of 45 km</);
  assert.match(html, /<strong>42<\/strong><span>km to go<\/span>/);
  assert.match(html, />78 of 120 km</);
  assert.match(html, /<strong>1800<\/strong><span>m to go<\/span>/, 'swimming stays in metres');
  assert.match(html, />3200 of 5000 m</);
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
  assert.match(html, /<strong>\+35<\/strong><span>km over<\/span>/, 'a week past its target reports the overshoot, not a negative "to go"');
  assert.match(html, />80 of 45 km</, 'actual and prescribed both stay on the record line');
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
  assert.match(html, /Also logged/, 'the group says what it is, so each row does not have to');
  assert.match(html, /Swimming/);
  assert.match(html, />1800 m</);
  assert.match(html, /1 session/);
  assert.match(html, /42 min/);
  // No dial and no gauge: there is no target to progress against, and an empty
  // ring captioned "no weekly target" spent a third of the panel saying so.
  assert.doesNotMatch(html, /Coach target · Locked|role="progressbar"|sport-target-track/);
  assert.doesNotMatch(html, /No weekly target/);
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
  assert.match(html, /<strong>74\.6<\/strong><span>km to go<\/span>/);
  assert.match(html, />11\.4 of 86 km</);
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
  assert.match(html, /Running[\s\S]*10 of 45 km/);
  assert.doesNotMatch(html, /Planned target/);
  // The prescribed sport keeps the dial; the one that was merely logged drops
  // below it as a line, and the label carries what the caption used to say.
  assert.match(html, /Running[\s\S]*Also logged[\s\S]*Cycling[\s\S]*30 km/);
  assert.match(html, /sport-targets-solo/, 'one dial goes wide, with its facts beside it rather than centred under it');
  assert.equal((html.match(/Coach target · Locked/g) || []).length, 1);
});

// ── What the dial says, and to whom ─────────────────────────────────────────
//
// Two decisions are under test here, and both are about what the panel SAYS
// rather than how it is drawn:
//
//   1. a dial is for a prescription. A sport the athlete did without being
//      asked to gets a line under "Also logged", not a full gauge with nothing
//      to sweep and a "no weekly target" caption at the same weight as the
//      sport's own name;
//   2. the headline figure is what is LEFT. Mid-week an athlete is deciding
//      what to run today, and the record of what they have already run is the
//      second line.

test('only a prescribed sport gets a dial', () => {
  const { coachTargetsHtml } = targetDisplayHelpers();
  const html = coachTargetsHtml({
    planned: 64,
    coachTargets: [],
    actualBySport: {
      running: { distanceMetres: 61200, sessions: 7, durationMinutes: 326 },
      cycling: { distanceMetres: 51400, sessions: 1, durationMinutes: 151 },
      swimming: { distanceMetres: 3025, sessions: 2, durationMinutes: 67 },
    },
  });
  assert.equal((html.match(/sport-target-track/g) || []).length, 1, 'one prescription, one dial');
  assert.equal((html.match(/role="progressbar"/g) || []).length, 1);
  // Both cross-training sports survive, with their distance and their make-up.
  assert.match(html, /Also logged[\s\S]*Cycling[\s\S]*51\.4 km[\s\S]*151 min/);
  assert.match(html, /Also logged[\s\S]*Swimming[\s\S]*3025 m[\s\S]*67 min/);
  assert.doesNotMatch(html, /sport-target-cycling|sport-target-swimming/, 'neither gets a dial');
});

test('the dial states what is left, and the record line states both numbers', () => {
  const { volumeDialFigure } = targetDisplayHelpers();
  assert.deepEqual({ ...volumeDialFigure(61200, 64000, 'running') }, { value: '2.8', qualifier: 'km to go', state: ' is-togo' });
  assert.deepEqual({ ...volumeDialFigure(85600, 75000, 'running') }, { value: '+10.6', qualifier: 'km over', state: ' is-over' });
  assert.deepEqual({ ...volumeDialFigure(3025, 5000, 'swimming') }, { value: '1975', qualifier: 'm to go', state: ' is-togo' });
  // Landing on the target deserves better than "0 km to go".
  assert.deepEqual({ ...volumeDialFigure(64000, 64000, 'running') }, { value: '✓', qualifier: 'on target', state: ' is-met' });
  // Rounding noise under 50 metres is on target, matching the bar chart's rule.
  assert.equal(volumeDialFigure(63960, 64000, 'running').qualifier, 'on target');
  // Nothing prescribed: the figure is simply what was done.
  assert.deepEqual({ ...volumeDialFigure(51400, 0, 'cycling') }, { value: '51.4', qualifier: 'km', state: '' });
});

test('the deadline is only reported while the week can still be affected', () => {
  const { weekDaysLeft, weekClockText } = targetDisplayHelpers();
  const iso = (offsetDays) => {
    const date = new Date();
    date.setDate(date.getDate() + offsetDays);
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  };
  assert.equal(weekDaysLeft({ isCurrent: true, endISO: iso(0) }), 0, 'the last day of the week');
  assert.equal(weekDaysLeft({ isCurrent: true, endISO: iso(3) }), 3);
  assert.equal(weekDaysLeft({ isCurrent: true, endISO: iso(-1) }), null, 'a finished week has no time left to report');
  assert.equal(weekDaysLeft({ isCurrent: false, endISO: iso(30) }), null, 'a future week would otherwise read "30 days left"');
  assert.equal(weekDaysLeft({ isCurrent: true }), null, 'no dates, no claim');
  assert.equal(weekClockText(0), 'Last day');
  assert.equal(weekClockText(1), '1 day left');
  assert.equal(weekClockText(4), '4 days left');
  assert.equal(weekClockText(null), '');
});

test('only what is still moving takes the readout colour', () => {
  // The remaining figure is the live number, so it glows; a banked total does
  // not. Baby blue on live values only is the whole rule of this palette.
  assert.match(css, /\.sport-target-distance\.is-togo strong\{color:var\(--run\)\}/);
  assert.match(css, /\.sport-target-distance\.is-over strong,\.sport-target-distance\.is-met strong\{color:var\(--done\)\}/);
});

test('one dial reads across, not down', () => {
  // A single dial centred over a stack of centred captions is the hardest
  // version of this to read. Alone, it goes left with its facts beside it.
  assert.match(nutritionSource, /dialled\.length===1\?' sport-targets-solo':''/);
  assert.match(css, /\.sport-targets-solo \.sport-target\{[\s\S]*?grid-template-areas:'ring head' 'ring record' 'ring meta' 'ring clock' 'note note'/);
  assert.match(css, /\.sport-targets-solo \.sport-target\{[\s\S]*?text-align:left/);
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
  assert.match(nutritionSource, /note\?'<div class="sport-target-note">'\+esc\(note\)/);
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
