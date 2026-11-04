import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

process.env.PORTAL_SESSION_SECRET = process.env.PORTAL_SESSION_SECRET || 'test-secret-that-is-at-least-32-characters-long';

const client = await import('../api/_lib/garmin-client.js');
const { garminAvailableFor, getAccessToken, processNotification } = await import('../api/garmin.js');

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

// ── PKCE ─────────────────────────────────────────────────────────────────────

test('the PKCE verifier is derived from the state, valid, and not guessable from it', () => {
  const state = 'dp1.payload.signature';
  const verifier = client.pkceVerifier(state);
  assert.ok(client.isValidVerifier(verifier), 'verifier must be 43-128 chars of the PKCE alphabet');
  assert.equal(client.pkceVerifier(state), verifier, 'the callback must be able to recompute the same verifier');
  assert.notEqual(client.pkceVerifier(`${state}x`), verifier);
  assert.ok(!verifier.includes(state), 'the verifier must not be readable from the state');
});

test('the challenge is base64url(SHA-256(verifier))', () => {
  const verifier = client.pkceVerifier('state-a');
  const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
  assert.equal(client.pkceChallenge(verifier), expected);
});

test('the authorize URL carries everything Garmin requires and the matching challenge', () => {
  const url = new URL(client.buildAuthorizeUrl('https://portal.dualperformance.au/api/garmin-callback', 'state-b', 'client-123'));
  assert.equal(`${url.origin}${url.pathname}`, 'https://connect.garmin.com/oauth2Confirm');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'client-123');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), client.pkceChallenge(client.pkceVerifier('state-b')));
  assert.equal(url.searchParams.get('redirect_uri'), 'https://portal.dualperformance.au/api/garmin-callback');
  assert.equal(url.searchParams.get('state'), 'state-b');
});

// ── Tokens ───────────────────────────────────────────────────────────────────

test('token expiry keeps Garmin\'s 600 second safety margin', () => {
  const now = Date.parse('2026-11-05T00:00:00Z');
  const fields = client.tokenFields({ access_token: 'a', refresh_token: 'r', expires_in: 86400, refresh_token_expires_in: 7775998, scope: 'PARTNER_READ' }, now);
  assert.equal(fields.access_expires_at, new Date(now + (86400 - 600) * 1000).toISOString());
  assert.equal(fields.refresh_expires_at, new Date(now + 7775998 * 1000).toISOString());
  assert.equal(client.accessTokenFresh(fields, now), true);
  assert.equal(client.accessTokenFresh(fields, now + 86400 * 1000), false);
});

test('a refresh saves the rotated refresh token before it is used', async () => {
  const saved = [];
  const connection = { athlete_code: 'DP1', access_token: 'old', refresh_token: 'r1', access_expires_at: '2000-01-01T00:00:00Z' };
  const token = await getAccessToken(connection, {
    refresh: async (refreshToken) => {
      assert.equal(refreshToken, 'r1');
      return { access_token: 'new', refresh_token: 'r2', expires_in: 86400 };
    },
    saveTokens: async (code, fields) => saved.push({ code, fields }),
  });
  assert.equal(token, 'new');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].fields.refresh_token, 'r2', 'Garmin rotates refresh tokens; the old one is dead after this');
  assert.equal(connection.refresh_token, 'r2');
});

test('a fresh token is used without calling Garmin', async () => {
  const connection = { athlete_code: 'DP1', access_token: 'live', refresh_token: 'r', access_expires_at: new Date(Date.now() + 3600e3).toISOString() };
  const token = await getAccessToken(connection, { refresh: async () => { throw new Error('should not refresh'); } });
  assert.equal(token, 'live');
});

test('only a rejected refresh asks for a reconnect; outages do not', () => {
  assert.equal(client.refreshRequiresReconnect({ status: 400 }), true);
  assert.equal(client.refreshRequiresReconnect({ status: 401 }), true);
  assert.equal(client.refreshRequiresReconnect({ status: 429 }), false);
  assert.equal(client.refreshRequiresReconnect({ status: 503 }), false);
});

// ── Availability ─────────────────────────────────────────────────────────────

test('Garmin stays hidden until the keys exist, then follows the allow list', () => {
  assert.equal(garminAvailableFor('DP1', {}), false, 'no keys, no button');
  const keys = { GARMIN_CLIENT_ID: 'id', GARMIN_CLIENT_SECRET: 'secret' };
  assert.equal(garminAvailableFor('DP1', keys), true, 'keys and no list: everyone');
  assert.equal(garminAvailableFor('dp1', { ...keys, GARMIN_ALLOWED_ATHLETES: 'DP1, DP2' }), true);
  assert.equal(garminAvailableFor('DP3', { ...keys, GARMIN_ALLOWED_ATHLETES: 'DP1, DP2' }), false);
  assert.equal(garminAvailableFor('DP3', { ...keys, GARMIN_ALLOWED_ATHLETES: '*' }), true);
});

// ── Normalisers ──────────────────────────────────────────────────────────────

test('an activity lands on the athlete\'s local day, not the UTC one', () => {
  // 05:30 on 6 Nov in Adelaide (+10:30) is 19:00 on 5 Nov UTC.
  const start = Date.parse('2026-11-05T19:00:00Z') / 1000;
  const row = client.normaliseActivity('dp1', {
    userId: 'u1', summaryId: '21047282990', activityId: 21047282990, activityName: 'Morning Run',
    startTimeInSeconds: start, startTimeOffsetInSeconds: 37800, durationInSeconds: 3600,
    activityType: 'RUNNING', distanceInMeters: 10000, activeKilocalories: 650,
    averageHeartRateInBeatsPerMinute: 155, maxHeartRateInBeatsPerMinute: 182, deviceName: 'Forerunner 965', manual: false,
  });
  assert.equal(row.athlete_code, 'DP1');
  assert.equal(row.local_date, '2026-11-06');
  assert.equal(row.start_time, '2026-11-05T19:00:00.000Z');
  assert.equal(row.distance_m, 10000);
  assert.equal(row.active_kcal, 650);
  assert.equal(row.manual, false);
});

test('missing measurements stay null instead of becoming zero', () => {
  const row = client.normaliseActivity('DP1', { summaryId: 's1', startTimeInSeconds: 1763597760, activityType: 'STRENGTH_TRAINING' });
  assert.equal(row.distance_m, null);
  assert.equal(row.avg_hr, null);
  assert.equal(row.manual, null);
  assert.equal(client.normaliseActivity('DP1', { startTimeInSeconds: 1 }), null, 'no id, no row');
  assert.equal(client.normaliseActivity('DP1', { summaryId: 's2' }), null, 'no start, no row');
});

test('dailies keep energy expenditure and drop Garmin\'s -1 stress placeholder', () => {
  const row = client.normaliseDaily('DP1', { summaryId: 'd1', calendarDate: '2026-11-05', activeKilocalories: 820, bmrKilocalories: 1750, steps: 14000, restingHeartRateInBeatsPerMinute: 48, averageStressLevel: -1 });
  assert.equal(row.calendar_date, '2026-11-05');
  assert.equal(row.active_kcal, 820);
  assert.equal(row.bmr_kcal, 1750);
  assert.equal(row.avg_stress, null);
  assert.equal(client.normaliseDaily('DP1', { summaryId: 'x' }), null);
});

test('sleeps map Garmin\'s stage durations', () => {
  const row = client.normaliseSleep('DP1', { calendarDate: '2026-11-05', durationInSeconds: 28800, deepSleepDurationInSeconds: 7200, lightSleepDurationInSeconds: 18000, remSleepInSeconds: 3600, awakeDurationInSeconds: 0 });
  assert.deepEqual([row.duration_s, row.deep_s, row.light_s, row.rem_s, row.awake_s], [28800, 7200, 18000, 3600, 0]);
});

// ── Notification parsing ─────────────────────────────────────────────────────

test('push, ping, deregistration and permission entries are told apart', () => {
  const parsed = client.parseNotification({
    activities: [{ userId: 'u1', summaryId: 'a1', startTimeInSeconds: 1 }],
    dailies: [{ userId: 'u1', callbackURL: 'https://apis.garmin.com/wellness-api/rest/dailies?token=x' }],
    deregistrations: [{ userId: 'u2' }],
    userPermissionsChange: [{ userId: 'u3', permissions: ['health_export', 'ACTIVITY_EXPORT'] }],
    epochs: [{ userId: 'u1' }],
  });
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].kind, 'activities');
  assert.deepEqual(parsed.pings.map((p) => p.kind), ['dailies']);
  assert.deepEqual(parsed.deregistrations, ['u2']);
  assert.deepEqual(parsed.permissionChanges[0].permissions, ['ACTIVITY_EXPORT', 'HEALTH_EXPORT']);
  assert.deepEqual(parsed.ignored, ['epochs']);
});

test('a ping callback is only ever followed to Garmin\'s API host', () => {
  assert.equal(client.isGarminCallbackUrl('https://apis.garmin.com/wellness-api/rest/dailies?token=x'), true);
  for (const url of [
    'http://apis.garmin.com/x',
    'https://apis.garmin.com.evil.example/x',
    'https://evil.example/?https://apis.garmin.com',
    'https://user:pass@apis.garmin.com/x',
    'not a url',
  ]) {
    assert.equal(client.isGarminCallbackUrl(url), false, url);
  }
});

// ── Notification processing ──────────────────────────────────────────────────

function harness(connections = { u1: { athlete_code: 'DP1', access_token: 't', refresh_token: 'r', access_expires_at: new Date(Date.now() + 3600e3).toISOString() } }) {
  const calls = { stored: [], removed: [], purged: [], updated: [], fetched: [] };
  const deps = {
    findConnection: async (userId) => connections[userId] || null,
    store: async (code, kind, records) => { calls.stored.push({ code, kind, count: records.length }); return { saved: records.length }; },
    removeData: async (code, kinds) => { calls.removed.push({ code, kinds }); },
    purge: async (code) => { calls.purged.push(code); },
    updateConnection: async (code, changes) => { calls.updated.push({ code, changes }); },
    accessToken: async (connection) => connection.access_token,
    fetchPing: async (url, token) => { calls.fetched.push({ url, token }); return [{ userId: 'u1', calendarDate: '2026-11-05' }]; },
  };
  return { calls, deps };
}

test('pushed summaries are stored against the linked athlete, one upsert per kind', async () => {
  const { calls, deps } = harness();
  const counts = await processNotification({
    activities: [
      { userId: 'u1', summaryId: 'a1', startTimeInSeconds: 1 },
      { userId: 'u1', summaryId: 'a2', startTimeInSeconds: 2 },
    ],
    sleeps: [{ userId: 'u1', calendarDate: '2026-11-05' }],
  }, deps);
  assert.deepEqual(calls.stored, [
    { code: 'DP1', kind: 'activities', count: 2 },
    { code: 'DP1', kind: 'sleeps', count: 1 },
  ]);
  assert.equal(counts.saved, 3);
  assert.ok(calls.updated.some((u) => u.changes.last_push_at), 'a delivery stamps last_push_at');
});

test('summaries for a Garmin user nobody connected are dropped, not stored', async () => {
  const { calls, deps } = harness();
  const counts = await processNotification({ activities: [{ userId: 'stranger', summaryId: 'a1', startTimeInSeconds: 1 }] }, deps);
  assert.equal(calls.stored.length, 0);
  assert.equal(counts.unknownUser, 1);
});

test('a ping is fetched with the athlete\'s token and stored like a push', async () => {
  const { calls, deps } = harness();
  await processNotification({ dailies: [{ userId: 'u1', callbackURL: 'https://apis.garmin.com/wellness-api/rest/dailies?token=x' }] }, deps);
  assert.equal(calls.fetched[0].token, 't');
  assert.deepEqual(calls.stored, [{ code: 'DP1', kind: 'dailies', count: 1 }]);
});

test('a deregistration deletes everything held for that athlete, even data in the same delivery', async () => {
  const { calls, deps } = harness();
  const counts = await processNotification({
    activities: [{ userId: 'u1', summaryId: 'a1', startTimeInSeconds: 1 }],
    deregistrations: [{ userId: 'u1' }],
  }, deps);
  assert.deepEqual(calls.purged, ['DP1']);
  assert.equal(counts.deregistered, 1);
  assert.ok(!calls.updated.some((u) => u.changes.last_push_at), 'nothing is stamped on a connection that was just deleted');
});

test('unticking a permission deletes exactly the data it covered', async () => {
  const { calls, deps } = harness();
  await processNotification({ userPermissionsChange: [{ userId: 'u1', permissions: ['ACTIVITY_EXPORT', 'WORKOUT_IMPORT'] }] }, deps);
  assert.deepEqual(calls.removed, [{ code: 'DP1', kinds: ['dailies', 'sleeps'] }]);
  assert.deepEqual(calls.updated.find((u) => u.changes.permissions).changes.permissions, ['ACTIVITY_EXPORT', 'WORKOUT_IMPORT']);
});

test('keeping every permission deletes nothing', async () => {
  const { calls, deps } = harness();
  await processNotification({ userPermissionsChange: [{ userId: 'u1', permissions: ['ACTIVITY_EXPORT', 'HEALTH_EXPORT'] }] }, deps);
  assert.deepEqual(calls.removed, []);
});

test('a storage failure propagates so the webhook answers 500 and Garmin redelivers', async () => {
  const { deps } = harness();
  deps.store = async () => { throw new Error('db down'); };
  await assert.rejects(processNotification({ activities: [{ userId: 'u1', summaryId: 'a1', startTimeInSeconds: 1 }] }, deps), /db down/);
});

// ── Wiring and boundaries ────────────────────────────────────────────────────

test('every Garmin mode has a real URL, and the callback matches the registered redirect', () => {
  const vercel = JSON.parse(read('../vercel.json'));
  const rewrites = Object.fromEntries((vercel.rewrites || []).map((r) => [r.source, r.destination]));
  assert.equal(rewrites['/api/garmin-callback'], '/api/garmin?mode=callback');
  assert.equal(rewrites['/api/garmin-webhook'], '/api/garmin?mode=webhook');
  assert.equal(rewrites['/api/garmin-disconnect'], '/api/garmin?mode=disconnect');
  assert.match(read('../api/garmin.js'), /`\$\{portalUrl\(\)\}\/api\/garmin-callback`/);
});

test('the Garmin tables are service-role only', () => {
  const file = readdirSync(new URL('../supabase/migrations', import.meta.url)).find((name) => name.includes('garmin_connect'));
  assert.ok(file, 'the Garmin migration must exist');
  const sql = read(`../supabase/migrations/${file}`);
  for (const table of ['garmin_connections', 'garmin_activities', 'garmin_dailies', 'garmin_sleeps']) {
    assert.match(sql, new RegExp(`alter table public\\.${table}\\s+enable row level security`));
    assert.match(sql, new RegExp(`revoke all on public\\.${table}\\s+from anon, authenticated`));
  }
  assert.doesNotMatch(sql, /^\s*grant\b[^;]*\bto\s+(anon|authenticated)/im);
  assert.doesNotMatch(sql, /^\s*create policy/im);
});

test('the browser never builds a Garmin authorize URL or reads Garmin tables', () => {
  const boot = read('../public/js/10-boot.js');
  assert.doesNotMatch(boot, /connect\.garmin\.com|oauth2Confirm/, 'use connectUrl from /api/garmin');
  for (const name of readdirSync(new URL('../public/js', import.meta.url))) {
    assert.doesNotMatch(read(`../public/js/${name}`), /garmin_(connections|activities|dailies|sleeps)/, name);
  }
});

test('Garmin data is kept away from the AI weekly review', () => {
  // dualperformance.au/privacy says the AI summary receives no connected-
  // provider data; that is why no separate AI consent exists for Garmin.
  assert.doesNotMatch(read('../api/_lib/performance-summary.js'), /garmin/i);
});

test('disconnect is two taps and deletes on the server', () => {
  const boot = read('../public/js/10-boot.js');
  const block = boot.slice(boot.indexOf('// GARMIN CONNECT'), boot.indexOf('// END GARMIN CONNECT'));
  assert.match(block, /data-confirm/);
  assert.match(block, /fetch\('\/api\/garmin-disconnect'/);
  // A native dialog would be confirm('...'); the comment explaining why it is
  // not used mentions confirm() without an argument.
  assert.doesNotMatch(block, /(?<![\w.])confirm\(\s*['"]/);
});
