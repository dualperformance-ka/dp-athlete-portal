import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PER_PAGE,
  REQUIRED_SCOPES,
  activitySufferScore,
  buildAuthorizeUrl,
  fetchAllActivities,
  hasRequiredScopes,
  isRunActivity,
  missingScopes,
  normaliseActivity,
  parseScopes,
  refreshRequiresReconnect,
  rowToActivity,
} from '../api/_lib/strava-client.js';

// ── Scope handling ───────────────────────────────────────────────────────────

// Strava has used both separators across API versions. Betting on one is how a
// correctly-scoped athlete gets told to reconnect forever.
test('granted scopes parse from either separator Strava has used', () => {
  assert.deepEqual(parseScopes('activity:read_all profile:read_all'), ['activity:read_all', 'profile:read_all']);
  assert.deepEqual(parseScopes('activity:read_all,profile:read_all'), ['activity:read_all', 'profile:read_all']);
  assert.deepEqual(parseScopes('  activity:read_all ,  profile:read_all '), ['activity:read_all', 'profile:read_all']);
  assert.deepEqual(parseScopes(''), []);
  assert.deepEqual(parseScopes(null), []);
});

test('a scope set is complete only when every required scope is present', () => {
  assert.equal(hasRequiredScopes('activity:read_all profile:read_all'), true);
  assert.equal(hasRequiredScopes('activity:read_all'), false);
  assert.equal(hasRequiredScopes(''), false);
  assert.equal(hasRequiredScopes(null), false);
  // Extra scopes are not a problem.
  assert.equal(hasRequiredScopes('read activity:read_all profile:read_all activity:write'), true);
});

test('missingScopes names exactly what still needs consent', () => {
  assert.deepEqual(missingScopes('activity:read_all'), ['profile:read_all']);
  assert.deepEqual(missingScopes('activity:read_all profile:read_all'), []);
  assert.deepEqual(missingScopes(''), REQUIRED_SCOPES);
});

// Without approval_prompt=force, Strava silently returns the OLD scope set to an
// already-connected athlete: consent never re-prompts, the granted scope never
// widens, and every zones call keeps 403-ing with no visible cause.
test('the authorize URL forces re-consent and requests every required scope', () => {
  process.env.STRAVA_CLIENT_ID = '12345';
  process.env.STRAVA_CLIENT_SECRET = 'secret';
  const url = buildAuthorizeUrl('https://portal.test/api/strava-callback', 'signed-state');

  assert.match(url, /approval_prompt=force/);
  assert.match(url, /scope=activity%3Aread_all%2Cprofile%3Aread_all/);
  assert.match(url, /state=signed-state/);
  assert.match(url, /redirect_uri=https%3A%2F%2Fportal\.test%2Fapi%2Fstrava-callback/);
  assert.match(url, /client_id=12345/);
  // The secret must never travel in a URL the athlete's browser follows.
  assert.ok(!url.includes('secret'), 'client_secret must never appear in the authorize URL');
});

// ── Effort ───────────────────────────────────────────────────────────────────

test('suffer_score is the REST field, with relative_effort only as a fallback', () => {
  assert.equal(activitySufferScore({ suffer_score: 84 }), 84);
  assert.equal(activitySufferScore({ relative_effort: 84 }), 84);
  assert.equal(activitySufferScore({ suffer_score: 12, relative_effort: 99 }), 12);
});

// Null means "this athlete ran without a heart-rate strap", not "easy run".
// Collapsing the two would mislabel every quality session they do.
test('an absent or zero effort reads as unknown, never as zero effort', () => {
  assert.equal(activitySufferScore({ suffer_score: null }), null);
  assert.equal(activitySufferScore({ suffer_score: 0 }), null);
  assert.equal(activitySufferScore({}), null);
  assert.equal(activitySufferScore(null), null);
});

test('run detection covers the sport_type variants Strava emits', () => {
  assert.equal(isRunActivity({ sport_type: 'Run' }), true);
  assert.equal(isRunActivity({ sport_type: 'TrailRun' }), true);
  assert.equal(isRunActivity({ sport_type: 'VirtualRun' }), true);
  assert.equal(isRunActivity({ type: 'Run' }), true);
  assert.equal(isRunActivity({ sport_type: 'Ride' }), false);
  assert.equal(isRunActivity({ sport_type: 'WeightTraining' }), false);
  assert.equal(isRunActivity({}), false);
});

// ── Normalisation ────────────────────────────────────────────────────────────

const summary = {
  id: 19758888707,
  name: 'SOLO LONGY',
  sport_type: 'Run',
  type: 'Run',
  start_date_local: '2026-08-16T05:51:48Z',
  start_date: '2026-08-15T20:21:48Z',
  distance: 30004.7,
  moving_time: 9099,
  elapsed_time: 9717,
  suffer_score: 180,
  gear_id: 'g16179325',
};

test('a summary activity becomes a complete cache row', () => {
  const row = normaliseActivity('dp-001', summary);
  assert.equal(row.athlete_code, 'DP-001', 'athlete codes are stored upper-cased');
  assert.equal(row.strava_activity_id, 19758888707);
  assert.equal(row.distance_m, 30004.7);
  assert.equal(row.moving_time_s, 9099);
  assert.equal(row.suffer_score, 180);
  assert.equal(row.gear_id, 'g16179325');
  assert.deepEqual(row.summary, summary, 'the whole payload is retained so new fields need no migration');
});

// One malformed activity must not be able to poison the cache with a row that
// nothing can ever match against, nor fail an entire backfill batch.
test('an activity without a usable id or start date is rejected', () => {
  assert.equal(normaliseActivity('DP-001', { ...summary, id: undefined }), null);
  assert.equal(normaliseActivity('DP-001', { ...summary, id: 0 }), null);
  assert.equal(normaliseActivity('DP-001', { ...summary, id: 'not-a-number' }), null);
  assert.equal(normaliseActivity('DP-001', { ...summary, start_date_local: '', start_date: '' }), null);
  assert.equal(normaliseActivity('DP-001', null), null);
});

test('start_date is used when start_date_local is absent', () => {
  const row = normaliseActivity('DP-001', { ...summary, start_date_local: undefined });
  assert.equal(row.start_date_local, '2026-08-15T20:21:48Z');
});

test('unusable numeric fields become null rather than NaN', () => {
  const row = normaliseActivity('DP-001', { ...summary, distance: 'x', moving_time: undefined });
  assert.equal(row.distance_m, null);
  assert.equal(row.moving_time_s, null);
});

// The read path flips from live-fetch to cache without touching 09-logging.js,
// 05-handbook.js or 06-nutrition.js — which only holds if a row round-trips back
// into exactly the shape those files already read.
test('a cache row round-trips into the activity shape the front-end reads', () => {
  const row = { ...normaliseActivity('DP-001', summary), synced_at: '2026-08-16T09:00:00Z' };
  const activity = rowToActivity(row);

  assert.equal(activity.id, summary.id);
  assert.equal(activity.name, summary.name);
  assert.equal(activity.distance, summary.distance);
  assert.equal(activity.moving_time, summary.moving_time);
  assert.equal(activity.elapsed_time, summary.elapsed_time);
  assert.equal(activity.sport_type, 'Run');
  assert.equal(activity.type, 'Run');
  assert.equal(activity.start_date_local, summary.start_date_local);
  // Exposed under both names so the matcher works whichever it reads.
  assert.equal(activity.suffer_score, 180);
  assert.equal(activity.relative_effort, 180);
});

test('a null suffer_score survives the round trip as null, not 0', () => {
  const row = normaliseActivity('DP-001', { ...summary, suffer_score: null });
  const activity = rowToActivity(row);
  assert.equal(activity.suffer_score, null);
  assert.equal(activity.relative_effort, null);
});

// ── Paging ───────────────────────────────────────────────────────────────────

function stubFetch(pages) {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    const page = Number(new URL(String(url)).searchParams.get('page'));
    const body = JSON.stringify(pages[page - 1] || []);
    return { ok: true, status: 200, headers: new Headers(), text: async () => body };
  };
  return calls;
}

test('paging stops as soon as a short page arrives', async () => {
  const full = Array.from({ length: MAX_PER_PAGE }, (_, i) => ({ ...summary, id: i + 1 }));
  const calls = stubFetch([full, [summary]]);

  const result = await fetchAllActivities('token', { after: 1750000000 });

  assert.equal(result.activities.length, MAX_PER_PAGE + 1);
  assert.equal(result.pages, 2);
  assert.equal(result.truncated, false);
  assert.equal(calls.length, 2, 'a short page means there is nothing after it — do not ask again');
  assert.match(calls[0], /after=1750000000/);
  assert.match(calls[0], /per_page=200/);
});

// The app's daily request budget is shared across every athlete. Without a hard
// page ceiling one athlete with a decade of history — or one bad `after` — would
// walk their whole account and take the entire cohort's sync down with them.
test('paging stops at the ceiling and says so instead of walking forever', async () => {
  const full = Array.from({ length: MAX_PER_PAGE }, (_, i) => ({ ...summary, id: i + 1 }));
  const calls = stubFetch([full, full, full, full, full, full]);

  const result = await fetchAllActivities('token', { maxPages: 3 });

  assert.equal(result.pages, 3);
  assert.equal(result.truncated, true, 'the caller must be able to tell history was cut short');
  assert.equal(calls.length, 3);
});

test('a missing after parameter is simply omitted rather than sent as garbage', async () => {
  const calls = stubFetch([[summary]]);
  await fetchAllActivities('token', {});
  assert.ok(!calls[0].includes('after='), 'after must be absent, not after=NaN or after=undefined');
});

// ── Failure classification ───────────────────────────────────────────────────

test('a rejected refresh token is a reconnect, and a transient failure is not', () => {
  assert.equal(refreshRequiresReconnect({ status: 400 }), true);
  assert.equal(refreshRequiresReconnect({ status: 401 }), true);
  assert.equal(refreshRequiresReconnect({ status: 429 }), false);
  assert.equal(refreshRequiresReconnect({ status: 500 }), false);
  assert.equal(refreshRequiresReconnect({ status: 503 }), false);
  assert.equal(refreshRequiresReconnect(new Error('network error')), false);
});

// A null column must not become 0. A null distance surfacing as a 0 km run
// would let the matcher claim a session that was never done.
test('null cache columns stay null instead of becoming zero', () => {
  const activity = rowToActivity({
    strava_activity_id: 5,
    start_date_local: '2026-08-16T06:00:00Z',
    sport_type: 'Run',
    name: 'Run',
    distance_m: null,
    moving_time_s: null,
    elapsed_time_s: null,
    suffer_score: null,
    summary: {},
  });

  assert.equal(activity.distance, null);
  assert.equal(activity.moving_time, null);
  assert.equal(activity.elapsed_time, null);
  assert.equal(activity.suffer_score, null);
});
