import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bookingRead, bookingSync, stateRead } from '../api/write.js';
import { syncBookingsForAthlete } from '../api/bookings.js';
import {
  adelaideDate, displayTime, isoWeekKey, storeCallBooked, reconcileCallBookings,
} from '../api/_lib/booking.js';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const navSource = readFileSync(join(root, 'public', 'js', '03-nav-nudges.js'), 'utf8');
const coreSource = readFileSync(join(root, 'public', 'js', '01-core.js'), 'utf8');
const apiSource = readFileSync(join(root, 'api', 'write.js'), 'utf8');

function checkinKeys(code) {
  const start = navSource.indexOf('function checkinWeekSuffix');
  const end = navSource.indexOf('function initCheckinNudge', start);
  assert.ok(start >= 0 && end > start, 'check-in key helpers should remain discoverable');
  const context = { athlete: { code } };
  vm.createContext(context);
  vm.runInContext(navSource.slice(start, end), context);
  return context;
}

function callKeys() {
  const start = navSource.indexOf('function callAdelaideDate');
  const end = navSource.indexOf('function callBookedPrefix', start);
  assert.ok(start >= 0 && end > start, 'call key helper should remain discoverable');
  const context = {};
  vm.createContext(context);
  vm.runInContext(navSource.slice(start, end), context);
  return context;
}

test('weekly check-in completion cache is scoped to the active athlete', () => {
  const monday = new Date(2026, 7, 3, 5, 54);
  assert.equal(checkinKeys('KARL').checkinWeekKey(monday), 'dp_checkin_KARL_2026_32');
  assert.equal(checkinKeys('ALEX').checkinWeekKey(monday), 'dp_checkin_ALEX_2026_32');
});

test('weekly completion state resets on Monday', () => {
  const keys = checkinKeys('KARL');
  assert.equal(keys.checkinWeekSuffix(new Date(2026, 7, 2)), '2026_31');
  assert.equal(keys.checkinWeekSuffix(new Date(2026, 7, 3)), '2026_32');
  assert.equal(keys.checkinWeekSuffix(new Date(2026, 7, 4)), '2026_32');
});

test('server booking keys reset on Monday too', () => {
  assert.equal(isoWeekKey(new Date(2026, 7, 2)), 'call_booked_2026_31');
  assert.equal(isoWeekKey(new Date(2026, 7, 3)), 'call_booked_2026_32');
  assert.equal(isoWeekKey(new Date(2026, 7, 4)), 'call_booked_2026_32');
});

test('portal booking nudge does not carry a Sunday booking into Monday', () => {
  const keys = callKeys();
  assert.equal(keys.callWeekSuffix(new Date(2026, 7, 2)), '2026_31');
  assert.equal(keys.callWeekSuffix(new Date(2026, 7, 3)), '2026_32');
  assert.equal(keys.callWeekSuffix(new Date(2026, 7, 4)), '2026_32');
});

test('booking week boundaries use Adelaide time even for UTC timestamps', () => {
  const sundayUtcButMondayAdelaide = new Date('2026-08-02T15:00:00Z');
  assert.equal(callKeys().callWeekSuffix(sundayUtcButMondayAdelaide), '2026_32');
  assert.equal(isoWeekKey(adelaideDate(sundayUtcButMondayAdelaide)), 'call_booked_2026_32');
});

test('booked calls display both their Adelaide date and time', () => {
  const start = new Date('2026-08-04T09:00:00Z');
  assert.equal(displayTime(start), 'Tue 4 Aug · 6:30 pm');

  const uiStart = navSource.indexOf('function dpFormatBookedTime');
  const uiEnd = navSource.indexOf("window.addEventListener('message'", uiStart);
  const context = {};
  vm.createContext(context);
  vm.runInContext(navSource.slice(uiStart, uiEnd), context);
  assert.equal(context.dpFormatBookedTime(start), 'Tue 4 Aug · 6:30 pm');
  assert.equal(
    context.dpExtractBookingStart({ data: { selected_slot: '2026-08-04T09:00:00Z' } }, '').toISOString(),
    '2026-08-04T09:00:00.000Z',
  );
});

test('confirmed calls retain the HighLevel event id and clean up the old week after rescheduling', async () => {
  const writes = [];
  const removals = [];
  const result = await storeCallBooked('THOMAS', new Date('2026-08-11T09:00:00Z'), {
    eventId: 'event-123',
    calendarId: 'calendar-456',
  }, {
    now: '2026-08-09T00:00:00Z',
    upsertRows: async (...args) => { writes.push(args); },
    selectRows: async () => [
      { key: 'call_booked_2026_32', value: { eventId: 'event-123' } },
      { key: 'call_booked_2026_33', value: { eventId: 'different-event' } },
    ],
    removeRows: async (...args) => { removals.push(args); },
  });

  assert.equal(result.value.eventId, 'event-123');
  assert.equal(result.value.calendarId, 'calendar-456');
  assert.equal(writes[0][1][0].key, result.key);
  assert.deepEqual(removals, [[
    'athlete_data',
    { athlete_code: 'eq.THOMAS', key: 'eq.call_booked_2026_32' },
  ]]);
});

test('the booking modal uses HighLevel reschedule mode and never falls back to a new booking for a confirmed call', () => {
  const start = navSource.indexOf('function callWidgetUrl');
  const end = navSource.indexOf('var _activeCallReschedule', start);
  assert.ok(start >= 0 && end > start, 'booking URL helper should remain discoverable');
  const context = { encodeURIComponent };
  vm.createContext(context);
  vm.runInContext(navSource.slice(start, end), context);
  const base = 'https://api.leadconnectorhq.com/widget/booking/calendar-456';
  assert.equal(context.callWidgetUrl(base, { booked: false }), base);
  assert.equal(context.callWidgetUrl(base, { booked: true, eventId: 'event 123' }), `${base}?event_id=event%20123`);
  assert.equal(context.callWidgetUrl(base, { booked: true, eventId: '' }), '');
});

test('booking refresh reads only weekly booking state for the authenticated athlete', async () => {
  let query;
  const result = await bookingRead('KARL', async (table, params) => {
    query = { table, params };
    return [{ key: 'call_booked_2026_32', value: { time: 'Tue 4 Aug · 6:30 pm' } }];
  });
  assert.equal(query.table, 'athlete_data');
  assert.equal(query.params.athlete_code, 'eq.KARL');
  assert.equal(query.params.key, 'like.call_booked_*');
  assert.equal(result.rows[0].key, 'call_booked_2026_32');
});

test('timestamp-free widget confirmations cannot overwrite the cloud booking value', () => {
  assert.match(navSource, /if\(start\)portalStateWrite\(sbKey,saveVal\)/);
  assert.match(navSource, /refreshCallBookingsFromCloud\(0\)/);
  assert.match(navSource, /getElementById\('callConfirmedSub'\)/);
  assert.match(coreSource, /if\(!datedBooking\)return/);
  assert.match(navSource, /portalRequest\(action\)/);
  assert.match(navSource, /\?'booking-sync':'booking-read'/);
  assert.match(navSource, /refreshCallBookingsFromCloud\(0,true\)/);
  assert.match(navSource, /currentRaw&&!currentRaw\.time&&hasDatedFuture/);
  assert.match(navSource, /applyCloudBookingRows\(result\.rows\|\|\[\],action==='booking-sync'\)/);
  assert.match(navSource, /refreshCallBookingsFromCloud\(0,true\);/);
  assert.match(navSource, /visibilitychange',refreshCallBookingsOnResume/);
  assert.match(navSource, /Date\.now\(\)-_callBookingLastSyncAt<30000/);
});

test('an authoritative booking sync removes a cancelled weekly projection even when GHL omits the event', async () => {
  const removals = [];
  const result = await reconcileCallBookings('KARL', [], {
    start: '2026-08-20T00:00:00Z',
    end: '2026-09-20T00:00:00Z',
    existingRows: [{
      key: 'call_booked_2026_35',
      value: { eventId: 'cancelled-event', startsAt: '2026-08-29T00:00:00Z' },
    }],
    removeRows: async (...args) => { removals.push(args); },
    storeBooking: async () => { throw new Error('cancelled appointments must not be stored'); },
  });

  assert.deepEqual(result.updated, []);
  assert.deepEqual(result.removed, [{ key: 'call_booked_2026_35', eventId: 'cancelled-event' }]);
  assert.deepEqual(removals, [[
    'athlete_data',
    { athlete_code: 'eq.KARL', key: 'eq.call_booked_2026_35' },
  ]]);
});

test('authoritative cloud rows prune only stale booking keys from the device cache', () => {
  const values = new Map([
    ['dp_call_booked_KARL_2026_35', JSON.stringify({ time: 'Sat 29 Aug · 9:30 am' })],
    ['dp_call_booked_KARL_2026_36', JSON.stringify({ time: 'Sat 5 Sep · 9:30 am' })],
    ['dp_logs_KARL', '{}'],
  ]);
  const localStorage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] || null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  const start = navSource.indexOf('function callAdelaideDate');
  const end = navSource.indexOf('async function refreshCallBookingsFromCloud', start);
  const context = { athlete: { code: 'KARL' }, localStorage, Intl, Date };
  vm.createContext(context);
  vm.runInContext(navSource.slice(start, end), context);

  context.applyCloudBookingRows([
    { key: 'call_booked_2026_36', value: { time: 'Sat 5 Sep · 10:30 am' } },
  ], true);

  assert.equal(localStorage.getItem('dp_call_booked_KARL_2026_35'), null);
  assert.match(localStorage.getItem('dp_call_booked_KARL_2026_36'), /10:30 am/);
  assert.equal(localStorage.getItem('dp_logs_KARL'), '{}');
});

test('multiple and altered bookings reconcile deterministically', async () => {
  const stored = [];
  const removed = [];
  const result = await reconcileCallBookings('KARL', [
    { id: 'early-active', startTime: '2026-08-28T00:00:00Z', appointmentStatus: 'confirmed' },
    { id: 'later-cancelled', startTime: '2026-08-29T00:00:00Z', appointmentStatus: 'cancelled' },
    { id: 'next-week', startTime: '2026-09-05T00:00:00Z', appointmentStatus: 'confirmed' },
  ], {
    start: '2026-08-20T00:00:00Z',
    end: '2026-09-20T00:00:00Z',
    existingRows: [
      { key: 'call_booked_2026_35', value: { eventId: 'later-cancelled' } },
      { key: 'call_booked_2026_37', value: { eventId: 'stale-event' } },
    ],
    storeBooking: async (code, date, appointment) => {
      const entry = { key: isoWeekKey(adelaideDate(date)), value: { eventId: appointment.eventId } };
      stored.push(entry);
      return entry;
    },
    removeRows: async (table, query) => { removed.push({ table, query }); },
  });

  assert.deepEqual(stored.map((entry) => entry.value.eventId), ['early-active', 'next-week']);
  assert.deepEqual(result.updated.map((entry) => entry.key), ['call_booked_2026_35', 'call_booked_2026_36']);
  assert.deepEqual(result.removed.map((entry) => entry.key), ['call_booked_2026_37']);
  assert.equal(removed.length, 1);
});

test('authenticated booking recovery stores only the matching athlete appointment', async () => {
  const stored = [];
  const patched = [];
  const start = '2026-08-04T09:00:00Z';
  const result = await syncBookingsForAthlete('THOMAS', {
    now: new Date('2026-08-04T00:00:00Z').getTime(),
    locationId: 'location',
    calendarId: 'calendar',
    selectRows: async () => [{ code: 'THOMAS', email: 'thomas@example.com', ghl_contact_id: null }],
    fetchGhl: async (path) => path.startsWith('/contacts/')
      ? { contact: { email: path.includes('contact-thomas') ? 'thomas@example.com' : 'other@example.com' } }
      : { events: [
        { id: 'other', contactId: 'contact-other', startTime: '2026-08-05T09:00:00Z', appointmentStatus: 'confirmed' },
        { id: 'match', contactId: 'contact-thomas', startTime: start, appointmentStatus: 'confirmed' },
      ] },
    patchRows: async (...args) => { patched.push(args); return []; },
    storeBooking: async (code, date, appointment) => {
      stored.push({ code, date: date.toISOString(), appointment });
      return { key: 'call_booked_2026_32', value: { time: 'Tue 4 Aug · 6:30 pm', startsAt: date.toISOString() } };
    },
  });
  // The same mocked events are returned for each date window, but event ids
  // are de-duplicated before matching and writing.
  assert.deepEqual(stored, [{
    code: 'THOMAS',
    date: '2026-08-04T09:00:00.000Z',
    appointment: { eventId: 'match', calendarId: 'calendar' },
  }]);
  assert.equal(patched.length, 1);
  assert.equal(result.updated.length, 1);
});

test('booking sync returns freshly recovered cloud rows', async () => {
  const result = await bookingSync(
    'THOMAS',
    async (code) => ({ updated: [{ key: 'call_booked_2026_32' }], removed: [{ key: 'call_booked_2026_31' }], code }),
    async () => ({ rows: [{ key: 'call_booked_2026_32', value: { time: 'Tue 4 Aug · 6:30 pm' } }] }),
  );
  assert.equal(result.rows[0].value.time, 'Tue 4 Aug · 6:30 pm');
  assert.equal(result.synced[0].key, 'call_booked_2026_32');
  assert.equal(result.removed[0].key, 'call_booked_2026_31');
});

test('cloud hydration uses structured check-ins, not legacy cache rows', async () => {
  assert.match(apiSource, /selectRows\('weekly_checkins'/);
  assert.match(apiSource, /!key\.startsWith\('checkin_'\)/);
  assert.match(apiSource, /!key\.startsWith\('_'\)/, 'server-only migration markers must not hydrate into portal state');
  assert.match(coreSource, /var structuredCheckins=result\.checkins\|\|\[\]/);
  assert.match(coreSource, /completedOn=row\.submitted_at\?new Date\(row\.submitted_at\)/);
  assert.doesNotMatch(coreSource, /row\.key\.startsWith\('checkin_'\).*lsKey=/);

  const queries = [];
  const result = await stateRead('KARL', async (table, params) => {
    queries.push({ table, params });
    if (table === 'athlete_data') return [
      { key: 'goals', value: { goal: '5k' } },
      { key: 'checkin_2026_31', value: { stale: true } },
      { key: '_progress_photos_migrated_v1', value: { completedAt: '2026-08-20T00:00:00Z' } },
    ];
    if (table === 'weekly_checkins') return [
      { week_key: 'week_ending_2026-08-02', week_ending: '2026-08-02', submitted_at: '2026-08-02T09:00:00Z' },
    ];
    return [];
  });
  assert.equal(queries.find((query) => query.table === 'weekly_checkins').params.athlete_code, 'eq.KARL');
  assert.deepEqual(result.rows, [{ key: 'goals', value: { goal: '5k' } }]);
  assert.equal(result.checkins[0].week_ending, '2026-08-02');
});
