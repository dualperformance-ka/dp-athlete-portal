import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The engine is pure: no DOM, no storage, no clock. It runs in a bare context
// so a test can only exercise the decision rules, never the rendering.
const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const engineSource = readFileSync(join(root, 'public', 'js', '08-strength-engine.js'), 'utf8');
const trainingSource = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');
const loggingSource = readFileSync(join(root, 'public', 'js', '09-logging.js'), 'utf8');
const styles = readFileSync(join(root, 'public', 'styles.css'), 'utf8');

const engine = vm.createContext({ console });
vm.runInContext(engineSource, engine);

const {
  STRENGTH_POLICY,
  normaliseStrengthPrescription,
  normaliseStrengthSets,
  strengthEffortEvidence,
  strengthLadder,
  strengthHarderRung,
  strengthEasierRung,
  strengthCalibrationDecision,
  strengthProgressionDecision,
  strengthTargetBeaten,
  strengthQualityCode,
} = engine;

const rangePress = {
  exercise: 'Incline Dumbbell Press', sets: '3', workingSets: '3', reps: '8', repRange: '8-12',
};
const prescribe = (overrides = {}) => normaliseStrengthPrescription({ ...rangePress, ...overrides });
// Rows are handed in already sliced to the programmed working window, exactly
// as 08-training.js does through getWorkingSlice.
const rows = (pres, list) => normaliseStrengthSets(list, pres, 'working');
const decide = (pres, list, history = [], ladder) => strengthProgressionDecision({
  prescription: pres,
  sets: rows(pres, list),
  history,
  ladder: ladder || strengthLadder(pres, history),
});
const set = (weight, reps, extra = {}) => ({ weight: String(weight), reps: String(reps), ...extra });

// 1 ── First-ever exercise: no load, no equipment rung, no invented kilos.
test('a first-ever exercise asks for a controllable load and invents no weight', () => {
  const pres = prescribe();
  const decision = decide(pres, []);
  assert.equal(decision.decision, 'calibrate');
  assert.equal(decision.weightKg, null, 'no fabricated kg value');
  assert.equal(decision.estimated, true);
  assert.equal(decision.confidence.level, 'low');
  assert.match(decision.targetNote, /about 2 more clean reps/);
  assert.doesNotMatch(decision.targetNote + decision.reason, /failure/i);
});

// 2 ── Coach configuration outranks every tracker default.
test('coach target load, effort target and progression rule take precedence', () => {
  const pres = normaliseStrengthPrescription({
    exercise: 'Back Squat', sets: '3', workingSets: '3',
    repMin: 5, repMax: 5, targetLoad: 100, targetRir: 3, progression: 'exact reps',
  });
  assert.equal(pres.repMode, 'exact');
  assert.equal(pres.exactReps, 5);
  assert.equal(pres.targetRir, 3);
  assert.equal(pres.targetEffortSource, 'coach');
  assert.equal(pres.progression.type, 'exact_reps');

  const decision = decide(pres, []);
  assert.equal(decision.decision, 'coach_target');
  assert.equal(decision.weightKg, 100);
  assert.equal(decision.action, 'Start at 100kg');
  assert.equal(decision.confidence.level, 'coach_set');
});

test('an RPE target is read as its reps-in-reserve equivalent, and RIR wins when both are set', () => {
  assert.equal(normaliseStrengthPrescription({ ...rangePress, targetRpe: 7 }).targetRir, 3);
  assert.equal(normaliseStrengthPrescription({ ...rangePress, targetRpe: 7, targetRir: 1 }).targetRir, 1);
  assert.equal(prescribe().targetRir, STRENGTH_POLICY.defaultTargetRir, 'no coach target falls back to the conservative default');
});

test('an unrecognised progression rule is displayed, never executed, and flagged for review', () => {
  const pres = prescribe({ progression: 'wave load 3s then autoregulate off bar speed' });
  assert.equal(pres.progression.type, 'coach_text');
  assert.equal(pres.progression.supported, false);
  assert.equal(pres.coachReview, true);
  assert.equal(pres.progression.raw, 'wave load 3s then autoregulate off bar speed');
  // Falls back conservatively rather than guessing at the rule's meaning.
  const decision = decide(pres, [set(30, 10), set(30, 10), set(30, 9)]);
  assert.equal(decision.decision, 'add_reps');
});

// 3 ── Exact reps versus a rep range.
test('an exact-rep prescription never invents an extra rep', () => {
  const pres = normaliseStrengthPrescription({
    exercise: 'Back Squat', sets: '3', workingSets: '3', repMin: 5, repMax: 5,
  });
  // All three sets at the written reps is the exact-rep unlock: the LOAD moves,
  // by one rung, and the rep target stays at five.
  const earned = decide(pres, [set(100, 5), set(100, 5), set(100, 5)]);
  assert.equal(earned.decision, 'increase_load');
  assert.deepEqual(Array.from(earned.target), [5, 5, 5], 'the target stays at the coach’s exact reps');
  assert.equal(earned.target.includes(6), false, 'six is never invented as the next target');

  // A missed set holds the load and still refuses to invent a sixth rep.
  const missed = decide(pres, [set(100, 5), set(100, 4), set(100, 5)]);
  assert.equal(missed.decision, 'hold_load');
  assert.deepEqual(Array.from(missed.target), [5, 5, 5]);
  assert.match(missed.reason, /under 5 reps/);

  // A coach who writes a range but an exact-rep rule still gets exact targets:
  // the reps stay where they were written and only the load can move.
  const ruled = normaliseStrengthPrescription({
    exercise: 'Back Squat', sets: '3', workingSets: '3', repMin: 5, repMax: 8, progression: 'exact reps',
  });
  const held = decide(ruled, [set(100, 6), set(100, 6), set(100, 6)]);
  assert.equal(held.decision, 'hold_load');
  assert.deepEqual(Array.from(held.target), [5, 5, 5]);
  assert.match(held.reason, /exactly 5 reps/);
});

// 4 ── One extra rep at the same load, inside the range.
test('a rep range asks for exactly one more total rep without passing the ceiling', () => {
  const decision = decide(prescribe(), [set(30, 10), set(30, 10), set(30, 9)]);
  assert.equal(decision.decision, 'add_reps');
  assert.deepEqual(Array.from(decision.target), [11, 10, 9]);
  assert.equal(decision.weightKg, 30);
  assert.equal(decision.confidence.level, 'confirmed');
});

// 5 ── Beating a per-set target is acknowledged exactly.
test('beating a per-set target reports the exact number of reps beaten', () => {
  const pres = prescribe();
  const beaten = strengthTargetBeaten(pres, rows(pres, [set(30, 13), set(30, 10)]), [10, 10, 10]);
  assert.equal(beaten.by, 3);
  assert.equal(beaten.setIndex, 0);
  assert.equal(beaten.label, 'Target beaten by 3 reps');
  assert.equal(strengthTargetBeaten(pres, rows(pres, [set(30, 11)]), [10]).label, 'Target beaten by 1 rep');
  assert.equal(strengthTargetBeaten(pres, rows(pres, [set(30, 9)]), [10]), null);
});

// 6 ── One set over the ceiling cannot unlock anything on its own.
test('a single set above the ceiling with the rest unfinished does not unlock more load', () => {
  const decision = decide(prescribe(), [set(30, 14)]);
  assert.equal(decision.decision, 'incomplete');
  assert.equal(decision.weightKg, 30);
  assert.match(decision.reason, /1 of 3 working sets/);
  assert.notEqual(decision.decision, 'increase_load');
});

// 7 ── Every programmed set at or above the ceiling.
test('every working set at the ceiling earns exactly one rung and resets the target to the floor', () => {
  // A full ladder above the working load, so "one rung" is unambiguous: 32.5,
  // not 35. Without rungs above the current load the arithmetic fallback would
  // hide a two-rung jump.
  const history = [
    { sets: [set(30, 12), set(30, 12), set(30, 12)] },
    { sets: [set(32.5, 10), set(32.5, 10), set(32.5, 10)] },
    { sets: [set(35, 10), set(35, 10), set(35, 10)] },
    { sets: [set(37.5, 8), set(37.5, 8), set(37.5, 8)] },
  ];
  const decision = decide(prescribe(), [set(30, 12), set(30, 12), set(30, 12)], history);
  assert.equal(decision.decision, 'increase_load');
  assert.equal(decision.weightKg, 32.5, 'one learned rung above 30, never two');
  assert.deepEqual(Array.from(decision.target), [8, 8, 8]);
  assert.equal(decision.confidence.level, 'learned');
  assert.equal(decision.estimated, false);
});

// 8/9 ── Same-day calibration, confirmed and unconfirmed.
test('a too-easy first set offers one rung today and only carries it forward once confirmed', () => {
  const pres = prescribe();
  const confirmed = decide(pres, [set(30, 10, { effort: 'too_easy' }), set(32.5, 9), set(32.5, 8)]);
  assert.equal(confirmed.decision, 'load_confirmed');
  assert.equal(confirmed.weightKg, 32.5);
  assert.equal(confirmed.confidence.level, 'confirmed');

  const unconfirmed = decide(pres, [set(30, 10, { effort: 'too_easy' }), set(32.5, 6), set(30, 8)]);
  assert.equal(unconfirmed.decision, 'change_unconfirmed');
  assert.equal(unconfirmed.weightKg, 30, 'returns to the previous confirmed starting load');
  assert.match(unconfirmed.reason, /did not confirm/);
});

test('a too-easy first set with no follow-up set stays provisional rather than confirmed', () => {
  const decision = decide(prescribe(), [set(30, 10, { effort: 'too_easy' })]);
  assert.equal(decision.decision, 'change_provisional');
  assert.equal(decision.estimated, true);
  assert.match(decision.reason, /confirm it with a full working set/);
});

// 10 ── Too hard, form breakdown and pain.
test('a first set under the floor at a hard effort steps one rung down', () => {
  const decision = decide(prescribe(), [set(30, 6, { effort: 'too_hard' }), set(27.5, 9), set(27.5, 8)]);
  assert.equal(decision.decision, 'reduce_load');
  assert.equal(decision.weightKg, 27.5);
  assert.equal(decision.painFlag, false);
});

test('a technique or pain answer suppresses any increase and flags the coach', () => {
  const first = decide(prescribe(), [set(30, 8, { effort: 'form_pain' }), set(27.5, 10), set(27.5, 9)]);
  assert.equal(first.decision, 'reduce_load');
  assert.equal(first.painFlag, true);
  assert.equal(first.coachReview, true);
  assert.match(first.reason, /lost clean technique/);

  const later = decide(prescribe(), [set(30, 10), set(30, 9, { effort: 'form_pain' }), set(30, 12)]);
  assert.equal(later.decision, 'technique_check');
  assert.equal(later.painFlag, true);
  assert.notEqual(later.decision, 'increase_load');
  // Guidance, not diagnosis.
  assert.doesNotMatch(later.reason, /injur|strain|tear|diagnos/i);
});

test('technique or pain outranks a session that would otherwise have earned a load increase', () => {
  const decision = decide(prescribe(), [set(30, 12), set(30, 12), set(30, 12, { effort: 'form_pain' })]);
  assert.equal(decision.decision, 'technique_check');
});

// 11 ── Conflicting inputs hold the load and say so.
test('conflicting reps and effort inputs hold the load and lower confidence', () => {
  const pres = prescribe();
  const calibration = strengthCalibrationDecision({
    prescription: pres,
    set: rows(pres, [set(30, 10, { effort: 'too_easy', rpe: '10' })])[0],
    ladder: strengthLadder(pres, []),
  });
  assert.equal(calibration.outcome, 'hold');
  assert.equal(calibration.conflict, true);
  assert.equal(calibration.targetLoad, 30);
  assert.equal(calibration.confidence.level, 'low');
  assert.match(calibration.message, /do not agree/);
});

test('a too-easy answer under the rep floor is treated as a conflict, not a licence to add load', () => {
  const pres = prescribe();
  const calibration = strengthCalibrationDecision({
    prescription: pres,
    set: rows(pres, [set(30, 5, { effort: 'too_easy' })])[0],
    ladder: strengthLadder(pres, []),
  });
  assert.equal(calibration.outcome, 'hold');
  assert.equal(calibration.conflict, true);
});

// 12 ── A deliberate heavier load, consolidated or not.
test('a deliberate heavier load is recognised when every set holds the floor', () => {
  const history = [{ sets: [set(60, 12), set(60, 12), set(60, 11)] }];
  const decision = decide(prescribe({ exercise: 'Leg Press' }), [set(65, 9), set(65, 8), set(65, 8)], history);
  assert.equal(decision.decision, 'load_confirmed');
  assert.equal(decision.status, 'New Load Confirmed');
  assert.equal(decision.weightKg, 65, 'fewer total reps than last week still counts as load progression');
});

test('a heavier load that drops later sets under the floor is noted but not confirmed', () => {
  const history = [{ sets: [set(60, 12), set(60, 12), set(60, 11)] }];
  const decision = decide(prescribe({ exercise: 'Leg Press' }), [set(65, 9), set(65, 6), set(65, 5)], history);
  assert.equal(decision.decision, 'change_unconfirmed');
  assert.equal(decision.status, 'Load Attempt Noted');
  assert.equal(decision.weightKg, 60, 'the previously confirmed load stays the baseline');
});

// 13 ── Ramped, top-set and back-off loads keep their roles.
test('a ramped session recommends each set role instead of flattening to one load', () => {
  const pres = prescribe({ exercise: 'Barbell Back Squat' });
  const decision = decide(pres, [set(50, 12), set(60, 12), set(70, 12)]);
  assert.equal(decision.ramped, true);
  assert.match(decision.action, /^Top set to /);
  assert.ok(decision.perSet && decision.perSet.length === 2);
  assert.equal(decision.perSet[0].role, 'top');
  assert.equal(decision.perSet[1].role, 'backoff');
  assert.ok(decision.perSet[0].loadKg > decision.perSet[1].loadKg, 'the back-off stays under the top set');
  assert.doesNotMatch(decision.action, /Stay at/);
});

// 14 ── Warm-ups and bonus sets are stored but are not progression evidence.
test('warm-up and bonus rows are classified out of the working window', () => {
  const pres = normaliseStrengthPrescription({
    exercise: 'Leg Extension', sets: '3', warmupSets: '1', workingSets: '2', repRange: '8-12',
  });
  const normalised = normaliseStrengthSets([
    { _rowIndex: 0, weight: '20', reps: '12' },
    { _rowIndex: 1, weight: '40', reps: '12' },
    { _rowIndex: 2, weight: '40', reps: '12' },
    { _rowIndex: 3, weight: '40', reps: '12' },
  ], pres);
  assert.deepEqual(Array.from(normalised, (row) => row.role), ['warmup', 'working', 'working', 'bonus']);
});

// 15 ── Partial rows are never read as zero reps.
test('weight-only, blank and impossible rows do not count as completed work', () => {
  const pres = prescribe();
  const normalised = normaliseStrengthSets([
    { weight: '30', reps: '' },
    { weight: '', reps: '' },
    { weight: '30', reps: '400' },
    { weight: '-5', reps: '10' },
    { weight: '30', reps: 'abc' },
    { weight: '30', reps: '10' },
  ], pres, 'working');
  // A row is evidence only when it carries usable reps AND no impossible value.
  // A negative load invalidates the whole row rather than half-trusting it.
  assert.deepEqual(Array.from(normalised, (row) => row.counts), [false, false, false, false, false, true]);
  assert.equal(normalised[3].load, null, 'a negative load is rejected, not stored');
  assert.equal(normalised[3].invalid, 'load');
  assert.equal(normalised[2].reps, null, 'an impossible rep count is dropped rather than used');
});

test('a missing log is never punished as a zero-rep session', () => {
  const decision = decide(prescribe(), [set(30, 10), { weight: '30', reps: '' }, {}]);
  assert.equal(decision.decision, 'incomplete');
  assert.match(decision.reason, /1 of 3 working sets/);
  assert.notEqual(decision.decision, 'reduce_load');
});

// 16 ── Unilateral work progresses on the weaker side.
test('unilateral sets progress on the weaker side and keep both sides', () => {
  const pres = prescribe({ exercise: 'Bulgarian Split Squat' });
  const normalised = rows(pres, [{ weight: '20', repsLeft: '12', repsRight: '9' }]);
  assert.equal(normalised[0].reps, 9, 'the weaker side decides progression');
  assert.equal(normalised[0].repsLeft, 12);
  assert.equal(normalised[0].repsRight, 9);
  assert.equal(normalised[0].weakerSide, 'right');

  const decision = decide(pres, [
    { weight: '20', repsLeft: '12', repsRight: '9' },
    { weight: '20', repsLeft: '12', repsRight: '9' },
    { weight: '20', repsLeft: '12', repsRight: '10' },
  ]);
  assert.notEqual(decision.decision, 'increase_load', 'a strong side alone cannot unlock load for both');
  assert.equal(decision.decision, 'add_reps');
});

// 17 ── Assisted machines run in reverse and stop at zero assistance.
test('assisted work gets harder by removing assistance and stops at bodyweight', () => {
  const pres = prescribe({ exercise: 'Assisted Pull-Up' });
  assert.equal(pres.loadMode, 'assisted');
  const ladder = { step: 5, rungs: null, source: 'learned', exact: true };
  assert.equal(strengthHarderRung(pres, 20, ladder).load, 15);
  assert.equal(strengthEasierRung(pres, 20, ladder).load, 25);
  const boundary = strengthHarderRung(pres, 5, ladder);
  assert.equal(boundary.load, 0);
  assert.equal(boundary.atBoundary, true, 'assistance never goes below zero');

  const decision = decide(pres, [set(5, 12), set(5, 12), set(5, 12)], [], ladder);
  assert.equal(decision.action, 'Try bodyweight');
  assert.equal(decision.weightKg, 0);
});

// 18 ── Bodyweight: zero load is data, not a gap.
test('bodyweight work treats a zero load as valid and progresses through reps', () => {
  const pres = prescribe({ exercise: 'Push-Up' });
  assert.equal(pres.loadMode, 'bodyweight');
  const normalised = rows(pres, [set(0, 12)]);
  assert.equal(normalised[0].load, 0);
  assert.equal(normalised[0].hasLoad, true, 'zero external load is real data on a bodyweight movement');
  assert.equal(normalised[0].counts, true);

  const decision = decide(pres, [set(0, 12), set(0, 12), set(0, 12)]);
  assert.equal(decision.decision, 'increase_reps');
  assert.deepEqual(Array.from(decision.target), [13, 13, 13]);
  assert.doesNotMatch(decision.action, /0kg/, 'bodyweight is never rendered as a missing load');
});

test('bodyweight plus added load progresses through load like any other loaded lift', () => {
  const pres = prescribe({ exercise: 'Weighted Pull-Up' });
  assert.equal(pres.loadMode, 'bodyweight_plus');
  const decision = decide(pres, [set(10, 12), set(10, 12), set(10, 12)]);
  assert.equal(decision.decision, 'increase_load');
  assert.ok(decision.weightKg > 10);
});

test('an unknown band resistance never produces a precise kilo instruction', () => {
  const pres = prescribe({ exercise: 'Band Pull-Apart' });
  assert.equal(pres.loadMode, 'band_unknown');
  assert.equal(strengthHarderRung(pres, 10, strengthLadder(pres, [])).load, null);
  const decision = decide(pres, [set(10, 12), set(10, 12), set(10, 12)]);
  assert.equal(decision.decision, 'coach_review');
  assert.equal(decision.coachReview, true);
});

// 19 ── Per-hand and unit isolation.
test('per-hand and kilogram/pound histories are kept apart', () => {
  const perHand = normaliseStrengthPrescription({ ...rangePress, loadConvention: 'per_hand' });
  const total = normaliseStrengthPrescription(rangePress);
  const pounds = normaliseStrengthPrescription({ ...rangePress, loadUnit: 'lb' });
  assert.notEqual(perHand.contextKey, total.contextKey);
  assert.notEqual(pounds.contextKey, total.contextKey);
  assert.equal(pounds.unit, 'lb');

  // A history entry tagged with another context contributes no rungs.
  const foreign = [{ context: total.contextKey, sets: [set(30, 10), set(35, 10)] }];
  assert.equal(strengthLadder(perHand, foreign).source, 'estimated');
  assert.equal(strengthLadder(total, foreign).source, 'learned');
});

test('a name is normalised for formatting but two different exercises never merge', () => {
  assert.equal(
    normaliseStrengthPrescription({ ...rangePress }, '  INCLINE   DUMBBELL PRESS ').contextKey,
    normaliseStrengthPrescription({ ...rangePress }, 'Incline Dumbbell Press').contextKey,
  );
  assert.notEqual(
    normaliseStrengthPrescription({ ...rangePress }, 'Incline Dumbbell Press').contextKey,
    normaliseStrengthPrescription({ ...rangePress }, 'Flat Dumbbell Press').contextKey,
  );
});

// 20 ── Learned rungs, estimates, machine changes and typos.
test('the equipment ladder is learned from real loads, and a lone outlier is dropped without touching the log', () => {
  const pres = prescribe({ exercise: 'Seated Cable Row' });
  const history = [
    { sets: [set(40, 10), set(40, 10)] },
    { sets: [set(45, 10), set(45, 10)] },
    { sets: [set(50, 10), set(50, 10)] },
    { sets: [set(145, 10)] },
  ];
  const ladder = strengthLadder(pres, history);
  assert.equal(ladder.source, 'learned');
  assert.equal(ladder.step, 5);
  assert.equal(ladder.rungs.includes(145), false, 'a lone 145 next to a 40-50 ladder is a typo, not a rung');
  assert.equal(history[3].sets[0].weight, '145', 'the source log is left exactly as it was logged');
  assert.equal(strengthHarderRung(pres, 45, ladder).load, 50);
});

test('with too little history the step is an estimate and says so', () => {
  const pres = prescribe({ exercise: 'Seated Cable Row' });
  const ladder = strengthLadder(pres, [{ sets: [set(40, 10)] }]);
  assert.equal(ladder.source, 'estimated');
  assert.equal(ladder.exact, false);
  const decision = decide(pres, [set(40, 12), set(40, 12), set(40, 12)], [{ sets: [set(40, 10)] }]);
  assert.equal(decision.estimated, true);
  assert.equal(decision.confidence.level, 'estimated');
  assert.match(decision.reason, /Round to the next setting your equipment actually has/);
});

test('a coach-defined increment beats a learned one', () => {
  const pres = prescribe({ exercise: 'Seated Cable Row', progression: '+2.5kg' });
  assert.equal(pres.progression.type, 'linear_load');
  const ladder = strengthLadder(pres, [{ sets: [set(40, 10)] }, { sets: [set(45, 10)] }]);
  assert.equal(ladder.source, 'coach');
  assert.equal(ladder.step, 2.5);
});

test('no suggested load passes the safety cap or goes below zero', () => {
  const pres = prescribe({ exercise: 'Leg Press' });
  const big = { step: 50, rungs: null, source: 'learned', exact: true };
  assert.ok(strengthHarderRung(pres, STRENGTH_POLICY.maxLoadKg, big).load <= STRENGTH_POLICY.maxLoadKg);
  assert.ok(strengthEasierRung(pres, 10, big).load >= 0);
});

// 21 ── Time and isometric prescriptions stay out of the rep engine.
test('a seconds or distance prescription defers to the coach instead of running rep logic', () => {
  const seconds = normaliseStrengthPrescription({ exercise: 'Plank', repMode: 'seconds', reps: '45', workingSets: '3' });
  const decision = decide(seconds, [set(0, 45), set(0, 45), set(0, 45)]);
  assert.equal(decision.decision, 'mode_deferred');
  assert.match(decision.targetNote, /time under tension/);

  const distance = normaliseStrengthPrescription({ exercise: 'Farmer Carry', repMode: 'distance', workingSets: '3' });
  assert.equal(decide(distance, [set(30, 20)]).decision, 'mode_deferred');
});

// 23 ── Plateaus need real evidence.
test('three sessions at one load do not deload on their own', () => {
  const pres = prescribe({ exercise: 'Seated Cable Row' });
  const improving = [
    { sets: [set(50, 11), set(50, 10), set(50, 10)] },
    { sets: [set(50, 10), set(50, 10), set(50, 9)] },
    { sets: [set(50, 9), set(50, 9), set(50, 9)] },
  ];
  assert.equal(decide(pres, [set(50, 11), set(50, 10), set(50, 10)], improving).decision, 'add_reps', 'reps still improving is progress');

  const flatNoEffort = [
    { sets: [set(50, 9), set(50, 9), set(50, 9)] },
    { sets: [set(50, 9), set(50, 9), set(50, 9)] },
    { sets: [set(50, 9), set(50, 9), set(50, 9)] },
  ];
  const held = decide(pres, [set(50, 9), set(50, 9), set(50, 9)], flatNoEffort);
  assert.equal(held.decision, 'hold_load');
  assert.equal(held.status, 'Hold And Log');
  assert.equal(held.confidence.level, 'low');
  assert.match(held.reason, /Rate the first set honestly/);
});

test('a true high-effort plateau recommends one conservative rung back and a coach conversation', () => {
  const pres = prescribe({ exercise: 'Seated Cable Row' });
  const hard = { effort: 'too_hard' };
  const stuck = [
    { sets: [set(50, 9, hard), set(50, 9), set(50, 9)] },
    { sets: [set(50, 9, hard), set(50, 9), set(50, 9)] },
    { sets: [set(50, 9, hard), set(50, 9), set(50, 9)] },
  ];
  const decision = decide(pres, [set(50, 9), set(50, 9), set(50, 9)], stuck);
  assert.equal(decision.decision, 'reduce_load');
  assert.equal(decision.coachReview, true);
  assert.ok(decision.weightKg < 50, 'one rung back, not a percentage guess');
});

test('an incomplete history is not plateau evidence', () => {
  const pres = prescribe({ exercise: 'Seated Cable Row' });
  const hard = { effort: 'too_hard' };
  const partial = [
    { sets: [set(50, 9, hard)] },
    { sets: [set(50, 9, hard)] },
    { sets: [set(50, 9, hard)] },
  ];
  assert.notEqual(decide(pres, [set(50, 9), set(50, 9), set(50, 9)], partial).decision, 'reduce_load');
});

test('a session after a load change is consolidation, not a plateau', () => {
  const pres = prescribe({ exercise: 'Seated Cable Row' });
  const hard = { effort: 'too_hard' };
  const stuck = [
    { sets: [set(50, 9, hard), set(50, 9), set(50, 9)] },
    { sets: [set(50, 9, hard), set(50, 9), set(50, 9)] },
    { sets: [set(50, 9, hard), set(50, 9), set(50, 9)] },
  ];
  assert.notEqual(decide(pres, [set(45, 9), set(45, 9), set(45, 9)], stuck).decision, 'reduce_load');
});

// 24 ── Effort evidence with and without RPE logging.
test('effort reads from RIR, RPE or the quality answer, and reports a disagreement', () => {
  const pres = prescribe();
  const fromRpe = strengthEffortEvidence(pres, rows(pres, [set(30, 10, { rpe: '8' })])[0]);
  assert.equal(fromRpe.rir, 2);
  assert.equal(fromRpe.band, 'on');

  const noRpe = strengthEffortEvidence(pres, rows(pres, [set(30, 10, { effort: 'on_target' })])[0]);
  assert.equal(noRpe.band, 'on', 'the quality answer works with RPE logging switched off');

  const clash = strengthEffortEvidence(pres, rows(pres, [set(30, 10, { effort: 'too_easy', rpe: '10' })])[0]);
  assert.equal(clash.conflict, true);
});

test('legacy effort codes keep their meaning', () => {
  assert.equal(strengthQualityCode('reserve'), 'too_easy');
  assert.equal(strengthQualityCode('failure'), 'at_limit');
  assert.equal(strengthQualityCode('form_break'), 'form_pain');
  assert.equal(strengthQualityCode('on_target'), 'on_target');
  assert.equal(strengthQualityCode('nonsense'), '');
});

// 25 ── Determinism: the same inputs always give the same decision.
test('the same inputs always produce the same decision object', () => {
  const pres = prescribe();
  const list = [set(30, 12), set(30, 11), set(30, 12)];
  const history = [{ sets: [set(27.5, 10), set(27.5, 10), set(27.5, 10)] }];
  assert.deepEqual(decide(pres, list, history), decide(pres, list, history));
  assert.equal(decide(pres, list, history).policyVersion, STRENGTH_POLICY.version);
});

test('every decision carries a reason and a confidence source', () => {
  const pres = prescribe();
  const cases = [
    [],
    [set(30, 10)],
    [set(30, 10), set(30, 10), set(30, 9)],
    [set(30, 12), set(30, 12), set(30, 12)],
    [set(30, 6, { effort: 'too_hard' }), set(27.5, 9), set(27.5, 8)],
    [set(30, 8, { effort: 'form_pain' })],
  ];
  for (const list of cases) {
    const decision = decide(pres, list);
    assert.ok(decision.reason && decision.reason.length > 10, `missing reason for ${JSON.stringify(list)}`);
    assert.ok(decision.confidence && decision.confidence.level, 'missing confidence');
    assert.ok(decision.tone, 'missing tone');
    assert.equal(decision.policyVersion, STRENGTH_POLICY.version);
  }
});

// 26 ── No default instruction to reach failure or 0 RIR anywhere in the copy.
test('no athlete-facing copy tells every athlete to train to failure or 0 RIR', () => {
  for (const [name, source] of [['engine', engineSource], ['training', trainingSource], ['logging', loggingSource]]) {
    assert.doesNotMatch(source, /technical failure/i, `${name} still instructs technical failure`);
    assert.doesNotMatch(source, /target 0 RIR/i, `${name} still targets 0 RIR`);
    assert.doesNotMatch(source, /Calibrate at technical/i, `${name} still calibrates at failure`);
    assert.doesNotMatch(source, /(?:train|go|push|work|reach|calibrat\w*|take it)\s+to (?:technical )?failure/i, `${name} still asks for failure`);
    assert.doesNotMatch(source, /all[- ]out set|max out|as many reps as possible/i, `${name} still pushes an all-out set`);
  }
  assert.match(trainingSource, /Calibrate the first working set/);
  assert.match(trainingSource, /two more clean reps/);
  assert.match(trainingSource, /on_target/);
  assert.match(trainingSource, /too_easy/);
  assert.match(trainingSource, /too_hard/);
  assert.match(trainingSource, /form_pain/);
  // The recommendation is one card with four labelled parts.
  assert.match(trainingSource, /Today’s target/);
  assert.match(trainingSource, /Live result/);
  assert.match(trainingSource, /Next session/);
  assert.match(trainingSource, /class="ns-conf/);
  assert.match(styles, /\.ns-today\{/);
  assert.match(styles, /\.ns-conf\{/);
  assert.match(styles, /\.ns-beaten\{/);
});

test('progress is never promised and effort is never shamed', () => {
  for (const source of [engineSource, trainingSource]) {
    assert.doesNotMatch(source, /you will get stronger|guaranteed gains|no excuses|stop being lazy/i);
  }
});
