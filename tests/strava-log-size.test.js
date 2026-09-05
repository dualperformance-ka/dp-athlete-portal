import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const core = readFileSync(join(root, 'public', 'js', '01-core.js'), 'utf8');
const logging = readFileSync(join(root, 'public', 'js', '09-logging.js'), 'utf8');
const loginGoals = readFileSync(join(root, 'public', 'js', '02-login-goals.js'), 'utf8');
const writeApi = readFileSync(join(root, 'api', 'write.js'), 'utf8');

// The trimming helpers are global-free by design, so lift them out of the
// browser bundle by source markers the same way the other portal tests do.
function trimHelpers() {
  const start = core.indexOf('var STRAVA_MATCH_ACTIVITY_FIELDS');
  const end = core.indexOf('function portalStateWrite(');
  assert.ok(start >= 0 && end > start, 'the Strava trimming helpers should remain discoverable');
  const context = {};
  vm.createContext(context);
  vm.runInContext(core.slice(start, end), context);
  return context;
}

const { STRAVA_MATCH_ACTIVITY_FIELDS, slimStravaActivity, pruneStravaMatchPayloads } = trimHelpers();

// The server-side ceiling this whole change exists to stay under. Read it out
// of api/write.js rather than hardcoding it, so raising the cap there without
// revisiting these expectations cannot pass silently.
const stateValueLimit = Number(
  (writeApi.match(/encoded\.length\s*>\s*([\d_]+)/) || [])[1]?.replace(/_/g, ''),
);

// A matched run as Strava's detailed-activity endpoint actually returns it:
// the promoted scalars the portal reads, plus the bulk that made the blob burst.
function fatActivity(id) {
  return {
    id,
    name: 'Morning Run',
    type: 'Run',
    sport_type: 'Run',
    distance: 9012.4,
    moving_time: 2731,
    elapsed_time: 2894,
    start_date: '2026-09-01T21:14:03Z',
    start_date_local: '2026-09-02T06:44:03Z',
    suffer_score: 61,
    segment_efforts: Array.from({ length: 40 }, (_, i) => ({
      id: i, name: `Segment ${i}`, elapsed_time: 90 + i, segment: { id: i, polyline: 'x'.repeat(400) },
    })),
    laps: Array.from({ length: 12 }, (_, i) => ({ id: i, split: i, elapsed_time: 300, notes: 'y'.repeat(200) })),
    best_efforts: Array.from({ length: 8 }, (_, i) => ({ id: i, name: `${i}k`, elapsed_time: 200 + i })),
    splits_metric: Array.from({ length: 9 }, (_, i) => ({ split: i, elapsed_time: 300 })),
    splits_standard: Array.from({ length: 6 }, (_, i) => ({ split: i, elapsed_time: 480 })),
    map: { id: `a${id}`, polyline: 'z'.repeat(3000), summary_polyline: 'z'.repeat(600) },
    similar_activities: { effort_count: 12, trend: { speeds: Array.from({ length: 30 }, () => 3.3) } },
    photos: { primary: { urls: { 600: 'https://example.invalid/p.jpg' } }, count: 1 },
    gear: { id: 'g1', name: 'Shoe', distance: 400000 },
    athlete: { id: 99, resource_state: 1 },
    description: 'felt good',
  };
}

function logsBlob(matchedRuns) {
  const logs = { __savedAt: Date.now() };
  for (let i = 0; i < matchedRuns; i += 1) {
    logs[`session-${i}`] = {
      distance: '9', duration: '45.5', pace: '5:03', pain: 'no',
      __submittedAt: '2026-09-02T07:02:00.000Z',
      __stravaMatch: {
        activityKey: String(1000 + i),
        clientWriteId: `strava_${1000 + i}`,
        activity: fatActivity(1000 + i),
        confidence: 'high',
        reasons: [],
        matchedAt: '2026-09-02T07:02:00.000Z',
      },
    };
  }
  return logs;
}

test('the cap the trimming defends is the one api/write.js actually enforces', () => {
  assert.ok(Number.isFinite(stateValueLimit), 'api/write.js should cap the encoded state value length');
  assert.equal(stateValueLimit, 750_000);
  assert.match(writeApi, /error\.status\s*=\s*413/, 'an oversized state value should be refused with 413');
});

test('slimming keeps every field the portal reads and drops the bulk', () => {
  const slim = slimStravaActivity(fatActivity(1));
  for (const field of ['id', 'name', 'type', 'sport_type', 'distance', 'moving_time', 'elapsed_time', 'start_date', 'start_date_local', 'suffer_score']) {
    assert.equal(slim[field], fatActivity(1)[field], `${field} must survive trimming`);
  }
  for (const field of ['segment_efforts', 'laps', 'best_efforts', 'splits_metric', 'splits_standard', 'map', 'similar_activities', 'photos', 'gear', 'athlete', 'description']) {
    assert.ok(!(field in slim), `${field} must not be stored in the log entry`);
  }
  assert.ok(JSON.stringify(slim).length < 400, 'a trimmed activity should be a few hundred bytes, not tens of kilobytes');
});

// The regression that actually bites: someone starts reading a field off a
// stored match that trimming throws away, and it is silently undefined in
// production for every athlete whose logs have already been pruned.
test('every activity field the portal reads is one that trimming keeps', () => {
  const sources = ['01-core.js', '02-login-goals.js', '08-training.js', '09-logging.js', 'strava-match.js']
    .map(name => readFileSync(join(root, 'public', 'js', name), 'utf8'))
    .join('\n');
  const read = new Set([...sources.matchAll(/\bactivity\.([a-zA-Z_][a-zA-Z0-9_]*)/g)].map(m => m[1]));
  const allowed = new Set(STRAVA_MATCH_ACTIVITY_FIELDS);
  const missing = [...read].filter(field => !allowed.has(field));
  assert.deepEqual(missing, [], `these activity fields are read but not preserved by slimStravaActivity: ${missing.join(', ')}`);
});

test('pruning an oversized blob brings it under the server cap', () => {
  const logs = logsBlob(37);
  assert.ok(JSON.stringify(logs).length > stateValueLimit, 'the fixture should reproduce the oversized blob');
  assert.equal(pruneStravaMatchPayloads(logs), true, 'pruning should report that it changed the blob');
  assert.ok(JSON.stringify(logs).length < stateValueLimit / 4, 'a pruned blob should be comfortably under the cap');
  assert.equal(logs['session-0'].__stravaMatch.activityKey, '1000', 'match metadata must survive');
  assert.equal(logs['session-0'].distance, '9', 'the athlete-entered log must survive');
});

test('pruning is idempotent, so an already-clean blob is not rewritten on every load', () => {
  const logs = logsBlob(3);
  pruneStravaMatchPayloads(logs);
  assert.equal(pruneStravaMatchPayloads(logs), false, 'a second pass should report no change');
});

test('pruning tolerates the shapes a real logs blob contains', () => {
  const logs = {
    __savedAt: 1, 'run-1': { distance: '5' }, 'gym-1': { Squat: [{ w: 100, r: 5 }] },
    'run-2': { __stravaMatch: { activityKey: '7' } }, 'run-3': null, 'run-4': 'unexpected',
  };
  assert.equal(pruneStravaMatchPayloads(logs), false);
  assert.equal(pruneStravaMatchPayloads(null), false);
  assert.equal(pruneStravaMatchPayloads(undefined), false);
});

test('a new match is stored trimmed rather than in full', () => {
  assert.match(logging, /activity:slimStravaActivity\(activity\)/,
    'completeStravaMatch must store the trimmed activity');
  assert.ok(!/__stravaMatch:\{[^}]*activity:activity[,}]/.test(logging),
    'no code path may persist the raw Strava activity into a log entry');
});

test('every route out of the device trims a logs value first', () => {
  assert.match(core, /function portalStateWrite\(key,value,options\)\{\s*(?:\/\/[^\n]*\n\s*)*if\(key==='logs'\)pruneStravaMatchPayloads\(value\);/,
    'portalStateWrite must trim a logs value before sending it');
  const retry = core.slice(core.indexOf('async function retryPendingPortalStateWrites'));
  assert.match(retry.slice(0, retry.indexOf('\n}')), /pruneStravaMatchPayloads\(item\.value\)/,
    'the outbox must trim a queued logs value, or a payload queued by an older build retries forever');
});

test('an existing device repairs its stored logs on the next sign-in', () => {
  assert.match(loginGoals, /pruneStravaMatchPayloads\(logs\)/,
    'hydrateLocalPortalState must prune the local copy');
  assert.match(loginGoals, /localStorage\.setItem\('dp_logs_'\+code,JSON\.stringify\(logs\)\)/,
    'the pruned local copy must be written back');
  const cloud = core.slice(core.indexOf("if(row.key==='logs'){"));
  assert.match(cloud.slice(0, 900), /pruneStravaMatchPayloads\(_cloudLogs\)/,
    'a cloud row written by an older build must be pruned before it re-inflates the device');
});

// The service worker drains the same outbox as the page, on activate and on
// background sync, and it cannot import from 01-core.js. A fix applied only to
// the page leaves the worker posting the untrimmed blob behind it, so the queue
// entry never clears and the pending banner never goes away.
test('the service worker trims a queued logs value before posting it', () => {
  const worker = readFileSync(join(root, 'public', 'sw.js'), 'utf8');
  const flush = worker.slice(worker.indexOf('async function flushOfflineQueue'));
  assert.match(flush, /if \(item\.key === 'logs'\) pruneStravaMatchPayloads\(item\.value\);\s*\n\s*if \(!await writePortalState/,
    'the worker must prune a logs value immediately before writing it');
});

test('the worker and the page agree on which activity fields survive', () => {
  const worker = readFileSync(join(root, 'public', 'sw.js'), 'utf8');
  const workerFields = worker.match(/const STRAVA_MATCH_ACTIVITY_FIELDS = (\[[^\]]*\])/);
  assert.ok(workerFields, 'sw.js should declare its own copy of the keep list');
  // Joined rather than deepEqual: the page's list is lifted out of a vm
  // context, so its Array comes from another realm and fails a strict
  // prototype comparison even when the contents are identical.
  assert.equal(
    JSON.parse(workerFields[1].replace(/'/g, '"')).join(','),
    [...STRAVA_MATCH_ACTIVITY_FIELDS].join(','),
    'sw.js and 01-core.js must keep the same activity fields, or the two drain paths disagree',
  );
});
