import test from 'node:test';
import assert from 'node:assert/strict';
import { performanceSummary } from '../api/_lib/performance-summary.js';
import { garminActivityAsStravaRow, mergeGarminWithStrava, sameConnectedRecording, garminSportType } from '../api/_lib/garmin-client.js';

// Garmin as the activity source for allowlisted athletes. The weekly review
// and reminders read garmin_activities only for an athlete on the Garmin
// allowlist who is connected; a recording both services hold counts once, as
// Garmin. Nothing new is stored and nobody else's numbers move.

const WEEK_ID = '0f30b419-62ad-4bef-80e2-35eb71eb8ccb';
const PROGRAMME_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const START = '2026-09-21';
const BASE = {
  athlete_programmes: [{ id: PROGRAMME_ID }],
  athlete_programme_weeks: [{ id: WEEK_ID, programme_id: PROGRAMME_ID, week_number: 8, week_label: 'Week 8', start_date: START }],
  planned_sessions: [{ id: 'p1', notion_page_id: 'k1', title: 'Easy Run 10k', planned_date: START, session_type: 'Run', status: 'Planned', library_id: null, distance_km: null, week_label: 'Week 8', prescription_mode: null }],
  session_logs: [], training_session_logs: [], daily_body_logs: [], weekly_checkins: [], workout_splits: [],
  session_exercises: [], run_steps: [], weekly_sport_targets: [], nutrition_plans: [],
};
// Tuesday 06:00 Adelaide (ACST, +09:30) is Monday 20:30 UTC.
const STRAVA_RUN = { sport_type: 'Run', start_date_local: '2026-09-22T06:00:00+00:00', distance_m: 10000, moving_time_s: 3000, elapsed_time_s: 3000 };
const GARMIN_RUN = { summary_id: 'g-run', start_time: '2026-09-21T20:30:00+00:00', local_date: '2026-09-22', activity_type: 'RUNNING', distance_m: 10000, duration_s: 3000, offset: 34200 };
const STRAVA_RIDE = { sport_type: 'Ride', start_date_local: '2026-09-24T05:00:00+00:00', distance_m: 40000, moving_time_s: 4800, elapsed_time_s: 4800 };
const GARMIN_RIDE = { summary_id: 'g-ride', start_time: '2026-09-23T19:30:00+00:00', local_date: '2026-09-24', activity_type: 'ROAD_BIKING', distance_m: 40000, duration_s: 4800, offset: 34200 };

function deps(tables, { garmin = false, failures = new Set() } = {}) {
  const reads = [];
  return {
    reads,
    garminAvailable: () => garmin,
    now: () => new Date('2026-09-28T02:00:00.000Z'),
    select: async (table, query) => {
      reads.push(table);
      if (failures.has(table)) throw new Error(`relation "${table}" blew up`);
      const value = tables[table];
      return typeof value === 'function' ? value(query) : (value || []);
    },
  };
}
const summarise = async (tables, options) => {
  const d = deps(tables, options);
  const { summary } = await performanceSummary('KARL', { period: 'week', programmeWeekId: WEEK_ID }, d);
  return { summary, reads: d.reads };
};
const stable = (summary) => JSON.stringify({ ...summary, generatedAt: null });

test('an athlete off the Garmin allowlist makes no Garmin read and gets the same review', async () => {
  const strava = { ...BASE, strava_activities: [STRAVA_RUN, STRAVA_RIDE] };
  const withGarminData = { ...strava, garmin_connections: [{ athlete_code: 'KARL' }], garmin_activities: [GARMIN_RUN, GARMIN_RIDE] };
  const before = await summarise(strava, { garmin: false });
  const after = await summarise(withGarminData, { garmin: false });
  assert.equal(stable(after.summary), stable(before.summary));
  assert.equal(after.reads.some((t) => t.startsWith('garmin_')), false);
  assert.equal(after.summary.endurance.running.actualSource, 'strava');
});

test('the default allowlist check reads nothing from Garmin without Garmin keys', async () => {
  const tables = { ...BASE, strava_activities: [STRAVA_RUN], garmin_connections: [{ athlete_code: 'KARL' }], garmin_activities: [GARMIN_RUN] };
  const d = deps(tables);delete d.garminAvailable;
  const before = { ...process.env };
  delete process.env.GARMIN_CLIENT_ID;delete process.env.GARMIN_CLIENT_SECRET;
  try {
    const { summary } = await performanceSummary('KARL', { period: 'week', programmeWeekId: WEEK_ID }, d);
    assert.equal(d.reads.some((t) => t.startsWith('garmin_')), false);
    assert.equal(summary.endurance.running.actualSource, 'strava');
  } finally { Object.assign(process.env, before); }
});

test('an allowlisted athlete who never connected Garmin is unchanged too',async()=>{
  const tables = { ...BASE, strava_activities: [STRAVA_RUN], garmin_connections: [], garmin_activities: [GARMIN_RUN] };
  const off = await summarise({ ...BASE, strava_activities: [STRAVA_RUN] }, { garmin: false });
  const on = await summarise(tables, { garmin: true });
  assert.equal(stable(on.summary), stable(off.summary));
  assert.equal(on.reads.includes('garmin_activities'), false);
});

test('Strava only, Garmin only and both give the same km, sessions and minutes',async()=>{
  const strava = await summarise({ ...BASE, strava_activities: [STRAVA_RUN, STRAVA_RIDE], garmin_connections: [{ athlete_code: 'KARL' }], garmin_activities: [] }, { garmin: true });
  const garmin = await summarise({ ...BASE, strava_activities: [], garmin_connections: [{ athlete_code: 'KARL' }], garmin_activities: [GARMIN_RUN, GARMIN_RIDE] }, { garmin: true });
  const both = await summarise({ ...BASE, strava_activities: [STRAVA_RUN, STRAVA_RIDE], garmin_connections: [{ athlete_code: 'KARL' }], garmin_activities: [GARMIN_RUN, GARMIN_RIDE] }, { garmin: true });
  const pick = (s, sport) => { const e = s.summary.endurance[sport]; return [e.actualSessions, e.actualDistanceKm, e.actualDurationMinutes]; };
  for (const sport of ['running', 'cycling']) {
    assert.deepEqual(pick(garmin, sport), pick(strava, sport), sport + ': garmin only');
    assert.deepEqual(pick(both, sport), pick(strava, sport), sport + ': both counted once');
  }
  assert.deepEqual(pick(both, 'running'), [1, 10, 50]);
  assert.equal(strava.summary.endurance.running.actualSource, 'strava');
  assert.equal(garmin.summary.endurance.running.actualSource, 'garmin');
  assert.equal(both.summary.endurance.running.actualSource, 'garmin', 'the duplicate was dropped in favour of Garmin');
  assert.equal(both.summary.endurance.swimming.actualSource, 'garmin_strava', 'a verified zero names both services that answered');
  assert.equal(JSON.stringify(both.summary).includes('summary_id'), false, 'no raw Garmin fields reach the response');
});

test('a Strava-only activity beside Garmin is still counted, and labelled as both',async()=>{
  const extra = { sport_type: 'Run', start_date_local: '2026-09-26T07:00:00+00:00', distance_m: 5000, moving_time_s: 1500, elapsed_time_s: 1500 };
  const { summary } = await summarise({ ...BASE, strava_activities: [STRAVA_RUN, extra], garmin_connections: [{ athlete_code: 'KARL' }], garmin_activities: [GARMIN_RUN] }, { garmin: true });
  assert.equal(summary.endurance.running.actualSessions, 2);assert.equal(summary.endurance.running.actualDistanceKm, 15);
  assert.equal(summary.endurance.running.actualSource, 'garmin_strava');
});

test('Garmin still counts when Strava cannot be read',async()=>{
  const { summary } = await summarise({ ...BASE, garmin_connections: [{ athlete_code: 'KARL' }], garmin_activities: [GARMIN_RUN] }, { garmin: true, failures: new Set(['strava_activities']) });
  assert.equal(summary.endurance.running.actualDistanceKm, 10);assert.equal(summary.endurance.running.actualSource, 'garmin');
  assert.ok(summary.dataQuality.missingSources.includes('strava_activities'));
});

test('the Garmin read is scoped to the athlete, the week and aggregate columns',async()=>{
  let query;
  await summarise({ ...BASE, strava_activities: [], garmin_connections: [{ athlete_code: 'KARL' }], garmin_activities: (q) => { query = q; return [GARMIN_RUN]; } }, { garmin: true });
  assert.equal(query.athlete_code, 'eq.KARL');assert.equal(query.and, '(local_date.gte.2026-09-21,local_date.lte.2026-09-27)');
  assert.doesNotMatch(query.select, /avg_hr|max_hr|active_kcal|device_name|summary,|summary$/);
});

test('Garmin rows take the athlete’s wall-clock time, including across midnight UTC',()=>{
  const row = garminActivityAsStravaRow(GARMIN_RUN);
  assert.equal(row.start_date_local, '2026-09-22T06:00:00Z');assert.equal(row.sport_type, 'Run');assert.equal(row.provider, 'garmin');
  // No stored offset: Adelaide time for that instant (ACDT +10:30 in November).
  assert.equal(garminActivityAsStravaRow({ ...GARMIN_RUN, offset: null, start_time: '2026-11-05T20:15:49Z' }).start_date_local, '2026-11-06T06:45:49Z');
  assert.deepEqual(['RUNNING', 'TREADMILL_RUNNING', 'ROAD_BIKING', 'MOUNTAIN_BIKING', 'INDOOR_CYCLING', 'LAP_SWIMMING', 'OPEN_WATER_SWIMMING', 'STRENGTH_TRAINING'].map(garminSportType),
    ['Run', 'Run', 'Ride', 'Ride', 'Ride', 'Swim', 'Swim', 'STRENGTH_TRAINING']);
});

test('duplicates need the same sport, a start within 10 minutes and distance within 3%',()=>{
  const g = garminActivityAsStravaRow(GARMIN_RUN);
  assert.equal(sameConnectedRecording(g, STRAVA_RUN), true);
  assert.equal(sameConnectedRecording(g, { ...STRAVA_RUN, start_date_local: '2026-09-22T06:11:00+00:00' }), false);
  assert.equal(sameConnectedRecording(g, { ...STRAVA_RUN, distance_m: 10250 }), true, 'within 3%');
  assert.equal(sameConnectedRecording(g, { ...STRAVA_RUN, distance_m: 10400 }), false);
  assert.equal(sameConnectedRecording(g, { ...STRAVA_RUN, sport_type: 'Ride' }), false);
  assert.equal(mergeGarminWithStrava([STRAVA_RUN, STRAVA_RUN], [GARMIN_RUN]).length, 2, 'one Garmin recording absorbs one Strava copy only');
});

// ── Reminders ────────────────────────────────────────────────────────────────
import { addStravaSynced, loadReminderInputs, zoneWindows, buildAthleteMessages } from '../api/_lib/reminder-plan.js';
import { buildStravaMessage } from '../api/_lib/notification-rules.js';
import { resolvePrefs } from '../api/_lib/push-devices.js';

const WALL = { iso: '2026-11-06', dow: 5, hour: 8, minute: 30 };
const placed = (code, now = WALL) => ({ code, tz: 'Australia/Adelaide', now, windows: zoneWindows(now), prefs: resolvePrefs([], { managed: true }), lastSent: {}, devices: [{ id: 'd1' }], errors: [] });
const KARL_STRAVA = { strava_activity_id: 653280837502, athlete_code: 'KARL', sport_type: 'Run', start_date_local: '2026-11-06T06:45:49+00:00', distance_m: 4410, moving_time_s: 1500 };
const KARL_GARMIN = { athlete_code: 'KARL', summary_id: 'g1', start_time: '2026-11-05T20:15:49Z', activity_type: 'RUNNING', distance_m: 4412, duration_s: 1510, offset: 37800 };
const NOW = Date.parse('2026-11-05T22:00:00Z');

test('synced push: an allowlisted athlete’s run from Garmin and Strava is one push', async () => {
  const due = { KARL: { strava: [] }, THOMAS: { strava: [] } };
  const reads = [];
  await addStravaSynced(due, [placed('KARL'), placed('THOMAS')], {
    nowMs: NOW, garminAvailable: (code) => code === 'KARL',
    read: async (table, q) => { reads.push({ table, q }); return table === 'garmin_activities' ? [KARL_GARMIN] : [KARL_STRAVA, { ...KARL_STRAVA, strava_activity_id: 1, athlete_code: 'THOMAS' }]; },
  });
  assert.deepEqual(reads.map((r) => r.table), ['strava_activities', 'garmin_activities']);
  assert.equal(reads[1].q.athlete_code, 'in.("KARL")', 'only allowlisted athletes are asked about Garmin');
  assert.doesNotMatch(reads[1].q.select, /avg_hr|kcal|device|summary,|summary$/);
  assert.equal(due.KARL.strava.length, 1);
  assert.equal(due.KARL.strava[0].provider, 'garmin');
  const message = buildStravaMessage(due.KARL.strava[0]);
  assert.equal(message.dedupeKey, 'synced:run:2026-11-06T06:45');
  assert.equal(buildStravaMessage({ ...KARL_STRAVA, dedupe_key: 'synced:run:2026-11-06T06:45' }).dedupeKey, message.dedupeKey, 'a later Strava copy has the same key, so the dedupe read suppresses it');
  assert.equal(due.THOMAS.strava[0].dedupe_key, undefined);
  assert.equal(buildStravaMessage(due.THOMAS.strava[0]).dedupeKey, 'strava:1', 'everyone else keeps the Strava id key');
  const [push] = buildAthleteMessages(placed('KARL'), { ...due.KARL, sessions: [], callsToday: [], coach: [], heldMessages: [] }, { nowMs: NOW }).filter((m) => m.type === 'strava');
  assert.equal(push.tag, 'dp-synced-run-2026-11-06T06-45');
});

test('synced push: nobody off the allowlist triggers a Garmin read', async () => {
  const due = { THOMAS: { strava: [] } };
  const tables = [];
  await addStravaSynced(due, [placed('THOMAS')], { nowMs: NOW, read: async (table) => { tables.push(table); return []; } });
  assert.deepEqual(tables, ['strava_activities']);
});

test('evening nudge: a Garmin activity today counts as logged for an allowlisted athlete only', async () => {
  const evening = { iso: '2026-11-06', dow: 5, hour: 19, minute: 30 };
  const athletes = [placed('KARL', evening), placed('THOMAS', evening)];
  const reads = [];
  const read = async (table, q) => {
    reads.push(table);
    if (table === 'planned_sessions') return [{ athlete_code: 'KARL', title: 'Easy', session_type: 'Easy', status: 'Planned' }, { athlete_code: 'THOMAS', title: 'Easy', session_type: 'Easy', status: 'Planned' }];
    if (table === 'garmin_activities' && q.local_date) { assert.equal(q.athlete_code, 'in.("KARL")'); assert.equal(q.local_date, 'eq.2026-11-06'); return [{ athlete_code: 'KARL' }]; }
    return [];
  };
  const due = await loadReminderInputs(athletes, { read, nowMs: Date.parse('2026-11-06T09:00:00Z'), garminAvailable: (code) => code === 'KARL' });
  assert.ok(athletes[0].windows.logging, 'test is in the logging window');
  assert.deepEqual(due.KARL.unlogged, [], 'Garmin recorded it, no nudge');
  assert.ok(due.THOMAS.unlogged && due.THOMAS.unlogged.length, 'Thomas is still nudged');
  assert.ok(reads.includes('garmin_activities'));
});

test('the weekly review card names Garmin when Garmin measured the week', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../public/js/07-progress.js', import.meta.url), 'utf8');
  assert.match(source, /garmin:'from Garmin',garmin_strava:'from Garmin and Strava'/);
});
