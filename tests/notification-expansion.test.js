import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CAP_EXEMPT_TYPES, DAILY_PUSH_CAP, FUEL_HOUR, FUEL_MINUTE, QUIET_HOUR, READINESS_HOUR,
  buildCheckinOverdueMessage, buildFuelMessage, buildNextWeekMessage, buildReadinessMessage,
  buildStravaMessage, isCapExempt, isQuietTime, partitionCoachChanges,
} from '../api/_lib/notification-rules.js';
import { _test } from '../api/reminders.js';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const reminders = readFileSync(join(root, 'api', 'reminders.js'), 'utf8');
const notify = readFileSync(join(root, 'api', 'notify.js'), 'utf8');
const loginGoals = readFileSync(join(root, 'public', 'js', '02-login-goals.js'), 'utf8');

// ── The cap governs automated reminders only ─────────────────────────────────

test('coach messages, programme changes, calls and the weekly review are never capped', () => {
  for (const type of ['custom', 'coach', 'calls', 'weekly_review']) assert.equal(isCapExempt(type), true, type);
  for (const type of ['sessions', 'logging', 'checkins', 'photos', 'strava', 'readiness', 'fuel']) {
    assert.equal(isCapExempt(type), false, type);
  }
  assert.equal(DAILY_PUSH_CAP, 5);
});

test('the daily count ignores exempt pushes and the loop never charges them', () => {
  const counter = reminders.slice(reminders.indexOf('async function pushedToday'), reminders.indexOf('async function unreadSuppressed'));
  assert.match(counter, /type: `not\.in\.\(\$\{CAP_EXEMPT_TYPES\.join\(','\)\}\)`/);
  assert.match(reminders, /const exempt = isCapExempt\(message\.type\);/);
  assert.match(reminders, /\(exempt \|\| pushCount < DAILY_PUSH_CAP\)/);
  assert.match(reminders, /if \(!exempt\) pushCount\+\+;/);
  assert.deepEqual([...CAP_EXEMPT_TYPES].sort(), ['calls', 'coach', 'custom', 'weekly_review']);
});

test('a coach message from the dashboard is not held back by the cap', () => {
  assert.doesNotMatch(notify, /DAILY_PUSH_CAP/);
  assert.match(notify, /if \(!vapidReady \|\| isQuietTime\(now\)\) continue;/);
});

// ── Quiet hours hold coach messages instead of dropping them ─────────────────

test('held coach messages are read only outside quiet hours and pushed as the existing row', async () => {
  let seen;
  const due = { KARL: { heldMessages: [] } };
  await _test.addHeldMessages(due, 'in.("KARL")', async (table, query) => {
    seen = { table, query };
    return [{ id: 'n1', athlete_code: 'KARL', type: 'custom', title: 'Great work', body: 'Nailed it', url: '/' }];
  }, Date.parse('2026-09-28T20:00:00Z'));
  assert.equal(seen.table, 'athlete_notifications');
  assert.equal(seen.query.type, 'eq.custom');
  assert.equal(seen.query.pushed_at, 'is.null');
  assert.equal(seen.query.read_at, 'is.null');
  assert.equal(seen.query.dismissed_at, 'is.null');
  assert.equal(seen.query.created_at, 'gte.2026-09-28T08:00:00.000Z', 'twelve hours back, no further');
  assert.equal(due.KARL.heldMessages.length, 1);
  assert.match(reminders, /if \(!isQuietTime\(now\)\) await addHeldMessages\(due, list\);/);
  assert.match(reminders, /for \(const held of athleteDue\.heldMessages \|\| \[\]\)[\s\S]{0,120}pushInboxMessage\(athlete, held,/);
});

// ── Readiness, fuel, overdue check-in ────────────────────────────────────────

function dueFor(codes) {
  const due = {};
  codes.forEach((code) => { due[code] = { readiness: false, fuel: false, checkinOverdue: false }; });
  return due;
}

test('the body-check nudge fires at 10am only for athletes with nothing logged', async () => {
  const codes = ['KARL', 'THOMAS'];
  const reads = [];
  const read = async (table, query) => { reads.push(table); return table === 'daily_body_logs' ? [{ athlete_code: 'THOMAS' }] : []; };
  let due = dueFor(codes);
  await _test.addDailyNudges(due, codes, { iso: '2026-09-28', dow: 1, hour: 9, minute: 59 }, 'list', read);
  assert.deepEqual(reads, [], 'no read outside its minute');
  due = dueFor(codes);
  await _test.addDailyNudges(due, codes, { iso: '2026-09-28', dow: 1, hour: READINESS_HOUR, minute: 0 }, 'list', read);
  assert.equal(due.KARL.readiness, true);
  assert.equal(due.THOMAS.readiness, false);
});

test('the fuel nudge is only for athletes on macros with nothing logged today', async () => {
  const codes = ['KARL', 'THOMAS', 'JOJO'];
  const read = async (table) => {
    if (table === 'nutrition_plans') return [{ athlete_code: 'KARL' }, { athlete_code: 'THOMAS' }];
    if (table === 'daily_nutrition_logs') return [{ athlete_code: 'THOMAS' }];
    return [];
  };
  const due = dueFor(codes);
  await _test.addDailyNudges(due, codes, { iso: '2026-09-28', dow: 1, hour: FUEL_HOUR, minute: FUEL_MINUTE }, 'list', read);
  assert.equal(due.KARL.fuel, true);
  assert.equal(due.THOMAS.fuel, false, 'already logged');
  assert.equal(due.JOJO.fuel, false, 'no macros set');
  assert.ok(FUEL_HOUR * 60 + FUEL_MINUTE < QUIET_HOUR * 60, 'lands before quiet hours');
});

test('the overdue check-in fires Monday midday only when last week is not in', async () => {
  const codes = ['KARL', 'THOMAS'];
  const read = async () => [{ athlete_code: 'THOMAS' }];
  let due = dueFor(codes);
  await _test.addDailyNudges(due, codes, { iso: '2026-09-28', dow: 1, hour: 12, minute: 0 }, 'list', read);
  assert.equal(due.KARL.checkinOverdue, true);
  assert.equal(due.THOMAS.checkinOverdue, false);
  due = dueFor(codes);
  await _test.addDailyNudges(due, codes, { iso: '2026-09-29', dow: 2, hour: 12, minute: 0 }, 'list', read);
  assert.equal(due.KARL.checkinOverdue, false, 'Tuesday is not Monday');
});

test('the new nudges deep-link to the right place and read calmly', () => {
  assert.equal(buildReadinessMessage('2026-09-28').url, '/?tab=log&log=body');
  assert.equal(buildFuelMessage('2026-09-28').url, '/?tab=log&log=fuel');
  assert.equal(buildCheckinOverdueMessage('2026-09-28').url, '/?tab=checkin');
  assert.equal(buildReadinessMessage('2026-09-28').dedupeKey, 'readiness:2026-09-28');
  assert.equal(buildFuelMessage('2026-09-28').dedupeKey, 'fuel:2026-09-28');
  assert.equal(buildCheckinOverdueMessage('2026-09-28').dedupeKey, 'checkin-overdue:2026-09-28');
  const now = { hour: READINESS_HOUR, minute: 0 };
  assert.equal(isQuietTime(now), false);
  assert.match(loginGoals, /deepTab==='log'[\s\S]{0,300}openLogSheet\(\['session','body','fuel'\]\.indexOf\(deepLog\)>=0\?deepLog:undefined\)/);
});

// ── Strava synced ────────────────────────────────────────────────────────────

const WALL = { iso: '2026-09-28', dow: 1, hour: 7, minute: 30 };

test('a fresh run synced from Strava is announced; strength and old activities are not', async () => {
  const due = { THOMAS: { strava: [] } };
  let query;
  await _test.addStravaSynced(due, ['THOMAS'], WALL, 'list', async (table, q) => {
    query = { table, q };
    return [
      { strava_activity_id: 1, athlete_code: 'THOMAS', sport_type: 'Run', start_date_local: '2026-09-28T06:10:00+00:00', distance_m: 11200 },
      { strava_activity_id: 2, athlete_code: 'THOMAS', sport_type: 'WeightTraining', start_date_local: '2026-09-28T06:00:00+00:00' },
      { strava_activity_id: 3, athlete_code: 'THOMAS', sport_type: 'Run', start_date_local: '2026-09-20T06:00:00+00:00' },
      { strava_activity_id: 4, athlete_code: 'SOMEONE', sport_type: 'Run', start_date_local: '2026-09-28T06:00:00+00:00' },
    ];
  }, Date.parse('2026-09-27T22:00:00Z'));
  assert.equal(query.table, 'strava_activities');
  assert.equal(query.q.synced_at, 'gte.2026-09-27T21:15:00.000Z', 'only rows synced in the last 45 minutes');
  assert.doesNotMatch(query.q.select, /summary|detail/, 'the raw Strava payload is never read here');
  assert.deepEqual(due.THOMAS.strava.map((row) => row.strava_activity_id), [1]);
});

test('the Strava message names the distance and time, once per activity', () => {
  const message = buildStravaMessage({
    strava_activity_id: 987654, sport_type: 'Run', start_date_local: '2026-09-28T06:10:00+00:00',
    distance_m: 11234, moving_time_s: 4212,
  });
  assert.equal(message.type, 'strava');
  assert.equal(message.title, 'Run synced · 11.2 km');
  assert.match(message.body, /^11\.2 km in 1:10:12\./);
  assert.equal(message.url, '/?tab=training&date=2026-09-28');
  assert.equal(message.dedupeKey, 'strava:987654');
  assert.equal(buildStravaMessage({ strava_activity_id: 'x' }), null);
});

// ── Next week is live ────────────────────────────────────────────────────────

test('sessions published for next week push; a block further out stays in the inbox', () => {
  const changes = [
    { source: 'training', changed_at: '2026-09-25T01:00:00Z', detail: { item: 'Easy Run', action: 'added', date: '2026-10-06' } },
    { source: 'training', changed_at: '2026-09-25T01:00:01Z', detail: { item: 'Long Run', action: 'added', date: '2026-10-05' } },
    { source: 'training', changed_at: '2026-09-25T01:00:02Z', detail: { item: 'Tempo', action: 'added', date: '2026-10-20' } },
  ];
  const split = partitionCoachChanges(changes, '2026-09-26');
  assert.equal(split.near.length, 0);
  assert.equal(split.nextWeek.length, 2);
  assert.equal(split.future.length, 1);
  const message = buildNextWeekMessage(split.nextWeek, '2026-09-26');
  assert.equal(message.type, 'coach');
  assert.equal(message.title, 'Next week is live');
  assert.match(message.body, /5 Oct/);
  assert.notEqual(message.push, false);
  assert.equal(buildNextWeekMessage([], '2026-09-26'), null);
  assert.match(reminders, /const nextWeek = buildNextWeekMessage\(partitioned\.nextWeek, now\.iso\);/);
});

test('no new message uses an em dash', () => {
  const copy = [
    buildReadinessMessage('d'), buildFuelMessage('d'), buildCheckinOverdueMessage('d'),
    buildStravaMessage({ strava_activity_id: 1, sport_type: 'Ride', distance_m: 40000, moving_time_s: 5000 }),
    buildNextWeekMessage([{ source: 'training', changed_at: 'x', detail: { date: '2026-10-05' } }], '2026-09-26'),
  ];
  copy.forEach((m) => assert.doesNotMatch(`${m.title} ${m.body}`, /—/));
});
