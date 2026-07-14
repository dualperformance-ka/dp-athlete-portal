// /api/call-booked.js — GHL "Appointment Booked" workflow webhook.
// Stores the booked call's time in athlete_data so the portal shows
// "Call booked · Tue 15 Jul · 6:30 pm" on every device, even when the
// GHL widget's postMessage doesn't include the time or the athlete books
// outside the portal.
//
//   POST /api/call-booked
//     auth: Authorization: Bearer <NOTIFY_SECRET>  (or x-notify-secret header)
//     body: flexible — needs a GHL contact id or email, plus an appointment
//           start time. Recommended custom payload from the GHL webhook action:
//           { "email": "{{contact.email}}",
//             "contact_id": "{{contact.id}}",
//             "start_time": "{{appointment.start_time}}" }
//
// The athlete_data key mirrors the portal client's weekly scheme
// (call_booked_YYYY_WW, ISO week of the APPOINTMENT date in Adelaide time),
// and the value is the display string the portal renders verbatim.

import { select, upsert } from './_lib/supabase-rest.js';

const TZ = 'Australia/Adelaide';

function send(res, status, payload) {
  return res.status(status).json(payload);
}

function requireSecret(req) {
  const secret = process.env.NOTIFY_SECRET;
  if (!secret) return false;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const alt = String(req.headers['x-notify-secret'] || '').trim();
  return bearer === secret || alt === secret;
}

function pick(...vals) {
  for (const v of vals) {
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// Date shifted into Adelaide wall-clock so week math matches the athlete.
function adelaideDate(date) {
  const parts = {};
  new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
  return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
}

// Same ISO-week math as the portal client's callNudgeWeekKey().
function isoWeekKey(localDate) {
  const d = new Date(localDate); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(d.getFullYear(), 0, 4);
  const week = 1 + Math.round(((d - w1) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7);
  return `call_booked_${d.getFullYear()}_${week < 10 ? '0' : ''}${week}`;
}

// Matches the client's dpFormatBookedTime output: "Tue 15 Jul · 6:30 pm".
// Built from parts so Node's locale data can't drift from browser output.
function displayTime(date) {
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method_not_allowed' });
  if (!requireSecret(req)) return send(res, 401, { ok: false, error: 'unauthorized' });

  const body = (typeof req.body === 'object' && req.body) || {};
  const contact = body.contact || {};
  const appointment = body.appointment || body.calendar || {};

  const email = pick(body.email, contact.email).toLowerCase();
  const contactId = pick(body.contact_id, body.contactId, contact.id);
  const startRaw = pick(
    body.start_time, body.startTime, body.appointment_start_time,
    appointment.start_time, appointment.startTime
  );

  if (!email && !contactId) return send(res, 400, { ok: false, error: 'missing_contact' });

  const start = startRaw ? new Date(startRaw) : null;
  if (!start || isNaN(start)) return send(res, 400, { ok: false, error: 'missing_or_invalid_start_time', received: startRaw });

  try {
    // Match the athlete: GHL contact id first (most precise), then email.
    let row = null;
    if (contactId) {
      const rows = await select('athletes', { ghl_contact_id: `eq.${contactId}`, select: 'code,active,archived_at', limit: 1 });
      row = (Array.isArray(rows) && rows[0]) || null;
    }
    if (!row && email) {
      const rows = await select('athletes', { email: `ilike.${email}`, select: 'code,active,archived_at', limit: 1 });
      row = (Array.isArray(rows) && rows[0]) || null;
    }
    if (!row || !row.code) return send(res, 404, { ok: false, error: 'no_matching_athlete' });

    const key = isoWeekKey(adelaideDate(start));
    const value = displayTime(start);
    await upsert('athlete_data', [{
      athlete_code: row.code,
      key,
      value,
      updated_at: new Date().toISOString(),
    }], 'athlete_code,key');

    return send(res, 200, { ok: true, code: row.code, key, value });
  } catch (e) {
    console.error('[call-booked] failed:', e && e.message);
    return send(res, 500, { ok: false, error: 'server_error' });
  }
}
