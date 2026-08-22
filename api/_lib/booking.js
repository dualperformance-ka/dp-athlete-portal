// api/_lib/booking.js — shared helpers for storing booked call times in
// athlete_data. Used by /api/call-booked (GHL webhook) and /api/sync-bookings
// (pull of existing/upcoming GHL appointments).

import { upsert, select, remove } from './supabase-rest.js';

export const TZ = 'Australia/Adelaide';

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
