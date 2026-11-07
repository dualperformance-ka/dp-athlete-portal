/**
 * Garmin Connect integration: single serverless function, four modes.
 *
 *   GET  /api/garmin                  athlete's connection status + recent activities
 *   GET  /api/garmin-callback         OAuth callback          (→ ?mode=callback)
 *   POST /api/garmin-webhook          Garmin push/ping data   (→ ?mode=webhook)
 *   POST /api/garmin-disconnect       deregister + purge      (→ ?mode=disconnect)
 *
 * One file with ?mode= branches, the same convention as api/strava.js and
 * api/bookings.js; the rewrites in vercel.json give each mode a real URL.
 *
 * ── HOW THE DATA FLOWS ──────────────────────────────────────────────────────
 * The athlete consents on Garmin's own page (OAuth 2.0 + PKCE). From then on
 * Garmin PUSHES summaries to /api/garmin-webhook a few minutes after each
 * watch sync, and the webhook upserts them. Nothing is pulled on page load.
 * The first authenticated read after connecting asks Garmin to replay the last
 * 30 days, which arrives through the same webhook.
 *
 * ── CONSENT BOUNDARY ────────────────────────────────────────────────────────
 * Data is deleted, not hidden, when consent goes: on disconnect in the portal,
 * on a deregistration notification from Garmin, and per data type when the
 * athlete unticks a permission in Garmin Connect. dualperformance.au/privacy
 * promises all three.
 *
 * Garmin data is NOT sent to the AI weekly review. The privacy policy says the
 * AI summary receives no connected-provider data, which is why no separate AI
 * consent was needed for Garmin. Keep it that way unless the policy changes
 * first.
 *
 * Required env:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   GARMIN_CLIENT_ID, GARMIN_CLIENT_SECRET   from developerportal.garmin.com
 *   PORTAL_URL                               https://portal.dualperformance.au
 * Optional env:
 *   GARMIN_ALLOWED_ATHLETES   comma-separated athlete codes. When set, only
 *                             those athletes are offered Garmin, which is how
 *                             the integration is tested before rollout. Unset
 *                             offers it to everyone once the keys exist.
 */
import { requestAthleteOr503 } from './_lib/auth.js';
import { timed } from './_lib/telemetry.js';
import { createPortalSession, verifyPortalSession } from './_lib/legacy-session.js';
import { allowPortalRequest } from './_lib/http.js';
import {
  BACKFILL_DAYS,
  BACKFILL_TYPES,
  PERMISSION_DATA,
  accessTokenFresh,
  buildAuthorizeUrl,
  deregister,
  exchangeCode,
  fetchCallback,
  fetchPermissions,
  fetchUserId,
  garminAvailableFor,
  garminConfigured,
  parseNotification,
  pkceVerifier,
  refreshGarminToken,
  refreshRequiresReconnect,
  requestBackfill,
  rowToActivity,
  tokenFields,
} from './_lib/garmin-client.js';
import {
  deleteData,
  findConnectionByGarminUser,
  getConnection,
  latestDaily,
  listActivities,
  patchConnection,
  purgeAthlete,
  saveConnection,
  saveRecords,
} from './_lib/garmin-store.js';

import { lockedAccessToken, loadWorkoutPrescription, sendPrescribedWorkout, workoutReceipt, refreshIdleGarminConnections } from './_lib/garmin-workout-service.js';

function portalUrl() {
  const configured = process.env.PORTAL_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
  return String(configured).replace(/\/+$/, '');
}

function callbackUrl() {
  // Must match the OAuth redirect URL registered on the Garmin app exactly.
  return `${portalUrl()}/api/garmin-callback`;
}

function requestId(req) {
  return (req.headers && req.headers['x-vercel-id']) || null;
}

function warn(payload) {
  console.warn(JSON.stringify({ level: 'warning', ...payload }));
}

function info(payload) {
  console.info(JSON.stringify({ level: 'info', ...payload }));
}

// Whether this athlete is offered Garmin at all lives in garmin-client.js so
// the weekly review and reminders can use the same allowlist.
export { garminAvailableFor };

// The only place a connect URL is built. The signed `state` names the athlete
// and also seeds the PKCE verifier, so a URL made anywhere else cannot work.
function buildConnectUrl(athleteCode) {
  const state = createPortalSession(athleteCode, { purpose: 'garmin', ttlSeconds: 10 * 60 });
  return buildAuthorizeUrl(callbackUrl(), state);
}

/**
 * A usable access token for this connection, refreshing when it is inside
 * Garmin's expiry margin. Garmin rotates refresh tokens, so the new one is
 * saved immediately; holding on to the old one would break the next refresh.
 */
export async function getAccessToken(connection, deps = {}) {
  const {
    refresh = refreshGarminToken,
    saveTokens = (code, fields) => patchConnection(code, fields),
    now = Date.now,
  } = deps;
  if (!connection || !connection.access_token) return null;
  if (!Object.keys(deps).length) return lockedAccessToken(connection);
  if (accessTokenFresh(connection, now())) return connection.access_token;

  const refreshed = await refresh(connection.refresh_token);
  const fields = tokenFields(refreshed, now());
  if (!fields.refresh_token) fields.refresh_token = connection.refresh_token;
  await saveTokens(connection.athlete_code, fields);
  Object.assign(connection, fields);
  return fields.access_token;
}

// ── Notifications ────────────────────────────────────────────────────────────

/**
 * Apply one webhook body. Pure routing over injectable deps; exported for
 * tests. Returns counts only, never athlete data, because it is what the
 * webhook logs.
 *
 * A summary for a Garmin user nobody here is linked to is skipped: forged, or
 * left over from an athlete who disconnected. Deregistrations run last so a
 * body that carries both data and a deregistration for the same athlete ends
 * with nothing stored.
 */
export async function processNotification(body, deps = {}) {
  const {
    findConnection = findConnectionByGarminUser,
    store = saveRecords,
    removeData = deleteData,
    purge = purgeAthlete,
    updateConnection = patchConnection,
    accessToken = getAccessToken,
    fetchPing = fetchCallback,
  } = deps;

  const parsed = parseNotification(body);
  const counts = { saved: 0, unknownUser: 0, pings: 0, deregistered: 0, permissionChanges: 0, ignoredTypes: parsed.ignored.length };
  const lookups = new Map();
  const touched = new Set();

  async function connectionFor(userId) {
    if (!lookups.has(userId)) lookups.set(userId, await findConnection(userId));
    return lookups.get(userId);
  }

  // Group pushed summaries per athlete and kind so each becomes one upsert.
  const groups = new Map();
  for (const item of parsed.records) {
    const connection = await connectionFor(item.userId);
    if (!connection) { counts.unknownUser += 1; continue; }
    const key = `${connection.athlete_code}|${item.kind}`;
    if (!groups.has(key)) groups.set(key, { code: connection.athlete_code, kind: item.kind, records: [] });
    groups.get(key).records.push(item.record);
  }
  for (const group of groups.values()) {
    const result = await store(group.code, group.kind, group.records);
    counts.saved += Number(result && result.saved) || 0;
    touched.add(group.code);
  }

  for (const ping of parsed.pings) {
    const connection = await connectionFor(ping.userId);
    if (!connection) { counts.unknownUser += 1; continue; }
    const token = await accessToken(connection);
    if (!token) continue;
    const records = await fetchPing(ping.callbackURL, token);
    const result = await store(connection.athlete_code, ping.kind, records);
    counts.saved += Number(result && result.saved) || 0;
    counts.pings += 1;
    touched.add(connection.athlete_code);
  }

  for (const change of parsed.permissionChanges) {
    const connection = await connectionFor(change.userId);
    if (!connection) { counts.unknownUser += 1; continue; }
    const revoked = Object.keys(PERMISSION_DATA).filter((permission) => !change.permissions.includes(permission));
    const kinds = [...new Set(revoked.flatMap((permission) => PERMISSION_DATA[permission]))];
    if (kinds.length) await removeData(connection.athlete_code, kinds);
    await updateConnection(connection.athlete_code, { permissions: change.permissions });
    counts.permissionChanges += 1;
  }

  for (const userId of parsed.deregistrations) {
    const connection = await connectionFor(userId);
    if (!connection) { counts.unknownUser += 1; continue; }
    await purge(connection.athlete_code);
    touched.delete(connection.athlete_code);
    counts.deregistered += 1;
  }

  // Best effort: a freshness stamp is not worth failing a delivery over.
  for (const code of touched) {
    try { await updateConnection(code, { last_push_at: new Date().toISOString() }); } catch { /* ignore */ }
  }

  return counts;
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const mode = String((req.query && req.query.mode) || '').toLowerCase();
  if (mode === 'workout') return handleWorkout(req, res);
  if (mode === 'refresh') return handleRefresh(req, res);
  if (mode === 'callback')   return handleCallback(req, res);
  if (mode === 'webhook')    return handleWebhook(req, res);
  if (mode === 'disconnect') return handleDisconnect(req, res);
  return timed('garmin.read', () => handleRead(req, res));
}

// ── Mode: read ───────────────────────────────────────────────────────────────

async function requestHistory(connection) {
  const token = await getAccessToken(connection);
  if (!token) return false;
  const endS = Math.floor(Date.now() / 1000);
  const startS = endS - BACKFILL_DAYS * 24 * 60 * 60;
  const outcomes = {};
  for (const type of BACKFILL_TYPES) {
    outcomes[type] = await requestBackfill(token, type, { startS, endS });
  }
  info({ message: 'Garmin history requested', route: '/api/garmin', athleteCode: connection.athlete_code, outcomes });
  await patchConnection(connection.athlete_code, { backfill_requested_at: new Date().toISOString() });
  return true;
}

async function handleRead(req, res) {
  if (!allowPortalRequest(req, res, 'GET, OPTIONS')) return;
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const identity = await requestAthleteOr503(req, res);
  if (identity === undefined) return;
  if (!identity) return res.status(401).json({ error: 'invalid_session' });
  const athleteCode = String(identity.athlete.code).toUpperCase();

  if (!garminAvailableFor(athleteCode)) return res.status(200).json({ available: false });

  try {
    const connection = await getConnection(athleteCode);
    if (!connection) {
      return res.status(200).json({ available: true, connected: false, connectUrl: buildConnectUrl(athleteCode), workoutsAvailable: process.env.GARMIN_WORKOUTS_ENABLED === 'true' });
    }

    // Liveness. Pushes keep arriving without our token, so a dead refresh token
    // does not stop the data, only history requests and (later) workout push.
    // That is a "reconnect when convenient", not a broken connection.
    let reconnectRecommended = false;
    let accessToken = null;
    try {
      accessToken = await getAccessToken(connection);
    } catch (error) {
      // Another request is refreshing this token right now. Not a broken
      // connection: show the card and let the next load verify permissions.
      if (error && error.code === 'busy') accessToken = null;
      else if (!refreshRequiresReconnect(error)) throw error;
      else {
        reconnectRecommended = true;
        warn({ message: 'Garmin refresh token rejected; reconnect recommended', route: '/api/garmin', requestId: requestId(req), garminStatus: error.status });
      }
    }

    let permissions = connection.permissions || [];
    let permissionsVerified = false;
    if(accessToken){
      try {
        permissions = await fetchPermissions(accessToken);
        permissionsVerified = true;
        if(JSON.stringify(permissions)!==JSON.stringify(connection.permissions||[]))await patchConnection(athleteCode,{permissions});
      } catch(error) {
        warn({message:'Garmin permissions could not be verified',route:'/api/garmin',garminStatus:error.status||null});
      }
    }
    const historyAvailable = permissionsVerified && permissions.includes('HISTORICAL_DATA_EXPORT');
    if (!reconnectRecommended && historyAvailable && !connection.backfill_requested_at) {
      try {
        await requestHistory(connection);
      } catch (error) {
        // Not stamped, so the next load asks again.
        warn({ message: 'Garmin history request failed; will retry on the next load', route: '/api/garmin', requestId: requestId(req), garminStatus: error.status || null, error: String(error.message || error).slice(0, 200) });
      }
    }

    const [rows, daily] = await Promise.all([listActivities(athleteCode, { limit: 60 }), latestDaily(athleteCode)]);

    return res.status(200).json({
      available: true,
      connected: true,
      connectedAt: connection.connected_at,
      lastSyncAt: connection.last_push_at || null,
      permissions,
      permissionsVerified,
      historyAvailable,
      workoutsAvailable: process.env.GARMIN_WORKOUTS_ENABLED === 'true',
      workoutConnectUrl: buildConnectUrl(athleteCode),
      // Connected, but Garmin confirmed workout import is not allowed: the
      // athlete is asked to reconnect and tick it. Unverified reads say nothing.
      workoutImportMissing: process.env.GARMIN_WORKOUTS_ENABLED === 'true' && permissionsVerified && !permissions.includes('WORKOUT_IMPORT'),
      historyRequested: !!connection.backfill_requested_at,
      activities: rows.map(rowToActivity).filter(Boolean),
      latestDaily: daily ? {
        date: daily.calendar_date,
        activeKcal: daily.active_kcal,
        bmrKcal: daily.bmr_kcal,
        steps: daily.steps,
        restingHr: daily.resting_hr,
      } : null,
      ...(reconnectRecommended ? { reconnectRecommended: true, reconnectUrl: buildConnectUrl(athleteCode) } : {}),
    });
  } catch (error) {
    console.error('[garmin]', error);
    return res.status(500).json({ error: error.message });
  }
}

// ── Mode: webhook ────────────────────────────────────────────────────────────

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return null;
}

async function handleWebhook(req, res) {
  // Garmin is not a browser: no CORS, no athlete session. A pushed summary is
  // only stored when its userId resolves to an athlete who connected, and a
  // ping callback is only followed to apis.garmin.com.
  res.setHeader('Cache-Control', 'no-store');

  // Reachability check from the endpoint configuration tool.
  if (req.method === 'GET' || req.method === 'HEAD') return res.status(200).json({ ok: true });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Garmin identifies the app in this header. It is not a secret, so it only
  // filters out stray traffic; a mismatch is still acknowledged so nothing
  // retries it.
  const sentClientId = req.headers && req.headers['garmin-client-id'];
  if (sentClientId && process.env.GARMIN_CLIENT_ID && String(sentClientId) !== String(process.env.GARMIN_CLIENT_ID)) {
    warn({ message: 'Garmin webhook from an unexpected client id', route: '/api/garmin-webhook' });
    return res.status(200).json({ received: true, ignored: 'unexpected_client' });
  }

  const body = parseBody(req);
  if (!body) return res.status(200).json({ received: true, ignored: 'malformed_body' });

  try {
    const counts = await processNotification(body);
    // Summary type names only (e.g. activityDetails), never their contents, so
    // a missing activity can be told apart from a type that is not stored.
    const ignoredKeys = counts.ignoredTypes ? parseNotification(body).ignored.slice(0, 10).map((key) => String(key).slice(0, 40)) : undefined;
    info({ message: 'Garmin notification applied', route: '/api/garmin-webhook', requestId: requestId(req), ...counts, ignoredKeys });
    return res.status(200).json({ received: true, ...counts });
  } catch (error) {
    // A non-200 makes Garmin redeliver, which is the only way a summary that
    // failed to store is not lost.
    console.error('[garmin-webhook]', error);
    return res.status(500).json({ error: 'store_failed' });
  }
}

// ── Mode: disconnect ─────────────────────────────────────────────────────────

async function handleDisconnect(req, res) {
  if (!allowPortalRequest(req, res, 'POST, OPTIONS')) return;
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const identity = await requestAthleteOr503(req, res);
  if (identity === undefined) return;
  if (!identity) return res.status(401).json({ error: 'invalid_session' });
  const athleteCode = String(identity.athlete.code).toUpperCase();

  try {
    const connection = await getConnection(athleteCode);

    // Tell Garmin first so it stops sending data, but never let its answer
    // block the local purge: the athlete asked for this, and keeping their
    // data because Garmin was slow is the wrong failure.
    if (connection) {
      try {
        const token = await getAccessToken(connection);
        if (token) await deregister(token);
      } catch (error) {
        warn({ message: 'Garmin deregistration failed; purging locally anyway', route: '/api/garmin-disconnect', requestId: requestId(req), garminStatus: error.status || null });
      }
    }

    await purgeAthlete(athleteCode);
    info({ message: 'Garmin disconnected', route: '/api/garmin-disconnect', requestId: requestId(req), athleteCode });
    return res.status(200).json({
      available: true,
      connected: false,
      disconnected: true,
      ...(garminAvailableFor(athleteCode) ? { connectUrl: buildConnectUrl(athleteCode) } : {}),
    });
  } catch (error) {
    console.error('[garmin-disconnect]', error);
    return res.status(500).json({ error: error.message });
  }
}

// ── Mode: callback ───────────────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .slice(0, 500);
}

function shell(title, body, accent, redirectUrl = '') {
  const refresh = redirectUrl ? `<meta http-equiv="refresh" content="1;url=${escapeHtml(redirectUrl)}">` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${refresh}
<title>${escapeHtml(title)} — Dual Performance</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0a0a0a;color:#f0ede8;font-family:'Helvetica Neue',sans-serif;
       display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .card{background:#161616;border:1px solid ${accent};border-radius:16px;
        padding:40px 32px;max-width:420px;width:100%;text-align:center}
  h1{font-size:22px;font-weight:900;letter-spacing:.04em;text-transform:uppercase;margin-bottom:8px}
  p{font-size:14px;color:rgba(255,255,255,.55);line-height:1.6;margin-top:8px}
  code{font-family:monospace;font-size:11px;color:#f87171;background:rgba(248,113,113,.08);padding:2px 6px;border-radius:4px}
  .action{display:inline-flex;margin-top:20px;padding:10px 16px;border-radius:9px;
          background:#92d2ed;color:#0a0d10;text-decoration:none;font-size:13px;font-weight:800}
</style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
}

function successPage(returnUrl) {
  return shell('Garmin Connected', `
  <h1>Garmin Connected</h1>
  <p>Your Garmin activities, daily energy expenditure and sleep will now sync
     to Dual Performance a few minutes after each watch sync.</p>
  <p>Your coaching team sees the data you authorised. You can disconnect at any
     time from Preferences in the portal, which deletes it.</p>
  <p>Returning you to the portal now.</p>
  <a class="action" href="${escapeHtml(returnUrl)}">Return to portal</a>`, 'rgba(146,210,237,.35)', returnUrl);
}

function errorPage(message) {
  const returnUrl = `${portalUrl()}/?garmin=error`;
  return shell('Connection Failed', `
  <h1 style="color:#f87171">Connection Failed</h1>
  <p>Something went wrong connecting your Garmin account.</p>
  <p><code>${escapeHtml(message)}</code></p>
  <p>Return to the portal and try again. If it still fails, contact your coach.</p>
  <a class="action" href="${escapeHtml(returnUrl)}">Return to portal</a>`, 'rgba(248,113,113,.25)');
}

async function handleCallback(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  const { code, state, error } = req.query || {};
  info({ message: 'Garmin OAuth callback received', route: '/api/garmin-callback', requestId: requestId(req), hasCode: !!code, hasState: !!state, hasError: !!error });

  if (error) return res.status(400).send(errorPage('Garmin access was not granted'));
  if (!code || !state) return res.status(400).send(errorPage('Missing code or athlete identifier'));

  const rawState = decodeURIComponent(String(state));
  const verified = verifyPortalSession(rawState, 'garmin');
  if (!verified) return res.status(400).send(errorPage('The connection link expired. Start again from the portal.'));
  const athleteCode = String(verified.code).toUpperCase();

  if (!garminConfigured()) return res.status(500).send(errorPage('Garmin credentials not configured'));
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).send(errorPage('Supabase credentials not configured'));
  }

  try {
    const tokens = await exchangeCode({ code: String(code), verifier: pkceVerifier(rawState), redirectUri: callbackUrl() });
    const fields = tokenFields(tokens);
    const garminUserId = await fetchUserId(fields.access_token);

    // One Garmin account, one athlete. Re-linking it here would silently
    // redirect someone else's data stream to this athlete.
    const existing = await findConnectionByGarminUser(garminUserId);
    if (existing && String(existing.athlete_code).toUpperCase() !== athleteCode) {
      warn({ message: 'Garmin account already linked to another athlete', route: '/api/garmin-callback', requestId: requestId(req), athleteCode });
      return res.status(409).send(errorPage('This Garmin account is already connected to another Dual Performance athlete.'));
    }

    let permissions = [];
    try {
      permissions = await fetchPermissions(fields.access_token);
    } catch (permissionError) {
      warn({ message: 'Garmin permissions lookup failed; saving the connection without them', route: '/api/garmin-callback', garminStatus: permissionError.status || null });
    }

    await saveConnection(athleteCode, {
      ...fields,
      garmin_user_id: garminUserId,
      permissions,
      connected_at: new Date().toISOString(),
      // A fresh consent may widen what was shared, so history is requested
      // again on the next read.
      backfill_requested_at: null,
    });

    info({ message: 'Garmin OAuth connection saved', route: '/api/garmin-callback', requestId: requestId(req), athleteCode, permissions });
    return res.status(200).send(successPage(`${portalUrl()}/?garmin=connected`));
  } catch (err) {
    console.error('[garmin-callback]', err);
    return res.status(500).send(errorPage(err.message));
  }
}


// Workout contents and dates are always re-read from the athlete's published
// coach prescription; a browser cannot send arbitrary Garmin workout payloads.
// The only things a request carries are the session id and the fingerprint of
// the preview the athlete reviewed.
function receiptView(receipt, fingerprint) {
  if (!receipt) return null;
  return {
    state: receipt.state,
    date: receipt.scheduled_date || null,
    sentAt: receipt.sent_at || null,
    upToDate: receipt.state === 'sent' && receipt.fingerprint === fingerprint,
  };
}

function previewBody(prescribed, connection, code, receipt) {
  return {
    sessionId: prescribed.session.id,
    workout: prescribed.workout,
    date: prescribed.date,
    fingerprint: prescribed.fingerprint,
    canSend: (connection.permissions || []).includes('WORKOUT_IMPORT'),
    reconnectUrl: buildConnectUrl(code),
    receipt: receiptView(receipt, prescribed.fingerprint),
  };
}

export function workoutFailure(error) {
  const status = Number(error && error.status);
  const reconnect = (error && error.code === 'reconnect') || status === 401 || status === 403 || status === 412
    || (error && error.garminRefresh && refreshRequiresReconnect(error));
  if (error && error.publicMessage && !reconnect) return { status, code: error.code || 'invalid', message: error.publicMessage };
  if (reconnect) return { status: 412, code: 'reconnect', message: (error && error.code === 'reconnect' && error.publicMessage) || 'Garmin needs you to reconnect and allow workout import before DP can add workouts.' };
  if (status === 400) return { status: 422, code: 'rejected', message: 'Garmin rejected this workout, so nothing was added. Ask your coach to check the session steps.' };
  if (status === 429) return { status: 429, code: 'rate_limited', message: 'Garmin is limiting requests right now. Nothing new was added. Try again in a few minutes.' };
  if (error && error.code === 'schedule_unconfirmed') return { status: 502, code: 'schedule_unconfirmed', message: 'Your workout is in Garmin Connect, but the calendar entry wasn’t confirmed. Try again: DP checks your Garmin calendar before adding it.' };
  return { status: 502, code: 'unconfirmed', message: 'Garmin didn’t confirm the workout. Check your Garmin Connect calendar before trying again.' };
}

async function handleWorkout(req, res) {
  if (!allowPortalRequest(req,res,'GET, POST, OPTIONS')) return;
  if (req.method==='OPTIONS') return res.status(200).end();
  if (!['GET','POST'].includes(req.method)) return res.status(405).json({error:'Method not allowed'});
  res.setHeader('Cache-Control','no-store');
  const identity=await requestAthleteOr503(req,res);
  if(identity===undefined)return;
  if(!identity)return res.status(401).json({error:'invalid_session'});
  const code=String(identity.athlete.code).toUpperCase();
  if(!garminAvailableFor(code)||process.env.GARMIN_WORKOUTS_ENABLED!=='true')return res.status(404).json({error:'Garmin workouts are not enabled.',code:'not_enabled'});
  try {
    const connection=await getConnection(code);
    if(!connection)return res.status(409).json({error:'Connect Garmin in Preferences before sending workouts.',code:'not_connected'});
    const key=req.method==='POST'?req.body?.sessionId:req.query?.sessionId;
    if(req.method==='GET') {
      const prescribed=await loadWorkoutPrescription(code,key);
      const receipt=await workoutReceipt(code,prescribed.session.id,connection.garmin_user_id);
      return res.status(200).json(previewBody(prescribed,connection,code,receipt));
    }
    const reviewed=typeof req.body?.fingerprint==='string'?req.body.fingerprint.slice(0,64):'';
    const receipt=await sendPrescribedWorkout(code,key,connection,reviewed);
    info({message:'Garmin workout saved to calendar',route:'/api/garmin',requestId:requestId(req),athleteCode:code,unchanged:!!receipt.unchanged});
    return res.status(200).json({sent:true,state:'saved',date:receipt.scheduled_date,sentAt:receipt.sent_at,unchanged:!!receipt.unchanged});
  } catch(error) {
    const failure=workoutFailure(error);
    if(failure.status>=500||failure.code==='delivery_uncertain')warn({message:'Garmin workout not confirmed',route:'/api/garmin',requestId:requestId(req),athleteCode:code,code:failure.code,garminStatus:Number(error&&error.status)||null});
    const body={error:failure.message,code:failure.code};
    if(failure.code==='reconnect')body.reconnectUrl=buildConnectUrl(code);
    if(failure.code==='stale_preview'&&error.preview){
      try{const connection=await getConnection(code);if(connection){const receipt=await workoutReceipt(code,error.preview.session.id,connection.garmin_user_id);body.preview=previewBody(error.preview,connection,code,receipt);}}catch{/* the athlete can review again */}
    }
    return res.status(failure.status).json(body);
  }
}

async function handleRefresh(req,res) {
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const secret=process.env.CRON_SECRET;
  if(!secret)return res.status(503).json({error:'Cron secret is not configured'});
  if(req.headers?.authorization!=='Bearer '+secret)return res.status(401).json({error:'Unauthorized'});
  try {
    const counts=await refreshIdleGarminConnections({available:garminAvailableFor});
    return res.status(200).json({ok:true,...counts});
  }catch{return res.status(503).json({error:'Garmin token maintenance is temporarily unavailable'});}
}
