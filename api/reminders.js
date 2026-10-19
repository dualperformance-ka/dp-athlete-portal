// ── ATHLETE REMINDERS ─────────────────────────────────────────────────────────
// POST (from portal client): save/remove push subscription, mark inbox read,
//   or soft-dismiss one/all inbox notifications for the signed-in athlete.
//   The client includes its timezone; the durable inbox works without push.
// GET  ?portal=1          : return the athlete's notification inbox. The old
//   per-request "due" computation (nine reads the portal never rendered) now
//   runs only when ?due=1 is asked for explicitly.
// GET  (scheduled)        : authorised with REMINDERS_CRON_SECRET or CRON_SECRET.
//   Triggered every FIVE minutes by Supabase pg_cron (job:
//   send-athlete-reminders, versioned in supabase/migrations) and once daily
//   by Vercel cron as a backstop. Each run:
//     1. wins a database lease or exits immediately (no overlapping runs),
//     2. works out which athletes are inside a reminder window locally,
//     3. loads that window's inputs once per run, in batches,
//     4. builds candidate messages, then reads existing inbox rows for ALL
//        candidates in one query (dedupe + daily cap), and
//     5. writes and pushes only what is new.
//   See api/_lib/reminder-plan.js and docs/reminder-scheduling.md. Quiet hours
//   (21:00-05:30) and the daily cap apply exactly as before.
//
// Delivery is decided per ATHLETE, not per subscription row. Stale endpoints
// pile up faster than Apple retires them, so every run first collapses an
// athlete's rows to one live subscription per physical device (see
// _lib/push-devices.js) and merges their delivery history — otherwise a single
// iPhone that has been reinstalled a few times buzzes once per leftover row.
import webpush from 'web-push';
import { select, upsert, patch, supabaseRequest, tablePath } from './_lib/supabase-rest.js';
import { getRequestAthlete } from './_lib/auth.js';
import { allowPortalRequest, safeError } from './_lib/http.js';
import { clearInbox, dismissInboxNotification, listInbox, markInboxRead } from './_lib/notification-inbox.js';
import { groupByAthlete, mergeLastSent, resolvePrefs, selectLiveDevices } from './_lib/push-devices.js';
import { DAILY_PUSH_CAP, isCapExempt } from './_lib/notification-rules.js';
import {
  buildAthleteMessages,
  dedupeKeyFor,
  deliveryAction,
  loadDeliveryState,
  loadReminderInputs,
  localNow,
  placeAthletes,
  safeTz,
} from './_lib/reminder-plan.js';
import { REMINDER_JOB, REMINDER_LEASE_SECONDS, acquireLease, newLeaseOwner, releaseLease } from './_lib/job-lease.js';
import { emitPerf, outcomeOf, safeCounts, timed } from './_lib/telemetry.js';

// Stop starting new deliveries after this long. vercel.json caps the function
// at 60s and the lease at 120s, so a run can never outlive its lease.
const RUN_BUDGET_MS = 45000;

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

export async function saveInboxMessage(code, message, localDate, write = upsert) {
  const rows = await write('athlete_notifications', {
    athlete_code: code,
    type: message.type,
    title: String(message.title || 'Dual Performance').slice(0, 120),
    body: String(message.body || '').slice(0, 1000),
    url: String(message.url || '/').slice(0, 500),
    dedupe_key: dedupeKeyFor(message, localDate),
    local_date: localDate,
  }, 'athlete_code,dedupe_key');
  return Array.isArray(rows) ? rows[0] : null;
}

// The service worker has no auth token, so it cannot mark a notification read
// itself. The row id rides on the URL instead and the portal consumes it on
// boot. Any existing query string and hash are preserved.
function withNotificationId(url, id) {
  if (!id) return String(url || '/');
  const raw = String(url || '/');
  const hashAt = raw.indexOf('#');
  const head = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
  const hash = hashAt >= 0 ? raw.slice(hashAt) : '';
  return `${head}${head.includes('?') ? '&' : '?'}n=${encodeURIComponent(id)}${hash}`;
}

async function pushInboxMessage(athlete, row, message) {
  if (!row || row.pushed_at || row.dismissed_at) {
    return { reached: false, sent: 0, alreadyPushed: !!row?.pushed_at, dismissed: !!row?.dismissed_at };
  }
  const payload = JSON.stringify({
    title: message.title, body: message.body, tag: message.tag || `dp-${message.type}`,
    url: withNotificationId(message.url || '/', row.id), notificationId: row.id,
  });
  let reached = false;
  let sent = 0;
  let removed = 0;
  for (const device of athlete.devices.slice()) {
    try {
      await webpush.sendNotification(
        { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
        payload,
        { TTL: 12 * 3600, timeout: 8000 }
      );
      reached = true; sent++;
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        await supabaseRequest(tablePath('push_subscriptions', { id: `eq.${device.id}` }), { method: 'DELETE' }).catch(() => {});
        athlete.devices = athlete.devices.filter((item) => item.id !== device.id);
        removed++;
      } else {
        // No athlete code, endpoint or provider message: only what failed.
        athlete.errors.push({ type: message.type, stage: 'push', status: Number(error.statusCode) || 0 });
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

// Compatibility: the reminder state for one athlete "as of now", every window
// treated as open. Only computed when ?due=1 is asked for; the portal itself
// renders the inbox and never read this.
async function computeDueForAthlete(code, tz) {
  const now = localNow(tz);
  const athlete = {
    code, tz, now, devices: [], lastSent: {},
    prefs: resolvePrefs([], { managed: true }),
    windows: { morning: true, logging: true, readiness: true, fuel: true, weeklyReview: false, quiet: false, checkinOverdue: now.dow === 1 },
  };
  const due = (await loadReminderInputs([athlete], { read: select }))[code];
  return {
    ...due,
    coach: [...new Set((due.coach || []).map((c) => c.source))],
    strava: undefined,
    heldMessages: undefined,
  };
}

async function handleDueCheck(req, res, identity) {
  const code = String(identity.athlete.code).toUpperCase();
  if (String(req.query?.due || '') === '1') {
    const subs = await select('push_subscriptions', { athlete_code: `eq.${code}`, select: 'timezone', limit: '1' });
    const tz = safeTz(subs && subs[0] && subs[0].timezone);
    const [due, inbox] = await Promise.all([computeDueForAthlete(code, tz), listInbox(code)]);
    return send(res, 200, { ok: true, timezone: tz, due, ...inbox });
  }
  const inbox = await timed('portal.notificationInbox', () => listInbox(code), { counts: (value) => ({ items: value.notifications.length }) });
  return send(res, 200, { ok: true, ...inbox });
}

// ── The scheduled run ────────────────────────────────────────────────────────

// Roster + live devices. Two reads per run whatever the athlete count.
export async function loadRoster({ read = select } = {}) {
  const [subs, activeRows] = await Promise.all([
    read('push_subscriptions', { order: 'created_at.asc' }),
    read('athletes', { active: 'eq.true', select: 'code,notifications_managed', limit: '500' }),
  ]);
  const subscriptions = Array.isArray(subs) ? subs : [];
  const grouped = groupByAthlete(subscriptions);
  // The inbox covers the full active roster, including athletes who never
  // installed the PWA or whose push permission is blocked.
  const roster = [];
  const retire = [];
  for (const rosterRow of activeRows || []) {
    const code = String(rosterRow.code || '').toUpperCase();
    if (!code) continue;
    const rows = grouped.get(code) || [];
    const { keep, drop } = selectLiveDevices(rows);
    retire.push(...drop);
    roster.push({
      code, devices: keep, lastSent: mergeLastSent(rows),
      tz: safeTz(keep[0]?.timezone), errors: [],
      prefs: resolvePrefs(rows, { managed: rosterRow.notifications_managed !== false }),
    });
  }
  return { roster, retire, subscriptions: subscriptions.length };
}

// Everything up to (not including) delivery. `stage(name, fn)` lets the
// handler time each step; tests call it with a counting fake `read`.
export async function planReminderRun({ read = select, at = new Date(), stage = (name, fn) => fn() } = {}) {
  const nowMs = at.getTime();
  const { roster, retire, subscriptions } = await stage('reminders.roster', () => loadRoster({ read }));
  const placement = placeAthletes(roster, at);
  const due = await stage('reminders.inputs', () => loadReminderInputs(placement.placed, { read, nowMs }));
  const candidates = await stage('reminders.compute', async () => placement.placed
    .map((athlete) => ({
      athlete,
      messages: buildAthleteMessages(athlete, due[athlete.code], { nowMs }),
      heldMessages: due[athlete.code].heldMessages || [],
    }))
    .filter((candidate) => candidate.messages.length || candidate.heldMessages.length));
  // Athletes with no candidate message never reach athlete_notifications.
  const delivery = await stage('reminders.dedupe', () => loadDeliveryState(
    candidates.filter((candidate) => candidate.messages.length), { read }));
  return {
    roster, retire, subscriptions, candidates, delivery,
    stats: {
      athletes: roster.length,
      timezones: placement.zones,
      activeZones: placement.activeZones,
      skippedZones: placement.skippedZones,
      candidates: candidates.length,
      messages: candidates.reduce((sum, c) => sum + c.messages.length, 0),
    },
  };
}

async function deliverReminders(plan, { deadline }) {
  let vapidReady = true;
  try { configureVapid(); } catch { vapidReady = false; }
  let sent = 0, notified = 0, inboxed = 0, suppressed = 0, removed = 0, deduped = 0, partial = false;
  const errors = [];

  for (const { athlete, messages, heldMessages } of plan.candidates) {
    if (Date.now() > deadline) { partial = true; break; }
    const now = athlete.now;
    const quiet = athlete.windows.quiet;
    const lastSent = athlete.lastSent;
    let pushCount = plan.delivery.pushed.get(`${athlete.code}|${now.iso}`) || 0;
    let delivered = false;

    for (const message of messages.filter(Boolean)) {
      const existing = plan.delivery.existing.get(`${athlete.code}|${dedupeKeyFor(message, now.iso)}`);
      const action = deliveryAction(message, existing, { quiet, canPush: vapidReady && athlete.devices.length > 0 });
      if (action === 'skip') { deduped++; continue; }
      // One message the inbox cannot store (a schema constraint, a transient
      // PostgREST error) must not abort every athlete after this one. It is
      // reported in `errors` and the loop carries on.
      let row = existing;
      if (action === 'insert') {
        try {
          row = await saveInboxMessage(athlete.code, message, now.iso);
        } catch (error) {
          errors.push({ type: message.type, stage: 'inbox', kind: outcomeOf(error) });
          continue;
        }
        if (!row) continue;
        inboxed++;
      }
      const exempt = isCapExempt(message.type);
      const mayPush = message.push !== false && !quiet && (exempt || pushCount < DAILY_PUSH_CAP) && vapidReady && athlete.devices.length;
      if (!mayPush) { suppressed++; continue; }
      const result = await pushInboxMessage(athlete, row, message);
      sent += result.sent || 0;
      removed += result.removed || 0;
      if (result.reached) {
        if (!exempt) pushCount++;
        notified++; delivered = true;
        if (message.historyKey) lastSent[message.historyKey] = message.historyValue || now.iso;
      }
    }
    // Coach messages held through quiet hours go out now. The row already
    // exists, so it is pushed as-is rather than written again.
    if (!quiet && vapidReady && athlete.devices.length) {
      for (const held of heldMessages || []) {
        const result = await pushInboxMessage(athlete, held, {
          type: 'custom', title: held.title, body: held.body, url: held.url || '/', tag: `dp-coach-msg-${held.id}`,
        });
        sent += result.sent || 0;
        removed += result.removed || 0;
        if (result.reached) { notified++; }
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
  return { sent, notified, inboxed, suppressed, removed, deduped, partial, errors };
}

async function handleCronSend(req, res) {
  const secrets = [process.env.REMINDERS_CRON_SECRET, process.env.CRON_SECRET].filter(Boolean);
  if (!secrets.length) return send(res, 503, { ok: false, error: 'Cron secret is not configured' });
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!secrets.includes(token)) return send(res, 401, { ok: false, error: 'Unauthorized' });

  const started = Date.now();
  const owner = newLeaseOwner();
  const lease = await timed('reminders.lease', () => acquireLease(REMINDER_JOB, owner, REMINDER_LEASE_SECONDS), {
    always: true,
    counts: (value) => ({ acquired: !!value.acquired, contended: value.reason === 'held' }),
  });
  if (!lease.acquired) {
    // Another run owns the lease (or the database could not grant one): do no
    // reminder work at all and answer 200 so pg_cron does not log a failure.
    return send(res, 200, { ok: true, skipped: lease.reason === 'held' ? 'lease_held' : 'lease_unavailable' });
  }

  let outcome = 'error';
  let counts = {};
  try {
    const plan = await planReminderRun({
      at: new Date(),
      stage: (name, fn) => timed(name, fn, { always: true }),
    });
    for (const row of plan.retire) {
      await supabaseRequest(tablePath('push_subscriptions', { id: `eq.${row.id}` }), { method: 'DELETE' }).catch(() => {});
    }
    const delivery = await timed('reminders.send', () => deliverReminders(plan, { deadline: started + RUN_BUDGET_MS }), {
      always: true,
      counts: (value) => ({ notified: value.notified, inboxed: value.inboxed, deduped: value.deduped, errors: value.errors.length }),
    });
    outcome = delivery.partial ? 'partial' : 'ok';
    counts = safeCounts({
      ...plan.stats,
      subscriptions: plan.subscriptions,
      retired: plan.retire.length,
      notifications: delivery.notified,
      inboxed: delivery.inboxed,
      suppressed: delivery.suppressed,
      deduped: delivery.deduped,
      sent: delivery.sent,
      removed: delivery.removed,
      errors: delivery.errors.length,
    });
    return send(res, 200, {
      ok: true,
      ...counts,
      partial: delivery.partial,
      lease: lease.degraded || 'held',
      // Error shape only (type, stage, kind/status). No athlete codes: pg_net
      // keeps response bodies in net._http_response.
      errors: delivery.errors.slice(0, 20),
    });
  } catch (error) {
    outcome = outcomeOf(error);
    throw error;
  } finally {
    const durationMs = Date.now() - started;
    emitPerf({ op: 'reminders.run', ms: durationMs, status: outcome, counts }, { always: true });
    if (!lease.degraded) await releaseLease(REMINDER_JOB, owner, outcome, { ...counts, durationMs });
  }
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
      if (req.body?.action === 'dismiss-notification') {
        const inbox = await dismissInboxNotification(String(identity.athlete.code).toUpperCase(), req.body?.id);
        return send(res, 200, { ok: true, ...inbox });
      }
      if (req.body?.action === 'clear-notifications') {
        const inbox = await clearInbox(String(identity.athlete.code).toUpperCase());
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
    console.error('[reminders]', error && (error.kind || error.message));
    const safe = safeError(error, 'Reminders are temporarily unavailable');
    return send(res, safe.status, { ok: false, error: safe.message });
  }
}
