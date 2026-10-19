import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import handler, { planReminderRun } from '../api/reminders.js';
import { acquireLease, releaseLease } from '../api/_lib/job-lease.js';
import {
  CALL_SOON_MAX_MINUTES, CALL_SOON_MIN_MINUTES, REMINDER_CADENCE_MINUTES, REMINDER_WINDOW_MINUTES,
  deliveryAction, dedupeKeyFor, localNow, zoneWindows,
} from '../api/_lib/reminder-plan.js';
import {
  CHECKIN_OVERDUE_HOUR, CHECKIN_OVERDUE_MINUTE, FUEL_HOUR, FUEL_MINUTE, LOGGING_HOUR, LOGGING_MINUTE,
  MORNING_HOUR, MORNING_MINUTE, READINESS_HOUR, READINESS_MINUTE, WEEKLY_REVIEW_HOUR, WEEKLY_REVIEW_MINUTE,
} from '../api/_lib/notification-rules.js';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const leaseMigration = readFileSync(join(root, 'supabase', 'migrations', '20261020090000_job_leases.sql'), 'utf8');
const scheduleMigration = readFileSync(join(root, 'supabase', 'migrations', '20261020092000_reminder_schedule_every_five_minutes.sql'), 'utf8');

// ── A small in-memory PostgREST ─────────────────────────────────────────────
// Enough of the filter grammar the reminder planner uses (eq, in, gte, lt,
// is.null, not.is.null, like, or=(dedupe_key.in,and(...))) to count reads and
// to keep state between simulated runs. Every read is recorded by table.
function parseIn(value) {
  const inner = value.replace(/^in\.\(/, '').replace(/\)$/, '');
  return inner.match(/"(?:[^"\\]|\\.)*"|[^,]+/g).map((v) => v.replace(/^"|"$/g, '').replace(/\\"/g, '"'));
}
function matches(row, key, cond) {
  const value = row[key];
  if (cond.startsWith('eq.')) return String(value) === cond.slice(3);
  if (cond.startsWith('in.(')) return parseIn(cond).includes(String(value));
  if (cond.startsWith('gte.')) return value != null && String(value) >= cond.slice(4);
  if (cond.startsWith('gt.')) return value != null && String(value) > cond.slice(3);
  if (cond.startsWith('lt.')) return value != null && String(value) < cond.slice(3);
  if (cond === 'is.null') return value == null;
  if (cond === 'not.is.null') return value != null;
  if (cond.startsWith('like.')) return String(value || '').startsWith(cond.slice(5).replace(/\*$/, ''));
  if (cond.startsWith('not.in.(')) return !parseIn(cond.slice(4)).includes(String(value));
  return true;
}
function orMatches(row, expression) {
  // (dedupe_key.in.(...),and(local_date.in.(...),pushed_at.not.is.null))
  const body = expression.slice(1, -1);
  const andAt = body.indexOf(',and(');
  const first = andAt >= 0 ? body.slice(0, andAt) : body;
  const second = andAt >= 0 ? body.slice(andAt + 5, -1) : '';
  const ok1 = first.startsWith('dedupe_key.') && matches(row, 'dedupe_key', first.slice('dedupe_key.'.length));
  let ok2 = false;
  if (second) {
    const dateAt = second.indexOf('),pushed_at');
    ok2 = matches(row, 'local_date', second.slice('local_date.'.length, dateAt + 1)) && row.pushed_at != null;
  } else if (first.startsWith('and(')) {
    ok2 = false;
  }
  return ok1 || ok2;
}
function fakeDb(tables) {
  const reads = [];
  const read = async (table, query) => {
    reads.push({ table, query });
    const rows = tables[table] || [];
    return rows.filter((row) => Object.entries(query).every(([key, cond]) => {
      if (['select', 'order', 'limit', 'and'].includes(key)) return true;
      if (key === 'or') return orMatches(row, cond);
      return matches(row, key, String(cond));
    }));
  };
  return { read, reads, tables, count: (table) => reads.filter((r) => r.table === table).length };
}

// Ten athletes in Adelaide, all with a device; managed (receive everything).
function roster(n = 10, tz = 'Australia/Adelaide') {
  const athletes = [];
  const subs = [];
  for (let i = 0; i < n; i++) {
    const code = `ATH${i}`;
    athletes.push({ code, active: true, notifications_managed: true });
    subs.push({ id: `s${i}`, athlete_code: code, endpoint: `https://push.example/${i}`, p256dh: 'k', auth: 'a', timezone: tz, user_agent: `ua-${i}`, last_sent: {}, created_at: '2026-10-01T00:00:00Z' });
  }
  return { athletes, push_subscriptions: subs };
}

// Adelaide is UTC+10:30 in October (daylight saving).
const adelaide = (local) => new Date(Date.parse(`${local}+10:30`));

// ── 1. Single flight ────────────────────────────────────────────────────────

function cronRequest() {
  return { method: 'GET', headers: { authorization: 'Bearer cron-secret' }, query: {} };
}
function response() {
  const state = { statusCode: 0, payload: null };
  const res = {
    setHeader() {},
    status(code) { state.statusCode = code; return res; },
    json(payload) { state.payload = payload; return res; },
    end() { return res; },
  };
  return { res, state };
}
async function withSupabase(fetchImpl, run) {
  const saved = { fetch: globalThis.fetch, url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_KEY, secret: process.env.REMINDERS_CRON_SECRET };
  globalThis.fetch = fetchImpl;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'service-key';
  process.env.REMINDERS_CRON_SECRET = 'cron-secret';
  const originalLog = console.log;
  console.log = () => {};
  try { return await run(); } finally {
    console.log = originalLog;
    globalThis.fetch = saved.fetch;
    process.env.SUPABASE_URL = saved.url;
    process.env.SUPABASE_SERVICE_KEY = saved.key;
    if (saved.secret === undefined) delete process.env.REMINDERS_CRON_SECRET; else process.env.REMINDERS_CRON_SECRET = saved.secret;
  }
}

test('a run that cannot win the lease exits 200 without a single reminder query', async () => {
  const urls = [];
  const { res, state } = response();
  await withSupabase(async (url) => {
    urls.push(String(url));
    if (String(url).includes('/rpc/acquire_job_lease')) return { ok: true, status: 200, text: async () => 'false' };
    throw new Error(`unexpected request ${url}`);
  }, () => handler(cronRequest(), res));
  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.payload, { ok: true, skipped: 'lease_held' });
  assert.equal(urls.length, 1, 'only the lease RPC was called');
});

test('a lease the database cannot grant in time also skips the run (no pile-up behind a slow database)', async () => {
  const { res, state } = response();
  let calls = 0;
  await withSupabase(async (url) => {
    calls++;
    return { ok: false, status: 503, text: async () => JSON.stringify({ message: 'overloaded' }) };
  }, () => handler(cronRequest(), res));
  assert.equal(state.statusCode, 200);
  assert.equal(state.payload.skipped, 'lease_unavailable');
  assert.equal(calls, 1);
});

test('the winning run releases its lease with counts only, even when the run fails', async () => {
  const released = [];
  const { res, state } = response();
  await withSupabase(async (url, init) => {
    const target = String(url);
    if (target.includes('/rpc/acquire_job_lease')) return { ok: true, status: 200, text: async () => 'true' };
    if (target.includes('/rpc/release_job_lease')) { released.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => 'true' }; }
    return { ok: false, status: 500, text: async () => JSON.stringify({ message: 'boom' }) };
  }, () => handler(cronRequest(), res));
  assert.equal(state.statusCode, 503, 'an upstream failure is a transient 503');
  assert.equal(released.length, 1, 'released in finally');
  assert.equal(released[0].p_outcome, 'upstream');
  assert.doesNotMatch(JSON.stringify(released[0].p_counts), /ATH|@|Bearer/);
});

test('lease wrapper: held, granted, missing function (pre-migration) and timeout', async () => {
  assert.deepEqual(await acquireLease('j', 'o', 120, { call: async () => false }), { acquired: false, reason: 'held' });
  assert.deepEqual(await acquireLease('j', 'o', 120, { call: async () => true }), { acquired: true });
  const missing = Object.assign(new Error('not found'), { kind: 'missing_function' });
  assert.deepEqual(await acquireLease('j', 'o', 120, { call: async () => { throw missing; } }), { acquired: true, degraded: 'lease_function_missing' });
  const timeout = Object.assign(new Error('slow'), { kind: 'timeout' });
  assert.deepEqual(await acquireLease('j', 'o', 120, { call: async () => { throw timeout; } }), { acquired: false, reason: 'unavailable', kind: 'timeout' });
  assert.equal(await releaseLease('j', 'o', 'ok', {}, { call: async () => { throw timeout; } }), false, 'a failed release never throws');
});

test('the lease SQL is atomic, self-expiring and owner-checked', () => {
  // One statement decides the winner: Postgres serialises ON CONFLICT on the row.
  assert.match(leaseMigration, /on conflict \(job_name\) do update[\s\S]*where l\.owner is null or l\.expires_at is null or l\.expires_at <= v_now;/);
  // An expired lease (crashed function) is taken over by the next run.
  assert.match(leaseMigration, /expires_at = excluded\.expires_at/);
  // Release only by the current owner, so a late release cannot free a newer run.
  assert.match(leaseMigration, /where job_name = p_job\s+and owner = p_owner/);
  assert.match(leaseMigration, /revoke all on function public\.acquire_job_lease\(text, text, integer\) from public, anon, authenticated;/);
  assert.doesNotMatch(leaseMigration, /pg_advisory_lock|pg_try_advisory_lock/, 'no session-scoped lock');
});

// ── 2. Inactive zones and the per-athlete history read ─────────────────────

const WINDOW_TABLES = ['planned_sessions', 'training_session_logs', 'weekly_checkins', 'daily_body_logs', 'nutrition_plans', 'daily_nutrition_logs'];

test('a zone outside every reminder window makes no time-window reads at all', async () => {
  const db = fakeDb(roster());
  const plan = await planReminderRun({ read: db.read, at: adelaide('2026-10-20T14:17:00') });
  assert.equal(plan.stats.activeZones, 0);
  for (const table of WINDOW_TABLES) assert.equal(db.count(table), 0, `${table} must not be read`);
  assert.equal(db.count('athlete_notifications'), 1, 'only the single batched held-message probe');
  assert.equal(plan.candidates.length, 0);
  // Roster (2) + bookings + coach changes + Strava + held messages: fixed,
  // whatever the athlete count.
  assert.equal(db.reads.length, 6);
});

test('an athlete with no candidate message never reaches the notification-history read', async () => {
  const tables = roster(3);
  // Only ATH0 has a session today; morning nudges go to everyone with a
  // morning message, so remove the other two from the morning by sending it.
  tables.push_subscriptions[1].last_sent = { morning: '2026-10-21' };
  tables.push_subscriptions[2].last_sent = { morning: '2026-10-21' };
  tables.planned_sessions = [{ athlete_code: 'ATH0', planned_date: '2026-10-21', publish_state: 'published', title: 'Easy Run', status: 'Planned' }];
  // ATH2 only has a coach message held through quiet hours: it is pushed as
  // the existing row, so it needs no dedupe lookup either.
  tables.athlete_notifications = [{ id: 'h2', athlete_code: 'ATH2', type: 'custom', created_at: '2026-10-20T12:00:00Z', title: 'Hi', body: 'x', url: '/' }];
  const db = fakeDb(tables);
  const plan = await planReminderRun({ read: db.read, at: adelaide('2026-10-21T05:30:00') });
  assert.deepEqual(plan.candidates.map((c) => c.athlete.code), ['ATH0', 'ATH2']);
  assert.equal(plan.candidates[1].messages.length, 0);
  const dedupe = db.reads.filter((r) => r.table === 'athlete_notifications' && r.query.or);
  assert.equal(dedupe.length, 1, 'one batched dedupe read');
  assert.equal(dedupe[0].query.athlete_code, 'in.("ATH0")', 'athletes without a candidate are not in it');

  // Nobody with a candidate: no dedupe read at all.
  const quiet = fakeDb(roster(3));
  await planReminderRun({ read: quiet.read, at: adelaide('2026-10-21T14:00:00') });
  assert.equal(quiet.reads.filter((r) => r.table === 'athlete_notifications' && r.query.or).length, 0);
});

test('window inputs are read once per run for the whole zone, not per athlete', async () => {
  const tables = roster(25);
  tables.planned_sessions = tables.athletes.map((a) => ({ athlete_code: a.code, planned_date: '2026-10-21', publish_state: 'published', title: 'Tempo', status: 'Planned' }));
  const db = fakeDb(tables);
  await planReminderRun({ read: db.read, at: adelaide('2026-10-21T19:30:00') });
  assert.equal(db.count('planned_sessions'), 1);
  assert.equal(db.count('training_session_logs'), 1);
  assert.equal(db.count('strava_activities'), 2, 'one "logged today" read and one fresh-sync probe');
  assert.equal(db.count('athlete_notifications'), 2, 'held messages + one batched dedupe, for 25 athletes');
});

// ── 3. Dedupe across a widened window ──────────────────────────────────────

test('three runs inside one 15-minute window send the morning reminder exactly once', async () => {
  const tables = roster(4);
  tables.athlete_notifications = [];
  tables.planned_sessions = tables.athletes.map((a) => ({ athlete_code: a.code, planned_date: '2026-10-21', publish_state: 'published', title: 'Long Run', status: 'Planned' }));
  const db = fakeDb(tables);
  let inserted = 0;
  for (const minute of ['05:30', '05:35', '05:40']) {
    const plan = await planReminderRun({ read: db.read, at: adelaide(`2026-10-21T${minute}:00`) });
    for (const { athlete, messages } of plan.candidates) {
      for (const message of messages) {
        const key = dedupeKeyFor(message, athlete.now.iso);
        const existing = plan.delivery.existing.get(`${athlete.code}|${key}`);
        const action = deliveryAction(message, existing, { quiet: athlete.windows.quiet, canPush: true });
        if (action === 'insert') {
          inserted++;
          // Delivered and pushed. last_sent is deliberately NOT updated, so
          // only the inbox dedupe stands between this and a second push.
          tables.athlete_notifications.push({ id: `n${inserted}`, athlete_code: athlete.code, type: message.type, dedupe_key: key, local_date: athlete.now.iso, pushed_at: new Date().toISOString() });
        } else {
          assert.equal(action, 'skip');
        }
      }
    }
  }
  assert.equal(inserted, 4, 'one morning message per athlete across all three runs');
});

test('a row stored but not yet pushed is retried, never re-inserted; dismissed or pushed rows are left alone', () => {
  const message = { type: 'logging', dedupeKey: 'logging:2026-10-21' };
  assert.equal(deliveryAction(message, undefined, { quiet: false, canPush: true }), 'insert');
  assert.equal(deliveryAction(message, { id: 'n', pushed_at: '2026-10-21T09:00:00Z' }, { quiet: false, canPush: true }), 'skip');
  assert.equal(deliveryAction(message, { id: 'n', dismissed_at: '2026-10-21T09:00:00Z' }, { quiet: false, canPush: true }), 'skip');
  assert.equal(deliveryAction(message, { id: 'n' }, { quiet: false, canPush: true }), 'push-existing');
  assert.equal(deliveryAction(message, { id: 'n' }, { quiet: false, canPush: false }), 'skip', 'no device: nothing new to do');
  assert.equal(deliveryAction({ ...message, push: false }, { id: 'n' }, { quiet: false, canPush: true }), 'skip', 'inbox-only stays inbox-only');
});

// ── 4. Quiet hours and held coach messages ─────────────────────────────────

test('quiet hours: stored rows wait, then go out once quiet ends', () => {
  const message = { type: 'coach', dedupeKey: 'coach:x' };
  const late = zoneWindows({ iso: '2026-10-21', dow: 2, hour: 22, minute: 10 });
  const early = zoneWindows({ iso: '2026-10-22', dow: 3, hour: 5, minute: 25 });
  const dawn = zoneWindows({ iso: '2026-10-22', dow: 3, hour: 5, minute: 30 });
  assert.equal(late.quiet, true);
  assert.equal(early.quiet, true);
  assert.equal(dawn.quiet, false);
  assert.equal(deliveryAction(message, { id: 'n' }, { quiet: late.quiet, canPush: true }), 'skip');
  assert.equal(deliveryAction(message, { id: 'n' }, { quiet: dawn.quiet, canPush: true }), 'push-existing');
});

test('held coach messages are only looked up for athletes outside quiet hours with a device', async () => {
  const tables = roster(2);
  tables.push_subscriptions = [tables.push_subscriptions[0]]; // ATH1 has no device
  tables.athlete_notifications = [{ id: 'h1', athlete_code: 'ATH0', type: 'custom', created_at: '2026-10-21T10:00:00Z', title: 'Nice', body: 'Well run', url: '/' }];
  const night = fakeDb(tables);
  await planReminderRun({ read: night.read, at: adelaide('2026-10-21T23:00:00') });
  assert.equal(night.reads.filter((r) => r.table === 'athlete_notifications' && r.query.type === 'eq.custom').length, 0, 'nothing asked during quiet hours');
  const morning = fakeDb(tables);
  const plan = await planReminderRun({ read: morning.read, at: adelaide('2026-10-22T05:31:00') });
  const held = morning.reads.find((r) => r.table === 'athlete_notifications' && r.query.type === 'eq.custom');
  assert.equal(held.query.athlete_code, 'in.("ATH0")');
  assert.equal(plan.candidates.find((c) => c.athlete.code === 'ATH0').heldMessages.length, 1);
});

// ── 5. A five-minute cadence cannot miss a reminder ────────────────────────

test('every time-of-day reminder lands in at least two five-minute runs, in every zone offset', () => {
  assert.equal(REMINDER_CADENCE_MINUTES, 5);
  assert.ok(REMINDER_WINDOW_MINUTES >= 2 * REMINDER_CADENCE_MINUTES, 'one skipped run must not lose a reminder');
  assert.match(scheduleMigration, /'\*\/5 \* \* \* \*'/);
  // [window, hour, minute, local date it must fire on]. 2026-10-19 is a Monday.
  const targets = [
    ['morning', MORNING_HOUR, MORNING_MINUTE, '2026-10-20'], ['logging', LOGGING_HOUR, LOGGING_MINUTE, '2026-10-20'],
    ['readiness', READINESS_HOUR, READINESS_MINUTE, '2026-10-20'], ['fuel', FUEL_HOUR, FUEL_MINUTE, '2026-10-20'],
    ['weeklyReview', WEEKLY_REVIEW_HOUR, WEEKLY_REVIEW_MINUTE, '2026-10-19'],
    ['checkinOverdue', CHECKIN_OVERDUE_HOUR, CHECKIN_OVERDUE_MINUTE, '2026-10-19'],
  ];
  // Real offsets in use or plausible (Adelaide +10:30 in October, Kathmandu
  // +5:45, Chatham +13:45), and lag between pg_cron's tick and the request.
  const zones = ['Australia/Adelaide', 'Australia/Sydney', 'Australia/Perth', 'Asia/Kathmandu', 'Pacific/Chatham', 'Europe/London'];
  for (const tz of zones) {
    for (const lagSeconds of [0, 20, 55]) {
      for (const [name, , , day] of targets) {
        let hits = 0;
        for (let t = Date.parse('2026-10-17T00:00:00Z'); t < Date.parse('2026-10-22T00:00:00Z'); t += REMINDER_CADENCE_MINUTES * 60000) {
          const now = localNow(tz, new Date(t + lagSeconds * 1000));
          if (now.iso === day && zoneWindows(now)[name]) hits++;
        }
        assert.ok(hits >= 2, `${name} in ${tz} (lag ${lagSeconds}s) had ${hits} eligible runs`);
        assert.ok(hits <= 3, `${name} in ${tz} stays inside its window (${hits} runs)`);
      }
    }
  }
});

test('"call in 2 hours" covers every five-minute phase', () => {
  assert.ok(CALL_SOON_MAX_MINUTES - CALL_SOON_MIN_MINUTES >= 2 * REMINDER_CADENCE_MINUTES);
  assert.ok(CALL_SOON_MIN_MINUTES >= 105 && CALL_SOON_MAX_MINUTES <= 125, 'still reads as two hours');
});

// ── 6. Daily budget ────────────────────────────────────────────────────────
// A full simulated day at the five-minute cadence for ten athletes. The old
// every-minute loop made ~27,900 requests a day for this roster, ~15,350 of
// them to athlete_notifications (measured against the same in-memory data;
// see docs/reminder-scheduling.md). These ceilings keep the gain from eroding.
test('a full day of planning stays inside the read budget', async () => {
  const tables = roster(10);
  tables.planned_sessions = tables.athletes.map((a) => ({ athlete_code: a.code, planned_date: '2026-10-19', publish_state: 'published', title: 'Tempo', status: 'Planned' }));
  tables.athlete_notifications = [];
  const db = fakeDb(tables);
  const start = adelaide('2026-10-19T00:00:00').getTime();
  for (let i = 0; i < 288; i++) await planReminderRun({ read: db.read, at: new Date(start + i * 5 * 60000) });
  const notificationsReads = db.count('athlete_notifications');
  assert.ok(notificationsReads <= 400, `athlete_notifications reads/day: ${notificationsReads}`);
  assert.ok(db.reads.length <= 2000, `total reads/day: ${db.reads.length}`);
  assert.ok(db.count('planned_sessions') <= 12, 'planned sessions only inside the morning and evening windows');
});
