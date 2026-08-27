// api/_lib/booking.js — shared helpers for storing booked call times in
// athlete_data. Used by /api/call-booked (GHL webhook) and /api/sync-bookings
// (pull of existing/upcoming GHL appointments).

import { upsert, select, remove } from './supabase-rest.js';

export const TZ = 'Australia/Adelaide';
export const INACTIVE_APPOINTMENT_STATUSES = new Set(['cancelled', 'canceled', 'noshow', 'no_show', 'invalid']);

// Date shifted into Adelaide wall-clock so week math matches the athlete.
export function adelaideDate(date) {
  const parts = {};
  new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
  return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
}

// Same ISO-week math as the portal client's callNudgeWeekKey().
//
// Weeks reset at Monday midnight in Adelaide. A Sunday booking belongs to the
// week that just ended; any booking from Monday onward belongs to the new week.
export function isoWeekKey(localDate) {
  const d = new Date(localDate); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(d.getFullYear(), 0, 4);
  const week = 1 + Math.round(((d - w1) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7);
  return `call_booked_${d.getFullYear()}_${week < 10 ? '0' : ''}${week}`;
}

// Matches the client's dpFormatBookedTime output: "Tue 15 Jul · 6:30 pm".
// Built from parts so Node's locale data can't drift from browser output.
export function displayTime(date) {
  const p = {};
  new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' })
    .formatToParts(date).forEach((x) => { p[x.type] = x.value; });
  const t = {};
  new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true })
    .formatToParts(date).forEach((x) => { t[x.type] = x.value; });
  const month = String(p.month || '').slice(0, 3);
  const ampm = String(t.dayPeriod || '').toLowerCase();
  return `${p.weekday} ${p.day} ${month} · ${t.hour}:${t.minute} ${ampm}`;
}

export function appointmentStart(event) {
  const raw = event?.startTime || event?.start_time || event?.startTimestamp;
  const date = raw ? new Date(raw) : null;
  return date && !isNaN(date) ? date : null;
}

export function appointmentEventId(event) {
  return String(event?.id || event?.eventId || event?.event_id || '').trim();
}

export function appointmentStatus(event) {
  return String(event?.appointmentStatus || event?.appoinmentStatus || event?.status || '').trim().toLowerCase();
}

export function bookingWeekKeysBetween(start, end) {
  const from = new Date(start);
  const to = new Date(end);
  const keys = new Set();
  if (isNaN(from) || isNaN(to) || from > to) return keys;
  // Step through UTC days; Adelaide conversion below supplies the authoritative
  // local week and naturally absorbs daylight-saving transitions.
  for (let at = from.getTime(); at <= to.getTime(); at += 86400000) {
    keys.add(isoWeekKey(adelaideDate(new Date(at))));
  }
  keys.add(isoWeekKey(adelaideDate(to)));
  return keys;
}

// Reconcile the one-row-per-week portal projection with the authoritative GHL
// event set. Multiple active events in one week retain the existing behaviour:
// the appointment with the latest start time is the row the portal displays.
// If that event is cancelled, the next active event wins; if none remain, the
// stale weekly row is removed. Events in different weeks retain separate rows.
export async function reconcileCallBookings(code, events, dependencies = {}) {
  const selectRows = dependencies.selectRows || select;
  const removeRows = dependencies.removeRows || remove;
  const storeBooking = dependencies.storeBooking || storeCallBooked;
  const now = dependencies.now ? new Date(dependencies.now) : new Date();
  const start = dependencies.start ? new Date(dependencies.start) : new Date(now.getTime() - 14 * 86400000);
  const end = dependencies.end ? new Date(dependencies.end) : new Date(now.getTime() + 60 * 86400000);
  const dryRun = dependencies.dryRun === true;
  const winners = new Map();
  const inactiveEventIds = new Set();
  let skipped = 0;

  for (const event of events || []) {
    const status = appointmentStatus(event);
    const eventId = appointmentEventId(event);
    if (status && INACTIVE_APPOINTMENT_STATUSES.has(status)) {
      if (eventId) inactiveEventIds.add(eventId);
      skipped++;
      continue;
    }
    const date = appointmentStart(event);
    if (!date) { skipped++; continue; }
    const key = isoWeekKey(adelaideDate(date));
    const prior = winners.get(key);
    if (!prior || date > prior.date) winners.set(key, { key, date, event });
  }

  const existing = dependencies.existingRows !== undefined
    ? dependencies.existingRows
    : await selectRows('athlete_data', {
      athlete_code: `eq.${code}`,
      key: 'like.call_booked_*',
      select: 'key,value',
      limit: '100',
    });
  const desiredKeys = new Set(winners.keys());
  const authoritativeKeys = bookingWeekKeysBetween(start, end);
  const updated = [];
  const removed = [];

  for (const winner of [...winners.values()].sort((a, b) => a.date - b.date)) {
    const appointment = {
      eventId: appointmentEventId(winner.event),
      calendarId: winner.event?.calendarId || winner.event?.calendar_id || dependencies.calendarId || '',
    };
    if (dryRun) {
      const value = { time: displayTime(winner.date), startsAt: winner.date.toISOString() };
      if (appointment.eventId) value.eventId = appointment.eventId;
      if (appointment.calendarId) value.calendarId = appointment.calendarId;
      updated.push({ key: winner.key, value });
    } else {
      updated.push(await storeBooking(code, winner.date, appointment));
    }
  }

  for (const row of existing || []) {
    const key = String(row?.key || '');
    if (!/^call_booked_\d{4}_\d{2}$/.test(key)) continue;
    const existingEventId = String(row?.value?.eventId || row?.value?.event_id || '').trim();
    const cancelled = !!(existingEventId && inactiveEventIds.has(existingEventId));
    // A different active event may replace the cancelled one in the same week;
    // its upsert has already made this key current, so never delete a desired key.
    if (desiredKeys.has(key) || (!cancelled && !authoritativeKeys.has(key))) continue;
    removed.push({ key, eventId: existingEventId || null });
    if (!dryRun) await removeRows('athlete_data', { athlete_code: `eq.${code}`, key: `eq.${key}` });
  }

  return { updated, removed, skipped, activeWeeks: winners.size };
}

// Writes the weekly call_booked key for an athlete. Returns { key, value }.
// The GHL event id is retained so the portal can open HighLevel's reschedule
// flow for the existing appointment instead of presenting a second booking
// form. Older rows remain readable and are repaired by the authenticated sync.
export async function storeCallBooked(code, startDate, appointment = {}, dependencies = {}) {
  const upsertRows = dependencies.upsertRows || upsert;
  const selectRows = dependencies.selectRows || select;
  const removeRows = dependencies.removeRows || remove;
  const now = dependencies.now ? new Date(dependencies.now) : new Date();
  const key = isoWeekKey(adelaideDate(startDate));
  const value = { time: displayTime(startDate), startsAt: new Date(startDate).toISOString() };
  const eventId = String(appointment.eventId || appointment.id || '').trim();
  const calendarId = String(appointment.calendarId || '').trim();
  if (eventId) value.eventId = eventId;
  if (calendarId) value.calendarId = calendarId;

  await upsertRows('athlete_data', [{
    athlete_code: code,
    key,
    value,
    updated_at: now.toISOString(),
  }], 'athlete_code,key');

  // A reschedule can move the same event into another ISO week. Remove the
  // previous weekly marker only after the new marker is safely written.
  if (eventId) {
    const previous = await selectRows('athlete_data', {
      athlete_code: `eq.${code}`,
      key: 'like.call_booked_*',
      select: 'key,value',
      limit: '100',
    });
    for (const row of previous || []) {
      const previousEventId = String(row?.value?.eventId || row?.value?.event_id || '').trim();
      if (row?.key && row.key !== key && previousEventId === eventId) {
        await removeRows('athlete_data', { athlete_code: `eq.${code}`, key: `eq.${row.key}` });
      }
    }
  }
  return { key, value };
}
