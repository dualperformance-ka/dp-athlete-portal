import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const logging = readFileSync(join(root, 'public', 'js', '09-logging.js'), 'utf8');
const start = logging.indexOf('async function saveStravaFeedback(');
const end = logging.indexOf('function paintStravaMatches(', start);
const saveSource = logging.slice(start, end);

function makeContext(queued) {
  const classNames = new Set();
  const elements = {
    srpe_0: { value: '4', focus() {}, setAttribute() {}, removeAttribute() {} },
    spain_0: { value: 'no', focus() {}, setAttribute() {}, removeAttribute() {} },
    snotes_0: { value: 'Felt controlled' },
    sfb_0: {
      disabled: false,
      textContent: 'Complete session',
      classList: {
        add: (...names) => names.forEach((name) => classNames.add(name)),
        remove: (...names) => names.forEach((name) => classNames.delete(name))
      }
    }
  };
  const calls = { done: 0, closed: 0, painted: 0, toast: '' };
  const context = {
    console, Date, Number,
    sessions: [{ id: 'run-1', name: 'Recovery 12km', date: '2026-08-26' }],
    logs: { 'run-1': { __stravaMatch: { activity: { id: 123 } } } },
    athlete: { code: 'KA', name: 'Karl' },
    WEBHOOK: '/api/write',
    focusedSessionIndex: 0,
    document: { getElementById: (id) => elements[id] || null },
    localStorage: { setItem() {} },
    getStravaSessionMatch: () => ({ activity: { id: 123 } }),
    stravaLogPayload: () => ({}),
    portalStateWrite: async () => ({}),
    coachWrite: async () => queued ? { queued: true } : { ok: true },
    markSessionDone: async () => { calls.done += 1; },
    paintStravaMatches: () => { calls.painted += 1; },
    closeFocusedSession: () => { calls.closed += 1; },
    showToast: (message) => { calls.toast = message; }
  };
  vm.createContext(context);
  vm.runInContext(saveSource, context);
  return { context, calls, elements, classNames };
}

test('confirmed Strava feedback completes and closes the focused session', async () => {
  const { context, calls, elements, classNames } = makeContext(false);

  await context.saveStravaFeedback(0);

  assert.equal(calls.done, 1);
  assert.equal(calls.closed, 1);
  assert.equal(calls.painted, 1);
  assert.match(context.logs['run-1'].__stravaFeedbackAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(context.logs['run-1'].__stravaFeedbackQueued, undefined);
  assert.equal(elements.sfb_0.textContent, 'Feedback saved ✓');
  assert.equal(classNames.has('saved'), true);
});

test('queued Strava feedback stays open and does not look complete', async () => {
  const { context, calls, elements, classNames } = makeContext(true);

  await context.saveStravaFeedback(0);

  assert.equal(calls.done, 0);
  assert.equal(calls.closed, 0);
  assert.equal(context.logs['run-1'].__stravaFeedbackAt, undefined);
  assert.equal(context.logs['run-1'].__stravaFeedbackQueued, true);
  assert.equal(elements.sfb_0.textContent, 'Retry feedback sync');
  assert.equal(classNames.has('is-sending'), true);
});
