import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { unavailableActivitiesResponse } from '../api/strava.js';

const boot = readFileSync(fileURLToPath(new URL('../public/js/10-boot.js', import.meta.url)), 'utf8');

test('Strava rate limits do not hide a valid connection', () => {
  assert.deepEqual(unavailableActivitiesResponse({ status: 429 }), {
    connected: true,
    activities: [],
    activitiesAvailable: false,
    warning: 'strava_rate_limited',
  });
});

test('non-rate-limit activity errors are not masked', () => {
  assert.equal(unavailableActivitiesResponse({ status: 401 }), null);
  assert.equal(unavailableActivitiesResponse(new Error('network error')), null);
});

// The OAuth callback identifies the athlete from the signed `state` token in the
// authorize URL. A client-built URL cannot sign one, so it always dies at the
// callback with "Missing code or athlete identifier" — the portal must only ever
// use the connect URL minted by GET /api/strava.
test('the portal never builds a Strava authorize URL client-side', () => {
  assert.ok(!/strava\.com\/oauth\/authorize/.test(boot),
    '10-boot.js must not construct a Strava authorize URL; use data.connectUrl from /api/strava');
  assert.ok(!/client_id/.test(boot),
    '10-boot.js must not hardcode the Strava client_id');
});

test('the connect button has no fallback URL when /api/strava fails', () => {
  assert.ok(/if \(res\.status === 401\)/.test(boot),
    'a 401 must be handled explicitly instead of being parsed as a normal response');
  assert.ok(/if \(!res\.ok\)/.test(boot),
    'a non-2xx response must not be parsed as if it were normal data');
});

// A silent failure is how a broken endpoint stays broken: the button vanishes
// and nobody can tell whether it is a bug or an athlete who never connected.
test('every /api/strava failure path leaves a visible, diagnosable state', () => {
  const reported = boot.match(/showUnavailable\(/g) || [];
  assert.ok(reported.length >= 5,
    'each failure path must call showUnavailable() rather than hiding the button');
  assert.ok(/window\._stravaDebug = /.test(boot),
    'the last failure reason must be readable from the console');
});
