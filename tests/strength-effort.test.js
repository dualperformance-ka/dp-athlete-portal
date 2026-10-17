import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const training = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');
// The progression engine is a separate script in index.html and must be in the
// context before 08-training.js, which delegates every decision to it.
const strengthEngine = readFileSync(join(root, 'public', 'js', '08-strength-engine.js'), 'utf8');
const logging = readFileSync(join(root, 'public', 'js', '09-logging.js'), 'utf8');
const styles = readFileSync(join(root, 'public', 'styles.css'), 'utf8');
const context = {
  console, Date, Math, Intl,
  esc: (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]),
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  document: {
    documentElement: { classList: { toggle: () => {} } },
    readyState: 'loading',
    addEventListener: () => {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => []
  },
  window: { addEventListener: () => {}, matchMedia: () => ({ matches: false }) },
  localStorage: { getItem: () => null, setItem: () => {} }
};
vm.createContext(context);
vm.runInContext(strengthEngine, context);
vm.runInContext(training, context);

const exercise = { exercise: 'Incline Dumbbell Press', reps: '8', repRange: '8-12', workingSets: '3' };

test('more reps in reserve increases the next working-set load', () => {
  const result = context.strengthEffortGuidance(exercise, 'reserve', { weight: '30', reps: '12' }, exercise.exercise, [], false);
  assert.equal(result.direction, 'harder');
  assert.equal(result.targetWeight, 32.5);
  assert.match(result.message, /remaining sets/);
});

test('technical failure inside the rep range holds the load', () => {
  const result = context.strengthEffortGuidance(exercise, 'failure', { weight: '30', reps: '10' }, exercise.exercise, [], false);
  assert.equal(result.direction, 'same');
  assert.equal(result.targetWeight, 30);
  assert.match(result.message, /Target hit/);
});

test('failure below the range or broken form reduces the next load', () => {
  const earlyFailure = context.strengthEffortGuidance(exercise, 'failure', { weight: '30', reps: '6' }, exercise.exercise, [], false);
  const formBreak = context.strengthEffortGuidance(exercise, 'form_break', { weight: '30', reps: '8' }, exercise.exercise, [], false);
  assert.equal(earlyFailure.targetWeight, 27.5);
  assert.equal(formBreak.targetWeight, 27.5);
  assert.equal(formBreak.tone, 'red');
});

test('assisted exercises get harder by reducing assistance', () => {
  const assisted = { exercise: 'Assisted Dips', reps: '8', repRange: '8-12', workingSets: '3' };
  const result = context.strengthEffortGuidance(assisted, 'reserve', { weight: '20', reps: '12' }, assisted.exercise, [], false);
  assert.equal(result.targetWeight, 15);
  assert.match(result.message, /reduce assistance/);
});

test('a load adjustment resets the remaining rep prompt to the range floor', () => {
  const repInput = { value: '', placeholder: '10' };
  const card = { getAttribute: (name) => name === 'data-split-key' ? 'Upper A' : null };
  const row = {
    querySelectorAll: () => [repInput],
    closest: (selector) => selector === '.exc' ? card : null
  };
  const weightInput = {
    value: '',
    closest: () => row
  };
  const previousGetter = context.document.getElementById;
  const previousDraft = context.draftGym;
  const previousToast = context.showToast;
  let toast = '';
  context.document.getElementById = (id) => id === 'w_0_0_1' ? weightInput : null;
  context.draftGym = () => {};
  context.showToast = (message) => { toast = message; };

  const changed = context.applyStrengthEffortLoadToRemaining(0, 0, 1, 1, 66, 8);

  assert.equal(changed, 1);
  assert.equal(weightInput.value, '66');
  assert.equal(repInput.placeholder, '8');
  assert.match(toast, /target 8 reps/);

  context.document.getElementById = previousGetter;
  context.draftGym = previousDraft;
  context.showToast = previousToast;
});

test('every unfinished workout requires effort while legacy submitted sessions stay complete', () => {
  assert.equal(context.strengthLogRequiresEffort({}, false), true);
  assert.equal(context.strengthLogRequiresEffort({ __submittedAt: '2026-08-01' }, true), false);
  assert.equal(context.strengthLogRequiresEffort({ __effortEnabled: true, __submittedAt: '2026-08-26' }, true), true);
  assert.equal(context.strengthLogRequiresEffort({ __effortEnabled: false }, false, '2026-08-26'), true, 'current unfinished sessions override stale cached flags');
  assert.equal(context.strengthLogRequiresEffort({ __effortEnabled: false }, false, '2026-06-01'), true, 'backdated unfinished programmes receive calibration too');
  assert.equal(context.strengthLogRequiresEffort({ __effortEnabled: false }, true, '2026-06-01'), false, 'historical submitted sessions keep their original completion rule');
});

for (const rpeOn of [false, true]) test(`the first-set prompt opens as soon as weight and reps are in · RPE ${rpeOn ? 'on' : 'off'}`, () => {
  const fields = {
    weight: { value: '59' },
    reps: { value: '8' },
    rpe: { value: '' }
  };
  const card = { getAttribute: (name) => name === 'data-rpe-required' ? String(rpeOn) : null };
  const row = {
    querySelector(selector) {
      if (selector.includes('id^="w_"')) return fields.weight;
      if (selector.includes('id^="r_"')) return fields.reps;
      if (selector.includes('id^="rpe_"')) return fields.rpe;
      return null;
    },
    closest: () => card,
    getAttribute(name) {
      if (name === 'data-effort-required') return 'true';
      if (name === 'data-effort') return '';
      return null;
    }
  };
  const classes = new Set();
  const panel = { classList: { add: (...names) => names.forEach((name) => classes.add(name)) } };
  const previousGetter = context.document.getElementById;
  context.document.getElementById = (id) => id === 'sr_0_0_2' ? row : (id === 'effort_0_0_2' ? panel : null);

  assert.equal(context.strengthSetHasRequiredInputs(row), false, 'effort still blocks completion');
  assert.equal(context.strengthSetHasRequiredInputs(row, true), !rpeOn, rpeOn ? 'blank RPE still blocks completion' : 'effort is the only thing left');
  assert.equal(context.strengthSetHasCalibrationInputs(row), true, 'weight and reps alone are ready to prompt');
  // RPE off: the reps-left question must be answered before the set completes.
  // RPE on: the RPE answers it, so the panel opens as a read-back with the
  // form/pain report and never blocks on a second qualitative question.
  assert.equal(context.promptStrengthCalibration(0, 0, 2), !rpeOn);
  assert.equal(classes.has('is-prompting'), true);

  context.document.getElementById = previousGetter;
});

test('first-set calibration is saved, sent to coaches, and kept compact', () => {
  assert.match(training, /item\.effort=effort/);
  assert.match(training, /data-effort-required=/);
  assert.match(training, /How many clean reps did you have left\?/);
  assert.doesNotMatch(training, /How did the first working set finish/);
  assert.match(training, /sessionEffortRequired&&si===warmupSets/);
  assert.match(training, /rowIndex===warmupSetsForEffort/);
  assert.match(training, /applyStrengthEffortLoadToRemaining/);
  assert.match(training, /oninput="draftStrengthSet\(/);
  assert.match(training, /strengthSavedSetHasRequiredInputs\(sv,false,false,false\)/, 'a saved draft reopens the prompt before RPE is entered');
  assert.match(logging, /__effortEnabled:strengthLogRequiresEffort/);
  assert.match(logging, /Effort: /);
  assert.match(styles, /\.set-effort-options/);
  assert.match(styles, /\.set-effort-summary/);
  assert.match(styles, /\.strength-effort-note/);
});

// ── Effort as clean reps left, and RPE as the same answer ──────────────────

test('the reps-left choices follow the coach’s RIR target instead of assuming two', () => {
  const labels = (rir) => Array.from(context.strengthEffortChoices(context.strengthPrescriptionFor({ ...exercise, rir }, exercise.exercise)), (c) => c.label);
  assert.deepEqual(Array.from(context.strengthEffortChoices(context.strengthPrescriptionFor(exercise, exercise.exercise)), (c) => c.code),
    ['too_easy', 'on_target', 'too_hard', 'form_pain'], 'stored codes are unchanged');
  assert.deepEqual(labels(2), ['4+ clean reps left', 'About 2 reps left', '0–1 clean reps left', 'Form or pain stopped me']);
  assert.deepEqual(labels(1), ['3+ clean reps left', 'About 1 rep left', '0 clean reps left', 'Form or pain stopped me']);
  assert.deepEqual(labels(3), ['5+ clean reps left', 'About 3 reps left', '0–2 clean reps left', 'Form or pain stopped me']);
  // A coach RPE target is read as reps in reserve too.
  assert.equal(labels(undefined)[1], 'About 2 reps left');
  assert.equal(Array.from(context.strengthEffortChoices(context.strengthPrescriptionFor({ ...exercise, rpe: 9 }, exercise.exercise)), (c) => c.label)[1], 'About 1 rep left');
  // Reps achieved and effort are separate signals: no choice mentions the range.
  for (const rir of [1, 2, 3]) for (const label of labels(rir)) assert.doesNotMatch(label, /range|failing|failure/i);
});

test('RPE maps onto the engine’s own effort bands, not a new rule', () => {
  const pres = context.strengthPrescriptionFor(exercise, exercise.exercise);
  assert.equal(context.strengthEffortFromRpe(pres, '6'), 'too_easy', 'RPE 6 is 4 reps left: the engine’s easy band');
  assert.equal(context.strengthEffortFromRpe(pres, '8'), 'on_target');
  assert.equal(context.strengthEffortFromRpe(pres, '9'), 'on_target', 'one rep either side of target is on target in the engine');
  assert.equal(context.strengthEffortFromRpe(pres, '10'), 'too_hard');
  assert.equal(context.strengthEffortFromRpe(pres, ''), '', 'no RPE, no answer');
  assert.equal(context.strengthEffortFromRpe(pres, '14'), '', 'an impossible RPE is not read');
  // Consistent with how the engine reads the same set: no conflict is raised.
  for (const rpe of ['6', '7', '8', '9', '10']) {
    const row = context.normaliseStrengthSets([{ weight: '30', reps: '10', rpe, effort: context.strengthEffortFromRpe(pres, rpe) }], pres, 'working')[0];
    assert.equal(context.strengthEffortEvidence(pres, row).conflict, false, `RPE ${rpe} must agree with its own mapped answer`);
  }
  const strict = context.strengthPrescriptionFor({ ...exercise, rir: 4 }, exercise.exercise);
  assert.equal(context.strengthEffortFromRpe(strict, '6'), 'on_target', 'the coach target moves the bands');
  assert.equal(context.strengthEffortFromRpe(strict, '8'), 'too_hard', 'two reps left is hard against a four-rep target');
});

test('an RPE-derived answer is stored with its source and legacy logs are not touched', () => {
  assert.match(training, /item\.effortSource='rpe'/, 'the source travels with the set so a later RPE edit can re-read it');
  assert.match(training, /if\(current&&source!=='rpe'\)return true;/, 'a tapped answer is never overwritten by RPE');
  // Only rows that still require the effort answer are read, which is every
  // unfinished workout; submitted sessions keep their own rule.
  assert.match(training, /row\.getAttribute\('data-effort-required'\)!=='true'\)return false;\n  if\(!strengthRowUsesRpeEffort\(row\)\)return false;/);
  // Read on change or a pause, never per keystroke: "1" of "10" must not act.
  assert.match(training, /if\(promptStrengthCalibration\(i,ei,si,true\)\)return;/);
  assert.match(training, /function draftStrengthSet\(i,ei,si,splitKey\)\{\n  draftGym\(i,splitKey\);promptStrengthCalibration\(i,ei,si\);/);
});

test('form or pain can be reported in both modes', () => {
  const pres = context.strengthPrescriptionFor(exercise, exercise.exercise);
  const off = context.strengthEffortPickerHtml(0, 0, 0, '', null, 1, true, true, pres, { rpeCapable: false });
  const on = context.strengthEffortPickerHtml(0, 0, 0, '', null, 1, true, true, pres, { rpeCapable: true, rpe: '8' });
  assert.match(off, /setStrengthEffort\(0,0,0,'form_pain'/);
  assert.match(on, /setStrengthEffort\(0,0,0,'form_pain'/, 'the full choice set stays in the DOM for an RPE switch-off');
  assert.match(on, /class="set-effort-pain" aria-pressed="false" onclick="toggleStrengthPainReport\(0,0,0,this\)">Form or pain stopped me</);
  assert.match(on, /RPE 8 · about 2 reps left/, 'the RPE is read back in words');
  assert.doesNotMatch(off, /set-effort-pain/);
  // CSS, not JS, decides which way in is shown, from the card's RPE flag.
  assert.match(styles, /\.exc\[data-rpe-required="true"\] \.set-effort\[data-rpe-capable="true"\] \.set-effort-editor\{display:none\}/);
  assert.match(styles, /\.set-effort-pain\{[^}]*min-height:44px/);
});
