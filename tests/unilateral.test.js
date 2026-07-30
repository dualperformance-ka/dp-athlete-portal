import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const source = readFileSync(join(root, 'public', 'js', '01-core.js'), 'utf8');
const start = source.indexOf('function normaliseExerciseName');
const end = source.indexOf('function getType', start);
const context = {};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);

test('female unilateral movements use left/right reps', () => {
  [
    'Bulgarian Split Squat',
    'Walking Lunge',
    'Reverse Lunge',
    'Dumbbell Step Up',
    'Cable Glute Kickback',
    'Cable Hip Abduction',
    'Cable Adduction',
    'Cable Lateral Raise',
    'Dumbbell Row',
    'Copenhagen Plank',
    'Single Leg Curl',
  ].forEach((name) => assert.equal(context.usesLeftRightReps(name), true, name));
});

test('female bilateral movements keep one reps field', () => {
  [
    'Barbell Romanian Deadlift',
    'Seated Hip Abduction',
    'Lateral Dumbbell Raise',
    'Machine Lateral Raise',
    'Dumbbell Bicep Curl',
    'Leg Press (feet high & wide)',
  ].forEach((name) => assert.equal(context.usesLeftRightReps(name), false, name));
});

test('Supabase metadata can explicitly mark non-obvious unilateral variants', () => {
  const prescription = {
    exercise: 'Contralateral Reach',
    repMode: 'left_right',
    leftRightExercises: ['Contralateral Reach', 'Supported Reach'],
  };
  assert.equal(context.usesLeftRightReps('Contralateral Reach', prescription), true);
  assert.equal(context.usesLeftRightReps('Supported Reach', prescription), true);
  assert.equal(context.usesLeftRightReps('Hack Squat', prescription), false);
});
