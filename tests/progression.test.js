import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const source = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');
const context = {
  console,
  Date,
  Math,
  Intl,
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  document: {
    addEventListener: () => {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => []
  },
  window: {
    addEventListener: () => {},
    matchMedia: () => ({ matches: false })
  },
  localStorage: {
    getItem: () => null,
    setItem: () => {}
  }
};
vm.createContext(context);
vm.runInContext(source, context);

const exercise = {
  exercise: 'Single Leg Extension',
  sets: '4',
  warmupSets: '1',
  workingSets: '3',
  reps: '8',
  repRange: '8-12'
};
const set = (row, reps) => ({
  _rowIndex: row,
  weight: '29',
  repsLeft: String(reps),
  repsRight: String(reps)
});
const previous = [
  { weight: '29', repsLeft: '10', repsRight: '10' },
  { weight: '29', repsLeft: '11', repsRight: '11' },
  { weight: '29', repsLeft: '11', repsRight: '11' },
  { weight: '29', repsLeft: '11', repsRight: '11' }
];

test('warm-up row never counts as a working set during live logging', () => {
  const current = [set(0, 12), set(1, 12), set(2, 12)];
  const working = context.getWorkingSlice(exercise, current);
  assert.equal(working.length, 2);
  assert.deepEqual(Array.from(working, (entry) => entry._rowIndex), [1, 2]);
});

test('final working set prompt holds weight and previews the unlocked load', () => {
  const current = [set(0, 12), set(1, 12), set(2, 12)];
  const live = context._nsLiveProgress(
    exercise,
    current,
    {},
    exercise.exercise,
    [{ sets: previous }],
    previous
  );
  assert.match(live.msg, /2 of 3 working sets/);
  assert.match(live.prompt, /Final working set: stay at 29kg and aim for 12/);
  assert.match(live.prompt, /next session/);
});

test('completed working sets show a consistent Today comparison and next-session action', () => {
  const current = [set(0, 12), set(1, 12), set(2, 12), set(3, 12)];
  const live = context._nsLiveProgress(
    exercise,
    current,
    {},
    exercise.exercise,
    [{ sets: previous }],
    previous
  );
  assert.equal(live.msg, '36 reps · 3 up on last session');
  assert.match(live.prompt, /^Next session: Increase to/);
  assert.equal(live.ahead, true);
});
