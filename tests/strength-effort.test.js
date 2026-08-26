import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const training = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');
const logging = readFileSync(join(root, 'public', 'js', '09-logging.js'), 'utf8');
const styles = readFileSync(join(root, 'public', 'styles.css'), 'utf8');
const context = {
  console, Date, Math, Intl,
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

test('new drafts require effort while legacy submitted sessions stay complete', () => {
  assert.equal(context.strengthLogRequiresEffort({}, false), true);
  assert.equal(context.strengthLogRequiresEffort({ __submittedAt: '2026-08-01' }, true), false);
  assert.equal(context.strengthLogRequiresEffort({ __effortEnabled: true, __submittedAt: '2026-08-26' }, true), true);
});

test('first-set calibration is saved, sent to coaches, and kept compact', () => {
  assert.match(training, /item\.effort=effort/);
  assert.match(training, /data-effort-required=/);
  assert.match(training, /How did the first working set finish\?/);
  assert.match(training, /sessionEffortRequired&&si===warmupSets/);
  assert.match(training, /rowIndex===warmupSetsForEffort/);
  assert.match(training, /applyStrengthEffortLoadToRemaining/);
  assert.match(logging, /__effortEnabled:strengthLogRequiresEffort/);
  assert.match(logging, /Effort: /);
  assert.match(styles, /\.set-effort-options/);
  assert.match(styles, /\.set-effort-summary/);
  assert.match(styles, /\.strength-effort-note/);
});
