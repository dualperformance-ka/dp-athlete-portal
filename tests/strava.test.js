import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { unavailableActivitiesResponse, refreshRequiresReconnect } from '../api/strava.js';

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const boot = read('../public/js/10-boot.js');
const stravaApi = read('../api/strava.js');
const migration = read('../supabase/migrations/20260816120000_strava_activity_cache.sql');
const vercelConfig = JSON.parse(read('../vercel.json'));

test('Strava rate limits do not hide a valid connection', () => {
  assert.deepEqual(unavailableActivitiesResponse({ status: 429 }), {
    connected: true,
    activities: [],
    activitiesAvailable: false,
    warning: 'strava_rate_limited',
  });
});

test('unexpected activity errors are not masked', () => {
  assert.equal(unavailableActivitiesResponse({ status: 500 }), null);
  assert.equal(unavailableActivitiesResponse(new Error('network error')), null);
});

// Strava refusing to hand over activities does not mean the athlete unlinked.
// Telling them to reconnect would be a lie: reconnecting cannot grant an app
// permission it no longer has.
test('a refused activities read keeps the athlete connected', () => {
  for (const status of [401, 403]) {
    assert.deepEqual(unavailableActivitiesResponse({ status }), {
      connected: true,
      activities: [],
      activitiesAvailable: false,
      warning: 'strava_access_denied',
      stravaStatus: status,
    });
  }
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

// A refresh token Strava rejects is dead. Returning 500 leaves the athlete with
// a broken button and no way to re-link; they must be offered a reconnect.
test('a rejected refresh token is treated as "reconnect", not as a server error', () => {
  assert.equal(refreshRequiresReconnect({ status: 400 }), true);
  assert.equal(refreshRequiresReconnect({ status: 401 }), true);
});

// Transient failures must NOT wipe a working connection off the screen.
test('transient Strava failures do not force a reconnect', () => {
  assert.equal(refreshRequiresReconnect({ status: 429 }), false);
  assert.equal(refreshRequiresReconnect({ status: 500 }), false);
  assert.equal(refreshRequiresReconnect({ status: 503 }), false);
  assert.equal(refreshRequiresReconnect(new Error('network error')), false);
});

// ── Compliance boundary ──────────────────────────────────────────────────────
//
// Strava's API Agreement permits a user's data to be displayed back to THAT USER
// only. The whole integration is built around that line, and it is enforced in
// two places at once: the tables grant nothing to a browser role, and the only
// reader is a route that authenticates the athlete. Both must hold — a grant
// added "just for the dashboard" would quietly undo it.

test('the Strava cache tables are unreachable from any browser role', () => {
  assert.match(migration, /revoke all on public\.strava_activities\s+from anon, authenticated/,
    'strava_activities must revoke anon and authenticated');
  assert.match(migration, /revoke all on public\.strava_webhook_events from anon, authenticated/,
    'strava_webhook_events must revoke anon and authenticated');
  assert.match(migration, /alter table public\.strava_activities\s+enable row level security/,
    'RLS must be on, so a missing policy denies rather than allows');

  const grantsToBrowser = migration.match(/grant[^;]*on\s+public\.strava_\w+[^;]*to[^;]*(anon|authenticated)/gi) || [];
  assert.deepEqual(grantsToBrowser, [],
    'no grant on a strava_* table may name anon or authenticated — reads go through /api/strava only');
});

// The callback page used to say "Your coach can now view your activity data".
// That was both a compliance problem and untrue: what the coach sees is the
// athlete's submitted log, not the Strava feed.
test('the OAuth success page does not promise the coach access to Strava data', () => {
  // Scoped to the rendered page, not the whole file: the comment above
  // successPage() quotes the old wording on purpose so the reason it changed
  // survives, and a whole-file match would flag that explanation as the bug.
  const start = stravaApi.indexOf('function successPage()');
  const page = stravaApi.slice(start, stravaApi.indexOf('function errorPage('));
  assert.ok(start >= 0 && page.length > 0, 'successPage() should remain discoverable');

  assert.ok(!/coach can now view your activity/i.test(page),
    'the success page must not tell athletes their coach can see their Strava data');
  assert.match(page, /Sessions you confirm are shared with your coach/,
    'the page should say what the coach actually receives: confirmed sessions');
});

test('the read route never accepts a coach or athlete-code override', () => {
  // Every read is scoped to getRequestAthlete()'s own code. A query parameter
  // that could name a different athlete is the one way this boundary breaks.
  assert.ok(!/req\.query\.(athlete|athleteCode|code)\b/.test(stravaApi),
    'the athlete must come from the authenticated session, never from the query string');
});

// ── Deployment shape ─────────────────────────────────────────────────────────

// Vercel's Hobby plan caps a deployment at 12 serverless functions. Every Strava
// mode shares one file for exactly this reason. Exceeding the cap fails the
// deploy, not the build — so it is discovered in production.
test('the api directory stays under the Vercel Hobby function cap', () => {
  const functions = readdirSync(fileURLToPath(new URL('../api', import.meta.url)))
    .filter((name) => name.endsWith('.js'));
  assert.ok(functions.length <= 12,
    `api/ has ${functions.length} functions; the Hobby cap is 12. Add a ?mode= branch to an existing file instead.`);
});

test('every Strava mode has a rewrite pointing at the one function', () => {
  const rewrites = Object.fromEntries((vercelConfig.rewrites || []).map((r) => [r.source, r.destination]));
  assert.equal(rewrites['/api/strava-callback'], '/api/strava?mode=callback');
  assert.equal(rewrites['/api/strava-webhook'], '/api/strava?mode=webhook');
  assert.equal(rewrites['/api/strava-disconnect'], '/api/strava?mode=disconnect');
});

// ── Front-end states ─────────────────────────────────────────────────────────

// An athlete who linked before profile:read_all was required is fully working —
// their runs sync. Showing them the red "reconnect" state would push them to
// disconnect something that is not broken.
test('the incomplete-scope state is an offer, not a broken-connection warning', () => {
  assert.match(boot, /scopeComplete === false/,
    'the boot script must branch on scopeComplete rather than guessing from an error');
  assert.match(boot, /showScopeUpgrade\(/);
  assert.ok(!/showScopeUpgrade\([^)]*\)\s*\{[^}]*Reconnect Strava/.test(boot),
    'the scope-upgrade state must not reuse the reconnect copy');
});

test('the scope-upgrade link is server-minted like every other Strava URL', () => {
  assert.match(boot, /data\.reconnectUrl/,
    'the re-consent URL must come from the server, which signs the state token');
});

test('disconnecting requires explicit confirmation', () => {
  assert.match(boot, /confirmation_required/,
    'disconnectStrava must refuse to run without a confirmed flag');
});

// Revoking at Strava while keeping the cached activities would leave their data
// here after consent was withdrawn — the exact thing the agreement forbids.
test('disconnect revokes at Strava and purges locally', () => {
  assert.match(stravaApi, /await deauthorize\(/);
  assert.match(stravaApi, /await deleteAllActivities\(athleteCode\)/);
  assert.match(stravaApi, /await deleteTokens\(athleteCode\)/);
});

// If Strava is down or the token is already dead, the athlete still asked to be
// disconnected. Their data must not survive because a third party was slow.
test('a failed deauthorize still purges the local copy', () => {
  const disconnect = stravaApi.slice(stravaApi.indexOf('async function handleDisconnect'));
  const catchBlock = disconnect.slice(disconnect.indexOf('catch (error)'), disconnect.indexOf('await deleteAllActivities'));
  assert.ok(!/return|throw/.test(catchBlock),
    'a deauthorize failure must fall through to the local purge, not return early');
});

// ── Migration safety ─────────────────────────────────────────────────────────

// The read path serves from the cache. Every athlete who linked BEFORE the cache
// existed has valid tokens and no rows, so without a catch-up backfill the day
// this deploys their km rings, volume chart and session matching all go blank at
// once — the integration would look broken to the entire cohort.
test('a connected athlete with an empty cache triggers a catch-up backfill', () => {
  assert.match(stravaApi, /!rows\.length && !tokenRow\.backfilled_at/,
    'the read path must backfill for a connected athlete that has no cached rows');
  assert.match(stravaApi, /rows = await listActivities/,
    'the backfill must re-read so the athlete sees the result on this same load');
});

// Stamping on failure would leave the athlete permanently empty; never stamping
// would re-pull their whole history on every single page load.
test('the backfill stamp is set only after a successful pull', () => {
  const read = stravaApi.slice(stravaApi.indexOf('async function handleRead'), stravaApi.indexOf('// ── Mode: webhook'));
  const stamp = read.indexOf('backfilled_at: new Date()');
  const save = read.indexOf('await saveActivities');
  const failure = read.indexOf('catch (backfillError)');
  assert.ok(save >= 0 && stamp > save, 'the stamp must come after the save');
  assert.ok(stamp < failure, 'the stamp must be inside the success path, not the catch');
});

// A re-consent may widen scope or follow the athlete fixing old activities, so
// it should be allowed to re-pull rather than being blocked by an old stamp.
test('reconnecting clears the backfill stamp', () => {
  assert.match(stravaApi, /backfilled_at: null/,
    'saveTokens on the callback path must reset backfilled_at');
});
