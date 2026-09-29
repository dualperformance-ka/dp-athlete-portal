import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/js/01-core.js', import.meta.url), 'utf8');
const start = source.indexOf('function getType(s){');
const end = source.indexOf('\nfunction sortSessionsForDisplay', start);
assert.ok(start >= 0 && end > start, 'getType should remain discoverable');

const context = {
  GYM_KEYS: [],
  sessionHasPrescription: () => false,
  sessionRunSteps: () => false,
};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);

test('swim sessions are classified as swimming instead of defaulting to runs', () => {
  assert.equal(context.getType({ name: 'Swim: Technique' }), 'swim');
  assert.equal(context.getType({ sessionType: 'Swimming', name: 'Technique' }), 'swim');
});

test('existing run, strength, rest, and note classification stays intact', () => {
  assert.equal(context.getType({ name: 'Easy Run' }), 'run');
  assert.equal(context.getType({ sessionType: 'Strength', name: 'Session' }), 'strength');
  assert.equal(context.getType({ name: 'Rest' }), 'rest');
  assert.equal(context.getType({ sessionType: 'Note', name: 'Reminder' }), 'note');
});
