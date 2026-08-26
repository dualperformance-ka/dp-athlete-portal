import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const source = readFileSync(join(root, 'public', 'js', '09-logging.js'), 'utf8');

function toastHelper() {
  const start = source.indexOf('var PB_TOAST_RANK=');
  const end = source.indexOf('// Run detection across a whole saved session');
  assert.ok(start >= 0 && end > start, 'the PB toast helper should remain discoverable');
  const context = {};
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context.pbToastMessage;
}

const pbToastMessage = toastHelper();

const hit = (over) => ({
  type: 'load',
  badge: 'LOAD PB',
  exercise: 'Back Squat',
  value: 105,
  unit: 'kg',
  delta: '+5kg',
  ...over,
});

// ── The problem this fixes ───────────────────────────────────────────────────
//
// "3 new PBs!" was the best moment in the app rendered as an integer. The hits
// already carried the lift and the number.

test('no PBs produces no message, and the caller keeps its own wording', () => {
  assert.equal(pbToastMessage([]), '');
  assert.equal(pbToastMessage(null), '');
  assert.equal(pbToastMessage(undefined), '');
});

test('one PB names the lift and the delta', () => {
  assert.equal(pbToastMessage([hit()]), 'Back Squat +5kg — new PB');
});

test('two PBs name both lifts', () => {
  const message = pbToastMessage([
    hit(),
    hit({ type: 'reps', badge: 'REP PB', exercise: 'Bench Press', delta: '+2 reps' }),
  ]);
  assert.equal(message, 'Back Squat +5kg and Bench Press +2 reps — two PBs');
});

test('three or more lifts fall back to the count', () => {
  const message = pbToastMessage([
    hit(),
    hit({ exercise: 'Bench Press', delta: '+2.5kg' }),
    hit({ exercise: 'Deadlift', delta: '+10kg' }),
  ]);
  assert.equal(message, '3 new PBs');
});

// ── One lift, several PBs ────────────────────────────────────────────────────
//
// A heavy top set commonly scores a load PB and an e1RM PB together. Naming the
// same lift twice in one toast reads as a bug.

test('several PBs on one lift name that lift once', () => {
  const message = pbToastMessage([
    hit({ type: 'e1rm', badge: 'STRENGTH PB', delta: '+3.2kg' }),
    hit({ type: 'load', badge: 'LOAD PB', delta: '+5kg' }),
    hit({ type: 'volume', badge: 'VOLUME PB', delta: '+120kg' }),
  ]);
  assert.equal(message, 'Back Squat +5kg — new PB');
});

test('the load PB is the number worth showing when a lift scores several', () => {
  const message = pbToastMessage([
    hit({ type: 'volume', badge: 'VOLUME PB', delta: '+120kg' }),
    hit({ type: 'reps', badge: 'REP PB', delta: '+1 reps' }),
  ]);
  assert.equal(message, 'Back Squat +1 reps — new PB');
});

test('two lifts scoring multiple PBs each still read as two', () => {
  const message = pbToastMessage([
    hit({ type: 'volume', delta: '+100kg' }),
    hit({ type: 'load', delta: '+5kg' }),
    hit({ exercise: 'Bench Press', type: 'e1rm', delta: '+2kg' }),
    hit({ exercise: 'Bench Press', type: 'load', delta: '+2.5kg' }),
  ]);
  assert.equal(message, 'Back Squat +5kg and Bench Press +2.5kg — two PBs');
});

test('the count above two lifts counts PBs, not lifts', () => {
  const message = pbToastMessage([
    hit(),
    hit({ type: 'volume', delta: '+100kg' }),
    hit({ exercise: 'Bench Press', delta: '+2kg' }),
    hit({ exercise: 'Deadlift', delta: '+10kg' }),
  ]);
  assert.equal(message, '4 new PBs');
});

// ── Tolerance ────────────────────────────────────────────────────────────────

test('a hit with no delta still names the lift', () => {
  assert.equal(pbToastMessage([hit({ delta: undefined })]), 'Back Squat — new PB');
});

test('a malformed hit is dropped rather than printed as undefined', () => {
  assert.equal(pbToastMessage([null, {}, hit()]), 'Back Squat +5kg — new PB');
  assert.doesNotMatch(pbToastMessage([hit(), {}, null]), /undefined|null/);
});

test('an unknown PB type does not outrank a known one', () => {
  const message = pbToastMessage([
    hit({ type: 'load', delta: '+5kg' }),
    hit({ type: 'something-new', delta: '+99kg' }),
  ]);
  assert.equal(message, 'Back Squat +5kg — new PB');
});

// ── The call site ────────────────────────────────────────────────────────────

test('the submit toast uses the named message and keeps the queued path', () => {
  assert.match(source, /pbToastMessage\(pbHits\)\|\|'Session submitted ✓'/);
  assert.match(source, /gymQueued\?'Session submitted - coach dashboard sync pending'/);
  // The old count-only string is gone.
  assert.doesNotMatch(source, /new PB'\+\(pbHits\.length>1\?'s':''\)\+'!'/);
});
