// Every Garmin data type Dual Performance is allowed to take, Nov 2026.
// Women's Health (menstrual cycle, pregnancy) is the one deliberate exclusion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

process.env.PORTAL_SESSION_SECRET = process.env.PORTAL_SESSION_SECRET || 'test-secret-that-is-at-least-32-characters-long';
process.env.SUPABASE_URL = 'https://db.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key-for-tests-only';

const client = await import('../api/_lib/garmin-client.js');
const store = await import('../api/_lib/garmin-store.js');
const { processNotification } = await import('../api/garmin.js');
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const GENERIC = ['activityDetails', 'activityFiles', 'epochs', 'bodyComps', 'hrv', 'stressDetails', 'allDayRespiration',
  'pulseox', 'healthSnapshot', 'skinTemp', 'userMetrics', 'bloodPressures', 'moveIQActivities'];

// ── Registry ─────────────────────────────────────────────────────────────────

test('every Activity and Health API type is registered, with a consent permission', () => {
  assert.deepEqual(Object.keys(client.GARMIN_TYPES).sort(), [...client.DEDICATED_KINDS, ...GENERIC].sort());
  for (const [kind, type] of Object.entries(client.GARMIN_TYPES)) {
    assert.ok(['ACTIVITY_EXPORT', 'HEALTH_EXPORT'].includes(type.permission), kind);
  }
});

test('history is requested for every type Garmin backfills, by Garmin\'s backfill names', () => {
  assert.deepEqual([...client.BACKFILL_TYPES].sort(), [
    'activities', 'activityDetails', 'bloodPressures', 'bodyComps', 'dailies', 'epochs', 'healthSnapshot',
    'hrv', 'moveiq', 'pulseOx', 'respiration', 'skinTemp', 'sleeps', 'stressDetails', 'userMetrics',
  ].sort());
});

test('Garmin\'s alternate webhook keys map to one kind', () => {
  assert.equal(client.kindForKey('manuallyUpdatedActivities'), 'activities');
  assert.equal(client.kindForKey('respiration'), 'allDayRespiration');
  assert.equal(client.kindForKey('pulseOx'), 'pulseox');
  assert.equal(client.kindForKey('moveiq'), 'moveIQActivities');
  assert.equal(client.kindForKey('nonsense'), null);
});

test('Women\'s Health is never a stored kind and never backfilled', () => {
  for (const key of ['mct', 'menstrualCycleTracking', 'pregnancySnapshot']) {
    assert.equal(client.kindForKey(key), null, key);
    assert.ok(client.EXCLUDED_KEYS.has(key), key);
  }
  assert.ok(!client.BACKFILL_TYPES.some((type) => /mct|menstrual|pregnan/i.test(type)));
});

// ── Normalising ──────────────────────────────────────────────────────────────

const START = 1794036000; // 2026-11-07T07:20:00Z
const ADL = 37800;

test('activity details read their nested summary and keep every sample', () => {
  const row = client.normaliseSummary('karl', 'activityDetails', {
    userId: 'g1', userAccessToken: 'leaked?', summaryId: '21047282990-detail', activityId: 21047282990,
    summary: { startTimeInSeconds: START, startTimeOffsetInSeconds: ADL, durationInSeconds: 1860 },
    samples: [{ startTimeInSeconds: START, heartRate: 150, speedMetersPerSecond: 2.7 }],
    laps: [{ startTimeInSeconds: START }],
  });
  assert.equal(row.athlete_code, 'KARL');
  assert.equal(row.summary_type, 'activityDetails');
  assert.equal(row.summary_id, '21047282990-detail');
  assert.equal(row.activity_id, 21047282990);
  assert.equal(row.calendar_date, '2026-11-07');
  assert.equal(row.duration_s, 1860);
  assert.equal(row.summary.samples[0].heartRate, 150);
  assert.equal(row.summary.laps.length, 1);
  assert.ok(!('userId' in row.summary) && !('userAccessToken' in row.summary), 'no Garmin id or token in stored data');
});

test('body composition and blood pressure are dated by their measurement time', () => {
  const body = client.normaliseSummary('KARL', 'bodyComps', { summaryId: 'b1', measurementTimeInSeconds: START, measurementTimeOffsetInSeconds: ADL, weightInGrams: 72000, bodyFatInPercent: 11.5 });
  assert.equal(body.start_time, new Date(START * 1000).toISOString());
  assert.equal(body.calendar_date, '2026-11-07');
  assert.equal(body.summary.weightInGrams, 72000);
  const bp = client.normaliseSummary('KARL', 'bloodPressures', { summaryId: 'bp1', measurementTimeInSeconds: START, systolic: 118, diastolic: 74 });
  assert.equal(bp.summary.systolic, 118);
});

test('date-only summaries (user metrics, HRV) key on the date when Garmin sends no id', () => {
  const metrics = client.normaliseSummary('KARL', 'userMetrics', { calendarDate: '2026-11-07', vo2Max: 58, fitnessAge: 29 });
  assert.equal(metrics.summary_id, 'd-2026-11-07');
  assert.equal(metrics.start_time, null);
  assert.equal(metrics.summary.vo2Max, 58);
  const hrv = client.normaliseSummary('KARL', 'hrv', { summaryId: 'h1', calendarDate: '2026-11-07', startTimeInSeconds: START, lastNightAvg: 62 });
  assert.equal(hrv.summary_id, 'h1');
});

test('every generic kind normalises a realistic record', () => {
  const samples = {
    epochs: { summaryId: 'e1', startTimeInSeconds: START, durationInSeconds: 900, steps: 120 },
    stressDetails: { summaryId: 's1', calendarDate: '2026-11-07', startTimeInSeconds: START, timeOffsetStressLevelValues: { 0: 25 } },
    allDayRespiration: { summaryId: 'r1', startTimeInSeconds: START, timeOffsetEpochToBreaths: { 0: 14.2 } },
    pulseox: { summaryId: 'p1', calendarDate: '2026-11-07', startTimeInSeconds: START, timeOffsetSpo2Values: { 0: 97 } },
    healthSnapshot: { summaryId: 'hs1', startTimeInSeconds: START, summaries: [{ summaryType: 'heart_rate', avgValue: 60 }] },
    skinTemp: { summaryId: 'st1', calendarDate: '2026-11-07', avgDeviationCelsius: 0.2 },
    moveIQActivities: { summaryId: 'm1', startTimeInSeconds: START, activityType: 'Walking', durationInSeconds: 600 },
  };
  for (const [kind, record] of Object.entries(samples)) {
    const row = client.normaliseSummary('KARL', kind, record);
    assert.ok(row, kind);
    assert.equal(row.summary_type, kind);
    assert.equal(row.calendar_date, '2026-11-07', kind);
  }
});

test('records that cannot be keyed or dated are dropped, and dedicated kinds are not generic', () => {
  assert.equal(client.normaliseSummary('KARL', 'epochs', { steps: 10 }), null);
  assert.equal(client.normaliseSummary('KARL', 'dailies', { summaryId: 'x', calendarDate: '2026-11-07' }), null);
  assert.equal(client.normaliseSummary('KARL', 'mct', { summaryId: 'x', calendarDate: '2026-11-07' }), null);
});

// ── Activity files ───────────────────────────────────────────────────────────

test('an activity file notification keeps metadata but never the signed callback URL', () => {
  const parsed = client.parseNotification({ activityFiles: [{ userId: 'g1', summaryId: '21047282990', activityId: 21047282990, fileType: 'FIT', startTimeInSeconds: START, callbackURL: 'https://apis.garmin.com/wellness-api/rest/activityFile?id=1&token=abc' }] });
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.records.length + parsed.pings.length, 0);
  assert.equal(parsed.files[0].meta.fileType, 'FIT');
  assert.doesNotMatch(JSON.stringify(parsed.files[0].meta), /callback|token/i);
});

test('files are only downloaded from apis.garmin.com', async () => {
  await assert.rejects(client.fetchFile('https://evil.example/file.fit', 't', async () => { throw new Error('must not fetch'); }), /outside apis\.garmin\.com/);
  const bytes = await client.fetchFile('https://apis.garmin.com/wellness-api/rest/activityFile?id=1', 'tok', async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer tok');
    return new Response(new Uint8Array([14, 16, 1, 2]), { status: 200 });
  });
  assert.equal(bytes.length, 4);
});

const connection = { athlete_code: 'KARL', access_token: 't', refresh_token: 'r', access_expires_at: new Date(Date.now() + 3600e3).toISOString() };
const baseDeps = {
  findConnection: async (userId) => (userId === 'g1' ? connection : null),
  store: async (code, kind, records) => ({ saved: records.length }),
  updateConnection: async () => {},
  accessToken: async (c) => c.access_token,
};

test('a FIT file is downloaded with the athlete\'s token and stored against them', async () => {
  const stored = [];
  const counts = await processNotification({ activityFiles: [{ userId: 'g1', summaryId: 'a1', fileType: 'FIT', callbackURL: 'https://apis.garmin.com/wellness-api/rest/activityFile?id=1' }] }, {
    ...baseDeps,
    downloadFile: async (url, token) => { assert.equal(token, 't'); return Buffer.from([1, 2, 3]); },
    storeFile: async (code, meta, bytes) => { stored.push({ code, meta, size: bytes.length }); return { saved: 1 }; },
  });
  assert.deepEqual(stored, [{ code: 'KARL', meta: { summaryId: 'a1', fileType: 'FIT' }, size: 3 }]);
  assert.equal(counts.files, 1);
  assert.deepEqual(counts.savedByType, { activityFiles: 1 });
});

test('a failed file download is skipped, not a failed delivery', async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const counts = await processNotification({ activityFiles: [{ userId: 'g1', summaryId: 'a1', fileType: 'FIT', callbackURL: 'https://apis.garmin.com/x' }] }, {
      ...baseDeps,
      downloadFile: async () => { const e = new Error('gone'); e.status = 410; throw e; },
      storeFile: async () => { throw new Error('must not store'); },
    });
    assert.equal(counts.files, 0);
  } finally { console.warn = warn; }
});

test('Women\'s Health in a delivery reaches nothing', async () => {
  const kinds = [];
  const counts = await processNotification({ mct: [{ userId: 'g1', summaryId: 'c1', dayInCycle: 3 }], epochs: [{ userId: 'g1', summaryId: 'e1', startTimeInSeconds: START }] }, {
    ...baseDeps, store: async (code, kind, records) => { kinds.push(kind); return { saved: records.length }; },
  });
  assert.deepEqual(kinds, ['epochs']);
  assert.equal(counts.excludedTypes, 1);
});

// ── Storage (Supabase stubbed at fetch) ──────────────────────────────────────

function stubFetch() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, method: init.method || 'GET', body: init.body });
    if (url.pathname.endsWith('/garmin_summaries') && (init.method || 'GET') === 'GET') {
      return new Response(JSON.stringify([{ summary: { storagePath: 'KARL/a1.fit' } }, { summary: { storagePath: 'KARL/a2.fit' } }]), { status: 200 });
    }
    return new Response(init.method === 'POST' && url.pathname.includes('/storage/') ? '{"Key":"x"}' : '', { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('generic summaries upsert into garmin_summaries, cut into batches under the size cap', async () => {
  const stub = stubFetch();
  try {
    const big = 'x'.repeat(900 * 1024); // ~0.9 MB of samples per activity
    const records = Array.from({ length: 8 }, (_, i) => ({ summaryId: `d${i}`, summary: { startTimeInSeconds: START + i }, samples: big }));
    const result = await store.saveRecords('KARL', 'activityDetails', records);
    assert.equal(result.saved, 8);
    const posts = stub.calls.filter((c) => c.method === 'POST');
    assert.ok(posts.length >= 3, `expected several batches, got ${posts.length}`);
    for (const post of posts) {
      assert.match(post.url.search, /on_conflict=athlete_code%2Csummary_type%2Csummary_id/);
      assert.ok(post.body.length < 3.2 * 1024 * 1024, 'each batch stays under the cap');
    }
  } finally { stub.restore(); }
});

test('an activity file goes to the private bucket under the athlete, then gets its row', async () => {
  const stub = stubFetch();
  try {
    await store.saveActivityFile('karl', { summaryId: '210/47', activityId: 21047, fileType: 'FIT', startTimeInSeconds: START }, Buffer.from([1, 2]));
    const [upload, row] = stub.calls;
    assert.equal(upload.url.pathname, '/storage/v1/object/garmin-activity-files/KARL/21047.fit');
    const saved = JSON.parse(row.body)[0];
    assert.equal(saved.summary_type, 'activityFiles');
    assert.equal(saved.summary.storagePath, 'KARL/21047.fit');
    assert.equal(saved.summary.sizeBytes, 2);
  } finally { stub.restore(); }
});

test('deleting activity data removes the files before their rows', async () => {
  const stub = stubFetch();
  try {
    await store.deleteData('KARL', ['activities', 'activityDetails', 'activityFiles']);
    const order = stub.calls.map((c) => `${c.method} ${c.url.pathname}${c.url.pathname.endsWith('/garmin_summaries') && c.method === 'DELETE' ? ' ' + c.url.searchParams.get('summary_type') : ''}`);
    const removeFiles = order.indexOf('DELETE /storage/v1/object/garmin-activity-files');
    const removeRows = order.findIndex((line) => line.startsWith('DELETE /rest/v1/garmin_summaries'));
    assert.ok(removeFiles >= 0 && removeRows > removeFiles, order.join('\n'));
    assert.equal(order[removeRows], 'DELETE /rest/v1/garmin_summaries in.(activityDetails,activityFiles)');
    assert.deepEqual(JSON.parse(stub.calls[removeFiles].body).prefixes, ['KARL/a1.fit', 'KARL/a2.fit']);
  } finally { stub.restore(); }
});

test('a full purge reaches every Garmin type', async () => {
  const stub = stubFetch();
  try {
    await store.purgeAthlete('KARL');
    const deletes = stub.calls.filter((c) => c.method === 'DELETE').map((c) => c.url.pathname);
    for (const table of ['garmin_activities', 'garmin_dailies', 'garmin_sleeps', 'garmin_summaries', 'garmin_connections']) {
      assert.ok(deletes.includes(`/rest/v1/${table}`), table);
    }
    const generic = stub.calls.find((c) => c.method === 'DELETE' && c.url.pathname.endsWith('/garmin_summaries'));
    assert.equal(generic.url.searchParams.get('summary_type'), `in.(${GENERIC.join(',')})`);
  } finally { stub.restore(); }
});

// ── Database shape ───────────────────────────────────────────────────────────

test('the migration allows exactly the generic kinds and is service-role only', () => {
  const file = readdirSync(new URL('../supabase/migrations', import.meta.url)).find((name) => name.includes('garmin_all_summaries'));
  assert.ok(file);
  const sql = read(`../supabase/migrations/${file}`);
  const allowed = [...sql.match(/summary_type in \(([^)]*)\)/s)[1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(allowed.sort(), [...GENERIC].sort(), 'the check constraint and GARMIN_TYPES must agree');
  assert.match(sql, /alter table public\.garmin_summaries enable row level security/);
  assert.match(sql, /revoke all on public\.garmin_summaries from anon, authenticated/);
  assert.match(sql, /'garmin-activity-files',\s*'garmin-activity-files',\s*false/);
  assert.doesNotMatch(sql, /^\s*create policy/im);
});

test('the browser never reads the summaries table or the file bucket', () => {
  for (const name of readdirSync(new URL('../public/js', import.meta.url))) {
    assert.doesNotMatch(read(`../public/js/${name}`), /garmin_summaries|garmin-activity-files/, name);
  }
});
