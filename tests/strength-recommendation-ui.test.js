import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Interaction and persistence side of the progression work: what the card
// renders, what the athlete's inputs suggest, and what survives a reload or a
// resubmission. The decision rules themselves live in strength-engine.test.js.
const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const engineSource = readFileSync(join(root, 'public', 'js', '08-strength-engine.js'), 'utf8');
const trainingSource = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');
const loggingSource = readFileSync(join(root, 'public', 'js', '09-logging.js'), 'utf8');
const styles = readFileSync(join(root, 'public', 'styles.css'), 'utf8');

function makeContext() {
  const context = {
    console, Date, Math, Intl,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    esc: (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]),
    document: {
      documentElement: { classList: { toggle: () => {} } },
      addEventListener: () => {}, getElementById: () => null,
      querySelector: () => null, querySelectorAll: () => [],
    },
    window: { addEventListener: () => {}, matchMedia: () => ({ matches: false }) },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  vm.createContext(context);
  vm.runInContext(engineSource, context);
  vm.runInContext(trainingSource, context);
  return context;
}

const press = {
  exercise: 'Incline Dumbbell Press', sets: '3', workingSets: '3', reps: '8', repRange: '8-12',
};

test('the calibration control offers four typed outcomes at the coach’s effort target', () => {
  const context = makeContext();
  const pres = context.strengthPrescriptionFor({ ...press, targetRir: 3 }, 'Incline Dumbbell Press');
  const html = context.strengthEffortPickerHtml(0, 0, 0, '', null, 1, true, false, pres);

  for (const code of ['on_target', 'too_easy', 'too_hard', 'form_pain']) {
    assert.match(html, new RegExp(`'${code}'`), `missing the ${code} outcome`);
  }
  assert.match(html, /aim for 3 reps in reserve/, 'the coach’s RIR target drives the prompt');
  assert.doesNotMatch(html, /0 RIR|technical failure/i);
  // Keyboard and screen-reader reachable, and readable without colour.
  assert.match(html, /role="group" aria-label="First working set effort and quality"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /aria-label="On target — Effort as prescribed"/);
  assert.match(html, /<button type="button"/);
});

test('the default effort target is two reps in reserve, never failure', () => {
  const context = makeContext();
  const pres = context.strengthPrescriptionFor(press, 'Incline Dumbbell Press');
  assert.equal(context.strengthEffortTargetLabel(pres), '2 reps in reserve (RPE 8)');
});

test('legacy effort answers still label and still complete a saved set', () => {
  const context = makeContext();
  assert.equal(context.strengthEffortLabel('reserve'), 'Too easy');
  assert.equal(context.strengthEffortLabel('failure'), 'On target');
  assert.equal(context.strengthEffortLabel('form_break'), 'Technique / niggle');
  assert.equal(context.strengthEffortLabel('too_hard'), 'Too hard');
  const legacy = { weight: '30', reps: '10', effort: 'failure' };
  const current = { weight: '30', reps: '10', effort: 'on_target' };
  assert.equal(context.strengthSavedSetHasRequiredInputs(legacy, false, false, true), true);
  assert.equal(context.strengthSavedSetHasRequiredInputs(current, false, false, true), true);
  assert.equal(context.strengthSavedSetHasRequiredInputs({ weight: '30', reps: '10' }, false, false, true), false);
});

test('the card separates today’s target, the live result, next session and why', () => {
  const context = makeContext();
  const rec = context._nsRecommendation(press, [
    { weight: '30', reps: '10' }, { weight: '30', reps: '10' }, { weight: '30', reps: '9' },
  ], 'Incline Dumbbell Press', []);
  rec.live = { msg: '29 reps · 2 up on last session', ahead: true, beaten: { label: 'Target beaten by 2 reps' }, prompt: null };
  const html = context._nsBody(rec);

  assert.match(html, /Today’s target/);
  assert.match(html, /30kg × 8–12 @ 2 reps in reserve/);
  assert.match(html, /Live result/);
  assert.match(html, /Target beaten by 2 reps/);
  assert.match(html, /Next session/);
  assert.match(html, /Why/);
  assert.match(html, /ns-conf-confirmed">Confirmed history/);
  assert.match(html, /data-ns-decision="add_reps"/);
  assert.match(html, new RegExp(`data-ns-policy="${context.STRENGTH_POLICY.version}"`));
  // One recommendation per exercise, not two competing ones.
  assert.equal(html.match(/class="ns-action"/g).length, 1);
});

test('an estimated step says so and asks for the nearest real setting', () => {
  const context = makeContext();
  const rec = context._nsRecommendation(press, [
    { weight: '30', reps: '12' }, { weight: '30', reps: '12' }, { weight: '30', reps: '12' },
  ], 'Incline Dumbbell Press', []);
  assert.equal(rec.approx, true);
  assert.match(context._nsBody(rec), /nearest weight your equipment actually has/);
});

test('the weight box suggests the recommended load while LAST stays separate', () => {
  const context = makeContext();
  const rec = context._nsRecommendation(press, [
    { weight: '30', reps: '12' }, { weight: '30', reps: '12' }, { weight: '30', reps: '12' },
  ], 'Incline Dumbbell Press', []);
  const previous = { weight: '30', reps: '12' };
  assert.equal(rec.weightKg, 32.5);
  assert.equal(context._nsRowLoadPlaceholder(rec, press, 0, previous), '32.5', 'the suggestion is the recommendation, not last session’s raw number');
  assert.equal(context._nsRowRepPlaceholder(rec, press, 0, previous), '8', 'the rep prompt resets to the range floor with the new load');
  // Last session is still shown, unchanged, by the LAST chip.
  assert.match(context.formatSetSummary([previous], 'Incline Dumbbell Press'), /30kg × 12/);
});

test('a warm-up row keeps its own suggestion rather than the working-set load', () => {
  const context = makeContext();
  const warmed = { ...press, sets: '4', warmupSets: '1', workingSets: '3' };
  const rec = context._nsRecommendation(warmed, [
    { _rowIndex: 1, weight: '30', reps: '12' },
    { _rowIndex: 2, weight: '30', reps: '12' },
    { _rowIndex: 3, weight: '30', reps: '12' },
  ], 'Incline Dumbbell Press', []);
  assert.equal(context._nsRowLoadPlaceholder(rec, warmed, 0, { weight: '15' }), '15');
  assert.equal(context._nsRowLoadPlaceholder(rec, warmed, 1, { weight: '30' }), '32.5');
});

test('the stored snapshot records the prescription, the recommendation and the policy version', () => {
  const context = makeContext();
  context.allSessions = [{ id: 'past', date: '2026-08-25' }];
  context.exPicks = {};
  context.logs = {
    past: { 'Incline Dumbbell Press': [{ weight: '30', reps: '12' }, { weight: '30', reps: '12' }, { weight: '30', reps: '12' }], __sessionDate: '2026-08-25' },
  };
  const snapshot = context.strengthRecommendationSnapshot('today', [press]);
  const entry = snapshot['Incline Dumbbell Press'];

  // Deliberately compact: this record is stored per exercise per session inside
  // the logs blob the server caps at 750KB, so the prose is not stored. The
  // decision code plus the numbers plus the policy version reproduce it.
  assert.equal(entry.v, context.STRENGTH_POLICY.version);
  assert.equal(entry.rx.reps, '8-12');
  assert.equal(entry.rx.mode, 'range');
  assert.equal(entry.rx.sets, 3);
  assert.equal(entry.rx.rir, 2);
  assert.equal(entry.rec.d, 'increase_load');
  assert.equal(entry.rec.c, 'estimated', 'one prior session is not enough to learn the equipment ladder');
  assert.equal(entry.rec.est, 1);
  assert.equal('reason' in entry.rec, false, 'the sentence is re-derivable, so it is not stored');
  assert.equal('unit' in entry.rx, false, 'kg is the default and is not written');
  assert.equal('conv' in entry.rx, false, 'total is the default and is not written');
  assert.ok(JSON.stringify(entry).length < 260, 'a record must stay small: ' + JSON.stringify(entry).length);

  // Reopening the draft must not change the stored explanation.
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.strengthRecommendationSnapshot('today', [press]))),
    JSON.parse(JSON.stringify(snapshot)),
  );
});

test('history carries the load context it was logged under, so a unit change starts a new ladder', () => {
  const context = makeContext();
  context.allSessions = [{ id: 'kgs', date: '2026-08-25' }, { id: 'lbs', date: '2026-09-01' }];
  context.logs = {
    kgs: {
      'Incline Dumbbell Press': [{ weight: '30', reps: '10' }],
      __sessionDate: '2026-08-25',
      __strengthRx: { 'Incline Dumbbell Press': { rx: { unit: 'kg', convention: 'total' } } },
    },
    lbs: {
      'Incline Dumbbell Press': [{ weight: '70', reps: '10' }],
      __sessionDate: '2026-09-01',
      __strengthRx: { 'Incline Dumbbell Press': { rx: { unit: 'lb', convention: 'total' } } },
    },
    legacy: { 'Incline Dumbbell Press': [{ weight: '27.5', reps: '10' }], __sessionDate: '2026-08-18' },
  };
  const history = context.getExerciseHistory('today', 'Incline Dumbbell Press');
  const contexts = Array.from(history, (entry) => entry.context);
  assert.equal(contexts.includes('incline dumbbell press|lb|total'), true);
  assert.equal(contexts.includes('incline dumbbell press|kg|total'), true);
  assert.equal(contexts.includes(null), true, 'sessions logged before the snapshot stay comparable');

  const pres = context.strengthPrescriptionFor(press, 'Incline Dumbbell Press');
  assert.equal(pres.contextKey, 'incline dumbbell press|kg|total');
  // The pound session contributes no rung to the kilogram ladder.
  const ladder = context.strengthLadder(pres, history, (sets) => context.getWorkingSlice(press, sets));
  assert.equal(ladder.rungs == null || !Array.from(ladder.rungs).includes(70), true);
});

test('the recommendation snapshot rides along with drafts, submissions and the coach payload', () => {
  // Draft and submission both stamp the snapshot and the policy version.
  assert.match(loggingSource, /__policyVersion:STRENGTH_POLICY\.version,__strengthRx:strengthRecommendationSnapshot\(s\.id,exercises\)/);
  assert.match(loggingSource, /__policyVersion:STRENGTH_POLICY\.version,__strengthRx:strengthSnapshot/);
  // The coach sees the prescription and the recommendation as structured
  // fields; exercise_log keeps the exact shape the dashboard parses.
  assert.match(loggingSource, /policyVersion:STRENGTH_POLICY\.version,/);
  assert.match(loggingSource, /prescription:\(strengthSnapshot\[exName\]&&strengthSnapshot\[exName\]\.rx\)\|\|null/);
  assert.match(loggingSource, /recommendation:\(strengthSnapshot\[exName\]&&strengthSnapshot\[exName\]\.recommendation\)\|\|null/);
  assert.match(loggingSource, /exerciseLog:exName\+': '\+sets\.map/);
  // Coach-only notes never travel to the athlete side.
  assert.doesNotMatch(trainingSource, /coach_notes/);
});

test('the stored snapshot cannot change a resubmission signature', () => {
  const context = vm.createContext({ console });
  const signature = loggingSource.slice(
    loggingSource.indexOf('function gymLogSignature(log){'),
    loggingSource.indexOf('function gymLogSignature(log){') + 400,
  );
  vm.runInContext(
    'function exerciseHistoryKey(name){return String(name||"").toLowerCase().trim();}\n' +
    signature.slice(0, signature.indexOf('\n}\n') + 3),
    context,
  );
  const log = { Squat: [{ weight: '80', reps: '5' }] };
  const withSnapshot = {
    ...log,
    __strengthRx: { Squat: { policyVersion: 3, recommendation: { decision: 'add_reps' } } },
    __policyVersion: 3,
  };
  assert.equal(context.gymLogSignature(withSnapshot), context.gymLogSignature(log));
});

test('the calibration answer only fills sets that are still empty', () => {
  const context = makeContext();
  const inputs = {
    w_0_0_1: { value: '', placeholder: '30', closest: () => row },
    w_0_0_2: { value: '30', placeholder: '30', closest: () => row },
  };
  const repInput = { value: '', placeholder: '12' };
  const card = { getAttribute: (name) => (name === 'data-split-key' ? 'Upper A' : null) };
  const row = { querySelectorAll: () => [repInput], closest: (sel) => (sel === '.exc' ? card : null) };
  const previousGetter = context.document.getElementById;
  const previousDraft = context.draftGym;
  const previousToast = context.showToast;
  context.document.getElementById = (id) => inputs[id] || null;
  context.draftGym = () => {};
  context.showToast = () => {};

  const changed = context.applyStrengthEffortLoadToRemaining(0, 0, 1, 2, 32.5, 8);

  assert.equal(changed, 1, 'only the blank row moves');
  assert.equal(inputs.w_0_0_1.value, '32.5');
  assert.equal(inputs.w_0_0_2.value, '30', 'a set already logged is never rewritten');
  assert.equal(repInput.placeholder, '8', 'the rep prompt resets to the floor for the new load');

  context.document.getElementById = previousGetter;
  context.draftGym = previousDraft;
  context.showToast = previousToast;
});

test('a live 63-to-68kg change replaces stale rep chasing and targets 15 immediately', () => {
  const context = makeContext();
  const hip = { exercise: 'Hip Abduction', sets: '4', workingSets: '4', reps: '15', repRange: '15-20', targetRir: 2 };
  const previous = [
    { weight: '63', reps: '19', done: true }, { weight: '63', reps: '15', done: true },
    { weight: '63', reps: '15', done: true }, { weight: '63', reps: '15', done: true },
  ];
  const current = [
    { _rowIndex: 0, weight: '63', reps: '19', done: true },
    { _rowIndex: 1, weight: '68', reps: '', done: false },
  ];
  const baseline = context._nsRecommendation(hip, previous, hip.exercise, []);
  const live = context._nsLiveProgress(hip, current, baseline, hip.exercise, [], previous);
  const displayed = context._nsApplyLiveLoadRecommendation(baseline, live);
  displayed.live = live;

  assert.equal(live.loadChanged, true);
  assert.equal(displayed.decision, 'live_load_increase');
  assert.equal(displayed.weightKg, 68);
  assert.deepEqual(Array.from(displayed.target), [20, 15, 15, 15], 'the completed set target is preserved and only remaining targets reset');
  const html = context._nsBody(displayed);
  assert.match(html, /Load Increased/);
  assert.match(html, /Aim for 15 clean reps/);
  assert.match(html, /Maintain approximately 2 reps in reserve/);
  assert.match(html, /Current recommendation/);
  assert.doesNotMatch(html, /One extra clean rep|Beat Last Week/i);
});

test('a live 68-to-63kg reduction updates guidance without restoring the old load', () => {
  const context = makeContext();
  const hip = { exercise: 'Hip Abduction', sets: '4', workingSets: '4', reps: '15', repRange: '15-20', targetRir: 2 };
  const previous = [
    { weight: '68', reps: '18', done: true }, { weight: '68', reps: '16', done: true },
    { weight: '68', reps: '15', done: true }, { weight: '68', reps: '15', done: true },
  ];
  const current = [
    { _rowIndex: 0, weight: '68', reps: '18', done: true },
    { _rowIndex: 1, weight: '63', reps: '', done: false },
  ];
  const baseline = context._nsRecommendation(hip, previous, hip.exercise, []);
  const live = context._nsLiveProgress(hip, current, baseline, hip.exercise, [], previous);
  const displayed = context._nsApplyLiveLoadRecommendation(baseline, live);
  displayed.live = live;

  assert.equal(displayed.decision, 'live_load_decrease');
  assert.equal(displayed.weightKg, 63);
  assert.equal(displayed.target[0], baseline.target[0], 'the completed set keeps its earlier target');
  assert.deepEqual(Array.from(displayed.target.slice(1)), [15, 15, 15]);
  assert.equal(live.ahead, false, 'a safety reduction is not styled as an ahead-of-target event');
  const html = context._nsBody(displayed);
  assert.match(html, /Load Reduced/);
  assert.match(html, /Aim for at least 15 clean reps/);
  assert.match(html, /Keep the manual change/);
  assert.doesNotMatch(html, /Beat Last Week|one more rep/i);
});

test('live target hints never rewrite completed sets or entered values', () => {
  const context = makeContext();
  const hip = { exercise: 'Hip Abduction', sets: '4', workingSets: '4', reps: '15', repRange: '15-20' };
  const makeInput = (value, placeholder = '') => ({ value, placeholder });
  const makeRow = (weight, reps, done) => {
    const w = makeInput(weight);
    const r = makeInput(reps);
    return {
      w, r,
      querySelector: (selector) => selector.startsWith('button')
        ? { classList: { contains: () => done } }
        : (selector.startsWith('input[id^="w_"') ? w : null),
      querySelectorAll: () => [r],
    };
  };
  const rows = [makeRow('63', '19', true), makeRow('68', '', false), makeRow('', '', false), makeRow('', '', false)];
  const card = { querySelectorAll: () => rows };
  const live = { loadDecision: { currentLoad: 68, repTarget: 15, startWorkingIndex: 1 } };

  assert.equal(context.applyStrengthLiveTargets(card, hip, live), 3);
  assert.equal(rows[0].w.value, '63');
  assert.equal(rows[0].r.value, '19');
  assert.equal(rows[1].w.value, '68');
  assert.equal(rows[1].r.placeholder, '15');
  assert.equal(rows[2].w.value, '', 'remaining loads stay user-controlled values');
  assert.equal(rows[2].w.placeholder, '68');
  assert.equal(rows[2].r.placeholder, '15');
});

test('warm-up load changes do not enter the live progression decision', () => {
  const context = makeContext();
  const warmed = { exercise: 'Machine Press', sets: '4', warmupSets: '1', workingSets: '3', reps: '8', repRange: '8-12' };
  const previous = [
    { _rowIndex: 1, weight: '50', reps: '10' },
    { _rowIndex: 2, weight: '50', reps: '10' },
    { _rowIndex: 3, weight: '50', reps: '9' },
  ];
  const baseline = context._nsRecommendation(warmed, previous, warmed.exercise, []);
  const live = context._nsLiveProgress(
    warmed,
    [{ _rowIndex: 0, weight: '70', reps: '' }],
    baseline,
    warmed.exercise,
    [],
    previous,
  );
  assert.equal(live, null);
});

test('a saved heavier workout reloads as the next 68kg baseline', () => {
  const context = makeContext();
  const hip = { exercise: 'Hip Abduction', sets: '4', workingSets: '4', reps: '15', repRange: '15-20' };
  context.allSessions = [
    { id: 'old', date: '2026-09-01' },
    { id: 'saved', date: '2026-09-08' },
  ];
  context.logs = {
    old: { 'Hip Abduction': [{ weight: '63', reps: '19' }, { weight: '63', reps: '15' }, { weight: '63', reps: '15' }, { weight: '63', reps: '15' }], __sessionDate: '2026-09-01' },
    saved: { 'Hip Abduction': [{ weight: '68', reps: '15' }, { weight: '68', reps: '15' }, { weight: '68', reps: '15' }, { weight: '68', reps: '15' }], __sessionDate: '2026-09-08', __policyVersion: 4 },
  };
  const restored = context.getExercisePreviousEffort('future', 'Hip Abduction');
  const rec = context._nsRecommendation(hip, restored, hip.exercise, context.getExerciseHistory('future', hip.exercise));
  assert.equal(restored[0].weight, '68');
  assert.equal(rec.weightKg, 68);
  assert.match(rec.action, /68kg/);
});

test('a load increase is only celebrated once it is genuinely unlocked', () => {
  const context = makeContext();
  const provisional = context._nsRecommendation(press, [
    { weight: '30', reps: '10', effort: 'too_easy' },
  ], 'Incline Dumbbell Press', []);
  assert.equal(provisional.decision, 'change_provisional');

  const live = context._nsLiveProgress(press, [
    { weight: '30', reps: '10', effort: 'too_easy' },
  ], provisional, 'Incline Dumbbell Press', [], null);
  assert.equal(live.unlocked, false, 'an unconfirmed change is never celebrated as unlocked');

  const earned = context._nsLiveProgress(press, [
    { weight: '30', reps: '12' }, { weight: '30', reps: '12' }, { weight: '30', reps: '12' },
  ], {}, 'Incline Dumbbell Press', [], null);
  assert.equal(earned.unlocked, true);
});

test('beating a target is reported live without unlocking a load change', () => {
  const context = makeContext();
  const live = context._nsLiveProgress(
    press,
    [{ weight: '30', reps: '13' }],
    { target: [10, 10, 10] },
    'Incline Dumbbell Press',
    [],
    null,
  );
  assert.equal(live.beaten.label, 'Target beaten by 3 reps');
  assert.equal(live.unlocked, false);
});

// ── The progress record on the card ─────────────────────────────────────────

test('the card shows the progress strip oldest to newest with the best session marked', () => {
  const context = makeContext();
  const rec = context._nsRecommendation(press, [
    { weight: '30', reps: '10' }, { weight: '30', reps: '10' }, { weight: '30', reps: '9' },
  ], 'Incline Dumbbell Press', [
    { date: '2026-09-01', sets: [{ weight: '30', reps: '10' }, { weight: '30', reps: '10' }, { weight: '30', reps: '9' }] },
    { date: '2026-08-25', sets: [{ weight: '27.5', reps: '10' }, { weight: '27.5', reps: '10' }, { weight: '27.5', reps: '9' }] },
    { date: '2026-08-18', sets: [{ weight: '25', reps: '10' }, { weight: '25', reps: '9' }, { weight: '25', reps: '9' }] },
  ]);
  const html = context._nsBody(rec);

  assert.match(html, /Your progress here/);
  // Oldest first, so the line reads upward.
  const loads = Array.from(html.matchAll(/class="ns-hl">([^<]+)</g), (m) => m[1]);
  assert.deepEqual(loads, ['25kg', '27.5kg', '30kg']);
  assert.match(html, /18 Aug/);
  assert.match(html, /ns-hpt is-best/);
  // A list, labelled for a screen reader, and readable without colour.
  assert.match(html, /<ol class="ns-hlist" aria-label="Completed sessions on this exercise, oldest first">/);
  assert.match(html, /class="ns-hb">Best</);
});

test('a single session is not dressed up as a trend', () => {
  const context = makeContext();
  const rec = context._nsRecommendation(press, [
    { weight: '30', reps: '10' }, { weight: '30', reps: '10' }, { weight: '30', reps: '9' },
  ], 'Incline Dumbbell Press', [
    { date: '2026-09-01', sets: [{ weight: '30', reps: '10' }, { weight: '30', reps: '10' }, { weight: '30', reps: '9' }] },
  ]);
  assert.doesNotMatch(context._nsBody(rec), /Your progress here/);
});

test('a consolidation step says so where the lower number appears', () => {
  const context = makeContext();
  const leg = { exercise: 'Leg Press', sets: '3', workingSets: '3', reps: '8', repRange: '8-12' };
  const history = [{ date: '2026-09-01', sets: [{ weight: '60', reps: '12' }, { weight: '60', reps: '12' }, { weight: '60', reps: '11' }] }];
  const rec = context._nsRecommendation(leg, [
    { weight: '65', reps: '9' }, { weight: '65', reps: '6' }, { weight: '65', reps: '5' },
  ], 'Leg Press', history);
  const html = context._nsBody(rec);

  assert.equal(rec.weightKg, 60);
  assert.match(html, /Consolidating 65kg/);
  assert.match(html, /Repeat 60kg to lock in 65kg/);
  assert.match(html, /already reached 65kg/);
  assert.match(html, /not a step backwards/);
  // The peak note sits with the action, where the lower number is read.
  assert.ok(html.indexOf('ns-peak') > html.indexOf('ns-action'));
});

test('the peak note only appears when the recommendation sits under a reached load', () => {
  const context = makeContext();
  const rec = context._nsRecommendation(press, [
    { weight: '30', reps: '12' }, { weight: '30', reps: '12' }, { weight: '30', reps: '12' },
  ], 'Incline Dumbbell Press', [
    { sets: [{ weight: '30', reps: '12' }, { weight: '30', reps: '12' }, { weight: '30', reps: '12' }] },
  ]);
  assert.equal(rec.belowPeak, false);
  assert.doesNotMatch(context._nsBody(rec), /ns-peak/);
});

test('the milestone ladder can shrink and wrap instead of running off the card', () => {
  // The four nodes used to be flex-shrink:0 with nowrap labels, so "Increase
  // next" overhung the card edge at a narrow width or a large type setting.
  assert.match(styles, /\.ns-mnode\{flex:1 1 0;min-width:0;flex-shrink:1\}/);
  assert.match(styles, /\.ns-mnode \.ns-ml\{white-space:normal/);
  assert.match(styles, /\.ns-mnode\.cur\{transform:none\}/);
  assert.match(styles, /\.ns-block\{min-width:0;overflow-wrap:break-word\}/);
  assert.match(styles, /\.ns-tgrid\{flex-wrap:wrap\}/);
  // The progress strip scrolls inside itself rather than widening the card.
  assert.match(styles, /\.ns-hlist\{[^}]*overflow-x:auto/);
});

test('the live prompt does not repeat the headline action word for word', () => {
  const context = makeContext();
  const leg = { exercise: 'Leg Press', sets: '3', workingSets: '3', reps: '8', repRange: '8-12' };
  const history = [{ date: '2026-09-01', sets: [{ weight: '60', reps: '12' }, { weight: '60', reps: '12' }, { weight: '60', reps: '11' }] }];
  const today = [{ weight: '65', reps: '9' }, { weight: '65', reps: '6' }, { weight: '65', reps: '5' }];
  const rec = context._nsRecommendation(leg, today, 'Leg Press', history);
  rec.live = context._nsLiveProgress(leg, today, rec, 'Leg Press', history, history[0].sets);

  assert.equal(rec.live.prompt, null, 'the next-session line is already the headline');
  const html = context._nsBody(rec);
  assert.equal(html.match(/Repeat 60kg to lock in 65kg/g).length, 1, 'said once, not twice');
});
