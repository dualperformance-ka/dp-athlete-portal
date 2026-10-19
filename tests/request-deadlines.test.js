import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { select, supabaseRequest, addRequestObserver } from '../api/_lib/supabase-rest.js';
import { getRequestAthlete, getUserFromToken } from '../api/_lib/auth.js';
import { createPortalSession } from '../api/_lib/legacy-session.js';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const core = readFileSync(join(root, 'public', 'js', '01-core.js'), 'utf8');
const login = readFileSync(join(root, 'public', 'js', '02-login-goals.js'), 'utf8');
const training = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');

// A fetch that never answers on its own, only rejects when its signal aborts,
// exactly like a request stuck behind a saturated database.
function hangingFetch(seen) {
  return (url, init = {}) => new Promise((resolve, reject) => {
    seen.signal = init.signal;
    if (!init.signal) return;
    init.signal.addEventListener('abort', () => {
      seen.aborted = true;
      const error = new Error('aborted'); error.name = 'AbortError';
      reject(error);
    });
  });
}

async function withEnv(fetchImpl, run) {
  const saved = { fetch: globalThis.fetch, url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_KEY, secret: process.env.PORTAL_SESSION_SECRET };
  globalThis.fetch = fetchImpl;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'service-key';
  process.env.PORTAL_SESSION_SECRET = process.env.PORTAL_SESSION_SECRET || 'x'.repeat(40);
  try { return await run(); } finally {
    globalThis.fetch = saved.fetch;
    process.env.SUPABASE_URL = saved.url;
    process.env.SUPABASE_SERVICE_KEY = saved.key;
    if (saved.secret === undefined) delete process.env.PORTAL_SESSION_SECRET; else process.env.PORTAL_SESSION_SECRET = saved.secret;
  }
}

// ── Server ──────────────────────────────────────────────────────────────────

test('a stalled Supabase read is aborted at its deadline and reported as a 504 timeout', async () => {
  const seen = {};
  const records = [];
  const stop = addRequestObserver((record) => records.push(record));
  const started = Date.now();
  await withEnv(hangingFetch(seen), async () => {
    await assert.rejects(select('planned_sessions', { athlete_code: 'eq.KARL' }, { timeoutMs: 60 }), (error) => {
      assert.equal(error.kind, 'timeout');
      assert.equal(error.status, 504);
      assert.equal(error.code, 'upstream_timeout');
      assert.doesNotMatch(error.message, /KARL|service-key/, 'no query or key in the message');
      return true;
    });
  });
  stop();
  assert.ok(seen.aborted, 'the underlying fetch was aborted, not merely ignored');
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(records.map((r) => [r.resource, r.outcome]), [['planned_sessions', 'timeout']]);
});

test('Supabase failures are classified: 5xx transient, 4xx not, missing RPC recognisable', async () => {
  const reply = (status, body) => async () => ({ ok: status < 400, status, text: async () => JSON.stringify(body), headers: new Map() });
  await withEnv(reply(503, { message: 'overloaded' }), async () => {
    await assert.rejects(select('athletes', {}), (e) => e.kind === 'upstream' && e.status === 503);
  });
  await withEnv(reply(400, { message: 'bad filter', code: 'PGRST100' }), async () => {
    await assert.rejects(select('athletes', {}), (e) => e.kind === 'http' && e.status === undefined && e.message === 'bad filter');
  });
  await withEnv(reply(404, { message: 'Could not find the function', code: 'PGRST202' }), async () => {
    await assert.rejects(supabaseRequest('rpc/acquire_job_lease', { method: 'POST', body: {} }), (e) => e.kind === 'missing_function');
  });
});

test('Supabase Auth being slow is "unavailable", never "invalid token"', async () => {
  const seen = {};
  await withEnv(async (url, init) => {
    if (String(url).includes('/auth/v1/user')) return { ok: false, status: 503, json: async () => ({}) };
    throw new Error('unexpected');
  }, async () => {
    await assert.rejects(getUserFromToken('jwt'), (e) => e.code === 'auth_unavailable' && e.status === 503);
  });
  await withEnv(async () => ({ ok: false, status: 401, json: async () => ({}) }), async () => {
    assert.equal(await getUserFromToken('jwt'), null, 'a rejected token is still just invalid');
  });
  // A stalled Auth call is aborted by its own deadline (8s); simulate the abort.
  await withEnv((url, init) => new Promise((resolve, reject) => {
    seen.signal = init.signal;
    setTimeout(() => { init.signal.dispatchEvent(new Event('abort')); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, 5);
  }), async () => {
    await assert.rejects(getUserFromToken('jwt'), (e) => e.code === 'auth_unavailable');
  });
  assert.ok(seen.signal, 'the Auth request carries an abort signal');
});

test('a database outage during the session check is a 503, not a 401 that signs the athlete out', async () => {
  await withEnv(async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ message: 'timeout' }) }), async () => {
    const token = createPortalSession('KARL');
    await assert.rejects(getRequestAthlete({ headers: { authorization: `Bearer ${token}` } }), (e) => e.code === 'auth_unavailable' && e.status === 503);
  });
  // With the services up, a credential Supabase rejects is still just null (401).
  await withEnv(async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => '' }), async () => {
    assert.equal(await getRequestAthlete({ headers: { authorization: 'Bearer not-a-session' } }), null);
  });
});

// ── Browser ─────────────────────────────────────────────────────────────────

function browserRuntime(fetchImpl, extra = {}) {
  const block = core.slice(core.indexOf('// ── REQUEST DEADLINES'), core.indexOf('// Access-code sessions are deliberately'));
  const context = {
    fetch: fetchImpl, AbortController, setTimeout, clearTimeout, Math, Date, JSON, Promise, Error, Object,
    navigator: { onLine: true }, performance: { now: () => Date.now() },
    window: {}, console, ...extra,
  };
  vm.createContext(context);
  vm.runInContext(block, context);
  return context;
}

test('portal requests abort at their deadline and say why', async () => {
  const seen = {};
  const runtime = browserRuntime(hangingFetch(seen));
  const started = Date.now();
  await assert.rejects(runtime.portalFetchJson('/api/portal-data', { method: 'POST' }, { timeoutMs: 50 }), (e) => e.kind === 'timeout');
  assert.ok(seen.aborted, 'the fetch itself was aborted');
  assert.ok(Date.now() - started < 1000);
  assert.equal(runtime.PORTAL_TIMEOUT_CRITICAL_MS, 9000, 'critical reads get ~9s');
  assert.ok(runtime.PORTAL_TIMEOUT_SECONDARY_MS < runtime.PORTAL_TIMEOUT_CRITICAL_MS, 'secondary work gets less');
  // Offline is distinguished from a slow server.
  const offline = browserRuntime(async () => { throw new TypeError('Failed to fetch'); });
  offline.navigator.onLine = false;
  await assert.rejects(offline.portalFetchJson('/api/x', {}, { timeoutMs: 50 }), (e) => e.kind === 'offline');
});

test('failure classes: auth, unsupported, timeout, server, client', () => {
  const runtime = browserRuntime(async () => ({}));
  assert.equal(runtime.classifyPortalStatus(401, {}), 'auth');
  assert.equal(runtime.classifyPortalStatus(404, {}), 'unsupported');
  assert.equal(runtime.classifyPortalStatus(501, {}), 'unsupported');
  assert.equal(runtime.classifyPortalStatus(400, { error: 'Unknown portal action' }), 'unsupported');
  assert.equal(runtime.classifyPortalStatus(400, { error: 'A valid date range is required' }), 'client');
  assert.equal(runtime.classifyPortalStatus(504, {}), 'timeout');
  assert.equal(runtime.classifyPortalStatus(503, { error: 'auth_unavailable' }), 'server');
  assert.equal(runtime.classifyPortalStatus(429, {}), 'server');
  assert.equal(runtime.portalFailureIsTransient({ kind: 'server' }), true);
  assert.equal(runtime.portalFailureIsTransient({ kind: 'auth' }), false);
  assert.equal(runtime.portalFailureIsTransient({ kind: 'unsupported' }), false);
});

test('backoff is bounded, exponential and jittered, and a success closes it', () => {
  const runtime = browserRuntime(async () => ({}), { setSaveState() {} });
  for (let attempt = 0; attempt < 12; attempt++) {
    const cap = Math.min(60000, 2000 * 2 ** attempt);
    for (let i = 0; i < 20; i++) {
      const delay = runtime.portalBackoffDelay(attempt, 2000, 60000);
      assert.ok(delay >= cap / 2 && delay <= cap, `attempt ${attempt}: ${delay}`);
    }
  }
  runtime.notePortalFailure({ kind: 'timeout' });
  assert.equal(runtime.portalBackoffActive(), true);
  assert.equal(runtime.portalResumeAllowed('bookings', 1000), false, 'resume work waits out the backoff');
  runtime.notePortalSuccess();
  assert.equal(runtime.portalBackoffActive(), false);
  assert.equal(runtime.portalResumeAllowed('bookings', 1000), true);
  assert.equal(runtime.portalResumeAllowed('bookings', 1000), false, 'focus + visibility together run once');
  runtime.notePortalFailure({ kind: 'auth' });
  assert.equal(runtime.portalBackoffActive(), false, 'an auth failure is not a reason to back off');
});

test('portalRequest never replays a write except after a 401 renewal', () => {
  const fn = core.slice(core.indexOf('async function portalRequest('), core.indexOf('// STRAVA MATCH PAYLOAD TRIMMING'));
  assert.equal((fn.match(/await send\(\)/g) || []).length, 2, 'one send, one post-401 replay');
  assert.match(fn, /if\(response\.status===401&&safeStorageGet\('dp_auth_method'\)==='code'\)\{\s*var renewed=await renewLegacySession\(\);\s*if\(renewed\)\{/);
  assert.doesNotMatch(fn, /setTimeout|for\s*\(|while\s*\(/, 'no retry loop');
});

// ── No fan-out on timeout or 5xx ───────────────────────────────────────────

function hydrationRuntime(bootstrapError) {
  const calls = [];
  const fn = login.slice(login.indexOf('async function hydratePortalData(code){'), login.indexOf('function hydrateLocalPortalState(code){'));
  const context = {
    calls, console: { warn() {} }, setTimeout: () => 0, athlete: { code: 'KARL' },
    portalRequest: async (action) => { calls.push(action); throw bootstrapError; },
    loadCloudData: async (code, pre) => { calls.push(pre === undefined ? 'state-read' : 'hydrate-state'); },
    loadStructuredBodyData: async (code, pre) => { calls.push(pre === undefined ? 'body-logs' : 'hydrate-body'); },
    loadStructuredNutritionData: async (code, pre) => { calls.push(pre === undefined ? 'nutrition-logs' : 'hydrate-nutrition'); },
    loadSessionLogs: async (pre) => { calls.push(pre === undefined ? 'session-logs-read' : 'hydrate-sessions'); },
    loadConfirmedLogDates: async () => { calls.push('daily-log-dates'); },
    hydrateConfirmedLogDates() {}, showPortalStaleState: () => calls.push('stale-shown'),
    portalBackoffDelay: () => 4000, portalBackoffRemaining: () => 0,
  };
  vm.createContext(context);
  vm.runInContext(fn, context);
  return context;
}

test('a bootstrap timeout or 5xx shows the saved state and does not fan out into five reads', async () => {
  for (const kind of ['timeout', 'server', 'offline', 'network']) {
    const runtime = hydrationRuntime(Object.assign(new Error('x'), { kind }));
    await assert.rejects(runtime.hydratePortalData('KARL'));
    assert.deepEqual(runtime.calls, ['bootstrap', 'stale-shown'], `${kind}: no compatibility reads`);
  }
});

test('only an endpoint that does not know bootstrap gets the compatibility reads', async () => {
  const runtime = hydrationRuntime(Object.assign(new Error('Unknown portal action'), { kind: 'unsupported' }));
  await runtime.hydratePortalData('KARL');
  assert.deepEqual(runtime.calls.slice().sort(), ['body-logs', 'bootstrap', 'daily-log-dates', 'nutrition-logs', 'session-logs-read', 'state-read']);
});

test('a training-read timeout uses the saved week and cache-only library, never the three legacy loaders', () => {
  const load = training.slice(training.indexOf('async function loadWeek(){'), training.indexOf('function showNoplan(){'));
  assert.match(load, /if\(\(readError&&readError\.kind!=='unsupported'\)\|\|failedSections\.length\)\{/);
  assert.match(load, /readPersistedTrainingSnapshot\(localISO\(fetchStart\),localISO\(fetchEnd\),true\)/);
  assert.match(load, /library:bundle\.library\|\|\{notModified:true\}/);
  assert.match(load, /splits:bundle\.splits\|\|savedBundle\.splits\|\|\{rows:\[\]\}/);
  assert.match(load, /if\(bundle&&bundle\.offlinePlanMissing\)\{\s*await loadRunningLibrary\(bundle\.library\);\s*results=\[null,null,null\];/);
  assert.match(load, /scheduleWeekRetry\(\);/);
});

// ── Secondary work waits for the current week ──────────────────────────────

test('secondary start-up runs only after the current week has painted, in stages', async () => {
  const doLogin = login.slice(login.indexOf('async function doLogin('), login.indexOf('// ── SECONDARY START-UP'));
  const beforeWeek = doLogin.slice(0, doLogin.indexOf('var initialWeekPromise=Promise.resolve(loadWeek())'));
  for (const call of ['initStrava', 'loadNutrition()', 'syncPushSubscription', 'refreshNotificationInbox', 'initCallNudge', 'retryPendingCoachWrites', 'refreshRunningLibraryRevision', 'loadProgrammeIndex']) {
    assert.ok(!beforeWeek.includes(call), `${call} must not start before the week loads`);
  }
  assert.match(doLogin, /initialWeekPromise\.finally\(function\(\)\{[\s\S]*startPortalSecondary\(loginStillCurrent\);/);

  // Run the stager with a fake clock: stage order and backoff deferral.
  const order = [];
  const timers = [];
  const fn = login.slice(login.indexOf('function portalWhenIdle('), login.indexOf('function populateStatic(){'));
  let backoff = true;
  const context = {
    window: { initStrava: () => { order.push('strava'); return Promise.resolve({}); } },
    athlete: { code: 'KARL' },
    setTimeout: (cb, ms) => timers.push({ cb, ms }),
    console: { warn() {} },
    loadNutrition: () => order.push('nutrition'),
    refreshRunningLibraryRevision: () => order.push('library'),
    loadProgrammeIndex: () => order.push('programme'),
    retryPendingCoachWrites: () => order.push('outbox'),
    initCallNudge: () => order.push('bookings'),
    syncPushSubscription: () => order.push('push'),
    refreshNotificationInbox: () => order.push('inbox'),
    maybePromptPwaNotifications: () => {},
    refreshStravaSessionMatches: () => {},
    portalBackoffActive: () => backoff,
    portalBackoffRemaining: () => 5000,
    dpPerfStart: () => 0, dpPerfRecord: () => {},
  };
  vm.createContext(context);
  vm.runInContext(fn, context);
  context.startPortalSecondary(() => true);
  assert.deepEqual(order, [], 'nothing runs while the backoff window is open');
  const delays = timers.map((t) => t.ms);
  assert.deepEqual(delays, [0, 700, 1800], 'three stages, staggered');
  // While the backoff window is open, a stage re-schedules itself instead of running.
  timers.splice(0).forEach((t) => t.cb());
  timers.splice(0).forEach((t) => t.cb()); // idle callbacks (setTimeout fallback)
  assert.deepEqual(order, []);
  assert.ok(timers.every((t) => t.ms === 5000), 'deferred by the remaining backoff');
  backoff = false;
  timers.splice(0).forEach((t) => t.cb());
  timers.splice(0).forEach((t) => t.cb());
  assert.deepEqual(order, ['strava', 'nutrition', 'library', 'programme', 'outbox', 'bookings', 'push', 'inbox']);

  // With no backoff, stage 1 runs in the same tick the week finished (its
  // Strava repaint must land before an athlete can open a session); the rest
  // stay staged.
  order.length = 0; timers.length = 0; backoff = false;
  context.startPortalSecondary(() => true);
  assert.deepEqual(order, ['strava', 'nutrition']);
  assert.deepEqual(timers.map((t) => t.ms), [700, 1800]);
});

test('programme history merges in place and never re-renders the visible week', () => {
  const load = training.slice(training.indexOf('function loadProgrammeIndex('), training.indexOf('// History sessions outside the visible week'));
  assert.doesNotMatch(load, /loadWeek\(/, 'an athlete may already have a session open');
  const merge = training.slice(training.indexOf('function mergeProgrammeIndexIntoSessions('), training.indexOf('// After a timeout or 5xx, one delayed re-read'));
  assert.match(merge, /allSessions\.push\(session\)/, 'appended, so existing indices stay stable');
  assert.doesNotMatch(merge, /loadWeek\(|renderCal\(|renderTodaySection\(/);
});
