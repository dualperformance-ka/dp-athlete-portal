import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const loginGoals = readFileSync(join(root, 'public', 'js', '02-login-goals.js'), 'utf8');
const training = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');

function functionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const syncEnd = source.indexOf(`function ${nextName}(`, start);
  const asyncEnd = source.indexOf(`async function ${nextName}(`, start);
  const end = asyncEnd >= 0 ? asyncEnd : syncEnd;
  assert.ok(start >= 0 && end > start, `could not extract ${name}`);
  return source.slice(start, end);
}

test('an exercise swap queued after logout is ignored without changing state', () => {
  let storageWrites = 0;
  const context = {
    athlete: null,
    exPicks: {},
    localStorage: { setItem: () => { storageWrites++; } },
    portalStateWrite: () => { throw new Error('must not sync a swap without an athlete'); },
    document: { querySelectorAll: () => [], getElementById: () => null },
    sessions: []
  };
  vm.createContext(context);
  vm.runInContext(functionSource(loginGoals, 'pickEx', 'saveGoals'), context);

  assert.equal(context.pickEx('Lat Pulldown', 'Cable Lat Pulldown'), false);
  assert.deepEqual(context.exPicks, {});
  assert.equal(storageWrites, 0);
});

function strengthInteractionContext({ sessions, renderedSessionId }) {
  let mutations = 0;
  const card = {
    getAttribute(name) {
      if (name === 'data-session-id') return renderedSessionId;
      if (name === 'data-split-key') return 'Upper A';
      return null;
    }
  };
  const row = {
    closest: () => card,
    setAttribute: () => { mutations++; }
  };
  const panel = {
    classList: { add: () => { mutations++; }, remove: () => { mutations++; } },
    querySelectorAll: () => [],
    querySelector: () => null
  };
  const context = {
    sessions,
    document: {
      getElementById(id) {
        if (id === 'sr_0_0_0') return row;
        if (id === 'effort_0_0_0') return panel;
        return null;
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(functionSource(training, 'setStrengthEffort', 'applyStrengthEffortLoad'), context);
  return { context, mutations: () => mutations };
}

test('a strength-effort tap is ignored when its session has disappeared', () => {
  const { context, mutations } = strengthInteractionContext({ sessions: [], renderedSessionId: 'old-session' });
  assert.equal(context.setStrengthEffort(0, 0, 0, 'on_target', null), false);
  assert.equal(mutations(), 0);
});

test('a strength-effort tap cannot target a newly re-indexed session', () => {
  const { context, mutations } = strengthInteractionContext({
    sessions: [{ id: 'new-session' }],
    renderedSessionId: 'old-session'
  });
  assert.equal(context.setStrengthEffort(0, 0, 0, 'on_target', null), false);
  assert.equal(mutations(), 0);
});
