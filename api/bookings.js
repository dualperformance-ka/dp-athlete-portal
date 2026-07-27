// /api/bookings.js — booked-call times for the portal, two modes in ONE
// serverless function (Vercel Hobby caps deployments at 12 functions).
// The original URLs still work via vercel.json rewrites:
//   /api/call-booked   -> /api/bookings?mode=webhook
//   /api/sync-bookings -> /api/bookings?mode=sync
//
// WEBHOOK MODE (POST, GHL "Appointment Booked" workflow):
//   auth: Authorization: Bearer <NOTIFY_SECRET>  (or x-notify-secret header)
//   body: { email: "{{contact.email}}", contact_id: "{{contact.id}}",
//           start_time: "{{appointment.start_time}}" }
//
// SYNC MODE (GET or ?mode=sync — pulls existing/upcoming GHL appointments):
//   auth: Authorization: Bearer <NOTIFY_SECRET or CRON_SECRET>
//   env:  GHL_API_TOKEN (Private Integration; calendar events + contacts
//         read scopes), GHL_LOCATION_ID, GHL_CALENDAR_ID (optional, defaults
//         to the portal booking widget calendar)
//
// Matching: athletes.ghl_contact_id first, then athletes.email. Email matches
// backfill ghl_contact_id onto the roster row for instant future matching.

import { select, patch } from './_lib/supabase-rest.js';
import { storeCallBooked } from './_lib/booking.js';
import crypto from 'node:crypto';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const DEFAULT_CALENDAR = 'WRivrNxfNTVER2xMit1z';
const SKIP_STATUSES = new Set(['cancelled', 'canceled', 'noshow', 'no_show', 'invalid']);

function send(res, status, payload) {
  return res.status(status).json(payload);
}

function pick(...vals) {
  for (const v of vals) {
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function authorized(req, secrets) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const alt = String(req.headers['x-notify-secret'] || '').trim();
  return secrets.filter(Boolean).some((secret) => {
    const expected = Buffer.from(String(secret));
    return [bearer, alt].some((value) => {
      const received = Buffer.from(String(value || ''));
      return received.length === expected.length
        && received.length > 0
        && crypto.timingSafeEqual(received, expected);
    });
  });
}

async function ghl(path, version) {
  const token = process.env.GHL_API_TOKEN;
  if (!token) throw new Error('GHL_API_TOKEN not configured');
  const response = await fetch(`${GHL_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Version: version, Accept: 'application/json' },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`GHL ${response.status}: ${(data && (data.message || data.error)) || 'request failed'}`);
  }
  return data;
}

// ── WEBHOOK MODE ──────────────────────────────────────────────────────────────

async function handleWebhook(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method_not_allowed' });
  if (!authorized(req, [process.env.NOTIFY_SECRET])) return send(res, 401, { ok: false, error: 'unauthorized' });

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
    let row = null;
    if (contactId) {
      const rows = await select('athletes', { ghl_contact_id: `eq.${contactId}`, select: 'code', limit: 1 });
      row = (Array.isArray(rows) && rows[0]) || null;
    }
    if (!row && email) {
      const rows = await select('athletes', { email: `ilike.${email}`, select: 'code', limit: 1 });
      row = (Array.isArray(rows) && rows[0]) || null;
    }
    if (!row || !row.code) return send(res, 404, { ok: false, error: 'no_matching_athlete' });

    const stored = await storeCallBooked(row.code, start);
    return send(res, 200, { ok: true, code: row.code, ...stored });
  } catch (e) {
    console.error('[bookings webhook] failed:', e && e.message);
    return send(res, 500, { ok: false, error: 'server_error' });
  }
}

// ── SYNC MODE ─────────────────────────────────────────────────────────────────

async function handleSync(req, res) {
  if (!authorized(req, [process.env.NOTIFY_SECRET, process.env.CRON_SECRET])) {
    return send(res, 401, { ok: false, error: 'unauthorized' });
  }
  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) return send(res, 500, { ok: false, error: 'GHL_LOCATION_ID not configured' });
  const calendarId = process.env.GHL_CALENDAR_ID || DEFAULT_CALENDAR;

  // 7 days back (this week's already-happened call still counts) to 21 ahead.
  const start = Date.now() - 7 * 86400000;
  const end = Date.now() + 21 * 86400000;

  try {
    const eventsRes = await ghl(
      `/calendars/events?locationId=${encodeURIComponent(locationId)}&calendarId=${encodeURIComponent(calendarId)}&startTime=${start}&endTime=${end}`,
      '2021-04-15'
    );
    const events = (eventsRes && (eventsRes.events || eventsRes.data)) || [];

    const roster = await select('athletes', { select: 'code,email,ghl_contact_id', limit: 500 });
    const byContact = {};
    const byEmail = {};
    (roster || []).forEach((r) => {
      if (r.ghl_contact_id) byContact[r.ghl_contact_id] = r;
      if (r.email) byEmail[String(r.email).toLowerCase()] = r;
    });

    const results = { events: events.length, updated: [], skipped: 0, unmatched: [] };

    for (const ev of events) {
      const status = String(ev.appointmentStatus || ev.appoinmentStatus || '').toLowerCase();
      if (status && SKIP_STATUSES.has(status)) { results.skipped++; continue; }
      const startRaw = ev.startTime || ev.start_time || ev.startTimestamp;
      const startDate = startRaw ? new Date(startRaw) : null;
      if (!startDate || isNaN(startDate)) { results.skipped++; continue; }

      const contactId = ev.contactId || ev.contact_id || '';
      let athlete = contactId ? byContact[contactId] : null;

      if (!athlete && contactId) {
        try {
          const contactRes = await ghl(`/contacts/${encodeURIComponent(contactId)}`, '2021-07-28');
          const email = String((contactRes && contactRes.contact && contactRes.contact.email) || '').toLowerCase();
          if (email && byEmail[email]) {
            athlete = byEmail[email];
            try {
              await patch('athletes', { code: `eq.${athlete.code}` }, { ghl_contact_id: contactId });
              byContact[contactId] = athlete;
            } catch (e) { console.warn('[bookings sync] contact id backfill failed:', e.message); }
          } else if (email) {
            results.unmatched.push(email);
          }
        } catch (e) {
          console.warn('[bookings sync] contact lookup failed:', e.message);
        }
      }

      if (!athlete) { if (!contactId) results.unmatched.push('(no contact on event)'); continue; }

      const stored = await storeCallBooked(athlete.code, startDate);
      results.updated.push({ code: athlete.code, ...stored });
    }

    return send(res, 200, { ok: true, ...results });
  } catch (e) {
    console.error('[bookings sync] failed:', e && e.message);
    return send(res, 500, { ok: false, error: String((e && e.message) || 'server_error') });
  }
}

export default async function handler(req, res) {
  const mode = String((req.query && req.query.mode) || '').toLowerCase();
  if (mode === 'sync' || (req.method === 'GET' && mode !== 'webhook')) return handleSync(req, res);
  return handleWebhook(req, res);
}
