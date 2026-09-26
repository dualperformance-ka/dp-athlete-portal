import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// INTEGRATION, not unit.
//
// The unit tests call performanceSummary() with a stubbed `select`. This drives
// the whole request instead: api/write.js's default handler, the CORS and method
// guards, getRequestAthlete() resolving a real signed portal session, dispatch(),
// the module's own reads through the real supabase-rest client, and the response
// envelope the browser actually parses.
//
// The only thing replaced is global fetch, which stands in for PostgREST and for
// Supabase Auth. Everything between the HTTP boundary and that fetch is the
// production path.

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key-that-is-long-enough-to-sign-with-0123456789';
process.env.PORTAL_SESSION_SECRET = 'portal-session-secret-long-enough-0123456789abcdef';

const { default: handler } = await import('../api/write.js');
const { createPortalSession } = await import('../api/_lib/legacy-session.js');

const WEEK_ID = '0f30b419-62ad-4bef-80e2-35eb71eb8ccb';
const PROGRAMME_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const START = '2026-09-21';

function mockResponse() {
  const state = { statusCode: null, payload: null, headers: {}, ended: false };
  const res = {
    setHeader(key, value) { state.headers[String(key).toLowerCase()] = value; },
    status(code) { state.statusCode = code; return res; },
    json(payload) { state.payload = payload; state.ended = true; return res; },
    end() { state.ended = true; return res; },
  };
  return { res, state };
}

function request(body, { token, method = 'POST', mode = 'portal' } = {}) {
  return {
    method,
    query: mode ? { mode } : {},
    headers: {
      'content-type': 'application/json',
      host: 'portal.test',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
  };
}

/**
 * Answer PostgREST from a table -> rows map, recording every URL so the test can
 * assert what was actually asked for.
 */
function mockFetch(tables, { calls = [], failFor = new Set() } = {}) {
  return async (url) => {
    const target = String(url);
    calls.push(target);
    const path = target.replace(/^https:\/\/example\.supabase\.co\/rest\/v1\//, '');
    const table = path.split('?')[0];
    if (failFor.has(table)) {
      return { ok: false, status: 500, async text() { return JSON.stringify({ message: 'internal detail that must not leak' }); } };
    }
    const value = tables[table];
    const rows = typeof value === 'function' ? value(new URLSearchParams(path.split('?')[1] || '')) : (value || []);
    return { ok: true, status: 200, async text() { return JSON.stringify(rows); } };
  };
}

const TABLES = {
  athletes: [{ code: 'KARL', name: 'Karl', active: true, archived_at: null }],
  athlete_programmes: [{ id: PROGRAMME_ID }],
  athlete_programme_weeks: [{
    id: WEEK_ID, programme_id: PROGRAMME_ID, week_number: 8, week_label: 'Week 8', start_date: START,
  }],
  planned_sessions: [
    { id: 'p1', notion_page_id: 'k1', title: 'Easy Run 10km', planned_date: START, session_type: 'Run', status: 'Planned', library_id: null, distance_km: null, week_label: 'Week 8', prescription_mode: null },
    { id: 'p2', notion_page_id: 'k2', title: 'Upper A', planned_date: '2026-09-22', session_type: 'Strength', status: 'Planned', library_id: null, distance_km: null, week_label: 'Week 8', prescription_mode: null },
  ],
  session_logs: [{ session_key: 'k1' }],
  training_session_logs: [{
    session_name: 'Upper A', session_category: 'Strength', session_date: '2026-09-22',
    exercise_name: 'Back Squat', programmed_exercise: 'Back Squat',
    raw_sets: [{ weight: '100', reps: '5' }, { weight: '100', reps: '5' }],
  }],
  daily_body_logs: [{ log_date: START, weight: '86.4', sleep: '7', energy: '6', stress: '4', soreness: '3' }],
  weekly_checkins: [],
  strava_activities: [{ sport_type: 'Run', start_date_local: `${START}T06:00:00+09:30`, distance_m: 10200, moving_time_s: 3000, elapsed_time_s: 3100 }],
  workout_splits: [{ name: 'Upper A' }],
  session_exercises: [],
  run_steps: [],
};

function withFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(run()).finally(() => { globalThis.fetch = original; });
}

// ── The happy path, through the real handler ─────────────────────────────────

test('a signed portal session gets a summary back through /api/portal-data', async () => {
  const calls = [];
  const { res, state } = mockResponse();
  const token = createPortalSession('KARL');
  await withFetch(mockFetch(TABLES, { calls }), () => handler(
    request({ action: 'performance-summary', period: 'week', programmeWeekId: WEEK_ID }, { token }),
    res,
  ));

  assert.equal(state.statusCode, 200, JSON.stringify(state.payload));
  assert.equal(state.payload.ok, true);
  assert.ok(state.payload.summary, 'the envelope carries the summary the client reads');
  const summary = state.payload.summary;

  assert.equal(summary.version, 1);
  assert.equal(summary.period.programmeWeekId, WEEK_ID);
  assert.equal(summary.period.label, 'Week 8');
  assert.equal(summary.period.startDate, START);
  assert.equal(summary.period.endDate, '2026-09-27');
  assert.equal(summary.training.plannedSessions, 2);
  assert.equal(summary.training.completedSessions, 1);
  assert.equal(summary.training.completionPercent, 50);
  assert.equal(summary.endurance.running.actualDistanceKm, 10.2);
  assert.equal(summary.endurance.running.actualSource, 'strava');
  assert.equal(summary.strength.workingSets, 2);
  assert.equal(summary.strength.measurableVolumeKg, 1000);
  assert.equal(summary.readiness.daysLogged, 1);
  assert.equal(summary.bodyweight.entries, 1);
  assert.equal(summary.bodyweight.changeKg, null);
  assert.equal(summary.dataQuality.partial, false);

  // The response is never cacheable — it is per-athlete derived data.
  assert.equal(state.headers['cache-control'], 'no-store');

  // Every scoped read carried the code from the TOKEN.
  const scoped = calls.filter((url) => url.includes('athlete_code='));
  assert.ok(scoped.length >= 5, `expected several scoped reads, saw ${scoped.length}`);
  scoped.forEach((url) => assert.ok(url.includes('athlete_code=eq.KARL'), url));
  // And the programme week was looked up scoped to this athlete's programmes.
  const weekLookup = calls.find((url) => url.includes('athlete_programme_weeks'));
  assert.ok(weekLookup.includes('programme_id=in.'), weekLookup);
  assert.ok(weekLookup.includes(PROGRAMME_ID), weekLookup);
});

// ── The boundaries ───────────────────────────────────────────────────────────

test('no session is a 401 before anything is read', async () => {
  const calls = [];
  const { res, state } = mockResponse();
  await withFetch(mockFetch(TABLES, { calls }), () => handler(
    request({ action: 'performance-summary', period: 'week', programmeWeekId: WEEK_ID }),
    res,
  ));
  assert.equal(state.statusCode, 401);
  assert.equal(state.payload.ok, false);
  assert.equal(calls.length, 0);
});

test('the legacy /api/write path stays retired', async () => {
  const { res, state } = mockResponse();
  await handler(request({ action: 'performance-summary' }, { token: createPortalSession('KARL'), mode: null }), res);
  assert.equal(state.statusCode, 410);
});

test('only POST is accepted', async () => {
  const { res, state } = mockResponse();
  await handler(request({}, { token: createPortalSession('KARL'), method: 'GET' }), res);
  assert.equal(state.statusCode, 405);
});

test('an athlete code in the body is ignored in favour of the session', async () => {
  const calls = [];
  const { res, state } = mockResponse();
  await withFetch(mockFetch(TABLES, { calls }), () => handler(
    request({
      action: 'performance-summary', period: 'week', programmeWeekId: WEEK_ID,
      athleteCode: 'SOMEONE', code: 'SOMEONE', athlete_code: 'SOMEONE',
    }, { token: createPortalSession('KARL') }),
    res,
  ));
  assert.equal(state.statusCode, 200);
  assert.equal(calls.some((url) => url.includes('SOMEONE')), false, 'no read may carry the body code');
});

test('a bad request is rejected with a safe message and no reads', async () => {
  const calls = [];
  const { res, state } = mockResponse();
  await withFetch(mockFetch(TABLES, { calls }), () => handler(
    request({ action: 'performance-summary', period: 'week', programmeWeekId: 'nope' }, { token: createPortalSession('KARL') }),
    res,
  ));
  assert.equal(state.statusCode, 400);
  assert.equal(state.payload.ok, false);
  assert.match(state.payload.error, /valid programme week/i);
  // Only the roster read for the session; nothing for the summary itself.
  assert.equal(calls.filter((url) => url.includes('athlete_programmes')).length, 0);
});

test("another athlete's programme week is a 404 that reveals nothing", async () => {
  const { res, state } = mockResponse();
  const tables = { ...TABLES, athlete_programme_weeks: [] };
  await withFetch(mockFetch(tables), () => handler(
    request({ action: 'performance-summary', period: 'week', programmeWeekId: WEEK_ID }, { token: createPortalSession('KARL') }),
    res,
  ));
  assert.equal(state.statusCode, 404);
  assert.equal(state.payload.error, 'Programme week not found');
  assert.equal(/exists|belongs|another|athlete/i.test(state.payload.error), false);
});

// ── Degradation, end to end ──────────────────────────────────────────────────

test('an optional source failing returns 200 with a partial summary and no raw error', async () => {
  const { res, state } = mockResponse();
  await withFetch(mockFetch(TABLES, { failFor: new Set(['strava_activities', 'daily_body_logs']) }), () => handler(
    request({ action: 'performance-summary', period: 'week', programmeWeekId: WEEK_ID }, { token: createPortalSession('KARL') }),
    res,
  ));
  assert.equal(state.statusCode, 200);
  const summary = state.payload.summary;
  assert.equal(summary.dataQuality.partial, true);
  assert.ok(summary.dataQuality.missingSources.includes('strava_activities'));
  assert.ok(summary.dataQuality.missingSources.includes('daily_body_logs'));
  // The rest still rendered.
  assert.equal(summary.training.plannedSessions, 2);
  assert.equal(summary.readiness.average, null);
  assert.equal(summary.endurance.running.actualSource, 'unavailable');
  // The database's own words never reach the athlete.
  assert.equal(JSON.stringify(state.payload).includes('internal detail'), false);
});

test('a mandatory read failing is a safe 500, not a partial', async () => {
  const { res, state } = mockResponse();
  await withFetch(mockFetch(TABLES, { failFor: new Set(['planned_sessions']) }), () => handler(
    request({ action: 'performance-summary', period: 'week', programmeWeekId: WEEK_ID }, { token: createPortalSession('KARL') }),
    res,
  ));
  assert.equal(state.statusCode, 500);
  assert.equal(state.payload.ok, false);
  assert.equal(state.payload.error, 'Request failed');
  assert.equal(JSON.stringify(state.payload).includes('internal detail'), false);
});

// ── Query construction ───────────────────────────────────────────────────────
//
// These assert the URL that actually reaches PostgREST. They exist because the
// queries are the one part of this feature no test can execute for real: a
// malformed filter fails at the database, degrades into a partial summary, and
// the card still renders — so the failure is silent in exactly the place a
// silent failure is worst.

test('every date range is one canonical and=() filter, not a mixed pair', async () => {
  const calls = [];
  const { res, state } = mockResponse();
  await withFetch(mockFetch(TABLES, { calls }), () => handler(
    request({ action: 'performance-summary', period: 'week', programmeWeekId: WEEK_ID }, { token: createPortalSession('KARL') }),
    res,
  ));
  assert.equal(state.statusCode, 200);

  const ranged = calls.filter((url) => /training_session_logs|daily_body_logs|weekly_checkins|strava_activities/.test(url));
  assert.ok(ranged.length >= 4, `expected the ranged reads, saw ${ranged.length}`);
  ranged.forEach((url) => {
    const params = new URLSearchParams(url.split('?')[1] || '');
    const and = params.get('and');
    if (!and) return;                       // the unbounded history read
    // Both bounds inside one and=(), which is the documented PostgREST form.
    assert.match(and, /^\((\w+)\.(gte|gt)\.[^,]+,\1\.(lte|lt)\.[^)]+\)$/, url);
    // And never the mixed form: a top-level filter on the same column as well.
    const column = and.slice(1).split('.')[0];
    assert.equal(params.get(column), null, `${column} is filtered twice in ${url}`);
  });
});

test('the Strava window is wider than the week, because the column is a timestamp', async () => {
  const calls = [];
  const { res } = mockResponse();
  await withFetch(mockFetch(TABLES, { calls }), () => handler(
    request({ action: 'performance-summary', period: 'week', programmeWeekId: WEEK_ID }, { token: createPortalSession('KARL') }),
    res,
  ));
  const strava = calls.find((url) => url.includes('strava_activities'));
  const and = new URLSearchParams(strava.split('?')[1]).get('and');
  // The week is 2026-09-21..2026-09-27. start_date_local is timestamptz, so a
  // bare-date comparison casts in the SERVER timezone and would cut an Adelaide
  // early-morning Monday run off the front of the week.
  assert.match(and, /start_date_local\.gte\.2026-09-20/, and);
  assert.match(and, /start_date_local\.lt\.2026-09-29/, and);
});

test('an Adelaide early-morning run on the first day of the week is counted', async () => {
  const { res, state } = mockResponse();
  const tables = {
    ...TABLES,
    strava_activities: (params) => {
      // Behave like Postgres: cast the bare dates in the filter to UTC
      // timestamps and compare, which is exactly what production does.
      const and = params.get('and') || '';
      const from = (and.match(/gte\.([0-9-]+)/) || [])[1];
      const to = (and.match(/lt\.([0-9-]+)/) || [])[1];
      const rows = [
        // 06:00 Adelaide on the Monday = 20:30 UTC on the Sunday.
        { sport_type: 'Run', start_date_local: `${START}T06:00:00+09:30`, distance_m: 12000, moving_time_s: 3600, elapsed_time_s: 3700 },
        // Late Sunday, the last day of the week.
        { sport_type: 'Run', start_date_local: '2026-09-27T21:30:00+09:30', distance_m: 5000, moving_time_s: 1500, elapsed_time_s: 1500 },
        // Genuinely outside the week — must stay out.
        { sport_type: 'Run', start_date_local: '2026-09-19T06:00:00+09:30', distance_m: 99000, moving_time_s: 9999, elapsed_time_s: 9999 },
      ];
      return rows.filter((row) => {
        const at = Date.parse(row.start_date_local);
        return at >= Date.parse(`${from}T00:00:00Z`) && at < Date.parse(`${to}T00:00:00Z`);
      });
    },
  };
  await withFetch(mockFetch(tables), () => handler(
    request({ action: 'performance-summary', period: 'week', programmeWeekId: WEEK_ID }, { token: createPortalSession('KARL') }),
    res,
  ));
  assert.equal(state.statusCode, 200);
  const running = state.payload.summary.endurance.running;
  assert.equal(running.actualSessions, 2, 'both in-week runs count, including the early Monday one');
  assert.equal(running.actualDistanceKm, 17, 'and the out-of-week run stays out');
});

test('completion is read by this week\'s keys, not by scanning the whole log', async () => {
  const calls = [];
  const { res, state } = mockResponse();
  await withFetch(mockFetch(TABLES, { calls }), () => handler(
    request({ action: 'performance-summary', period: 'week', programmeWeekId: WEEK_ID }, { token: createPortalSession('KARL') }),
    res,
  ));
  assert.equal(state.statusCode, 200);
  const logs = calls.find((url) => /\/session_logs\?/.test(url));
  const params = new URLSearchParams(logs.split('?')[1]);
  // Bounded by the week's own keys, so a long history can never truncate the
  // read and quietly under-report the headline number.
  // Each key is asked for in both spellings: the bare key and the
  // session_<CODE>_<key> form the browser actually writes.
  assert.equal(params.get('session_key'), 'in.(k1,session_KARL_k1,k2,session_KARL_k2)');
  assert.equal(params.get('athlete_code'), 'eq.KARL');
  assert.ok(Number(params.get('limit')) >= 4);
});

// ── Regression, Sep 2026 (Nathan Chung, week 3) ─────────────────────────────
// The programme week linked only the runs; the lifts were scheduled from the
// coaches dashboard Planning tab with no programme_week_id. And the portal
// writes session_logs.session_key as `session_<CODE>_<key>` (js/09-logging.js),
// which is how every production row is stored. The card read 0/2 sessions,
// Strength 0/0, and listed a logged run as missed.
// Drive the real handler with the clock pinned, so "today" (which decides what
// counts as missed) does not depend on the day the suite runs.
async function performanceSummaryFor(res, todayISO) {
  mock.timers.enable({ apis: ['Date'], now: new Date(`${todayISO}T02:00:00Z`) });
  try {
    await handler(
      request({ action: 'performance-summary', period: 'week', programmeWeekId: WEEK_ID }, { token: createPortalSession('KARL') }),
      res,
    );
  } finally {
    mock.timers.reset();
  }
}

const RUN = '44444444-4444-4444-8444-444444444444';
const LIFT_DONE = '55555555-5555-4555-8555-555555555555';
const LIFT_TODAY = '66666666-6666-4666-8666-666666666666';
const MIXED_TABLES = {
  ...TABLES,
  planned_sessions: (params) => (params.get('programme_week_id') === 'is.null'
    ? [
      { id: LIFT_DONE, notion_page_id: null, title: 'Upper C (3 days / wk)', planned_date: '2026-09-24', session_type: 'Strength', status: 'Planned', library_id: null, distance_km: null, week_label: null, prescription_mode: 'legacy' },
      { id: LIFT_TODAY, notion_page_id: null, title: 'Upper B (3 days / wk)', planned_date: '2026-09-26', session_type: 'Strength', status: 'Planned', library_id: null, distance_km: null, week_label: null, prescription_mode: 'legacy' },
    ]
    : [
      { id: RUN, notion_page_id: null, title: 'Threshold Cruise — 4 x 3 min', planned_date: '2026-09-23', session_type: 'Threshold', status: 'Planned', library_id: null, distance_km: null, week_label: 'Week 8', prescription_mode: 'legacy' },
    ]),
  session_logs: (params) => {
    const wanted = new Set(String(params.get('session_key') || '').replace(/^in\.\(|\)$/g, '').split(','));
    return [`session_KARL_${RUN}`, `session_KARL_${LIFT_DONE}`, 'session_OTHER_x']
      .filter((key) => wanted.has(key))
      .map((session_key) => ({ session_key }));
  },
};

test('a week mixing linked and unlinked sessions counts both, and prefixed log keys complete them', async () => {
  const { res, state } = mockResponse();
  await withFetch(mockFetch(MIXED_TABLES), () => performanceSummaryFor(res, '2026-09-26'));
  assert.equal(state.statusCode, 200);
  const training = state.payload.summary.training;
  assert.equal(training.plannedSessions, 3, 'the unlinked lifts are part of the week');
  assert.equal(training.completedSessions, 2, 'session_<CODE>_<key> rows complete their sessions');
  assert.deepEqual(training.missedSessions, [], 'a logged run is never listed as missed; today is not missed yet');
});

test('a session linked to the week and also dated in it is counted once', async () => {
  const { res, state } = mockResponse();
  const dup = { id: RUN, notion_page_id: null, title: 'Threshold Cruise — 4 x 3 min', planned_date: '2026-09-23', session_type: 'Threshold', status: 'Planned', library_id: null, distance_km: null, week_label: 'Week 8', prescription_mode: 'legacy' };
  await withFetch(mockFetch({ ...MIXED_TABLES, planned_sessions: () => [dup] }), () => performanceSummaryFor(res, '2026-09-26'));
  assert.equal(state.statusCode, 200);
  assert.equal(state.payload.summary.training.plannedSessions, 1);
  assert.equal(state.payload.summary.training.completedSessions, 1);
});

test('the unlinked-session read failing still returns the linked week', async () => {
  const { res, state } = mockResponse();
  const tables = {
    ...MIXED_TABLES,
  };
  const base = mockFetch(tables);
  const failing = async (url) => (/\/planned_sessions\?/.test(String(url)) && /programme_week_id=is\.null/.test(String(url))
    ? { ok: false, status: 500, async text() { return JSON.stringify({ message: 'internal detail' }); } }
    : base(url));
  await withFetch(failing, () => performanceSummaryFor(res, '2026-09-26'));
  assert.equal(state.statusCode, 200);
  assert.equal(state.payload.summary.training.plannedSessions, 1);
});

test('a week with no planned sessions does not read the log at all', async () => {
  const calls = [];
  const { res, state } = mockResponse();
  await withFetch(mockFetch({ ...TABLES, planned_sessions: [] }, { calls }), () => handler(
    request({ action: 'performance-summary', period: 'week', programmeWeekId: WEEK_ID }, { token: createPortalSession('KARL') }),
    res,
  ));
  assert.equal(state.statusCode, 200);
  assert.equal(calls.some((url) => /\/session_logs\?/.test(url)), false);
  assert.equal(state.payload.summary.training.completionPercent, null);
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test('the action is a dispatch entry, not a new serverless function', () => {
  const write = readFileSync(join(root, 'api', 'write.js'), 'utf8');
  assert.match(write, /if \(action === 'performance-summary'\) return performanceSummary\(code, body\);/);
  assert.match(write, /from '\.\/_lib\/performance-summary\.js'/);

  const files = readFileSync(join(root, 'scripts', 'check-portal.mjs'), 'utf8');
  assert.match(files, /API_FUNCTION_BUDGET = 24/, 'the budget must not have moved');

  // The summary lives in _lib, which Vercel does not deploy as a function.
  assert.equal(
    readFileSync(join(root, 'api', '_lib', 'performance-summary.js'), 'utf8').includes('export async function performanceSummary'),
    true,
  );
});

test('the response the browser parses is exactly {ok, summary}', async () => {
  const { res, state } = mockResponse();
  await withFetch(mockFetch(TABLES), () => handler(
    request({ action: 'performance-summary', period: 'week', programmeWeekId: WEEK_ID }, { token: createPortalSession('KARL') }),
    res,
  ));
  assert.deepEqual(Object.keys(state.payload).sort(), ['ok', 'summary']);
});
