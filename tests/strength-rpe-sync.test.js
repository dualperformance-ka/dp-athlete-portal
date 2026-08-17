import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const core = readFileSync(join(root, 'public', 'js', '01-core.js'), 'utf8');
const training = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');
const logging = readFileSync(join(root, 'public', 'js', '09-logging.js'), 'utf8');
const api = readFileSync(join(root, 'api', 'write.js'), 'utf8');

const preferenceFunctions = training.slice(
  training.indexOf('function strengthRpeEnabled'),
  training.indexOf('function updateStrengthRpeControls')
);
const context = {
  localStorage: { getItem: () => null },
};
vm.createContext(context);
vm.runInContext(`${preferenceFunctions};this.strengthLogRequiresRpe=strengthLogRequiresRpe;`, context);

test('RPE preference is allowed, uploaded and hydrated through athlete state', () => {
  assert.match(api, /\^strength_rpe_enabled\$\//);
  assert.match(core, /key==='dp_strength_rpe_enabled'\) sbKey='strength_rpe_enabled'/);
  assert.match(core, /row\.key==='strength_rpe_enabled'\) lsKey='dp_strength_rpe_enabled'/);
});

test('new strength logs freeze the RPE rule used for that session', () => {
  assert.match(logging, /__rpeEnabled:strengthLogRequiresRpe\(previous,isSessionLogged\(s\.id\)\)/);
  assert.match(training, /data-rpe-required=/);
  assert.match(training, /strengthSavedSetHasRequiredInputs\(set,isSingleLeg,sessionRpeRequired\)/);
});

test('legacy submitted sets completed without RPE remain complete after a domain change', () => {
  const legacy = {
    __submittedAt: '2026-08-17T10:00:00.000Z',
    'Machine Hip Thrust': [{ weight: '68', reps: '10', rpe: '', done: true }],
  };
  assert.equal(context.strengthLogRequiresRpe(legacy), false);
  const confirmedWithoutMarker = { 'Machine Hip Thrust': legacy['Machine Hip Thrust'] };
  assert.equal(context.strengthLogRequiresRpe(confirmedWithoutMarker, true), false);
  assert.equal(context.strengthLogRequiresRpe({ ...legacy, __rpeEnabled: true }), true);
  assert.equal(context.strengthLogRequiresRpe({ ...legacy, __rpeEnabled: false }), false);
});

test('submission awaits the final cloud snapshot containing its submitted marker', () => {
  const saveStart = logging.indexOf('async function saveGym');
  const saveEnd = logging.indexOf('function flashSave', saveStart);
  const saveGym = logging.slice(saveStart, saveEnd);
  assert.match(saveGym, /stampSessionSubmitted\(s\.id\);[\s\S]*await portalStateWrite\('logs',logs\)/);
  assert.match(saveGym, /gymStateQueued\|\|gymCoachResults/);
});
