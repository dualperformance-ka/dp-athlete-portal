// ── ATHLETE REMINDERS ─────────────────────────────────────────────────────────
// POST (from portal client): save / remove a push subscription + preferences.
// GET  ?code=X            : return which reminders are due today for one athlete
//                           (used by the in-app fallback, no secret required).
// GET  (Vercel cron)      : authorised with CRON_SECRET — send due reminders to
//                           every subscribed athlete via Web Push.
import webpush from 'web-push';
import { select, upsert, patch, supabaseRequest, tablePath } from './lib/supabase-rest.js';

const DONE_STATUS = /^(done|completed?|complete|skipped|missed)$/i;

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

// Current date in the athletes' timezone (UK).
function londonToday() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return {
    iso: `${get('year')}-${get('month')}-${get('day')}`,
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
  };
}

function inList(values) {
  return `in.(${[...new Set(values)].map((v) => `"${String(v).replace(/"/g, '')}"`).join(',')})`;
}

// For each athlete code, work out which reminder types are due today.
async function computeDue(codes, { iso, dow }) {
  const due = {};
  codes.forEach((c) => { due[c] = { sessions: [], checkin: false, photos: false, coach: false }; });
  const list = inList(codes);

  // 1. Training sessions planned today and not already completed.
  const sessions = await select('planned_sessions', {
    athlete_code: list, planned_date: `eq.${iso}`, select: 'athlete_code,title,session_type,status',
  });
  for (const row of sessions || []) {
    if (row.status && DONE_STATUS.test(String(row.status).trim())) continue;
    if (due[row.athlete_code]) due[row.athlete_code].sessions.push(row.title || row.session_type || 'Session');
  }

  // 2. Weekly check-in: nudge on Sunday if nothing submitted in the last 6 days.
  if (dow === 0) {
    const since = new Date(Date.now() - 6 * 864e5).toISOString();
    const done = await select('weekly_checkins', {
      athlete_code: list, submitted_at: `gte.${since}`, select: 'athlete_code',
    });
    const submitted = new Set((done || []).map((r) => r.athlete_code));
    codes.forEach((c) => { if (!submitted.has(c)) due[c].checkin = true; });
  }

  // 3. Progress photos: Monday of every 4th week since the athlete's start date.
  if (dow === 1) {
    const athletes = await select('athletes', { code: list, select: 'code,start_date' });
    for (const a of athletes || []) {
      if (!a.start_date || !due[a.code]) continue;
      const weeks = Math.floor((new Date(iso) - new Date(a.start_date)) / (7 * 864e5));
      if (weeks > 0 && weeks % 4 === 0) due[a.code].photos = true;
    }
  }

  // 4. Coach replies: prescription overrides touched in the last 24h.
  const since24 = new Date(Date.now() - 24 * 36e5).toISOString();
  const overrides = await select('session_overrides', { updated_at: `gte.${since24}`, select: 'notion_page_id' });
  if (overrides && overrides.length) {
    const pages = await select('planned_sessions', {
      notion_page_id: inList(overrides.map((o) => o.notion_page_id)), select: 'athlete_code',
    });
    for (const p of pages || []) if (due[p.athlete_code]) due[p.athlete_code].coach = true;
  }

  return due;
}

function buildMessages(dueForAthlete, prefs) {
  const messages = [];
  if (prefs.sessions && dueForAthlete.sessions.length) {
    messages.push({
      type: 'sessions', title: 'Training today',
      body: dueForAthlete.sessions.join(' · ') + ' — open the portal for the full prescription.',
    });
  }
  if (prefs.checkins && dueForAthlete.checkin) {
    messages.push({
      type: 'checkins', title: 'Weekly check-in due',
      body: 'Take three minutes to review your week before it resets tomorrow.',
    });
  }
  if (prefs.photos && dueForAthlete.photos) {
    messages.push({
      type: 'photos', title: 'Progress photo week',
      body: 'Same time, same lighting — grab your four angles this week.',
    });
  }
  if (prefs.coach && dueForAthlete.coach) {
    messages.push({
      type: 'coach', title: 'Coach update',
      body: 'Your coach adjusted your plan — check the changes before your next session.',
    });
  }
  return messages;
}

async function handleSubscribe(req, res) {
  const { action, code, subscription, prefs, endpoint, userAgent } = req.body || {};

  if (action === 'unsubscribe') {
    if (!endpoint) return send(res, 400, { ok: false, error: 'endpoint required' });
    await supabaseRequest(tablePath('push_subscriptions', { endpoint: `eq.${endpoint}` }), { method: 'DELETE' });
    return send(res, 200, { ok: true });
  }

  if (action !== 'subscribe') return send(res, 400, { ok: false, error: 'Unknown action' });
  const keys = subscription && subscription.keys;
  if (!code || !subscription || !subscription.endpoint || !keys || !keys.p256dh || !keys.auth) {
    return send(res, 400, { ok: false, error: 'code and subscription required' });
  }

  const athlete = await select('athletes', { code: `eq.${String(code).toUpperCase()}`, select: 'code' });
  if (!athlete || !athlete.length) return send(res, 404, { ok: false, error: 'Unknown athlete code' });

  await upsert('push_subscriptions', {
    athlete_code: athlete[0].code,
    endpoint: subscription.endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    prefs: prefs || {},
    user_agent: (userAgent || '').slice(0, 500),
    updated_at: new Date().toISOString(),
  }, 'endpoint');

  return send(res, 200, { ok: true });
}

async function handleDueCheck(req, res) {
  const code = String(req.query.code || '').toUpperCase();
  if (!code) return send(res, 400, { ok: false, error: 'code required' });
  const due = await computeDue([code], londonToday());
  return send(res, 200, { ok: true, due: due[code] });
}

async function handleCronSend(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token !== cronSecret) return send(res, 401, { ok: false, error: 'Unauthorized' });
  }

  configureVapid();
  const today = londonToday();
  const subs = await select('push_subscriptions', { order: 'created_at.asc' });
  if (!subs || !subs.length) return send(res, 200, { ok: true, sent: 0, note: 'No subscriptions' });

  const due = await computeDue(subs.map((s) => s.athlete_code), today);

  let sent = 0, removed = 0;
  const errors = [];

  for (const sub of subs) {
    const prefs = sub.prefs || {};
    const lastSent = sub.last_sent || {};
    const messages = buildMessages(due[sub.athlete_code] || {}, prefs)
      .filter((m) => lastSent[m.type] !== today.iso); // one per type per day

    let delivered = false;
    for (const msg of messages) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify({ title: msg.title, body: msg.body, tag: 'dp-' + msg.type, url: '/' }),
          { TTL: 12 * 3600 }
        );
        lastSent[msg.type] = today.iso;
        sent++; delivered = true;
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          await supabaseRequest(tablePath('push_subscriptions', { id: `eq.${sub.id}` }), { method: 'DELETE' });
          removed++;
          break;
        }
        errors.push({ athlete: sub.athlete_code, type: msg.type, error: String(error.message || error).slice(0, 200) });
      }
    }
    if (delivered) {
      await patch('push_subscriptions', { id: `eq.${sub.id}` }, { last_sent: lastSent, updated_at: new Date().toISOString() });
    }
  }

  return send(res, 200, { ok: true, subscriptions: subs.length, sent, removed, errors });
}

export default async function handler(req, res) {
  try {
    if (req.method === 'POST') return await handleSubscribe(req, res);
    if (req.method === 'GET' && req.query.code) return await handleDueCheck(req, res);
    if (req.method === 'GET') return await handleCronSend(req, res);
    return send(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (error) {
    return send(res, 500, { ok: false, error: String(error.message || error).slice(0, 500) });
  }
}
