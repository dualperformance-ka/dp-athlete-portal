import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Leaving a session: the × asks only when something is unsent, and Clear
// removes exactly what the athlete entered — never a Strava match, and for a
// session already sent, only what was added after sending.
const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const training = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');
const logging = readFileSync(join(root, 'public', 'js', '09-logging.js'), 'utf8');

function slice(source, from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `could not slice ${from} → ${to}`);
  return source.slice(start, end);
}

function context(logs, submitted = new Set()) {
  const writes = [];
  const ctx = {
    logs, ticked: {}, athlete: { code: 'KA' },
    isSessionLogged: (id) => submitted.has(id),
    exerciseHistoryKey: (name) => String(name).toLowerCase(),
    getType: (s) => s.type || 'strength',
    localStorage: { setItem: (k, v) => writes.push([k, v]) },
    portalStateWrite: async () => ({}),
    Date, Object, String, Array, Math, parseInt, JSON
  };
  vm.createContext(ctx);
  vm.runInContext(slice(training, 'function logHasRealData(', 'function buildCard('), ctx);
  vm.runInContext(slice(training, 'function gymDraftHasData(', 'function strengthCoachChangesHtml('), ctx);
  vm.runInContext(slice(logging, 'function gymLogSignature(', '// Deterministic per athlete'), ctx);
  vm.runInContext(slice(training, '// What is actually sitting unsent', 'function ensureLeaveSessionSheet('), ctx);
  vm.runInContext(slice(training, '// Never-sent: remove everything', 'function togS('), ctx);
  ctx.writes = writes;
  return ctx;
}

test('clearing a never-sent session removes every entry but keeps a Strava match', () => {
  const ctx = context({
    gym: { Squat: [{ weight: '', reps: '', done: true }], __notes: 'oops', __updatedAt: 'x', __slots: { a: 1 } },
    run: { distance: '8', notes: 'typo', __stravaMatch: { activity: { id: 9 } }, __stravaFeedbackQueued: true }
  });
  ctx.clearSessionDraft({ id: 'gym' });
  assert.equal(ctx.logs.gym, undefined, 'the whole draft goes, bookkeeping included, so nothing reads as awaiting');
  ctx.clearSessionDraft({ id: 'run', type: 'run' });
  assert.deepEqual(Object.keys(ctx.logs.run).sort(), ['__stravaFeedbackQueued', '__stravaMatch']);
  assert.equal(ctx.trainingSessionHasUnsentDraft({ id: 'gym' }), false);
  assert.ok(ctx.writes.some(([k]) => k === 'dp_logs_KA'), 'the cleared state is saved on the phone');
});

test('discarding changes on a sent session trims back to exactly what was sent', () => {
  const submitted = new Set(['gym']);
  const ctx = context({
    gym: {
      Squat: [{ weight: '80', reps: '5' }, { weight: '80', reps: '5' }, { weight: '85', reps: '3' }],
      RDL: [{ weight: '60', reps: '8' }],
      __notes: 'kept', __submittedAt: '2026-10-13T00:00:00Z', __submittedSig: 'squat:2'
    }
  }, submitted);
  assert.equal(ctx.trainingSessionHasUnsentDraft({ id: 'gym' }), true);
  assert.equal(ctx.unsentDraftSummary({ id: 'gym' }), '2 new sets');
  ctx.clearSessionDraft({ id: 'gym' });
  assert.equal(ctx.logs.gym.Squat.length, 2);
  assert.equal(ctx.logs.gym.RDL, undefined);
  assert.equal(ctx.logs.gym.__submittedAt, '2026-10-13T00:00:00Z', 'the sent record is untouched');
  assert.equal(ctx.trainingSessionHasUnsentDraft({ id: 'gym' }), false);
});

test('the summary names what is unsent in the athlete’s terms', () => {
  const ctx = context({
    one: { Squat: [{ weight: '80', reps: '5' }] },
    three: { Squat: [{ weight: '80' }, { weight: '80' }], RDL: [{ weight: '60' }] },
    notes: { __notes: 'felt flat' },
    run: { distance: '9' }
  });
  assert.equal(ctx.unsentDraftSummary({ id: 'one' }), '1 set');
  assert.equal(ctx.unsentDraftSummary({ id: 'three' }), '3 sets');
  assert.equal(ctx.unsentDraftSummary({ id: 'notes' }), 'Your notes');
  assert.equal(ctx.unsentDraftSummary({ id: 'run', type: 'run' }), 'Your run details');
});

test('the × and Escape ask first; only an unsent session gets the question', () => {
  assert.match(training, /<button class="focus-close" onclick="requestCloseFocusedSession\(\)" aria-label="Close session">/);
  assert.match(training, /if\(closeLeaveSessionSheet\(\)\)return;if\(focusedSessionIndex!=null\)requestCloseFocusedSession\(\);/);
  const request = slice(training, 'function requestCloseFocusedSession(', '// What is actually sitting unsent');
  // Pending typing is saved before deciding, and a clean session just closes.
  assert.match(request, /flushGymDraft\(\)[\s\S]*if\(!s\|\|!trainingSessionHasUnsentDraft\(s\)\)\{closeFocusedSession\(\);return;\}[\s\S]*openLeaveSessionSheet\(i\)/);
});

test('keep never sends; clear saves the screen first, then clears; submit uses the normal save path', () => {
  const keep = slice(training, 'function leaveSessionKeep(', 'function leaveSessionSubmit(');
  assert.doesNotMatch(keep, /coachWrite|saveGym|saveRun|saveNote|markSessionLogged/);
  assert.match(keep, /closeFocusedSession\(\)/);
  const clear = slice(training, 'function leaveSessionClear(', '// Never-sent: remove everything');
  assert.match(clear, /closeFocusedSession\(\);\s*clearSessionDraft\(s\);/);
  assert.doesNotMatch(clear, /coachWrite|markSessionLogged/);
  const submit = slice(training, 'function leaveSessionSubmit(', 'function leaveSessionClear(');
  assert.match(submit, /getElementById\('sb_'\+i\)[\s\S]*save\.click\(\)/);
});
