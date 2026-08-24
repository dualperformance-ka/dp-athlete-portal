import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Athletes routinely add an exercise after pressing save — they finish the
// session, then remember the last movement. The save button used to lock
// permanently on submit, so that work only ever reached the local draft and no
// coach ever saw it. And on the occasions a second submit did get through, the
// write id was random, so it inserted a duplicate copy of the whole session
// rather than updating it.
//
// Both failures are the same missing idea: a strength row is identified by the
// athlete, the session and the exercise — not by when the submit happened.

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const source = readFileSync(join(root, 'public', 'js', '09-logging.js'), 'utf8');
const training = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');

function slice(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.ok(start > 0, `${startMarker} should exist`);
  const end = text.indexOf(endMarker, start);
  assert.ok(end > start, `${endMarker} should follow ${startMarker}`);
  return text.slice(start, end);
}

const context = {
  logs: {},
  athlete: { code: 'ALVIN' },
  localStorage: { setItem() {}, getItem() { return null; } },
  statuses: [],
  buttons: [],
};
vm.createContext(context);
vm.runInContext(
  slice(training, 'function exerciseHistoryKey(', 'function getExerciseSetsFromLog(') +
  slice(training, 'function gymDraftHasData(', 'function setGymSubmissionStatus(') +
  // The DOM-facing helpers are replaced by recorders — this test is about which
  // state is chosen, not how it is painted.
  'function setGymSubmissionStatus(i,state){statuses.push(state);}\n' +
  'function lockSaveButton(i,label){buttons.push({locked:true,label:label});}\n' +
  'function unlockSaveButton(i,label){buttons.push({locked:false,label:label});}\n' +
  slice(source, '// What was actually sent to the coaches', 'function refreshGymSubmitState(') +
  slice(source, 'function refreshGymSubmitState(', 'async function saveRun(') +
  slice(source, 'function stampSessionSubmitted(', 'function lockSaveButton(') +
  'this.gymLogSignature=gymLogSignature;this.strengthClientWriteId=strengthClientWriteId;' +
  'this.refreshGymSubmitState=refreshGymSubmitState;this.stampSessionSubmitted=stampSessionSubmitted;',
  context
);

const { gymLogSignature, strengthClientWriteId, refreshGymSubmitState, stampSessionSubmitted } = context;

function reset() { context.statuses = []; context.buttons = []; context.logs = {}; }
const sets = n => Array.from({ length: n }, (_, i) => ({ weight: '50', reps: String(10 + i) }));
// Objects built inside the VM belong to another realm, so they are compared
// through plain copies rather than deepEqual on the raw values.
const plain = value => JSON.parse(JSON.stringify(value));

test('the same exercise in the same session always writes to the same row', () => {
  const first = strengthClientWriteId('sess-1', 'Iso-Lateral Row');
  const second = strengthClientWriteId('sess-1', 'iso-lateral   row');
  assert.equal(first, second, 'casing and spacing must not fork the row');
  assert.notEqual(first, strengthClientWriteId('sess-1', 'Pec Dec'));
  assert.notEqual(first, strengthClientWriteId('sess-2', 'Iso-Lateral Row'));
});

test('dumbbell split squat history merges with Bulgarian but not barbell', () => {
  const bulgarian = strengthClientWriteId('sess-1', 'Bulgarian Split Squat');
  assert.equal(bulgarian, strengthClientWriteId('sess-1', 'Dumbbell Split Squat'));
  assert.equal(bulgarian, strengthClientWriteId('sess-1', 'Dumbbell Bulgarian Split Squat'));
  assert.notEqual(bulgarian, strengthClientWriteId('sess-1', 'Barbell Split Squat'));
});

test('a write id stays within the column limit even for absurd exercise names', () => {
  const long = 'Iso-Lateral Plate Loaded Chest Supported Wide Grip Machine Row Variation Two Handed';
  const id = strengthClientWriteId('3ef24625-9cc4-4f47-99f4-1df058b7c3d8', long);
  assert.ok(id.length <= 120, `id was ${id.length} characters`);
  // Folding must not collapse different exercises onto one row.
  assert.notEqual(id, strengthClientWriteId('3ef24625-9cc4-4f47-99f4-1df058b7c3d8', long + ' Reverse'));
});

test('adding an exercise after submitting re-opens the button', () => {
  reset();
  context.logs['s1'] = { 'Pec Dec': sets(3), 'Iso-Lateral Row': sets(2) };
  stampSessionSubmitted('s1');

  context.statuses = []; context.buttons = [];
  refreshGymSubmitState(0, 's1', context.logs['s1']);
  assert.deepEqual(context.statuses, ['submitted']);
  assert.deepEqual(plain(context.buttons), [{ locked: true, label: 'Save session' }]);

  // He remembers one more movement and logs it.
  context.statuses = []; context.buttons = [];
  context.logs['s1']['Rear Delt Fly'] = sets(2);
  refreshGymSubmitState(0, 's1', context.logs['s1']);
  assert.deepEqual(context.statuses, ['resubmit']);
  assert.deepEqual(plain(context.buttons), [{ locked: false, label: 'Update session' }]);
});

test('adding a set to an exercise already submitted also re-opens it', () => {
  reset();
  context.logs['s1'] = { 'Pec Dec': sets(2) };
  stampSessionSubmitted('s1');
  context.statuses = []; context.buttons = [];
  context.logs['s1']['Pec Dec'] = sets(3);
  refreshGymSubmitState(0, 's1', context.logs['s1']);
  assert.deepEqual(context.statuses, ['resubmit']);
});

test('re-submitting settles the session again', () => {
  reset();
  context.logs['s1'] = { 'Pec Dec': sets(2) };
  stampSessionSubmitted('s1');
  context.logs['s1']['Rear Delt Fly'] = sets(2);
  stampSessionSubmitted('s1');
  context.statuses = []; context.buttons = [];
  refreshGymSubmitState(0, 's1', context.logs['s1']);
  assert.deepEqual(context.statuses, ['submitted']);
});

test('a never-submitted session still reads as a draft', () => {
  reset();
  context.logs['s1'] = { 'Pec Dec': sets(2) };
  refreshGymSubmitState(0, 's1', context.logs['s1']);
  assert.deepEqual(context.statuses, ['draft']);
  assert.deepEqual(plain(context.buttons), []);
});

test('an empty session shows nothing at all', () => {
  reset();
  context.logs['s1'] = { 'Pec Dec': [] };
  refreshGymSubmitState(0, 's1', context.logs['s1']);
  assert.deepEqual(context.statuses, ['hidden']);
});

test('sessions submitted before signatures existed are not flagged as unsent', () => {
  reset();
  // Historic shape: __submittedAt, no __submittedSig.
  context.logs['old'] = { 'Pec Dec': sets(3), __submittedAt: '2026-08-05T06:01:29.900Z' };
  refreshGymSubmitState(0, 'old', context.logs['old']);
  assert.deepEqual(context.statuses, ['submitted']);
});

test('the signature ignores notes and empty exercises', () => {
  const a = gymLogSignature({ 'Pec Dec': sets(2), __notes: 'felt good' });
  const b = gymLogSignature({ 'Pec Dec': sets(2), __notes: 'left knee sore', 'Rear Delt Fly': [] });
  assert.equal(a, b, 'only logged work should decide whether a resubmit is needed');
});
