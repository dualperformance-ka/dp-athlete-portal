// ── ATHLETE REMINDERS ─────────────────────────────────────────────────────────
// POST (from portal client): save/remove push subscription or mark inbox read.
//   The client includes its timezone; the durable inbox works without push.
// GET  ?portal=1          : return due state and the athlete's notification inbox.
// GET  (scheduled)        : authorised with REMINDERS_CRON_SECRET or CRON_SECRET.
//   Triggered every minute by Supabase pg_cron (job: send-athlete-reminders) and
//   once daily by Vercel cron as a backstop. Each run only sends to athletes whose
//   LOCAL time matches 05:30 morning or 19:30 logging windows. All push types
//   obey the 21:00–05:30 quiet period and three-per-local-day cap.
//
// Delivery is decided per ATHLETE, not per subscription row. Stale endpoints
// pile up faster than Apple retires them, so every run first collapses an
// athlete's rows to one live subscription per physical device (see
// _lib/push-devices.js) and merges their delivery history — otherwise a single
// iPhone that has been reinstalled a few times buzzes once per leftover row.
import webpush from 'web-push';
import { select, upsert, patch, supabaseRequest, tablePath } from './_lib/supabase-rest.js';
import { getRequestAthlete } from './_lib/auth.js';
import { allowPortalRequest } from './_lib/http.js';
import { groupByAthlete, mergeLastSent, resolvePrefs, selectLiveDevices } from './_lib/push-devices.js';
import {
  DAILY_PUSH_CAP, MORNING_HOUR, MORNING_MINUTE, LOGGING_HOUR, LOGGING_MINUTE,
  buildCallMessage, buildCoachMessage, buildLoggingMessage, buildMorningMessage,
  isQuietTime, minuteMatches, partitionCoachChanges,
} from './_lib/notification-rules.js';

const DONE_STATUS = /^(done|completed?|complete|skipped|missed)$/i;
const DEFAULT_TZ = 'Australia/Adelaide';

// Which categories a managed athlete receives lives in _lib/push-devices.js
// alongside resolvePrefs(), so the delivery rules stay testable without pulling
// web-push into the test process.
//
// Athletes carrying their own preferences. Anyone missing from the table, or
// with the column unset, is managed — the default has to be "receives
// everything", or a new athlete would silently get nothing.
async function loadUnmanagedAthletes(codes) {
  if (!codes.length) return new Set();
  try {
    const rows = await select('athletes', {
      code: inList(codes),
      notifications_managed: 'is.false',
      select: 'code',
    });
    return new Set((rows || []).map((row) => String(row.code).toUpperCase()));
  } catch (error) {
    // A missing column must not take reminders down: fall back to managed.
    return new Set();
  }
}

function send(res, status, payload) {
  return res.status(status).json(payload);
}

function configureVapid() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:coach@dualperformance.co';
  if (!publicKey || !privateKey) throw new Error('VAPID keys not configured');
  webpush.setVapidDetails(subject, publicKey, privateKey);
}

// Local date / weekday / hour for a timezone. Returns null for invalid zones.
function localNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date());
    const get = (t) => { const p = parts.find((x) => x.type === t); return p ? p.value : null; };
    return {
      tz,
      iso: `${get('year')}-${get('month')}-${get('day')}`,
      dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
      hour: parseInt(get('hour'), 10),
      minute: parseInt(get('minute'), 10),
    };
  } catch (e) { return null; }
}

function safeTz(tz) {
  return (tz && localNow(tz)) ? tz : DEFAULT_TZ;
}

function inList(values) {
  return `in.(${[...new Set(values)].map((v) => `"${String(v).replace(/"/g, '')}"`).join(',')})`;
}

// For each athlete code, work out which reminder types are due on this local day.
async function computeDue(codes, { iso, dow, tz = DEFAULT_TZ }) {
  const due = {};
  codes.forEach((c) => { due[c] = {
    iso, sessions: [], unlogged: [], checkin: false, photos: false, coach: [],
    callsToday: [], callsSoon: [], noCallBooked: false,
  }; });
  const list = inList(codes);

  // 1. Training sessions planned today (local) and not already completed.
  const sessions = await select('planned_sessions', {
    athlete_code: list, planned_date: `eq.${iso}`, publish_state: 'eq.published',
    select: 'athlete_code,title,session_type,status,part_of_day,estimated_minutes',
  });
  for (const row of sessions || []) {
    if (row.status && DONE_STATUS.test(String(row.status).trim())) continue;
    if (due[row.athlete_code]) due[row.athlete_code].sessions.push(row);
  }

  // 2. Weekly check-in: Sunday morning, if nothing submitted in the last 6 days.
  if (dow === 0) {
    const since = new Date(Date.now() - 6 * 864e5).toISOString();
    const done = await select('weekly_checkins', {
      athlete_code: list, submitted_at: `gte.${since}`, select: 'athlete_code',
    });
    const submitted = new Set((done || []).map((r) => r.athlete_code));
    codes.forEach((c) => { if (!submitted.has(c)) due[c].checkin = true; });
  }

  // 3. Progress photos: requested weekly — every Monday, start of the week.
  if (dow === 1) {
    codes.forEach((c) => { due[c].photos = true; });
  }

  // 4. Coach updates: any coach-side change logged in the last 24h.
  //    (DB triggers on planned_sessions, nutrition_plans, workout_splits and
  //    session_overrides write to coach_change_log, ignoring athlete-driven
  //    fields like session status.)
  const since24 = new Date(Date.now() - 24 * 36e5).toISOString();
  const changes = await select('coach_change_log', {
    athlete_code: list, changed_at: `gte.${since24}`, select: 'athlete_code,source,changed_at,detail',
  });
  for (const c of changes || []) {
    const d = due[c.athlete_code];
    if (d) d.coach.push({ source: c.source, at: c.changed_at, detail: c.detail });
  }

  // 5. Evening logging reminder. Any structured log or Strava activity today
  // counts as completed work; never nag an athlete who has already recorded it.
  const [loggedRows, activityRows] = await Promise.all([
    select('training_session_logs', {
      athlete_code: list, session_date: `eq.${iso}`, select: 'athlete_code', limit: '1000',
    }),
    select('strava_activities', {
      athlete_code: list,
      start_date_local: `gte.${iso}T00:00:00`,
      select: 'athlete_code,start_date_local', limit: '1000',
    }),
  ]);
  const logged = new Set((loggedRows || []).map((row) => row.athlete_code));
  for (const row of activityRows || []) {
    if (String(row.start_date_local || '').slice(0, 10) === iso) logged.add(row.athlete_code);
  }
  codes.forEach((code) => {
    if (!logged.has(code)) due[code].unlogged = due[code].sessions.slice();
  });

  // 6. Calls are already synchronised into Supabase athlete_data by the GHL
  // webhook/backfill. The reminder cron reads only that durable copy.
  const bookingRows = await select('athlete_data', {
    athlete_code: list, key: 'like.call_booked_*', select: 'athlete_code,key,value', limit: '1000',
  });
  const nowMs = Date.now();
  const weekEndMs = nowMs + 7 * 86400000;
  const hasUpcoming = new Set();
  for (const row of bookingRows || []) {
    const startsAt = row?.value?.startsAt || row?.value?.startTime || row?.value?.start_time;
    const startMs = Date.parse(startsAt || '');
    if (!Number.isFinite(startMs) || startMs < nowMs - 6 * 3600000) continue;
    const target = due[row.athlete_code];
    if (!target) continue;
    if (startMs <= weekEndMs) hasUpcoming.add(row.athlete_code);
    const call = { startsAt: new Date(startMs).toISOString(), displayTime: row?.value?.time || row?.value?.displayTime || 'time in the portal' };
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(startMs));
    const part = (name) => parts.find((entry) => entry.type === name)?.value || '';
    if (`${part('year')}-${part('month')}-${part('day')}` === iso) {
      target.callsToday.push(call);
    }
    const minutesAway = (startMs - nowMs) / 60000;
    if (minutesAway >= 118 && minutesAway <= 122) target.callsSoon.push(call);
  }
  if (dow === 0) codes.forEach((code) => { due[code].noCallBooked = !hasUpcoming.has(code); });

  return due;
}

// "Tue 14 Jul" from a YYYY-MM-DD planned date (locale-independent).
function formatChangeDate(iso) {
  const d = new Date(String(iso) + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return days[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + months[d.getUTCMonth()];
}

// Build the coach-update body from change details: name up to three changes
// ("Tempo Run (Tue 14 Jul) updated - Long Run added"), falling back to
// per-area counts when there are too many or details are missing.
function coachBody(changes) {
  const seen = new Set();
  const named = [];
  for (const c of changes) { // newest first
    const det = c.detail || {};
    if (!det.item) continue;
    const key = det.action + '|' + det.item + '|' + (det.date || '');
    if (seen.has(key)) continue;
    seen.add(key);
    const date = det.date ? formatChangeDate(det.date) : null;
    named.push(det.item + (date ? ' (' + date + ')' : '') + ' ' + (det.action || 'updated'));
  }
  const allNamed = named.length && named.length === seen.size && changes.every((c) => c.detail && c.detail.item);
  if (allNamed && named.length <= 3) {
    const body = named.join(' \u00b7 ');
    if (body.length <= 140) return body + ' \u2014 open the portal for details.';
  }
  // Fallback: counts per area, e.g. "4 training changes \u00b7 nutrition updated".
  const bySource = {};
  for (const c of changes) bySource[c.source] = (bySource[c.source] || 0) + 1;
  const parts = Object.entries(bySource)
    .map(([src, n]) => (n > 1 ? n + ' ' + src + ' changes' : src + ' updated'));
  return 'Your coach made changes: ' + parts.join(' \u00b7 ') + ' \u2014 see the portal.';
}

function buildMessages(dueForAthlete, prefs, allowed, coachChanges) {
  const messages = [];
  if (allowed.morning && prefs.sessions && dueForAthlete.sessions.length) {
    messages.push({
      type: 'sessions', title: 'Training today',
      body: dueForAthlete.sessions.join(' · ') + ' — open the portal for the full prescription.',
    });
  }
  if (allowed.morning && prefs.checkins && dueForAthlete.checkin) {
    messages.push({
      type: 'checkins', title: 'Weekly check-in due',
      body: 'Take three minutes to review your week before it resets tomorrow.',
    });
  }
  if (allowed.morning && prefs.photos && dueForAthlete.photos) {
    messages.push({
      type: 'photos', title: 'Progress photo week',
      body: 'New week — grab your four angles. Same time, same lighting.',
    });
  }
  if (allowed.coach && prefs.coach && coachChanges && coachChanges.length) {
    messages.push({ type: 'coach', title: 'Coach update', body: coachBody(coachChanges) });
  }
  return messages;
}

async function saveInboxMessage(code, message, localDate) {
  const rows = await upsert('athlete_notifications', {
    athlete_code: code,
    type: message.type,
    title: String(message.title || 'Dual Performance').slice(0, 120),
    body: String(message.body || '').slice(0, 1000),
    url: String(message.url || '/').slice(0, 500),
    dedupe_key: String(message.dedupeKey || `${message.type}:${localDate}`).slice(0, 240),
    local_date: localDate,
  }, 'athlete_code,dedupe_key');
  return Array.isArray(rows) ? rows[0] : null;
}

async function listInbox(code) {
  const [rows, unreadRows] = await Promise.all([
    select('athlete_notifications', {
      athlete_code: `eq.${code}`,
      select: 'id,type,title,body,url,created_at,read_at,pushed_at',
      order: 'created_at.desc',
      limit: '50',
    }),
    select('athlete_notifications', {
      athlete_code: `eq.${code}`, read_at: 'is.null', select: 'id', limit: '1000',
    }),
  ]);
  const notifications = Array.isArray(rows) ? rows : [];
  return { notifications, unread: Array.isArray(unreadRows) ? unreadRows.length : 0 };
}

async function markInboxRead(code, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) {
    const error = new Error('A valid notification id is required');
    error.status = 400;
    throw error;
  }
  await patch('athlete_notifications', { id: `eq.${id}`, athlete_code: `eq.${code}` }, { read_at: new Date().toISOString() });
  return listInbox(code);
}

async function pushedToday(code, iso) {
  const rows = await select('athlete_notifications', {
    athlete_code: `eq.${code}`, local_date: `eq.${iso}`, pushed_at: 'not.is.null',
    select: 'id', limit: String(DAILY_PUSH_CAP + 1),
  });
  return Array.isArray(rows) ? rows.length : 0;
}

async function unreadSuppressed(code, iso) {
  const rows = await select('athlete_notifications', {
    athlete_code: `eq.${code}`, local_date: `lt.${iso}`, pushed_at: 'is.null', read_at: 'is.null',
    select: 'id', limit: '25',
  });
  return Array.isArray(rows) ? rows.length : 0;
}

async function pushInboxMessage(athlete, row, message) {
  if (!row || row.pushed_at) return { reached: false, sent: 0, alreadyPushed: !!row?.pushed_at };
  const payload = JSON.stringify({
    title: message.title, body: message.body, tag: `dp-${message.type}`,
    url: message.url || '/', notificationId: row.id,
  });
  let reached = false;
  let sent = 0;
  let removed = 0;
  for (const device of athlete.devices.slice()) {
    try {
      await webpush.sendNotification(
        { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
        payload,
        { TTL: 12 * 3600 }
      );
      reached = true; sent++;
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        await supabaseRequest(tablePath('push_subscriptions', { id: `eq.${device.id}` }), { method: 'DELETE' }).catch(() => {});
        athlete.devices = athlete.devices.filter((item) => item.id !== device.id);
        removed++;
      } else {
        athlete.errors.push({ athlete: athlete.code, type: message.type, error: String(error.message || error).slice(0, 200) });
      }
    }
  }
  if (reached) await patch('athlete_notifications', { id: `eq.${row.id}` }, { pushed_at: new Date().toISOString() });
  return { reached, sent, removed };
}

// Retire the rows a device left behind on earlier installs and give every
// surviving device one shared delivery history and one set of preferences.
// Without this a brand-new endpoint starts with `last_sent: {}` and replays
// whatever the athlete already saw on the same phone this morning.
async function reconcileAthleteDevices(code, options = {}) {
  const rows = await select('push_subscriptions', { athlete_code: `eq.${code}` });
  if (!rows || !rows.length) return { devices: 0, retired: 0 };

  const { keep, drop } = selectLiveDevices(rows, { pinnedEndpoint: options.pinnedEndpoint });
  const lastSent = mergeLastSent(rows);

  for (const row of drop) {
    await supabaseRequest(tablePath('push_subscriptions', { id: `eq.${row.id}` }), { method: 'DELETE' }).catch(() => {});
  }

  const values = { last_sent: lastSent };
  if (options.prefs) values.prefs = options.prefs;
  if (options.timezone) values.timezone = options.timezone;
  for (const row of keep) {
    await patch('push_subscriptions', { id: `eq.${row.id}` }, values).catch(() => {});
  }

  return { devices: keep.length, retired: drop.length };
}

async function handleSubscribe(req, res, identity) {
  const { action, subscription, prefs, endpoint, userAgent, timezone } = req.body || {};
  const code = String(identity.athlete.code).toUpperCase();

  if (action === 'unsubscribe') {
    if (!endpoint) return send(res, 400, { ok: false, error: 'endpoint required' });
    await supabaseRequest(tablePath('push_subscriptions', {
      endpoint: `eq.${endpoint}`,
      athlete_code: `eq.${code}`,
    }), { method: 'DELETE' });
    return send(res, 200, { ok: true });
  }

  if (action !== 'subscribe') return send(res, 400, { ok: false, error: 'Unknown action' });
  const keys = subscription && subscription.keys;
  if (!code || !subscription || !subscription.endpoint || !keys || !keys.p256dh || !keys.auth) {
    return send(res, 400, { ok: false, error: 'code and subscription required' });
  }

  const tz = safeTz(timezone);
  // The portal no longer sends preferences — it has no toggles to send. Omit
  // the column entirely rather than writing {} over it, so an exempt athlete's
  // stored choice survives every re-subscribe.
  const cleanPrefs = (prefs && typeof prefs === 'object') ? prefs : null;

  const row = {
    athlete_code: code,
    endpoint: subscription.endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    timezone: tz,
    user_agent: (userAgent || '').slice(0, 500),
    updated_at: new Date().toISOString(),
  };
  if (cleanPrefs) row.prefs = cleanPrefs;
  await upsert('push_subscriptions', row, 'endpoint');

  const reconciled = await reconcileAthleteDevices(code, {
    pinnedEndpoint: subscription.endpoint,
    prefs: cleanPrefs,
    timezone: tz,
  });

  return send(res, 200, { ok: true, devices: reconciled.devices, retired: reconciled.retired });
}

async function handleDueCheck(req, res, identity) {
  const code = String(identity.athlete.code).toUpperCase();
  const subs = await select('push_subscriptions', { athlete_code: `eq.${code}`, select: 'timezone', limit: '1' });
  const tz = safeTz(subs && subs[0] && subs[0].timezone);
  const due = await computeDue([code], localNow(tz));
  const d = due[code];
  d.coach = [...new Set((d.coach || []).map((c) => c.source))];
  const inbox = await listInbox(code);
  return send(res, 200, { ok: true, timezone: tz, due: d, ...inbox });
}

async function handleCronSend(req, res) {
  const secrets = [process.env.REMINDERS_CRON_SECRET, process.env.CRON_SECRET].filter(Boolean);
  if (!secrets.length) return send(res, 503, { ok: false, error: 'Cron secret is not configured' });
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!secrets.includes(token)) return send(res, 401, { ok: false, error: 'Unauthorized' });

  const [subs, activeRows] = await Promise.all([
    select('push_subscriptions', { order: 'created_at.asc' }),
    select('athletes', { active: 'eq.true', select: 'code,notifications_managed', limit: '500' }),
  ]);
  const subscriptions = Array.isArray(subs) ? subs : [];
  const grouped = groupByAthlete(subscriptions);
  let vapidReady = true;
  try { configureVapid(); } catch { vapidReady = false; }

  // The inbox covers the full active roster, including athletes who never
  // installed the PWA or whose push permission is blocked.
  let retired = 0;
  const roster = [];
  for (const rosterRow of activeRows || []) {
    const code = String(rosterRow.code || '').toUpperCase();
    if (!code) continue;
    const rows = grouped.get(code) || [];
    const { keep, drop } = selectLiveDevices(rows);
    for (const row of drop) {
      await supabaseRequest(tablePath('push_subscriptions', { id: `eq.${row.id}` }), { method: 'DELETE' }).catch(() => {});
      retired++;
    }
    roster.push({
      code, rows, devices: keep, lastSent: mergeLastSent(rows),
      tz: safeTz(keep[0]?.timezone), errors: [],
      prefs: resolvePrefs(rows, { managed: rosterRow.notifications_managed !== false }),
    });
  }
  if (!roster.length) return send(res, 200, { ok: true, sent: 0, retired, note: 'No active athletes' });

  // Group athletes by timezone; only process zones in an active window.
  const groups = new Map();
  for (const athlete of roster) {
    if (!groups.has(athlete.tz)) groups.set(athlete.tz, []);
    groups.get(athlete.tz).push(athlete);
  }

  let sent = 0, notified = 0, inboxed = 0, suppressed = 0, removed = 0, skippedZones = 0;
  const errors = [];

  for (const [tz, zoneAthletes] of groups) {
    const now = localNow(tz);
    if (!now) { skippedZones++; continue; }
    const morning = minuteMatches(now, MORNING_HOUR, MORNING_MINUTE);
    const logging = minuteMatches(now, LOGGING_HOUR, LOGGING_MINUTE);
    const quiet = isQuietTime(now);
    const due = await computeDue(zoneAthletes.map((a) => a.code), now);

    for (const athlete of zoneAthletes) {
      const lastSent = athlete.lastSent;
      const athleteDue = due[athlete.code] || { iso: now.iso, sessions: [], unlogged: [], coach: [] };
      const messages = [];

      if (morning) {
        const missed = await unreadSuppressed(athlete.code, now.iso);
        const morningDue = {
          ...athleteDue,
          sessions: athlete.prefs.sessions ? athleteDue.sessions : [],
          checkin: athlete.prefs.checkins && athleteDue.checkin,
          photos: athlete.prefs.photos && athleteDue.photos,
          callsToday: athlete.prefs.calls ? athleteDue.callsToday : [],
          noCallBooked: athlete.prefs.calls && athleteDue.noCallBooked,
          missedSummary: missed ? `${missed} coaching update${missed === 1 ? '' : 's'} waiting in your inbox` : '',
        };
        const message = buildMorningMessage(morningDue);
        if (message && lastSent.morning !== now.iso) messages.push({ ...message, historyKey: 'morning' });
      }
      if (logging && athlete.prefs.logging) {
        const message = buildLoggingMessage(athleteDue.unlogged, now.iso);
        if (message && lastSent.logging !== now.iso) messages.push({ ...message, historyKey: 'logging' });
      }
      if (athlete.prefs.calls) {
        for (const call of athleteDue.callsSoon || []) messages.push({ ...buildCallMessage(call, now.iso), historyKey: 'calls' });
      }

      // A coach edit is processed once it is two minutes old, so a save burst
      // becomes one useful batch. Only the next seven days can spend a push;
      // future block publication remains durable in the inbox.
      const coachEntries = athleteDue.coach || [];
      const lastCoach = lastSent.coach ? new Date(lastSent.coach).getTime() : 0;
      const freshChanges = coachEntries.filter((c) => new Date(c.at).getTime() > lastCoach);
      const newest = freshChanges.length ? Math.max(...freshChanges.map((c) => new Date(c.at).getTime())) : 0;
      const coachChanges = (freshChanges.length && Date.now() - newest >= 2 * 60 * 1000)
        ? freshChanges.slice().sort((a, b) => new Date(b.at) - new Date(a.at)) : [];
      if (athlete.prefs.coach && coachChanges.length) {
        const partitioned = partitionCoachChanges(coachChanges, now.iso);
        const near = buildCoachMessage([...partitioned.near, ...partitioned.undated], now.iso);
        const future = buildCoachMessage(partitioned.future, now.iso, { future: true });
        if (near) messages.push({ ...near, historyKey: 'coach', historyValue: new Date(newest).toISOString() });
        if (future) messages.push({ ...future, historyKey: null, push: false });
      }

      let pushCount = await pushedToday(athlete.code, now.iso);
      let delivered = false;
      for (const message of messages.filter(Boolean)) {
        const row = await saveInboxMessage(athlete.code, message, now.iso);
        if (!row) continue;
        inboxed++;
        const mayPush = message.push !== false && !quiet && pushCount < DAILY_PUSH_CAP && vapidReady && athlete.devices.length;
        if (!mayPush) { suppressed++; continue; }
        const result = await pushInboxMessage(athlete, row, message);
        sent += result.sent || 0;
        removed += result.removed || 0;
        if (result.reached) {
          pushCount++; notified++; delivered = true;
          if (message.historyKey) lastSent[message.historyKey] = message.historyValue || now.iso;
        }
      }
      errors.push(...athlete.errors);

      // One shared history across the athlete's devices, so a phone that comes
      // back online later inherits it instead of replaying today.
      if (delivered && athlete.devices.length) {
        const stamp = new Date().toISOString();
        for (const device of athlete.devices) {
          await patch('push_subscriptions', { id: `eq.${device.id}` }, { last_sent: lastSent, updated_at: stamp }).catch(() => {});
        }
      }
    }
  }

  return send(res, 200, {
    ok: true,
    subscriptions: subscriptions.length,
    athletes: roster.length,
    timezones: groups.size,
    notifications: notified,
    inboxed,
    suppressed,
    sent,
    retired,
    removed,
    skippedZones,
    errors,
  });
}

export default async function handler(req, res) {
  if (!allowPortalRequest(req, res, 'GET, POST, OPTIONS')) return;
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    if (req.method === 'POST') {
      const identity = await getRequestAthlete(req);
      if (!identity) return send(res, 401, { ok: false, error: 'invalid_session' });
      if (req.body?.action === 'read-notification') {
        const inbox = await markInboxRead(String(identity.athlete.code).toUpperCase(), req.body?.id);
        return send(res, 200, { ok: true, ...inbox });
      }
      return await handleSubscribe(req, res, identity);
    }
    if (req.method === 'GET' && req.query.portal === '1') {
      const identity = await getRequestAthlete(req);
      if (!identity) return send(res, 401, { ok: false, error: 'invalid_session' });
      return await handleDueCheck(req, res, identity);
    }
    if (req.method === 'GET') return await handleCronSend(req, res);
    return send(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (error) {
    return send(res, 500, { ok: false, error: String(error.message || error).slice(0, 500) });
  }
}
