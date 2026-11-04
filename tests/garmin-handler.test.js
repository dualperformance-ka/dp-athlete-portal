// End-to-end through the real handler, with Garmin and Supabase stubbed at the
// fetch boundary. The unit tests in garmin.test.js prove each piece; these
// prove the pieces are wired together: the verifier sent at the callback is
// the one whose challenge went out in the authorize URL, and a pushed summary
// actually becomes an upsert against the right table.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.PORTAL_SESSION_SECRET = process.env.PORTAL_SESSION_SECRET || 'test-secret-that-is-at-least-32-characters-long';
process.env.SUPABASE_URL = 'https://db.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key-for-tests-only';
process.env.GARMIN_CLIENT_ID = 'garmin-client';
process.env.GARMIN_CLIENT_SECRET = 'garmin-secret';
process.env.PORTAL_URL = 'https://portal.dualperformance.au';

const { default: handler } = await import('../api/garmin.js');
const { buildAuthorizeUrl } = await import('../api/_lib/garmin-client.js');
const { createPortalSession } = await import('../api/_lib/legacy-session.js');

function response() {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.send = (body) => { res.body = body; return res; };
  res.end = () => res;
  res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = value; };
  return res;
}

function json(body, status = 200) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const call = { url, method: init.method || 'GET', body: init.body };
    calls.push(call);
    for (const [match, reply] of routes) {
      if (match(call)) return reply(call);
    }
    throw new Error(`unexpected fetch ${call.method} ${url}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('callback: the verifier sent to Garmin matches the challenge in the authorize URL', async () => {
  const state = createPortalSession('DP7', { purpose: 'garmin', ttlSeconds: 600 });
  const authorize = new URL(buildAuthorizeUrl('https://portal.dualperformance.au/api/garmin-callback', state));
  const challenge = authorize.searchParams.get('code_challenge');

  let saved = null;
  const stub = stubFetch([
    [(c) => c.url.startsWith('https://connectapi.garmin.com/di-oauth2-service/oauth/token'),
      () => json({ access_token: 'acc', refresh_token: 'ref', expires_in: 86400, refresh_token_expires_in: 7775998, scope: 'PARTNER_READ' })],
    [(c) => c.url === 'https://apis.garmin.com/wellness-api/rest/user/id', () => json({ userId: 'garmin-user-7' })],
    [(c) => c.url === 'https://apis.garmin.com/wellness-api/rest/user/permissions', () => json(['ACTIVITY_EXPORT', 'HEALTH_EXPORT'])],
    [(c) => c.url.startsWith('https://db.test/rest/v1/garmin_connections?garmin_user_id='), () => json([])],
    [(c) => c.method === 'POST' && c.url.startsWith('https://db.test/rest/v1/garmin_connections'),
      (c) => { saved = JSON.parse(c.body)[0]; return json([saved], 201); }],
  ]);
  try {
    const res = response();
    await handler({ method: 'GET', headers: {}, query: { mode: 'callback', code: 'auth-code', state } }, res);
    assert.equal(res.statusCode, 200, String(res.body).slice(0, 300));

    const tokenCall = stub.calls.find((c) => c.url.includes('/oauth/token'));
    const form = new URLSearchParams(tokenCall.body);
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('code'), 'auth-code');
    assert.equal(form.get('redirect_uri'), 'https://portal.dualperformance.au/api/garmin-callback');
    assert.equal(crypto.createHash('sha256').update(form.get('code_verifier')).digest('base64url'), challenge,
      'the callback must send the verifier whose challenge went out in the authorize URL');

    assert.equal(saved.athlete_code, 'DP7');
    assert.equal(saved.garmin_user_id, 'garmin-user-7');
    assert.equal(saved.refresh_token, 'ref');
    assert.deepEqual(saved.permissions, ['ACTIVITY_EXPORT', 'HEALTH_EXPORT']);
  } finally {
    stub.restore();
  }
});

test('callback: a Garmin account already linked to another athlete is refused', async () => {
  const state = createPortalSession('DP8', { purpose: 'garmin', ttlSeconds: 600 });
  const stub = stubFetch([
    [(c) => c.url.includes('/oauth/token'), () => json({ access_token: 'acc', refresh_token: 'ref', expires_in: 86400 })],
    [(c) => c.url.endsWith('/user/id'), () => json({ userId: 'shared-user' })],
    [(c) => c.url.startsWith('https://db.test/rest/v1/garmin_connections?garmin_user_id='), () => json([{ athlete_code: 'DP1', garmin_user_id: 'shared-user' }])],
  ]);
  try {
    const res = response();
    await handler({ method: 'GET', headers: {}, query: { mode: 'callback', code: 'c', state } }, res);
    assert.equal(res.statusCode, 409);
    assert.ok(!stub.calls.some((c) => c.method === 'POST' && c.url.includes('garmin_connections')), 'nothing may be saved');
  } finally {
    stub.restore();
  }
});

test('callback: a state minted for Strava cannot be replayed against Garmin', async () => {
  const state = createPortalSession('DP7', { purpose: 'strava', ttlSeconds: 600 });
  const stub = stubFetch([]);
  try {
    const res = response();
    await handler({ method: 'GET', headers: {}, query: { mode: 'callback', code: 'c', state } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(stub.calls.length, 0, 'no token exchange without a valid Garmin state');
  } finally {
    stub.restore();
  }
});

test('webhook: a pushed activity becomes an upsert on garmin_activities for the linked athlete', async () => {
  let upsert = null;
  const stub = stubFetch([
    [(c) => c.method === 'GET' && c.url.startsWith('https://db.test/rest/v1/garmin_connections?garmin_user_id=eq.u1'),
      () => json([{ athlete_code: 'DP7', garmin_user_id: 'u1', access_token: 'a', refresh_token: 'r', access_expires_at: '2999-01-01T00:00:00Z' }])],
    [(c) => c.method === 'POST' && c.url.startsWith('https://db.test/rest/v1/garmin_activities'),
      (c) => { upsert = { url: c.url, rows: JSON.parse(c.body) }; return json(undefined, 201); }],
    [(c) => c.method === 'PATCH' && c.url.startsWith('https://db.test/rest/v1/garmin_connections'), () => json([{}])],
  ]);
  try {
    const res = response();
    await handler({
      method: 'POST',
      headers: { 'garmin-client-id': 'garmin-client' },
      query: { mode: 'webhook' },
      body: { activities: [{ userId: 'u1', summaryId: 'a1', activityId: 1, startTimeInSeconds: 1763597760, startTimeOffsetInSeconds: 37800, activityType: 'RUNNING', distanceInMeters: 8000 }] },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.saved, 1);
    assert.match(upsert.url, /on_conflict=athlete_code%2Csummary_id/);
    assert.equal(upsert.rows[0].athlete_code, 'DP7');
    assert.equal(upsert.rows[0].distance_m, 8000);
  } finally {
    stub.restore();
  }
});

test('webhook: a storage failure answers 500 so Garmin redelivers', async () => {
  const stub = stubFetch([
    [(c) => c.method === 'GET' && c.url.includes('garmin_connections'), () => json([{ athlete_code: 'DP7', garmin_user_id: 'u1' }])],
    [(c) => c.method === 'POST' && c.url.includes('garmin_activities'), () => json({ message: 'boom' }, 500)],
  ]);
  try {
    const res = response();
    await handler({ method: 'POST', headers: {}, query: { mode: 'webhook' }, body: { activities: [{ userId: 'u1', summaryId: 'a1', startTimeInSeconds: 1763597760 }] } }, res);
    assert.equal(res.statusCode, 500);
  } finally {
    stub.restore();
  }
});

test('webhook: traffic for a different Garmin app is acknowledged and dropped', async () => {
  const stub = stubFetch([]);
  try {
    const res = response();
    await handler({ method: 'POST', headers: { 'garmin-client-id': 'someone-else' }, query: { mode: 'webhook' }, body: { activities: [{ userId: 'u1', summaryId: 'a1', startTimeInSeconds: 1 }] } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ignored, 'unexpected_client');
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});
