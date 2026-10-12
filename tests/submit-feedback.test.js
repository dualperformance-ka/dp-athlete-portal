import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Two athlete-facing promises:
//  1. A session with typed-but-unsent work is flagged on the week view, so an
//     athlete can see at a glance that the coaches do not have it yet.
//  2. Every "send to coaches" button shows Sending while it works and turns
//     green once it lands, instead of greying out and looking dead.
const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const training = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');
const logging = readFileSync(join(root, 'public', 'js', '09-logging.js'), 'utf8');
const checkin = readFileSync(join(root, 'public', 'js', '04-checkin.js'), 'utf8');
const styles = readFileSync(join(root, 'public', 'styles.css'), 'utf8');

function slice(source, from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `could not slice ${from} → ${to}`);
  return source.slice(start, end);
}

function draftContext(logs, submitted = new Set()) {
  const context = { logs, ticked: {}, isSessionLogged: (id) => submitted.has(id) };
  vm.createContext(context);
  vm.runInContext(slice(training, 'function logHasRealData(', 'function buildCard('), context);
  vm.runInContext(slice(training, 'function gymDraftHasData(', 'function strengthCoachChangesHtml('), context);
  vm.runInContext(slice(logging, 'function gymLogSignature(', '// Deterministic per athlete'), context);
  context.exerciseHistoryKey = (name) => String(name).toLowerCase();
  return context;
}

test('untouched and bookkeeping-only sessions are not flagged as unsent', () => {
  const ctx = draftContext({
    blank: {},
    meta: { __updatedAt: '2026-10-12T00:00:00Z', __sessionDate: '2026-10-12', __slots: { a: 1 }, Squat: [] },
    emptyRun: { distance: '', duration: '', pace: '', rpe: '', feel: '', notes: '' }
  });
  assert.equal(ctx.trainingSessionHasUnsentDraft({ id: 'blank' }), false);
  assert.equal(ctx.trainingSessionHasUnsentDraft({ id: 'meta' }), false);
  assert.equal(ctx.trainingSessionHasUnsentDraft({ id: 'emptyRun' }), false);
  assert.equal(ctx.trainingSessionHasUnsentDraft({ id: 'missing' }), false);
});

test('typed strength sets, run numbers and notes are flagged until sent', () => {
  const submitted = new Set();
  const ctx = draftContext({
    gym: { Squat: [{ weight: '80', reps: '5', done: true }] },
    run: { distance: '9', duration: '', pace: '', rpe: '', feel: '', notes: '' },
    note: { __notes: 'Felt flat today' }
  }, submitted);
  assert.equal(ctx.trainingSessionHasUnsentDraft({ id: 'gym', status: 'Planned' }), true);
  assert.equal(ctx.trainingSessionHasUnsentDraft({ id: 'run', status: 'Planned' }), true);
  assert.equal(ctx.trainingSessionHasUnsentDraft({ id: 'note', status: 'Planned' }), true);
  submitted.add('gym'); submitted.add('run'); submitted.add('note');
  assert.equal(ctx.trainingSessionHasUnsentDraft({ id: 'gym', status: 'Planned' }), false);
  assert.equal(ctx.trainingSessionHasUnsentDraft({ id: 'run', status: 'Planned' }), false);
  assert.equal(ctx.trainingSessionHasUnsentDraft({ id: 'note', status: 'Planned' }), false);
});

test('a sent strength session that has been added to is flagged again', () => {
  const submitted = new Set(['gym']);
  const ctx = draftContext({
    gym: { Squat: [{ weight: '80', reps: '5' }], __submittedAt: '2026-10-12T00:00:00Z', __submittedSig: 'squat:1' }
  }, submitted);
  assert.equal(ctx.trainingSessionHasUnsentDraft({ id: 'gym' }), false);
  ctx.logs.gym['RDL'] = [{ weight: '60', reps: '8' }];
  assert.equal(ctx.trainingSessionHasUnsentDraft({ id: 'gym' }), true);
});

test('Strava sessions waiting on RPE keep their own Finish state', () => {
  const ctx = draftContext({ tempo: { rpe: '7', __stravaMatch: { activity: { id: 1 } } } });
  assert.equal(ctx.trainingSessionNeedsFeedback({ id: 'tempo' }), true);
  assert.equal(ctx.trainingSessionHasUnsentDraft({ id: 'tempo' }), false);
});

test('the week row carries the unsent flag in class, text and accessible name', () => {
  const render = slice(training, 'function renderCal(', '// ── WEEKLY PLAN KM TARGET');
  assert.match(render, /unsent=trainingSessionHasUnsentDraft\(s\),done=sessionDone\(s\)&&!unsent/);
  assert.match(render, /\(unsent\?' has-draft':''\)/);
  assert.match(render, /<span class="mobile-week-draft" aria-hidden="true">Not sent<\/span>/);
  assert.match(render, /unsent\?', '\+UNSENT_DRAFT_LABEL/);
  // Closing a session refreshes the flags without waiting for a full render.
  assert.match(slice(training, 'function closeFocusedSession(', 'function togS('), /syncMobileWeekSessionDrafts\(\);/);
  assert.match(styles, /\.mobile-week-draft\{display:none/);
  assert.match(styles, /\.mobile-week-session\.has-draft\{background:[^}]*var\(--watch\)/);
  assert.match(styles, /\.mobile-week-session\.has-draft \.mobile-week-draft\{display:inline-flex\}/);
});

function fakeButton(text) {
  const classes = new Set();
  return {
    textContent: text, disabled: false, attributes: {},
    setAttribute(n, v) { this.attributes[n] = v; },
    removeAttribute(n) { delete this.attributes[n]; },
    classList: {
      add: (...n) => n.forEach((x) => classes.add(x)),
      remove: (...n) => n.forEach((x) => classes.delete(x)),
      contains: (x) => classes.has(x)
    },
    classes
  };
}

function buttonContext() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(slice(logging, 'var SENT_HOLD_MS=', 'function lockSaveButton('), context);
  return context;
}

test('a busy button says Sending, keeps its spinner hook and restores its label', () => {
  const ctx = buttonContext();
  const btn = fakeButton('Review & submit');
  ctx.setButtonBusy(btn, true);
  assert.equal(btn.textContent, 'Sending…');
  assert.equal(btn.disabled, true);
  assert.equal(btn.attributes['aria-busy'], 'true');
  assert.equal(btn.classes.has('is-loading'), true);
  ctx.setButtonBusy(btn, false);
  assert.equal(btn.textContent, 'Review & submit');
  assert.equal(btn.disabled, false);
  assert.equal(btn.attributes['aria-busy'], undefined);
});

test('a sent button turns green and says so; a queued one says it is waiting', () => {
  const ctx = buttonContext();
  const sent = fakeButton('Send to coaches');
  ctx.setButtonBusy(sent, true);
  ctx.markButtonSent(sent);
  assert.equal(sent.textContent, 'Sent to coaches ✓');
  assert.equal(sent.classes.has('is-sent'), true);
  assert.equal(sent.classes.has('is-loading'), false);
  assert.equal(sent.attributes['aria-busy'], undefined);
  // Clearing busy afterwards must not resurrect the pre-send label.
  ctx.setButtonBusy(sent, false);
  assert.equal(sent.textContent, 'Sent to coaches ✓');

  const queued = fakeButton('Send to coaches');
  ctx.setButtonBusy(queued, true);
  ctx.markButtonSent(queued, null, true);
  assert.equal(queued.classes.has('is-sending'), true);
  assert.equal(queued.classes.has('is-sent'), false);
  assert.match(queued.textContent, /sends when online/);
});

test('sending never falls through to the grey disabled style', () => {
  assert.match(styles, /\.savebtn\[aria-busy="true"\]:disabled,\.focus-done-btn\[aria-busy="true"\]:disabled,\s*\.strength-review-primary\[aria-busy="true"\],\.coach-note-send\[aria-busy="true"\]\{[^}]*opacity:1/);
  assert.match(styles, /\.savebtn\.is-sent,[^{]*\.strength-review-primary\.is-sent[^{]*\{[^}]*background:var\(--done\)/);
  // The busy rule must come after the generic :disabled rule to win the cascade.
  const disabledAt = styles.indexOf('.savebtn:disabled,.todaybtn:disabled{');
  const busyAt = styles.indexOf('.savebtn[aria-busy="true"]:disabled');
  assert.ok(disabledAt > 0 && busyAt > disabledAt);
});

test('the strength review stays up and shows Sending while the session uploads', () => {
  const submit = slice(training, 'async function submitStrengthFromReview(', 'function showStrengthSessionRecap(');
  assert.doesNotMatch(submit, /closeStrengthReview\(\)/);
  assert.match(submit, /setButtonBusy\(primary,true\)/);
  assert.match(submit, /await saveGym\(/);
  const save = slice(logging, 'async function saveGym(', 'function flashSave(');
  assert.match(save, /markButtonSent\(reviewPrimary,null,gymQueued\);await holdSentState\(\);[\s\S]*showStrengthSessionRecap/);
});

test('check-in and log sheets show Sending, then green before moving on', () => {
  const ci = slice(checkin, 'async function submitCheckin(', '// ── TESTIMONIAL ASK');
  assert.match(ci, /btn\.textContent='Sending\\u2026'/);
  assert.match(ci, /is-sent[\s\S]*Sent to coaches[\s\S]*setTimeout\(resolve,750\)[\s\S]*ciSuccess/);
  assert.match(checkin, /qlbSubmitBtn'\);[^\n]*btn\.textContent='Sending\\u2026'/);
  assert.match(checkin, /qlnSubmitBtn'\);[^\n]*btn\.textContent='Sending\\u2026'/);
  const feedback = slice(checkin, 'function showQuickLogSubmitFeedback(', 'function resetQuickLogSubmitButton(');
  assert.match(feedback, /classList\.remove\('is-loading'\);btn\.removeAttribute\('aria-busy'\)/);
});
