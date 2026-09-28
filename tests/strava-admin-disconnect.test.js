import test from 'node:test';
import assert from 'node:assert/strict';

import { disconnectInactiveAthleteStrava } from '../api/athletes.js';

function deps(overrides = {}) {
  const calls = [];
  return {
    calls,
    value: {
      findAthlete: async (code) => ({ code, name: 'Shaun', active: false }),
      readTokens: async () => ({
        access_token: 'expired-access',
        refresh_token: 'refresh-token',
        expires_at: 100,
      }),
      refreshToken: async (token) => {
        calls.push(['refresh', token]);
        return { access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_at: 2000 };
      },
      saveTokenChanges: async (code, changes) => calls.push(['save', code, changes]),
      revoke: async (token) => calls.push(['revoke', token]),
      purgeActivities: async (code) => calls.push(['activities', code]),
      purgeTokens: async (code) => calls.push(['tokens', code]),
      nowSeconds: () => 1000,
      ...overrides,
    },
  };
}

test('admin Strava disconnect requires an inactive athlete and explicit confirmation', async () => {
  const inactive = deps();
  await assert.rejects(
    disconnectInactiveAthleteStrava({ code: 'SHAUN' }, inactive.value),
    (error) => error.status === 400 && /confirmed/.test(error.message),
  );
  assert.deepEqual(inactive.calls, []);

  const active = deps({ findAthlete: async (code) => ({ code, active: true }) });
  await assert.rejects(
    disconnectInactiveAthleteStrava({ code: 'SHAUN', confirmed: true }, active.value),
    (error) => error.status === 409 && /inactive/.test(error.message),
  );
  assert.deepEqual(active.calls, []);
});

test('an expired token is refreshed before Strava is revoked and local data is purged', async () => {
  const fixture = deps();
  const result = await disconnectInactiveAthleteStrava(
    { code: 'shaun', confirmed: true },
    fixture.value,
  );

  assert.deepEqual(result, { ok: true, code: 'SHAUN', disconnected: true, refreshed: true });
  assert.deepEqual(fixture.calls.map((entry) => entry[0]), [
    'refresh', 'save', 'revoke', 'activities', 'tokens',
  ]);
  assert.deepEqual(fixture.calls[2], ['revoke', 'fresh-access']);
});

test('a Strava refresh failure keeps the credential and cached activities for retry', async () => {
  const fixture = deps({
    refreshToken: async () => {
      const error = new Error('Strava unavailable');
      error.status = 503;
      throw error;
    },
  });

  await assert.rejects(
    disconnectInactiveAthleteStrava({ code: 'SHAUN', confirmed: true }, fixture.value),
    /Strava unavailable/,
  );
  assert.deepEqual(fixture.calls, []);
});

test('an already-missing authorization is cleaned locally without contacting Strava', async () => {
  const fixture = deps({ readTokens: async () => null });
  const result = await disconnectInactiveAthleteStrava(
    { code: 'SHAUN', confirmed: true },
    fixture.value,
  );

  assert.deepEqual(result, {
    ok: true,
    code: 'SHAUN',
    disconnected: true,
    alreadyDisconnected: true,
  });
  assert.deepEqual(fixture.calls, [['activities', 'SHAUN'], ['tokens', 'SHAUN']]);
});
