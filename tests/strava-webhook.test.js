import test from 'node:test';
import assert from 'node:assert/strict';

import { processEvent, webhookChallengeResponse } from '../api/strava.js';

// ── Subscription validation handshake ────────────────────────────────────────

test('a correct handshake echoes the challenge', () => {
  const result = webhookChallengeResponse({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'shared-secret',
    'hub.challenge': 'abc123',
  }, 'shared-secret');

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { 'hub.challenge': 'abc123' });
});

// Without the token check, anyone who guesses the callback URL can complete a
// subscription handshake against this endpoint and start pushing events at it.
test('a wrong or missing verify token is refused', () => {
  const query = { 'hub.mode': 'subscribe', 'hub.verify_token': 'guessed', 'hub.challenge': 'abc123' };
  assert.equal(webhookChallengeResponse(query, 'shared-secret').status, 403);
  assert.equal(webhookChallengeResponse({ ...query, 'hub.verify_token': '' }, 'shared-secret').status, 403);
});

// A deploy that forgot the env var must fail loudly rather than accept anything.
test('an unconfigured verify token fails closed, not open', () => {
  const query = { 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': 'abc123' };
  const result = webhookChallengeResponse(query, undefined);
  assert.equal(result.status, 500);
  assert.equal(result.body.error, 'verify_token_not_configured');
});

test('a malformed handshake is rejected', () => {
  assert.equal(webhookChallengeResponse({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 's', 'hub.challenge': 'c' }, 's').status, 400);
  assert.equal(webhookChallengeResponse({ 'hub.mode': 'subscribe', 'hub.verify_token': 's' }, 's').status, 400);
  assert.equal(webhookChallengeResponse({}, 's').status, 400);
});

// ── Event processing ─────────────────────────────────────────────────────────

function harness(overrides = {}) {
  const calls = { fetched: [], stored: [], removedActivity: [], removedAll: [], removedTokens: [] };
  const deps = {
    resolveAthlete: async () => 'DP-001',
    accessToken: async () => 'access-token',
    fetchActivity: async (token, id) => {
      calls.fetched.push({ token, id });
      return { id: Number(id), name: 'Run', sport_type: 'Run', start_date_local: '2026-08-16T06:00:00Z', distance: 10000 };
    },
    storeActivities: async (code, activities) => { calls.stored.push({ code, activities }); },
    removeActivity: async (code, id) => { calls.removedActivity.push({ code, id }); },
    removeAllActivities: async (code) => { calls.removedAll.push(code); },
    removeTokens: async (code) => { calls.removedTokens.push(code); },
    ...overrides,
  };
  return { calls, deps };
}

const activityEvent = (aspect, extra = {}) => ({
  object_type: 'activity',
  object_id: 19758888707,
  aspect_type: aspect,
  owner_id: 4242,
  updates: {},
  ...extra,
});

test('a created activity is fetched and cached', async () => {
  const { calls, deps } = harness();
  const result = await processEvent(activityEvent('create'), deps);

  assert.equal(result.reason, 'activity_created');
  assert.equal(result.athleteCode, 'DP-001');
  assert.equal(calls.fetched.length, 1);
  assert.equal(calls.fetched[0].id, 19758888707);
  assert.equal(calls.stored[0].code, 'DP-001');
});

// An athlete correcting a run's distance or renaming it on Strava must update
// the cached copy, or the portal keeps matching against a stale version.
test('an updated activity is re-fetched, not ignored', async () => {
  const { calls, deps } = harness();
  const result = await processEvent(activityEvent('update', { updates: { title: 'EASY 55"' } }), deps);

  assert.equal(result.reason, 'activity_updated');
  assert.equal(calls.fetched.length, 1);
  assert.equal(calls.stored.length, 1);
});

// A run deleted on Strava must disappear here too, otherwise the session stays
// marked complete against an activity that no longer exists.
test('a deleted activity is removed from the cache without a fetch', async () => {
  const { calls, deps } = harness();
  const result = await processEvent(activityEvent('delete'), deps);

  assert.equal(result.reason, 'activity_deleted');
  assert.deepEqual(calls.removedActivity, [{ code: 'DP-001', id: 19758888707 }]);
  assert.equal(calls.fetched.length, 0, 'fetching an activity Strava just deleted would 404');
});

// Consent withdrawn at Strava's end. Keeping their activities after that is
// precisely what the API agreement forbids, so the purge is not optional.
test('deauthorization purges both the activities and the tokens', async () => {
  const { calls, deps } = harness();
  const result = await processEvent({
    object_type: 'athlete',
    object_id: 4242,
    owner_id: 4242,
    aspect_type: 'update',
    updates: { authorized: 'false' },
  }, deps);

  assert.equal(result.reason, 'deauthorized');
  assert.deepEqual(calls.removedAll, ['DP-001']);
  assert.deepEqual(calls.removedTokens, ['DP-001']);
});

test('an ordinary athlete update is not mistaken for deauthorization', async () => {
  const { calls, deps } = harness();
  const result = await processEvent({
    object_type: 'athlete',
    object_id: 4242,
    owner_id: 4242,
    aspect_type: 'update',
    updates: { authorized: 'true' },
  }, deps);

  assert.equal(result.reason, 'athlete_update_ignored');
  assert.deepEqual(calls.removedAll, []);
  assert.deepEqual(calls.removedTokens, []);
});

// The webhook endpoint is unauthenticated by design — Strava does not sign
// events. An event naming a Strava athlete nobody is linked to is either forged
// or a leftover. It must resolve to "nothing to do", never to a fetch, and never
// to an error that retries forever.
test('an event for an unknown athlete does no work and does not retry', async () => {
  const { calls, deps } = harness({ resolveAthlete: async () => null });
  const result = await processEvent(activityEvent('create'), deps);

  assert.equal(result.reason, 'unknown_athlete');
  assert.equal(result.athleteCode, null);
  assert.equal(calls.fetched.length, 0);
  assert.equal(calls.stored.length, 0);
});

test('an athlete whose tokens are already gone is skipped cleanly', async () => {
  const { calls, deps } = harness({ accessToken: async () => null });
  const result = await processEvent(activityEvent('create'), deps);

  assert.equal(result.reason, 'not_connected');
  assert.equal(calls.fetched.length, 0);
});

test('object and aspect types we do not handle are ignored, not failed', async () => {
  const { deps } = harness();
  assert.equal((await processEvent(activityEvent('create', { object_type: 'segment' }), deps)).reason, 'unhandled_object_type');
  assert.equal((await processEvent(activityEvent('archive'), deps)).reason, 'unhandled_aspect');
});

test('a pre-resolved athlete_code skips the lookup', async () => {
  let looked = 0;
  const { deps } = harness({ resolveAthlete: async () => { looked += 1; return 'DP-999'; } });
  const result = await processEvent(activityEvent('create', { athlete_code: 'DP-001' }), deps);

  assert.equal(result.athleteCode, 'DP-001');
  assert.equal(looked, 0);
});

// A failure inside the fetch must propagate so the drain records the attempt and
// retries later. Swallowing it here would silently drop the activity forever.
test('a Strava failure propagates so the event can be retried', async () => {
  const { deps } = harness({
    fetchActivity: async () => { const e = new Error('Strava activity fetch failed: 429'); e.status = 429; throw e; },
  });
  await assert.rejects(() => processEvent(activityEvent('create'), deps), /429/);
});
