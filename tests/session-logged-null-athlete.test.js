import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const logging = readFileSync(join(root, 'public', 'js', '09-logging.js'), 'utf8');

function isSessionLoggedSource() {
  const start = logging.indexOf('function isSessionLogged(');
  const end = logging.indexOf('function stampSessionSubmitted(', start);
  assert.ok(start >= 0 && end > start, 'isSessionLogged should remain discoverable');
  return logging.slice(start, end);
}

function makeContext(athlete, sessionLoggedCache = {}, logs = {}) {
  const context = {
    athlete,
    sessionLoggedCache,
    logs,
    stravaSessionNeedsManualLog: () => false,
  };
  vm.createContext(context);
  vm.runInContext(isSessionLoggedSource(), context);
  return context;
}

test('a workout refresh is harmless while no athlete profile is available', () => {
  const context = makeContext(null);
  assert.doesNotThrow(() => context.isSessionLogged('session-1'));
  assert.equal(context.isSessionLogged('session-1'), false);
});

test('an active athlete still reads cloud and local submission markers', () => {
  const cached = makeContext(
    { code: 'CHUNG' },
    { 'session_CHUNG_cloud-session': true },
  );
  assert.equal(cached.isSessionLogged('cloud-session'), true);

  const local = makeContext(
    { code: 'CHUNG' },
    {},
    { 'local-session': { __submittedAt: '2026-09-29T03:26:43.000Z' } },
  );
  assert.equal(local.isSessionLogged('local-session'), true);
});
