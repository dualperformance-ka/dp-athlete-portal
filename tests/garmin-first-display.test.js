// Garmin first, Strava fills gaps (Karl's call, Nov 2026).
//
// Every session view shows the Garmin recording behind a session: the run
// card, swim and ride reviews, the list attribution and the footer. Since
// Garmin became the primary source the match itself is usually Garmin's;
// where Strava completed a session first, Garmin's copy is shown (and the
// stored match moves to it, see tests/e2e/garmin-primary.spec.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { garminActivity, garminTwinOf, garminPaceLabel, garminDeviceLabel } from '../public/js/connected-activities.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const start = '2026-11-06T20:00:00Z';
const garminRun = garminActivity({ id: 'g1', activityId: 21047282990, type: 'RUNNING', startTime: start, localDate: '2026-11-07', distanceM: 5012, durationS: 1870, avgHr: 151, maxHr: 170, device: 'Garmin fenix 7' });
const stravaRun = { id: 111, type: 'Run', sport_type: 'Run', start_date: start, distance: 5010, moving_time: 1860, elapsed_time: 1880 };

test('a Strava recording finds its single Garmin twin', () => {
  assert.equal(garminTwinOf(stravaRun, [garminRun]), garminRun);
  assert.equal(garminRun.garminActivityId, 21047282990, 'the Garmin Connect link needs the activity id');
  assert.equal(garminRun.max_heartrate, 170);
});

test('no twin when Garmin never got the recording, or the sport differs', () => {
  assert.equal(garminTwinOf(stravaRun, []), null, 'Strava fills the gap');
  assert.equal(garminTwinOf({ ...stravaRun, sport_type: 'Ride', type: 'Ride' }, [garminRun]), null);
  assert.equal(garminTwinOf({ ...stravaRun, start_date: '2026-11-07T02:00:00Z' }, [garminRun]), null);
});

test('a combined match of several Strava runs, or two candidate twins, stays Strava', () => {
  assert.equal(garminTwinOf({ ...stravaRun, source_activity_count: 2 }, [garminRun]), null);
  const second = { ...garminRun, id: 'garmin:g2' };
  assert.equal(garminTwinOf(stravaRun, [garminRun, second]), null, 'ambiguity is never resolved by guessing');
});

test('a Garmin activity is never its own twin', () => {
  assert.equal(garminTwinOf(garminRun, [garminRun]), null);
});

test('pace and device labels', () => {
  assert.equal(garminPaceLabel(garminRun), '6:13');
  assert.equal(garminPaceLabel({ distance: 0, moving_time: 100 }), '');
  assert.equal(garminDeviceLabel(garminRun), 'Garmin fenix 7');
  assert.equal(garminDeviceLabel({ device: 'unknown' }), 'Garmin', 'Garmin reports "unknown" for some uploads');
  assert.equal(garminDeviceLabel({}), 'Garmin');
});

test('the run card is run-only, and only a twin offers "Not this run"', () => {
  const source = read('../public/js/connected-activities.js');
  const block = source.slice(source.indexOf('window.garminSessionResultHtml'), source.indexOf('window.garminSessionResultHtml') + 2500);
  assert.match(block, /getType\(session\) !== 'run'\) return ''/);
  assert.match(block, /const reject = twin &&/);
  assert.match(block, /connect\.garmin\.com\/modern\/activity\//);
});

test('every session view passes its index so "Not this run" can reach the stored match', () => {
  assert.match(read('../public/js/08-training-run.js'), /garminSessionResultHtml\(s,i\)/);
  assert.match(read('../public/js/09-logging.js'), /garminSessionResultHtml\(session,i\)/);
});

// Rewritten when Garmin became the primary source: this used to assert that
// the stored match was always the Strava activity. It now asserts the match
// records which service it came from, and that the feed module itself still
// never writes anything (matching and logging live in 09-logging.js).
test('a stored match records its provider; the feed module writes nothing', () => {
  const logging = read('../public/js/09-logging.js');
  assert.match(logging, /__stravaMatch:\{activityKey:stravaMatchActivityKey\(activity\),activityKeys:stravaMatchActivityKeys\(match\),clientWriteId:stravaClientWriteId\(activity\),provider:matchProvider\(activity\)/);
  const display = read('../public/js/connected-activities.js');
  assert.doesNotMatch(display, /coachWrite\(|portalStateWrite\(|localStorage\.|fetch\(/);
});

test('Garmin and Strava matches get distinct, stable client write ids', () => {
  const logging = read('../public/js/09-logging.js');
  const start = logging.indexOf('function matchProvider(');
  const end = logging.indexOf('function stravaDistanceKm(');
  const context = { window: {}, String, stravaMatchActivityKey: (a) => String(a.id) };
  const fn = new Function('ctx', 'with(ctx){' + logging.slice(start, end) + '; return {matchProvider, stravaClientWriteId};}');
  const { matchProvider, stravaClientWriteId } = fn(context);
  assert.equal(matchProvider({ provider: 'Garmin' }), 'Garmin');
  assert.equal(matchProvider({ id: 1 }), 'Strava', 'an untagged recording is Strava, as every stored match before Garmin was');
  assert.equal(stravaClientWriteId({ id: 'garmin:21047282990', provider: 'Garmin' }), 'garmin_21047282990');
  assert.equal(stravaClientWriteId({ id: 111 }), 'strava_111');
});

test('the stored-activity keep list carries the provider, in the page and the worker', () => {
  for (const file of ['../public/js/01-core.js', '../public/sw.js']) {
    const source = read(file);
    for (const field of ['provider', 'garminActivityId', 'device']) {
      assert.match(source, new RegExp(`STRAVA_MATCH_ACTIVITY_FIELDS\\s*=\\s*\\[[^\\]]*'${field}'`), `${file} keeps ${field}`);
    }
  }
});

test('swims and rides review from Garmin, laps labelled as Strava', () => {
  const run = read('../public/js/08-training-run.js');
  assert.match(run, /function enduranceStravaReviewHtml\(type,activity,garmin\)/);
  assert.match(run, /recorded'\+\(g\?' · from Strava':''\)/);
  const training = read('../public/js/08-training.js');
  assert.match(training, /enduranceStravaReviewHtml\(type,stravaActivity,garminTwin\)/);
});

test('swim distance is shown in whole metres, not rounded through tenths of a km', () => {
  const training = read('../public/js/08-training.js');
  assert.match(training, /type==='swim'\?Math\.round\(Number\(activity\.distance\)\|\|0\)\+' m'/);
  assert.match(read('../public/js/09-logging.js'), /swim\?Math\.round\(Number\(shown\.distance\)\|\|0\)\+' m'/);
});

test('"Not this run" removes a Garmin-completed log on the server too', async () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://db.test';
  process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'service-key-for-tests-only';
  process.env.PORTAL_SESSION_SECRET = process.env.PORTAL_SESSION_SECRET || 'test-secret-that-is-at-least-32-characters-long';
  const { rejectStravaMatch } = await import('../api/write.js');
  const original = globalThis.fetch;
  const deletes = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if ((init.method || 'GET') === 'DELETE') deletes.push(url.pathname + ' ' + (url.searchParams.get('client_write_id') || url.searchParams.get('session_key')));
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await rejectStravaMatch('KARL', { sessionKey: 'session_KARL_run-1', clientWriteId: 'garmin_g1' });
    assert.deepEqual(deletes.sort(), ['/rest/v1/session_logs eq.session_KARL_run-1', '/rest/v1/training_session_logs eq.garmin_g1']);
    await assert.rejects(rejectStravaMatch('KARL', { sessionKey: 'session_KARL_run-1', clientWriteId: 'manual_123' }), /valid activity match/,
      'a hand-logged session is never removed by an activity unmatch');
  } finally { globalThis.fetch = original; }
});
