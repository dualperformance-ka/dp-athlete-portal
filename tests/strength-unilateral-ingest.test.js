import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalStrengthClientWriteId,
  canonicalStrengthExerciseName,
  normalizeStrengthPayload,
} from '../api/ingest.js';

test('side-specific sets force a dashboard-queryable left_right mode', () => {
  const normalized = normalizeStrengthPayload({
    type: 'Strength',
    repMode: 'reps',
    rawSets: [
      { weight: '20', repsLeft: '9', repsRight: '8', done: true },
      { weight: '20', repsLeft: '8', repsRight: '8', done: true },
    ],
  });

  assert.equal(normalized.repMode, 'left_right');
  assert.equal(normalized.rawSets[0].repsLeft, '9');
  assert.equal(normalized.rawSets[0].repsRight, '8');
});

test('an older client with no repMode is inferred from the submitted set shape', () => {
  assert.equal(normalizeStrengthPayload({
    rawSets: [{ weight: '12', repsLeft: '10', repsRight: '11' }],
  }).repMode, 'left_right');
  assert.equal(normalizeStrengthPayload({
    rawSets: [{ weight: '12', reps: '10' }],
  }).repMode, 'reps');
});

test('normalization does not mutate the submitted payload or set objects', () => {
  const payload = { rawSets: [{ weight: '12', repsLeft: '10', repsRight: '10' }] };
  const before = structuredClone(payload);
  normalizeStrengthPayload(payload);
  assert.deepEqual(payload, before);
});

test('cached dumbbell split squat submissions are canonical before Supabase storage', () => {
  const normalized = normalizeStrengthPayload({
    clientWriteId: 'strength_A1_session-9_dumbbell-bulgarian-split-squat',
    name: 'Athlete — Dumbbell Bulgarian Split Squat — 2026-08-12',
    exerciseName: 'Dumbbell Bulgarian Split Squat',
    programmedExercise: 'Bulgarian Split Squat',
    exerciseLog: 'Dumbbell Bulgarian Split Squat: Set 1: 20kg × 8reps',
    isSwap: true,
    rawSets: [{ weight: '20', repsLeft: '8', repsRight: '8' }],
  });

  assert.equal(normalized.clientWriteId, 'strength_A1_session-9_bulgarian-split-squat');
  assert.equal(normalized.exerciseName, 'Bulgarian Split Squat');
  assert.equal(normalized.programmedExercise, 'Bulgarian Split Squat');
  assert.match(normalized.name, /— Bulgarian Split Squat —/);
  assert.match(normalized.exerciseLog, /^Bulgarian Split Squat: Set 1:/);
  assert.equal(normalized.isSwap, false);
});

test('barbell split squat retains a separate Supabase identity', () => {
  assert.equal(canonicalStrengthExerciseName('Barbell Split Squat'), 'Barbell Split Squat');
  assert.equal(
    canonicalStrengthClientWriteId('strength_A1_session-9_barbell-split-squat'),
    'strength_A1_session-9_barbell-split-squat'
  );
});
