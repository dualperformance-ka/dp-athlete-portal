import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_DEVICES_PER_ATHLETE,
  deviceKey,
  groupByAthlete,
  mergeLastSent,
  newestPrefs,
  selectLiveDevices,
} from '../api/_lib/push-devices.js';

const root = new URL('..', import.meta.url).pathname;
const remindersSource = readFileSync(join(root, 'api', 'reminders.js'), 'utf8');

// The real user agents behind the duplicate-delivery bug: one iPhone, seen
// across three Safari point releases.
const IPHONE_265 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1';
const IPHONE_2652 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Mobile/15E148 Safari/604.1';
const IPHONE_266 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1';

function row(overrides) {
  return {
    id: overrides.endpoint,
    athlete_code: 'KARL',
    user_agent: IPHONE_266,
    prefs: { sessions: true, checkins: true, photos: true, coach: true },
    last_sent: {},
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

test('a Safari point release is the same phone, not a new one', () => {
  assert.equal(deviceKey(IPHONE_265), deviceKey(IPHONE_266));
  assert.equal(deviceKey(IPHONE_2652), deviceKey(IPHONE_266));
  assert.notEqual(deviceKey(IPAD), deviceKey(IPHONE_266));
  assert.equal(deviceKey(''), 'unknown');
});

test('Chrome and Edge are not mistaken for Safari', () => {
  const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
  const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';
  assert.equal(deviceKey(chrome), 'mac|chrome');
  assert.equal(deviceKey(edge), 'windows|edge');
});

test('one iPhone with thirteen leftover rows collapses to a single device', () => {
  // Exactly the shape of the live data: same handset, thirteen endpoints.
  const rows = Array.from({ length: 13 }, (_, i) => row({
    endpoint: 'https://web.push.apple.com/karl-' + i,
    user_agent: i % 3 === 0 ? IPHONE_265 : IPHONE_266,
    updated_at: '2026-08-' + String(i + 5).padStart(2, '0') + 'T06:30:00.000Z',
  }));

  const { keep, drop } = selectLiveDevices(rows);
  assert.equal(keep.length, 1, 'one physical device should survive');
  assert.equal(drop.length, 12);
  assert.equal(keep[0].endpoint, 'https://web.push.apple.com/karl-12', 'the most recently active row wins');
});

test('genuinely separate devices are both kept', () => {
  const rows = [
    row({ endpoint: 'phone', user_agent: IPHONE_266, updated_at: '2026-08-19T00:00:00.000Z' }),
    row({ endpoint: 'tablet', user_agent: IPAD, updated_at: '2026-08-18T00:00:00.000Z' }),
  ];
  const { keep, drop } = selectLiveDevices(rows);
  assert.equal(keep.length, 2);
  assert.equal(drop.length, 0);
});

test('devices per athlete are capped, newest first', () => {
  const rows = [
    row({ endpoint: 'a', user_agent: IPHONE_266, updated_at: '2026-08-01T00:00:00.000Z' }),
    row({ endpoint: 'b', user_agent: IPAD, updated_at: '2026-08-02T00:00:00.000Z' }),
    row({ endpoint: 'c', user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15', updated_at: '2026-08-03T00:00:00.000Z' }),
    row({ endpoint: 'd', user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', updated_at: '2026-08-04T00:00:00.000Z' }),
  ];
  const { keep } = selectLiveDevices(rows);
  assert.equal(keep.length, MAX_DEVICES_PER_ATHLETE);
  assert.deepEqual(keep.map((r) => r.endpoint), ['d', 'c', 'b']);
});

test('the device that just subscribed is always kept', () => {
  const rows = [
    row({ endpoint: 'old', user_agent: IPHONE_266, updated_at: '2026-08-19T00:00:00.000Z' }),
    // A fresh row whose timestamps have not been written yet.
    row({ endpoint: 'fresh', user_agent: IPHONE_265, updated_at: null, created_at: null }),
  ];
  const { keep, drop } = selectLiveDevices(rows, { pinnedEndpoint: 'fresh' });
  assert.deepEqual(keep.map((r) => r.endpoint), ['fresh']);
  assert.deepEqual(drop.map((r) => r.endpoint), ['old']);
});

test('a new endpoint inherits history instead of replaying today', () => {
  // The bug: a reinstalled phone arrives with last_sent {} and gets this
  // morning's training reminder a second time.
  const rows = [
    row({ endpoint: 'old', last_sent: { sessions: '2026-08-20', checkins: '2026-08-16', coach: '2026-08-19T06:30:31.722Z' } }),
    row({ endpoint: 'fresh', last_sent: {} }),
  ];
  const merged = mergeLastSent(rows);
  assert.equal(merged.sessions, '2026-08-20');
  assert.equal(merged.checkins, '2026-08-16');
  assert.equal(merged.coach, '2026-08-19T06:30:31.722Z');
});

test('merged history keeps the newest value per reminder type', () => {
  const merged = mergeLastSent([
    row({ endpoint: 'a', last_sent: { sessions: '2026-08-17', coach: '2026-08-15T06:30:32.233Z' } }),
    row({ endpoint: 'b', last_sent: { sessions: '2026-08-20', coach: '2026-08-12T11:40:02.484Z' } }),
  ]);
  assert.equal(merged.sessions, '2026-08-20');
  assert.equal(merged.coach, '2026-08-15T06:30:32.233Z');
});

test('the athlete latest preference wins across their rows', () => {
  // JOJO turned everything but training off on their current phone; the older
  // row must not keep shipping coach updates.
  const prefs = newestPrefs([
    row({ endpoint: 'older', updated_at: '2026-08-17T04:37:09.877Z', prefs: { sessions: true, checkins: true, photos: true, coach: true } }),
    row({ endpoint: 'current', updated_at: '2026-08-19T22:36:39.330Z', prefs: { sessions: true, checkins: false, photos: false, coach: false } }),
  ]);
  assert.deepEqual(prefs, { sessions: true, checkins: false, photos: false, coach: false });
});

test('rows are grouped by athlete, case-insensitively', () => {
  const groups = groupByAthlete([
    row({ endpoint: 'a', athlete_code: 'KARL' }),
    row({ endpoint: 'b', athlete_code: 'karl' }),
    row({ endpoint: 'c', athlete_code: 'NATE' }),
  ]);
  assert.equal(groups.size, 2);
  assert.equal(groups.get('KARL').length, 2);
  assert.equal(groups.get('NATE').length, 1);
});

// ── Delivery-path guards ─────────────────────────────────────────────────────
// handleCronSend talks to Supabase and Apple, so these assert the structure of
// the code that surrounds the pure helpers above.

test('the cron send path decides per athlete, not per subscription row', () => {
  assert.ok(
    /for \(const \[code, rows\] of groupByAthlete\(subs\)\)/.test(remindersSource),
    'subscriptions must be grouped by athlete before any send decision'
  );
  assert.ok(
    /selectLiveDevices\(rows\)/.test(remindersSource),
    'each athlete must be collapsed to their live devices'
  );
  assert.ok(
    !/for \(const sub of zoneSubs\)/.test(remindersSource),
    'the old per-row send loop must be gone'
  );
});

test('a send is only recorded once it reaches a device', () => {
  const guard = remindersSource.indexOf('if (reached) {');
  const record = remindersSource.indexOf('lastSent[msg.type] =', guard);
  assert.ok(guard > 0 && record > guard, 'last_sent must be written inside the reached guard');
});

test('subscribing reconciles the athlete devices', () => {
  assert.ok(/await reconcileAthleteDevices\(code, \{/.test(remindersSource));
  assert.ok(/pinnedEndpoint: subscription\.endpoint/.test(remindersSource));
});
