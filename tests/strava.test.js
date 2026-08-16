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
  const failurePaths = boot.match(/hideButton\(\);/g) || [];
  assert.ok(failurePaths.length >= 4,
    'every /api/strava failure path must hide the button rather than offer a link');
  assert.ok(/if \(res\.status === 401\)/.test(boot),
    'a 401 must be handled explicitly instead of being parsed as a normal response');
});
