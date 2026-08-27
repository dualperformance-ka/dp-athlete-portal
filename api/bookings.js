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

import { select, patch, remove } from './_lib/supabase-rest.js';
import {
  storeCallBooked, reconcileCallBookings,
} from './_lib/booking.js';
import crypto from 'node:crypto';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const DEFAULT_CALENDAR = 'WRivrNxfNTVER2xMit1z';

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

function calendarEvents(response) {
  if (Array.isArray(response?.events)) return response.events;
  if (Array.isArray(response?.data)) return response.data;
  throw new Error('GHL calendar response did not contain an events array');
}

// Authenticated portal recovery path. GHL's embedded widget sometimes reports
// a successful booking without including the selected timestamp in its
// postMessage payload. In that case /api/portal-data calls this function with
// the athlete code derived from the signed session, then reads the resulting
// athlete_data row back to the browser. No client-supplied identity is trusted.
export async function syncBookingsForAthlete(code, options = {}) {
  const selectRows = options.selectRows || select;
  const patchRows = options.patchRows || patch;
  const removeRows = options.removeRows || remove;
  const fetchGhl = options.fetchGhl || ghl;
  const storeBooking = options.storeBooking || storeCallBooked;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const locationId = options.locationId || process.env.GHL_LOCATION_ID;
  const calendarId = options.calendarId || process.env.GHL_CALENDAR_ID || DEFAULT_CALENDAR;
  if (!locationId) throw new Error('GHL_LOCATION_ID not configured');

  const roster = await selectRows('athletes', {
    code: `eq.${String(code).toUpperCase()}`,
    select: 'code,email,ghl_contact_id',
    limit: 1,
  });
  const athlete = Array.isArray(roster) ? roster[0] : null;
  if (!athlete) throw new Error('Athlete not found');

  // Include recent history as well as upcoming appointments so an already
  // booked call can recover after a reload or a delayed webhook.
  const start = now - 14 * 86400000;
  const end = now + 60 * 86400000;
  const windowMs = 30 * 86400000;
  const events = [];
  for (let from = start; from < end; from += windowMs) {
    const to = Math.min(from + windowMs, end);
    const response = await fetchGhl(
      `/calendars/events?locationId=${encodeURIComponent(locationId)}&calendarId=${encodeURIComponent(calendarId)}&startTime=${from}&endTime=${to}`,
      '2021-04-15'
    );
    const batch = calendarEvents(response);
    for (const event of batch) events.push(event);
  }

  const targetEmail = String(athlete.email || '').trim().toLowerCase();
  let targetContactId = String(athlete.ghl_contact_id || '').trim();
  const contactEmails = new Map();
  const seen = new Set();
  const matchedEvents = [];
  const ordered = events
    .filter((event) => {
      const id = event.id || event.eventId || `${event.contactId || event.contact_id}:${event.startTime || event.start_time}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => new Date(a.startTime || a.start_time || 0) - new Date(b.startTime || b.start_time || 0));

  for (const event of ordered) {
    const contactId = String(event.contactId || event.contact_id || '').trim();
    const inlineEmail = String(
      event.email || event.contactEmail || event.contact_email || (event.contact && event.contact.email) || ''
    ).trim().toLowerCase();
    let matches = !!(targetContactId && contactId === targetContactId)
      || !!(targetEmail && inlineEmail === targetEmail);

    // Older roster rows may not have a GHL contact id yet. Resolve only the
    // unique contacts present on this calendar and stop doing lookups once the
    // athlete's id is known.
    if (!matches && !targetContactId && targetEmail && contactId) {
      let eventEmail = contactEmails.get(contactId);
      if (eventEmail === undefined) {
        try {
          const contactResponse = await fetchGhl(`/contacts/${encodeURIComponent(contactId)}`, '2021-07-28');
          eventEmail = String(contactResponse && contactResponse.contact && contactResponse.contact.email || '').trim().toLowerCase();
        } catch {
          eventEmail = '';
        }
        contactEmails.set(contactId, eventEmail);
      }
      if (eventEmail && eventEmail === targetEmail) {
        matches = true;
        targetContactId = contactId;
        try {
          await patchRows('athletes', { code: `eq.${athlete.code}` }, { ghl_contact_id: contactId });
        } catch (error) {
          console.warn('[bookings recovery] contact id backfill failed:', error && error.message);
        }
      }
    }
    if (!matches) continue;

    matchedEvents.push(event);
  }

  const reconciled = await reconcileCallBookings(athlete.code, matchedEvents, {
    start,
    end,
    now,
    calendarId,
    selectRows,
    removeRows,
    storeBooking,
  });
  return { ...reconciled, calendarId };
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

    const stored = await storeCallBooked(row.code, start, {
      eventId: pick(body.event_id, body.eventId, body.appointment_id, body.appointmentId, appointment.id, appointment.eventId),
      calendarId: pick(body.calendar_id, body.calendarId, appointment.calendar_id, appointment.calendarId),
    });
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

  // Backlog window. Defaults reach far enough back to pick up calls booked
  // before this endpoint existed, so every athlete's history lands on the
  // right week key. Override per-run with ?days_back=&days_ahead=.
  const days = (value, fallback) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, 400) : fallback;
  };
  const q = req.query || {};
  const daysBack = days(q.days_back, 120);
  const daysAhead = days(q.days_ahead, 60);
  const start = Date.now() - daysBack * 86400000;
  const end = Date.now() + daysAhead * 86400000;
  // ?debug=1 reports what was actually queried and what came back; ?dry_run=1
  // matches athletes without writing. "Nothing happened" is otherwise
  // indistinguishable from "wrong calendar" or "token can't see the calendar".
  const debug = String(q.debug || '') === '1';
  const dryRun = String(q.dry_run || '') === '1';

  try {
    // GHL's calendar events endpoint gets unreliable over long spans, so the
    // range is walked in 30-day windows and the results concatenated.
    const WINDOW = 30 * 86400000;
    const events = [];
    const windows = [];
    for (let from = start; from < end; from += WINDOW) {
      const to = Math.min(from + WINDOW, end);
      const eventsRes = await ghl(
        `/calendars/events?locationId=${encodeURIComponent(locationId)}&calendarId=${encodeURIComponent(calendarId)}&startTime=${from}&endTime=${to}`,
        '2021-04-15'
      );
      const batch = calendarEvents(eventsRes);
      if (debug) {
        windows.push({
          from: new Date(from).toISOString().slice(0, 10),
          to: new Date(to).toISOString().slice(0, 10),
          count: batch.length,
          // If GHL nests events under a key we don't read, the payload keys
          // reveal it immediately rather than silently yielding zero.
          payloadKeys: batch.length ? undefined : Object.keys(eventsRes || {}),
        });
      }
      for (const ev of batch) events.push(ev);
    }
    // De-duplicate across window overlaps, then process oldest first so the
    // most recent booking wins when a week holds more than one appointment.
    const seen = new Set();
    const ordered = events
      .filter((ev) => {
        const id = ev.id || ev.eventId || `${ev.contactId}:${ev.startTime}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .sort((a, b) => new Date(a.startTime || a.start_time || 0) - new Date(b.startTime || b.start_time || 0));

    const roster = await select('athletes', { select: 'code,email,ghl_contact_id', limit: 500 });
    const byContact = {};
    const byEmail = {};
    const unknownContacts = new Set();
    (roster || []).forEach((r) => {
      if (r.ghl_contact_id) byContact[r.ghl_contact_id] = r;
      if (r.email) byEmail[String(r.email).toLowerCase()] = r;
    });

    const results = {
      window: { from: new Date(start).toISOString(), to: new Date(end).toISOString() },
      calendarId,
      calendarSource: process.env.GHL_CALENDAR_ID ? 'env' : 'default',
      rosterWithContactId: Object.keys(byContact).length,
      dryRun,
      events: ordered.length,
      updated: [],
      removed: [],
      skipped: 0,
      unmatched: [],
    };
    if (debug) {
      results.windows = windows;
      results.sample = ordered.slice(0, 5).map((ev) => ({
        contactId: ev.contactId || ev.contact_id || null,
        startTime: ev.startTime || ev.start_time || null,
        status: ev.appointmentStatus || ev.appoinmentStatus || null,
        onRoster: !!byContact[ev.contactId || ev.contact_id],
      }));
    }

    const eventsByAthlete = {};
    for (const ev of ordered) {
      const contactId = ev.contactId || ev.contact_id || '';
      let athlete = contactId ? byContact[contactId] : null;

      // A long backlog window can hold dozens of events for contacts who are
      // not on the roster; the negative cache keeps that to one lookup each.
      if (!athlete && contactId && !unknownContacts.has(contactId)) {
        try {
          const contactRes = await ghl(`/contacts/${encodeURIComponent(contactId)}`, '2021-07-28');
          const email = String((contactRes && contactRes.contact && contactRes.contact.email) || '').toLowerCase();
          if (email && byEmail[email]) {
            athlete = byEmail[email];
            try {
              await patch('athletes', { code: `eq.${athlete.code}` }, { ghl_contact_id: contactId });
              byContact[contactId] = athlete;
            } catch (e) { console.warn('[bookings sync] contact id backfill failed:', e.message); }
          } else {
            unknownContacts.add(contactId);
            if (email) results.unmatched.push(email);
          }
        } catch (e) {
          unknownContacts.add(contactId);
          console.warn('[bookings sync] contact lookup failed:', e.message);
        }
      }

      if (!athlete) { if (!contactId) results.unmatched.push('(no contact on event)'); continue; }
      const athleteCode = String(athlete.code || '').toUpperCase();
      if (!eventsByAthlete[athleteCode]) eventsByAthlete[athleteCode] = [];
      eventsByAthlete[athleteCode].push(ev);
    }

    // Pull the existing projection once. Athletes whose cancelled event has
    // disappeared from GHL's response still enter reconciliation through this
    // set, which is what lets an all-cancelled week clear reliably.
    const existingBookingRows = await select('athlete_data', {
      key: 'like.call_booked_*',
      select: 'athlete_code,key,value',
      limit: '5000',
    });
    const existingByAthlete = {};
    for (const row of existingBookingRows || []) {
      const code = String(row.athlete_code || '').toUpperCase();
      if (!code) continue;
      if (!existingByAthlete[code]) existingByAthlete[code] = [];
      existingByAthlete[code].push(row);
    }
    const rosterCodes = new Set((roster || []).map((row) => String(row.code || '').toUpperCase()).filter(Boolean));
    const reconcileCodes = new Set([...Object.keys(eventsByAthlete), ...Object.keys(existingByAthlete)]);
    for (const code of reconcileCodes) {
      if (!rosterCodes.has(String(code).toUpperCase())) continue;
      const reconciled = await reconcileCallBookings(code, eventsByAthlete[code] || [], {
        start,
        end,
        now: Date.now(),
        calendarId,
        dryRun,
        existingRows: existingByAthlete[String(code).toUpperCase()] || [],
      });
      results.updated.push(...reconciled.updated.map((entry) => ({ code, ...entry })));
      results.removed.push(...reconciled.removed.map((entry) => ({ code, ...entry })));
      results.skipped += reconciled.skipped;
    }

    results.unmatched = [...new Set(results.unmatched)];
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
