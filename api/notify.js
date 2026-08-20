// /api/notify.js  (ATHLETE PORTAL)
// Sends a custom coach-written push notification to an athlete's subscribed
// devices (or every athlete). Lives on the portal because the VAPID private
// key is already configured here — the coaches dashboard calls this endpoint
// server-to-server via its own /api/notify proxy.
//
//   POST /api/notify
//     auth: Authorization: Bearer <NOTIFY_SECRET>  (or x-notify-secret header)
//     body: { code: 'ABC123' | 'ALL', title?, message }
//
// Env required (portal Vercel project):
//   NOTIFY_SECRET                        -> any long random string you create;
//                                           set the SAME value on the dashboard
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY  -> already configured (reminders use them)
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   -> already configured

import webpush from 'web-push';
import crypto from 'node:crypto';
import { select, upsert, patch, supabaseRequest, tablePath } from './_lib/supabase-rest.js';
import { DAILY_PUSH_CAP, isQuietTime } from './_lib/notification-rules.js';
import { selectLiveDevices } from './_lib/push-devices.js';

const MAX_TITLE = 80;
const MAX_MESSAGE = 500;

function send(res, status, payload) {
  return res.status(status).json(payload);
}

function equalSecret(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireSecret(req) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const alt = String(req.headers['x-notify-secret'] || '').trim();
  const presented = bearer || alt;

  const error = new Error('Unauthorized');
  error.status = 401;
  const configured = String(process.env.NOTIFY_SECRET || '').trim();
  if (!configured) {
    error.status = 503;
    error.message = 'Notification service is not configured';
    throw error;
  }
  if (!equalSecret(presented, configured)) throw error;
}

function configureVapid() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:coach@dualperformance.co';
  if (!publicKey || !privateKey) throw new Error('VAPID keys not configured');
  webpush.setVapidDetails(subject, publicKey, privateKey);
}

function localNow(timezone) {
  let tz = String(timezone || 'Australia/Adelaide');
  try { new Intl.DateTimeFormat('en-AU', { timeZone: tz }).format(); }
  catch { tz = 'Australia/Adelaide'; }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  return { iso: `${value('year')}-${value('month')}-${value('day')}`, hour: Number(value('hour')), minute: Number(value('minute')) };
}

async function loadRecipients(code) {
  if (code === 'ALL') {
    const athletes = await select('athletes', { active: 'eq.true', select: 'code', limit: '500' });
    return (athletes || []).map((row) => String(row.code).toUpperCase());
  }
  const athletes = await select('athletes', {
    or: `(code.eq.${code},name.ilike.${code})`, active: 'eq.true', select: 'code', limit: '1',
  });
  return athletes?.length ? [String(athletes[0].code).toUpperCase()] : [];
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
    requireSecret(req);

    const code = String(req.body?.code || '').trim().toUpperCase();
    const title = String(req.body?.title || '').trim().slice(0, MAX_TITLE) || 'Message from your coach';
    const message = String(req.body?.message || '').trim().slice(0, MAX_MESSAGE);

    if (!code) return send(res, 400, { ok: false, error: 'code required (athlete code or ALL)' });
    if (!message) return send(res, 400, { ok: false, error: 'message required' });

    let vapidReady = true;
    try { configureVapid(); } catch { vapidReady = false; }

    const recipients = await loadRecipients(code);
    if (!recipients.length) return send(res, 404, { ok: false, error: `No active athlete found for ${code}` });
    const subs = await select('push_subscriptions', { athlete_code: `in.(${recipients.map((item) => `"${item}"`).join(',')})` });
    const byAthlete = new Map();
    for (const sub of subs || []) {
      const key = String(sub.athlete_code).toUpperCase();
      if (!byAthlete.has(key)) byAthlete.set(key, []);
      byAthlete.get(key).push(sub);
    }

    // Unique tag so consecutive custom messages stack instead of replacing
    // each other on the athlete's device.
    const requestStamp = Date.now();
    const dedupe = crypto.createHash('sha1').update(`${title}\n${message}`).digest('hex').slice(0, 16);
    const payload = JSON.stringify({
      title,
      body: message,
      tag: `dp-coach-msg-${requestStamp}`,
      url: '/',
    });

    let sent = 0;
    let removed = 0;
    const failed = [];
    const reached = new Set();

    for (const athleteCode of recipients) {
      const { keep, drop } = selectLiveDevices(byAthlete.get(athleteCode) || []);
      const now = localNow(keep[0]?.timezone);
      const localDate = now.iso;
      const inboxRows = await upsert('athlete_notifications', {
        athlete_code: athleteCode, type: 'custom', title, body: message, url: '/', local_date: localDate,
        dedupe_key: `custom:${requestStamp}:${dedupe}`,
      }, 'athlete_code,dedupe_key');
      const inbox = inboxRows?.[0];
      for (const stale of drop) {
        await supabaseRequest(tablePath('push_subscriptions', { id: `eq.${stale.id}` }), { method: 'DELETE' }).catch(() => {});
        removed++;
      }
      const pushed = await select('athlete_notifications', {
        athlete_code: `eq.${athleteCode}`, local_date: `eq.${localDate}`, pushed_at: 'not.is.null',
        select: 'id', limit: String(DAILY_PUSH_CAP + 1),
      });
      if (!vapidReady || isQuietTime(now) || (pushed || []).length >= DAILY_PUSH_CAP) continue;
      let athleteReached = false;
      for (const sub of keep) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 12 * 3600 }
          );
          sent++; athleteReached = true;
        } catch (error) {
          if (error.statusCode === 404 || error.statusCode === 410) {
            await supabaseRequest(tablePath('push_subscriptions', { id: `eq.${sub.id}` }), { method: 'DELETE' }).catch(() => {});
            removed++;
          } else {
            failed.push({ athlete: sub.athlete_code, error: String(error.message || error).slice(0, 200) });
          }
        }
      }
      if (athleteReached) {
        reached.add(athleteCode);
        if (inbox?.id) await patch('athlete_notifications', { id: `eq.${inbox.id}` }, { pushed_at: new Date().toISOString() });
      }
    }

    return send(res, 200, { ok: true, inboxed: recipients.length, sent, athletes: reached.size, devices: (subs || []).length, removed, failed, pushReady: vapidReady });
  } catch (error) {
    return send(res, error.status || 500, {
      ok: false,
      error: error.status && error.status < 500 ? String(error.message || error) : 'Notification service unavailable',
    });
  }
}
