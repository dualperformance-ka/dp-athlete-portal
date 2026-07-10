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
import { select, supabaseRequest, tablePath } from './_lib/supabase-rest.js';

const MAX_TITLE = 80;
const MAX_MESSAGE = 500;

function send(res, status, payload) {
  return res.status(status).json(payload);
}

async function requireSecret(req) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const alt = String(req.headers['x-notify-secret'] || '').trim();
  const presented = bearer || alt;

  const error = new Error('Unauthorized');
  error.status = 401;
  if (!presented) {
    console.log('[notify-auth] no bearer/x-notify-secret header arrived');
    throw error;
  }

  // Fast path: exact match against this project's own secrets.
  const local = [process.env.NOTIFY_SECRET, process.env.SUPABASE_SERVICE_KEY]
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  if (local.includes(presented)) return;

  // Robust path: the dashboard may hold a DIFFERENT (but equally valid)
  // service key for the same Supabase project. Verify by capability instead
  // of string equality: only a service-level key can read rows from the
  // RLS-locked athletes table (anon keys get an empty array, invalid keys 401).
  try {
    const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    const r = await fetch(`${url}/rest/v1/athletes?select=code&limit=1`, {
      headers: { apikey: presented, Authorization: `Bearer ${presented}` },
    });
    const body = await r.text();
    let rows = null;
    try { rows = JSON.parse(body); } catch (_) { /* not json */ }
    if (r.ok && Array.isArray(rows) && rows.length > 0) return; // proven service key

    console.log('[notify-auth] probe failed', JSON.stringify({
      presentedLen: presented.length,
      presentedPrefix: presented.slice(0, 10),
      localSecretLens: local.map((s) => s.length),
      supabaseUrlSet: Boolean(process.env.SUPABASE_URL),
      probeStatus: r.status,
      probeBody: String(body).slice(0, 200),
    }));
  } catch (probeError) {
    console.log('[notify-auth] probe threw', String(probeError && probeError.message || probeError).slice(0, 200));
  }

  throw error;
}

function configureVapid() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:coach@dualperformance.co';
  if (!publicKey || !privateKey) throw new Error('VAPID keys not configured');
  webpush.setVapidDetails(subject, publicKey, privateKey);
}

async function loadSubscriptions(code) {
  if (code === 'ALL') return (await select('push_subscriptions', {})) || [];

  let subs = await select('push_subscriptions', { athlete_code: `eq.${code}` });
  if (subs && subs.length) return subs;

  // Resolve a name to a roster code (the dashboard sometimes only has names).
  const athletes = await select('athletes', {
    or: `(code.eq.${code},name.ilike.${code})`,
    select: 'code',
    limit: '1',
  });
  if (athletes && athletes.length) {
    subs = await select('push_subscriptions', { athlete_code: `eq.${athletes[0].code}` });
    if (subs && subs.length) return subs;
  }
  return [];
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
    await requireSecret(req);

    const code = String(req.body?.code || '').trim().toUpperCase();
    const title = String(req.body?.title || '').trim().slice(0, MAX_TITLE) || 'Message from your coach';
    const message = String(req.body?.message || '').trim().slice(0, MAX_MESSAGE);

    if (!code) return send(res, 400, { ok: false, error: 'code required (athlete code or ALL)' });
    if (!message) return send(res, 400, { ok: false, error: 'message required' });

    configureVapid();

    const subs = await loadSubscriptions(code);
    if (!subs.length) {
      return send(res, 404, {
        ok: false,
        error: code === 'ALL'
          ? 'No athletes have push notifications enabled yet'
          : `No subscribed devices for ${code} — the athlete needs to enable notifications in their portal`,
      });
    }

    // Unique tag so consecutive custom messages stack instead of replacing
    // each other on the athlete's device.
    const payload = JSON.stringify({
      title,
      body: message,
      tag: `dp-coach-msg-${Date.now()}`,
      url: '/',
    });

    let sent = 0;
    let removed = 0;
    const failed = [];
    const reached = new Set();

    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: 12 * 3600 }
        );
        sent++;
        reached.add(sub.athlete_code);
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          // Dead subscription — clean it up like /api/reminders does.
          await supabaseRequest(tablePath('push_subscriptions', { id: `eq.${sub.id}` }), { method: 'DELETE' }).catch(() => {});
          removed++;
        } else {
          failed.push({
            athlete: sub.athlete_code,
            error: String(error.message || error).slice(0, 200),
          });
        }
      }
    }

    return send(res, 200, { ok: sent > 0, sent, athletes: reached.size, devices: subs.length, removed, failed });
  } catch (error) {
    return send(res, error.status || 500, { ok: false, error: String(error.message || error).slice(0, 500) });
  }
}
