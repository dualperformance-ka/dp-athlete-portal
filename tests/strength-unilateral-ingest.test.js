import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeStrengthPayload } from '../api/ingest.js';

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
