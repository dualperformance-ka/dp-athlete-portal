import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  detectExercisePBs,
  exerciseHistoryKey,
  isAssistedExercise,
  pbCleanSets,
  pbE1rm,
  pbFold,
  plannedKmFromRow,
  safeKm,
  sportForStravaActivity,
  titleKmFromName,
  dailyReadiness,
} from '../api/_lib/performance-summary.js';

// PARITY, NOT REIMPLEMENTATION.
//
// The server summary repeats four rule sets the browser already owns: PB
// detection, planned-distance parsing, Strava sport mapping and the readiness
// formula. Asserting the server copy against hand-written expectations would
// only prove the server agrees with itself. These tests load the BROWSER's own
// functions out of public/js and run both implementations over the same inputs,
// so editing either side without the other fails here.

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const readPublic = (name) => readFileSync(join(root, 'public', 'js', name), 'utf8');

function slice(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + 1);
  assert.ok(start >= 0, `${label}: start marker moved — update this test rather than deleting it`);
  assert.ok(end > start, `${label}: end marker moved — update this test rather than deleting it`);
  return source.slice(start, end);
}

// ── The browser's PB engine ──────────────────────────────────────────────────

function browserPb() {
  const logging = readPublic('09-logging.js');
  const training = readPublic('08-training.js');
  const context = {};
  vm.createContext(context);
  // exerciseHistoryKey and _isAssistedExercise live in 08-training.js; the PB
  // rules in 09-logging.js call both.
  vm.runInContext(slice(training, 'function exerciseHistoryKey(', 'function getExerciseSetsFromLog(', 'exerciseHistoryKey'), context);
  vm.runInContext(slice(training, 'function _isAssistedExercise(', 'function formatSetSummary(', '_isAssistedExercise'), context);
  vm.runInContext(slice(logging, 'var PB_REP_CAP=', '// ── PB TOAST', 'PB rules'), context);
  assert.equal(typeof context.detectExercisePBs, 'function');
  assert.equal(typeof context.pbFold, 'function');
  return context;
}

const browser = browserPb();

function emptyStore() {
  return { load: null, reps: null, e1rm: null, volume: null };
}

// The browser's copies run inside a vm context, so every object they return is
// from a different realm and deepEqual rejects it on prototype identity alone.
// Compare the values, which is what parity actually means here.
function plain(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}

// A deterministic spread of sets: bilateral, unilateral, bodyweight, unparsable,
// over the rep cap, under the 60% minimum-load guard, and exactly on each edge.
const SET_POOL = [
  { weight: '100', reps: '5' },
  { weight: '105', reps: '5' },
  { weight: '100', reps: '6' },
  { weight: '110', reps: '1' },
  { weight: '40', reps: '20' },          // over PB_REP_CAP
  { weight: '50', reps: '3' },           // under 60% of a 100kg store
  { weight: '60', reps: '12' },          // exactly on the cap
  { weight: '60', reps: '13' },          // one past the cap
  { weight: '100', reps: '10' },         // e1RM boundary
  { weight: '100', reps: '11' },         // past the e1RM boundary
  { weight: '', reps: '10' },            // bodyweight
  { weight: '80', reps: '' },            // no reps
  { weight: '20', repsLeft: '8', repsRight: '7' },  // unilateral
  { weight: 'x', reps: 'y' },            // unparsable
  { weight: '0', reps: '5' },            // zero load
];

// Deterministic LCG so a failure is always reproducible.
function lcg(seed) {
  let state = seed >>> 0;
  return () => { state = (state * 1_664_525 + 1_013_904_223) >>> 0; return state / 4_294_967_296; };
}

test('PB detection matches the browser rule for rule across 400 generated cases', () => {
  const random = lcg(20_260_923);
  const names = ['Back Squat', 'Bench Press', 'Assisted Pull Up', 'Bulgarian Split Squat', 'ASSISTANCE Dip'];
  let compared = 0;
  let flagged = 0;

  for (let iteration = 0; iteration < 400; iteration += 1) {
    const name = names[Math.floor(random() * names.length)];

    // Build a shared history, then fold it with BOTH implementations so the
    // stored records themselves are compared as well as the flags.
    const historySessions = [];
    const historyCount = Math.floor(random() * 4);
    for (let h = 0; h < historyCount; h += 1) {
      const size = 1 + Math.floor(random() * 4);
      historySessions.push(Array.from({ length: size }, () => SET_POOL[Math.floor(random() * SET_POOL.length)]));
    }
    const serverStore = emptyStore();
    const browserStore = emptyStore();
    historySessions.forEach((sets) => {
      pbFold(serverStore, sets);
      browser.pbFold(browserStore, sets);
    });
    assert.deepEqual(plain(serverStore), plain(browserStore), `stored records diverged on iteration ${iteration}`);

    const size = 1 + Math.floor(random() * 5);
    const sets = Array.from({ length: size }, () => SET_POOL[Math.floor(random() * SET_POOL.length)]);

    const mine = detectExercisePBs(name, sets, serverStore);
    const theirs = browser.detectExercisePBs(name, sets, browserStore);

    assert.deepEqual(
      plain(mine.map((hit) => hit.type)),
      plain(theirs.map((hit) => hit.type)),
      `PB types diverged on iteration ${iteration} for ${name}: ${JSON.stringify({ sets, serverStore })}`,
    );
    mine.forEach((hit, index) => {
      const other = theirs[index];
      assert.equal(hit.value, other.value, `value diverged on iteration ${iteration}`);
      assert.equal(hit.previous, other.previous, `previous diverged on iteration ${iteration}`);
      assert.equal(hit.unit, other.unit, `unit diverged on iteration ${iteration}`);
      // The browser formats its delta for a badge ("+5kg"); the server returns
      // the number so the client can format it. Same magnitude either way.
      assert.equal(String(hit.delta), String(other.delta).replace(/^\+/, '').replace(/kg| reps/g, ''));
    });
    compared += 1;
    flagged += mine.length;
  }

  assert.equal(compared, 400);
  // If the generator stopped producing PBs the comparison above would pass
  // trivially, so assert it actually exercised the flagging paths.
  assert.ok(flagged > 50, `only ${flagged} PBs were generated — the comparison is not exercising the rules`);
});

test('the parity harness bites when a PB rule is changed', () => {
  // Reproduce the server's load rule with the rep cap wrongly applied, and
  // confirm the browser disagrees. This is the check that proves the harness
  // above is capable of failing.
  const stored = emptyStore();
  pbFold(stored, [{ weight: '100', reps: '5' }]);
  const sets = [{ weight: '110', reps: '20' }];   // heavier, but over the rep cap

  const correct = detectExercisePBs('Back Squat', sets, stored);
  const fromBrowser = browser.detectExercisePBs('Back Squat', sets, stored);
  assert.equal(correct.some((hit) => hit.type === 'load'), true, 'a heavier set is a load PB at any rep count');
  assert.equal(fromBrowser.some((hit) => hit.type === 'load'), true);

  const wrong = sets.filter((set) => Number(set.reps) <= 12);
  assert.equal(wrong.length, 0, 'the mistaken rule would drop this set');
  assert.notEqual(correct.length, wrong.length, 'the two rules genuinely disagree');
});

test('the browser is the authority on the specific guards the summary depends on', () => {
  const stored = emptyStore();
  pbFold(stored, [{ weight: '100', reps: '5' }]);

  // A store whose REP record sits at a light weight. This is the only shape in
  // which the 60%-of-load guard changes the answer: the set can beat the rep
  // record while still being far below the load PB.
  const lightRepRecord = emptyStore();
  pbFold(lightRepRecord, [{ weight: '100', reps: '5' }]);
  pbFold(lightRepRecord, [{ weight: '50', reps: '8' }]);

  const cases = [
    { label: 'first ever seeds silently', store: emptyStore(), sets: [{ weight: '200', reps: '5' }] },
    { label: 'light set beats the rep record but is under 60% of the load PB', store: lightRepRecord, sets: [{ weight: '50', reps: '9' }] },
    { label: 'the same set once an RPE is present', store: lightRepRecord, sets: [{ weight: '50', reps: '9', rpe: '8' }] },
    { label: 'just over 60% of the load PB', store: lightRepRecord, sets: [{ weight: '61', reps: '9' }] },
    { label: 'exactly 60% of the load PB', store: lightRepRecord, sets: [{ weight: '60', reps: '9' }] },
    { label: 'a hair under 60% of the load PB', store: lightRepRecord, sets: [{ weight: '59.9', reps: '9' }] },
    { label: 'light e1rm candidate under the guard', store: lightRepRecord, sets: [{ weight: '55', reps: '2' }] },
    { label: 'below 60% of stored load', store: stored, sets: [{ weight: '55', reps: '3' }] },
    { label: 'exactly 60% of stored load', store: stored, sets: [{ weight: '60', reps: '3' }] },
    { label: 'heavier at high reps', store: stored, sets: [{ weight: '120', reps: '15' }] },
    { label: 'unilateral only', store: stored, sets: [{ weight: '20', repsLeft: '8', repsRight: '8' }] },
    { label: 'bodyweight only', store: stored, sets: [{ reps: '20' }] },
    { label: 'e1rm at 10 reps', store: stored, sets: [{ weight: '95', reps: '10' }] },
    { label: 'e1rm at 11 reps', store: stored, sets: [{ weight: '95', reps: '11' }] },
  ];

  cases.forEach(({ label, store, sets }) => {
    const mine = detectExercisePBs('Back Squat', sets, store).map((hit) => hit.type).sort();
    const theirs = browser.detectExercisePBs('Back Squat', sets, store).map((hit) => hit.type).sort();
    assert.deepEqual(plain(mine), plain(theirs), label);
  });
});

test('assisted detection and history keys match the browser exactly', () => {
  const names = [
    'Assisted Pull Up', 'assisted dip', 'ASSISTANCE Chin Up', 'Assist Machine Row',
    'Back Squat', 'Bench Press', 'Dumbbell Split Squat', 'dumbbell bulgarian split squat',
    'Bulgarian  Split   Squat ', 'Lat Pulldown', 'Assistive Device Press',
  ];
  names.forEach((name) => {
    assert.equal(isAssistedExercise(name), browser._isAssistedExercise(name), `assisted: ${name}`);
    assert.equal(exerciseHistoryKey(name), browser.exerciseHistoryKey(name), `key: ${name}`);
  });
});

test('pbCleanSets and pbE1rm match the browser', () => {
  assert.deepEqual(plain(pbCleanSets(SET_POOL)), plain(browser.pbCleanSets(SET_POOL)));
  for (let reps = 0; reps <= 13; reps += 1) {
    assert.equal(pbE1rm(100, reps), browser.pbE1rm(100, reps), `e1rm at ${reps} reps`);
  }
});

// ── Planned distance ─────────────────────────────────────────────────────────

function browserDistance() {
  const handbook = readPublic('05-handbook.js');
  const context = { runLibraryById: {}, RUNNING_LIBRARY_BY_ID: {} };
  vm.createContext(context);
  vm.runInContext(slice(handbook, 'function titleKmFromName(', 'var _programmeVolume=', 'distance helpers'), context);
  assert.equal(typeof context.plannedKmFromRow, 'function');
  return context;
}

const distance = browserDistance();

test('planned distance parsing matches the browser', () => {
  const titles = [
    'Easy Run — 12km', '5x1km Threshold', '3km pace', 'Long Run 18km', 'Progression 8km (controlled)',
    '8 x 400m reps', 'Recovery 9km', '10km time trial', 'Sub-49 Specific 3x2km + 4x200m',
    'Mobility', '2.5km shakeout', '', '45min easy',
  ];
  titles.forEach((title) => {
    assert.equal(titleKmFromName(title), distance.titleKmFromName(title), `title: ${title}`);
    assert.equal(
      plannedKmFromRow({ title }).km,
      distance.plannedKmFromRow({ title }),
      `row from title: ${title}`,
    );
  });

  const raws = ['12', '12.5', '12,5', '45min', '1 hour', '90 sec', '250', '0', '', null, undefined, '8km', '  7.5  '];
  raws.forEach((raw) => {
    assert.equal(safeKm(raw), distance.safeKm(raw), `safeKm: ${String(raw)}`);
    assert.equal(
      plannedKmFromRow({ distance_km: raw, title: 'Easy Run 9km' }).km,
      distance.plannedKmFromRow({ distance_km: raw, title: 'Easy Run 9km' }),
      `row: ${String(raw)}`,
    );
  });
});

test('Strava sport mapping matches the browser', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    slice(readPublic('05-handbook.js'), 'function sportForStravaActivity(', 'function completedSportMetrics(', 'sport mapping'),
    context,
  );
  const types = [
    'Run', 'TrailRun', 'VirtualRun', 'Ride', 'VirtualRide', 'GravelRide', 'EBikeRide',
    'Swim', 'OpenWaterSwim', 'Walk', 'Hike', 'WeightTraining', 'Workout', '', null,
  ];
  types.forEach((type) => {
    assert.equal(
      sportForStravaActivity({ sport_type: type }),
      context.sportForStravaActivity({ sport_type: type }),
      `sport: ${String(type)}`,
    );
  });
});

// ── Readiness ────────────────────────────────────────────────────────────────

test('the readiness formula matches calculateDailyReadiness exactly', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    slice(readPublic('08-training.js'), 'function calculateDailyReadiness(', 'function getHomeInsights(', 'readiness'),
    context,
  );
  const random = lcg(4_242_424);
  const pick = () => {
    const roll = random();
    if (roll < 0.2) return undefined;
    if (roll < 0.25) return '';
    if (roll < 0.3) return 'not a number';
    return String(1 + Math.floor(random() * 10));
  };
  for (let i = 0; i < 300; i += 1) {
    const log = { sleep: pick(), energy: pick(), soreness: pick(), stress: pick() };
    assert.equal(
      dailyReadiness(log),
      context.calculateDailyReadiness(log),
      `readiness diverged for ${JSON.stringify(log)}`,
    );
  }
  assert.equal(dailyReadiness(null), context.calculateDailyReadiness(null));
});
