import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// An athlete opened a session from the mobile week view, logged their sets, and
// pressed "Done — back to plan". The card was built on demand (the mobile
// calendar does not render full workout cards), so closeFocusedSession REMOVED
// it from the DOM. The 250ms strength draft was still pending. It fired against
// a card that no longer existed, read zero sets for every exercise, and merged
// those empty arrays over the real session — wiping work the athlete had
// already entered minutes earlier, on every device, because the localStorage
// write syncs straight to Supabase.
//
// Two things have to hold: a write from an absent card must not happen at all,
// and an emptied-but-present exercise must still clear.

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const logging = readFileSync(join(root, 'public', 'js', '09-logging.js'), 'utf8');
const training = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');

function slice(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.ok(start > 0, `${startMarker} should exist`);
  const end = text.indexOf(endMarker, start);
  assert.ok(end > start, `${endMarker} should follow ${startMarker}`);
  return text.slice(start, end);
}

// Which element ids the fake DOM currently holds. Nothing else about the page
// matters here — the bug is entirely about reading ids that have gone away.
function makeContext(presentIds, sets) {
  const stored = {};
  const context = {
    sessions: [{ id: 'sess_1', date: '2026-08-18', name: 'Lower A' }],
    logs: {
      sess_1: {
        'Back Squat': [
          { weight: '100', reps: '5', rpe: '8', done: true },
          { weight: '100', reps: '5', rpe: '8.5', done: true },
        ],
        'Romanian Deadlift': [{ weight: '80', reps: '8', rpe: '7', done: true }],
      },
    },
    exPicks: {},
    athlete: { code: 'ALVIN' },
    localStorage: {
      setItem(k, v) { stored[k] = v; },
      getItem(k) { return stored[k] || null; },
    },
    stored,
    document: {
      getElementById(id) { return presentIds.has(id) ? { id, value: '' } : null; },
    },
    getSplit: () => [{ exercise: 'Back Squat' }, { exercise: 'Romanian Deadlift' }],
    collectExerciseSets: (i, ei) => sets[ei] || [],
    strengthSessionDate: () => '2026-08-18',
    collectSlotMap: () => ({}),
    strengthLogRequiresRpe: () => true,
    isSessionLogged: () => false,
    refreshStrengthFeedback() {},
    refreshStrengthExerciseStates() {},
    refreshGymSubmitState() {},
    markInlinePbs() {},
  };
  vm.createContext(context);
  vm.runInContext(
    slice(training, 'function exerciseHistoryKey(', 'function getExerciseSetsFromLog(') +
    slice(logging, 'function mergeStrengthLog(', 'function draftGym(') +
    slice(logging, 'function persistGymDraft(', '// ── NOTE-ONLY SESSION'),
    context,
  );
  return context;
}

test('a draft firing after the card is removed does not wipe the session', () => {
  // Card gone: no scb_0, no sets_0_*. collectExerciseSets would return [].
  const ctx = makeContext(new Set(), [[], []]);
  ctx.persistGymDraft(0, 'Lower A');
  assert.equal(ctx.logs.sess_1['Back Squat'].length, 2, 'squat sets should survive the close');
  assert.equal(ctx.logs.sess_1['Romanian Deadlift'].length, 1, 'RDL sets should survive the close');
  assert.equal(ctx.stored['dp_logs_ALVIN'], undefined, 'nothing should be written from an absent card');
});

test('one unrendered exercise does not clear the exercises that are rendered', () => {
  // Card present, but the second exercise row is not in the DOM.
  const ctx = makeContext(new Set(['scb_0', 'sets_0_0']), [
    [{ weight: '105', reps: '5', rpe: '8', done: true }],
    [],
  ]);
  ctx.persistGymDraft(0, 'Lower A');
  assert.equal(ctx.logs.sess_1['Back Squat'][0].weight, '105', 'rendered exercise should take the new value');
  assert.equal(ctx.logs.sess_1['Romanian Deadlift'].length, 1, 'unrendered exercise should keep its saved sets');
});

test('deleting every set from a rendered exercise still clears it', () => {
  // The container exists and holds nothing — that is a real deletion, not an
  // absent card, and it must still reach storage.
  const ctx = makeContext(new Set(['scb_0', 'sets_0_0', 'sets_0_1']), [[], []]);
  ctx.persistGymDraft(0, 'Lower A');
  assert.equal(ctx.logs.sess_1['Back Squat'].length, 0, 'cleared exercise should clear');
  assert.ok(ctx.stored['dp_logs_ALVIN'], 'a real edit should still be written');
});

test('closeFocusedSession flushes the pending draft before removing the card', () => {
  const close = slice(training, 'function closeFocusedSession(', 'document.addEventListener(\'keydown\'');
  const flushAt = close.indexOf('flushGymDraft');
  const removeAt = close.indexOf('card.remove()');
  assert.ok(flushAt > 0, 'close should flush the strength draft');
  assert.ok(removeAt > flushAt, 'the flush must happen before the card is removed');
});

test('a backgrounded app flushes the pending draft', () => {
  assert.match(logging, /pagehide['"],\s*flushGymDraft/, 'pagehide should flush the strength draft');
  assert.match(logging, /visibilityState==='hidden'\)flushGymDraft\(\)/, 'hiding the app should flush the strength draft');
});
