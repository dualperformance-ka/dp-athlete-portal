// /api/sync-bookings.js — pulls upcoming appointments straight from the GHL
// calendar API and stores each athlete's booked call time in athlete_data, so
// EXISTING bookings (made before the webhook existed, or if a webhook was
// missed) show up in the portal.
//
//   GET/POST /api/sync-bookings
//     auth: Authorization: Bearer <NOTIFY_SECRET or CRON_SECRET>
//
// Env required:
//   GHL_API_TOKEN    -> Private Integration token (Settings -> Private
//                       Integrations; scopes: calendars/events readonly,
//                       contacts readonly)
//   GHL_LOCATION_ID  -> the sub-account location id
//   GHL_CALENDAR_ID  -> optional; defaults to the portal booking widget's
//                       calendar (WRivrNxfNTVER2xMit1z)
//
// Matching: athletes.ghl_contact_id first, then athletes.email against the
// GHL contact's email. When an email match succeeds the contact id is
// backfilled onto the roster row so future webhook calls match instantly.

import { select, patch } from './_lib/supabase-rest.js';
import { storeCallBooked } from './_lib/booking.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const DEFAULT_CALENDAR = 'WRivrNxfNTVER2xMit1z';
const SKIP_STATUSES = new Set(['cancelled', 'canceled', 'noshow', 'no_show', 'invalid']);

function send(res, status, payload) {
  return res.status(status).json(payload);
}

function authorized(req) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const alt = String(req.headers['x-notify-secret'] || '').trim();
  const secrets = [process.env.NOTIFY_SECRET, process.env.CRON_SECRET].filter(Boolean);
  return secrets.some((s) => bearer === s || alt === s);
}

async function ghl(path, version) {
  const token = process.env.GHL_API_TOKEN;
  if (!token) throw new Error('GHL_API_TOKEN not configured');
  const response = await fetch(`${GHL_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Version: version,
      Accept: 'application/json',
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`GHL ${response.status}: ${(data && (data.message || data.error)) || 'request failed'}`);
  }
  return data;
}

export default async function handler(req, res) {
  if (!authorized(req)) return send(res, 401, { ok: false, error: 'unauthorized' });

  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) return send(res, 500, { ok: false, error: 'GHL_LOCATION_ID not configured' });
  const calendarId = process.env.GHL_CALENDAR_ID || DEFAULT_CALENDAR;

  // Window: 7 days back (this week's already-happened call still counts for
  // the weekly key) to 21 days ahead.
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

      // Fall back to email match via the GHL contact record.
      if (!athlete && contactId) {
        try {
          const contactRes = await ghl(`/contacts/${encodeURIComponent(contactId)}`, '2021-07-28');
          const email = String((contactRes && contactRes.contact && contactRes.contact.email) || '').toLowerCase();
          if (email && byEmail[email]) {
            athlete = byEmail[email];
            // Backfill the contact id so future lookups (and the webhook) are instant.
            try {
              await patch('athletes', { code: `eq.${athlete.code}` }, { ghl_contact_id: contactId });
              byContact[contactId] = athlete;
            } catch (e) { console.warn('[sync-bookings] contact id backfill failed:', e.message); }
          } else if (email) {
            results.unmatched.push(email);
          }
        } catch (e) {
          console.warn('[sync-bookings] contact lookup failed:', e.message);
        }
      }

      if (!athlete) { if (!contactId) results.unmatched.push('(no contact on event)'); continue; }

      const stored = await storeCallBooked(athlete.code, startDate);
      results.updated.push({ code: athlete.code, ...stored });
    }

    return send(res, 200, { ok: true, ...results });
  } catch (e) {
    console.error('[sync-bookings] failed:', e && e.message);
    return send(res, 500, { ok: false, error: String(e && e.message || 'server_error') });
  }
}
