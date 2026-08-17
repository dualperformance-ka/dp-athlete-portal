/**
 * Strava integration — single serverless function, five modes.
 *
 *   GET  /api/strava                  athlete's cached activities
 *   GET  /api/strava-callback         OAuth callback      (→ ?mode=callback)
 *   GET  /api/strava-webhook          Strava's validation (→ ?mode=webhook)
 *   POST /api/strava-webhook          Strava's events     (→ ?mode=webhook)
 *   POST /api/strava-disconnect       revoke + purge      (→ ?mode=disconnect)
 *   POST /api/strava?mode=attempt     connect-click telemetry
 *
 * All five live in one file because Vercel's Hobby plan caps a deployment at 12
 * serverless functions and api/ is at 10. The rewrites in vercel.json give each
 * mode a real URL; the pattern matches api/bookings.js.
 *
 * ── HOW THE DATA FLOWS ──────────────────────────────────────────────────────
 * Activities are no longer pulled from Strava on page render. They arrive once,
 * by webhook, into strava_activities, and every read is local. See the header of
 * supabase/migrations/20260816120000_strava_activity_cache.sql for why.
 *
 * ── COMPLIANCE BOUNDARY ─────────────────────────────────────────────────────
 * Strava's API Agreement permits a user's data to be shown back to THAT USER
 * only. Every read here is scoped to the authenticated athlete's own code, and
 * the cache tables grant nothing to anon/authenticated. Coaches see the
 * athlete's SUBMITTED log (training_session_logs) — Dual Performance's own data
 * — never this cache. Do not add a coach-scoped read to this file.
 *
 * Required env:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET
 *   STRAVA_WEBHOOK_VERIFY_TOKEN     any long random string; must match the value
 *                                   used when creating the push subscription
 *   PORTAL_URL                      e.g. https://dp-athlete-portal.vercel.app
 * Optional env:
 *   STRAVA_API_BASE                 defaults to https://www.strava.com/api/v3
 *   STRAVA_BACKFILL_DAYS            history pulled on connect (default 180)
 *   STRAVA_WEBHOOK_SUBSCRIPTION_ID  when set, events from other subscriptions
 *                                   are rejected
 */
import { getRequestAthlete } from './_lib/auth.js';
import { createPortalSession, verifyPortalSession } from './_lib/legacy-session.js';
import { allowPortalRequest } from './_lib/http.js';
import {
  REQUIRED_SCOPES,
  buildAuthorizeUrl,
  deauthorize,
  exchangeCode,
  fetchActivityById,
  fetchAllActivities,
  hasRequiredScopes,
  isMobileUserAgent,
  missingScopes,
  refreshRequiresReconnect,
  refreshStravaToken,
  rowToActivity,
} from './_lib/strava-client.js';
import {
  MAX_EVENT_ATTEMPTS,
  deleteActivity,
  deleteAllActivities,
  deleteTokens,
  enqueueEvent,
  findAthleteCodeByStravaId,
  getTokens,
  listActivities,
  markEventFailed,
  markEventProcessed,
  mergeTokens,
  pendingEvents,
  saveActivities,
  saveTokens,
} from './_lib/strava-store.js';

export { refreshRequiresReconnect };

function portalUrl() {
  const configured = process.env.PORTAL_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
  return String(configured).replace(/\/+$/, '');
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

function backfillAfterEpoch() {
  const days = Number(process.env.STRAVA_BACKFILL_DAYS || 180);
  const window = Number.isFinite(days) && days > 0 ? days : 180;
  return Math.floor((Date.now() - window * 24 * 60 * 60 * 1000) / 1000);
}

/**
 * An activities read that fails is NOT a broken connection. The athlete's OAuth
 * link is intact — only the data sync is unavailable — so the portal keeps its
 * normal portal-log fallback rather than telling them to reconnect (which fixes
 * none of these) or 500-ing into a dead button.
 *   429     — rate limited, retries on its own.
 *   401/403 — the app may not read activities: revoked scope, or developer API
 *             access that has lapsed. Not fixable by reconnecting.
 * Anything else is a genuine error and is allowed to throw.
 */
export function unavailableActivitiesResponse(error) {
  const status = Number(error && error.status);
  if (status === 429) {
    return { connected: true, activities: [], activitiesAvailable: false, warning: 'strava_rate_limited' };
  }
  if (status === 401 || status === 403) {
    return {
      connected: true,
      activities: [],
      activitiesAvailable: false,
      warning: 'strava_access_denied',
      stravaStatus: status,
    };
  }
  return null;
}

// The only place a connect URL is ever built. The `state` token is what tells
// the callback which athlete is connecting, so a URL without it always fails —
// clients must use this one, never their own.
function buildConnectUrl(athleteCode, req) {
  const state = createPortalSession(athleteCode, { purpose: 'strava', ttlSeconds: 10 * 60 });
  const userAgent = String((req && req.headers && req.headers['user-agent']) || '');
  return buildAuthorizeUrl(
    `${portalUrl()}/api/strava-callback`,
    state,
    REQUIRED_SCOPES,
    { mobile: isMobileUserAgent(userAgent) },
  );
}

/**
 * A valid access token for this athlete, refreshing if it is inside the 5-minute
 * expiry buffer. Returns null when the athlete is not connected, and throws a
 * flagged error when the stored refresh token is dead so callers can offer a
 * reconnect instead of a 500.
 */
async function getAccessToken(athleteCode, tokenRow) {
  const row = tokenRow || await getTokens(athleteCode);
  if (!row || !row.access_token) return null;

  if (Date.now() / 1000 <= Number(row.expires_at) - 300) return row.access_token;

  const refreshed = await refreshStravaToken(row.refresh_token);
  await mergeTokens(athleteCode, {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token || row.refresh_token,
    expires_at: refreshed.expires_at,
    // Strava returns the granted scope on refresh from Apr 2026. Keep the old
    // value when it is absent rather than blanking a known-good scope.
    ...(refreshed.scope ? { scope: refreshed.scope } : {}),
  });
  return refreshed.access_token;
}

// ── Event processing ─────────────────────────────────────────────────────────

/**
 * Apply one webhook event. Pure routing over the store; exported for tests.
 *
 * Returns a short reason string describing what happened, which is what the
 * drain logs — an event that resolved to "unknown_athlete" and one that failed
 * are very different problems and must not look the same in the logs.
 */
export async function processEvent(event, deps = {}) {
  const {
    resolveAthlete = findAthleteCodeByStravaId,
    accessToken = getAccessToken,
    fetchActivity = fetchActivityById,
    storeActivities = saveActivities,
    removeActivity = deleteActivity,
    removeAllActivities = deleteAllActivities,
    removeTokens = deleteTokens,
  } = deps;

  const athleteCode = event.athlete_code || await resolveAthlete(event.owner_id);
  // An event for a Strava athlete nobody in the portal is linked to. Forged, or
  // a leftover from an athlete who has been removed. Mark it done — retrying
  // resolves nothing.
  if (!athleteCode) return { athleteCode: null, reason: 'unknown_athlete' };

  const objectType = String(event.object_type || '').toLowerCase();
  const aspect = String(event.aspect_type || '').toLowerCase();

  // Athlete-level deauthorization: the athlete revoked us from Strava's side.
  // Purge locally — keeping their activities after consent is withdrawn is
  // exactly what the API agreement forbids.
  if (objectType === 'athlete') {
    const updates = event.updates || {};
    if (String(updates.authorized) === 'false') {
      await removeAllActivities(athleteCode);
      await removeTokens(athleteCode);
      return { athleteCode, reason: 'deauthorized' };
    }
    return { athleteCode, reason: 'athlete_update_ignored' };
  }

  if (objectType !== 'activity') return { athleteCode, reason: 'unhandled_object_type' };

  if (aspect === 'delete') {
    await removeActivity(athleteCode, event.object_id);
    return { athleteCode, reason: 'activity_deleted' };
  }

  if (aspect !== 'create' && aspect !== 'update') {
    return { athleteCode, reason: 'unhandled_aspect' };
  }

  const token = await accessToken(athleteCode);
  if (!token) return { athleteCode, reason: 'not_connected' };

  // GET /activities/{id} returns DetailedActivity, a superset of the summary —
  // so this already carries laps, splits and best_efforts for Phase 2.
  const activity = await fetchActivity(token, event.object_id);
  await storeActivities(athleteCode, [activity]);
  return { athleteCode, reason: aspect === 'create' ? 'activity_created' : 'activity_updated' };
}

/**
 * Work through queued events. Never throws: a drain runs inside a read request
 * and on the deauthorization path, and in both cases failing to sync must not
 * fail the thing the caller actually asked for.
 */
export async function drainEvents({ ownerId, limit = 10 } = {}) {
  let processed = 0;
  let failed = 0;
  try {
    const events = await pendingEvents({ ownerId, limit });
    for (const event of events) {
      try {
        const result = await processEvent(event);
        await markEventProcessed(event.id, result.athleteCode);
        processed += 1;
      } catch (error) {
        failed += 1;
        await markEventFailed(event.id, event.attempts, error).catch(() => {});
        warn({
          message: 'Strava webhook event failed',
          route: '/api/strava-webhook',
          eventId: event.id,
          attempts: Number(event.attempts || 0) + 1,
          willRetry: Number(event.attempts || 0) + 1 < MAX_EVENT_ATTEMPTS,
          stravaStatus: error.status || null,
          error: String(error.message || error).slice(0, 200),
        });
      }
    }
  } catch (error) {
    warn({ message: 'Strava drain could not read the queue', error: String(error.message || error).slice(0, 200) });
  }
  return { processed, failed };
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const mode = String((req.query && req.query.mode) || '').toLowerCase();
  if (mode === 'callback')   return handleCallback(req, res);
  if (mode === 'webhook')    return handleWebhook(req, res);
  if (mode === 'disconnect') return handleDisconnect(req, res);
  if (mode === 'attempt')    return handleConnectAttempt(req, res);
  return handleRead(req, res);
}

// ── Mode: connect attempt ───────────────────────────────────────────────────

// OAuth failures that happen inside Strava or a mobile browser never reach the
// callback. This small authenticated marker closes that observability gap: a
// "clicked" log without a later "callback received" log identifies a device or
// Strava hand-off failure without recording tokens, codes, or signed state.
async function handleConnectAttempt(req, res) {
  if (!allowPortalRequest(req, res, 'POST, OPTIONS')) return;
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const identity = await getRequestAthlete(req);
  if (!identity) return res.status(401).json({ error: 'invalid_session' });

  const userAgent = String((req.headers && req.headers['user-agent']) || '');
  info({
    message: 'Strava connect clicked',
    route: '/api/strava',
    requestId: requestId(req),
    athleteCode: String(identity.athlete.code).toUpperCase(),
    oauthSurface: isMobileUserAgent(userAgent) ? 'mobile' : 'web',
  });
  return res.status(204).end();
}

// ── Mode: read ───────────────────────────────────────────────────────────────

async function handleRead(req, res) {
  if (!allowPortalRequest(req, res, 'GET, OPTIONS')) return;
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const identity = await getRequestAthlete(req);
  if (!identity) {
    // Never log the token. Whether a header arrived, and which credential shape
    // it was, is what separates "athlete never sent one" from "we rejected it".
    const authHeader = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
    warn({
      message: 'Strava lookup rejected: no resolvable athlete',
      route: '/api/strava',
      requestId: requestId(req),
      hasAuthHeader: !!authHeader,
      credentialShape: !authHeader ? 'none' : (/^Bearer\s+dp1\./i.test(authHeader) ? 'legacy' : 'supabase-jwt'),
    });
    return res.status(401).json({ error: 'invalid_session' });
  }
  const athleteCode = String(identity.athlete.code).toUpperCase();

  if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Strava credentials not configured' });
  }

  try {
    const tokenRow = await getTokens(athleteCode);

    if (!tokenRow || !tokenRow.access_token) {
      const connectUrl = buildConnectUrl(athleteCode, req);
      info({
        message: 'Strava connect URL minted',
        route: '/api/strava',
        requestId: requestId(req),
        athleteCode,
        oauthSurface: isMobileUserAgent(req.headers && req.headers['user-agent']) ? 'mobile' : 'web',
      });
      return res.status(200).json({ connected: false, connectUrl });
    }

    // Athletes who linked before profile:read_all was required are still fully
    // connected — their runs sync fine. Only the zones-derived views are
    // unavailable, so this is a soft prompt, not a broken state.
    const scopeOk = hasRequiredScopes(tokenRow.scope);

    // Liveness check. Reads come from the cache now, so nothing else on this
    // path would ever touch Strava — which means a revoked or dead refresh
    // token would go unnoticed and the athlete would sit on a green "connected"
    // pill in front of data that had quietly stopped updating.
    //
    // This is cheap: getAccessToken returns immediately without a network call
    // while the stored token is inside its 6-hour life, and refreshes at most a
    // few times a day per athlete. A dead token throws 400/401 and is handled
    // as reconnectRequired in the catch below.
    await getAccessToken(athleteCode, tokenRow);

    // Best-effort catch-up for anything the webhook queued but could not finish.
    // Bounded and scoped to this athlete so a backed-up queue cannot turn one
    // athlete's page load into a long sync.
    if (tokenRow.strava_athlete_id) {
      await drainEvents({ ownerId: tokenRow.strava_athlete_id, limit: 5 });
    }

    let rows = await listActivities(athleteCode, { limit: 400 });

    // Self-healing backfill.
    //
    // Every athlete who linked BEFORE this cache existed has valid tokens and an
    // empty cache. Without this, the day it deploys their km rings, volume chart
    // and session matching all go blank until they happen to run again — the
    // integration would look broken to the whole cohort at once.
    //
    // It also performs the first-connect import after the short OAuth callback
    // has returned the athlete to the portal.
    //
    // backfilled_at is stamped only on success, so a failure retries on the next
    // load instead of leaving them permanently empty; and once stamped, an
    // athlete with a genuinely empty history does not re-pull on every render.
    if (!rows.length && !tokenRow.backfilled_at) {
      try {
        const token = await getAccessToken(athleteCode, tokenRow);
        if (token) {
          const { activities: fetched } = await fetchAllActivities(token, { after: backfillAfterEpoch() });
          await saveActivities(athleteCode, fetched);
          await mergeTokens(athleteCode, { backfilled_at: new Date().toISOString() });
          rows = await listActivities(athleteCode, { limit: 400 });
        }
      } catch (backfillError) {
        warn({
          message: 'Strava catch-up backfill failed; will retry on the next load',
          route: '/api/strava',
          requestId: requestId(req),
          stravaStatus: backfillError.status || null,
          error: String(backfillError.message || backfillError).slice(0, 200),
        });
        // A rate limit or refused read here is reported through the normal
        // fallback rather than swallowed, so the UI stays truthful.
        const fallback = unavailableActivitiesResponse(backfillError);
        if (fallback) return res.status(200).json(fallback);
      }
    }

    const activities = rows.map(rowToActivity).filter(Boolean);

    return res.status(200).json({
      connected: true,
      activities,
      // A connected athlete with an empty cache has simply not run since
      // connecting, or the backfill is still catching up. That is "no
      // activities", not "sync is broken" — the front-end distinguishes them.
      activitiesAvailable: true,
      syncedAt: rows.length ? rows[0].synced_at || null : null,
      scopeComplete: scopeOk,
      ...(scopeOk ? {} : {
        missingScopes: missingScopes(tokenRow.scope),
        // Re-consent URL. approval_prompt=force is set inside
        // buildAuthorizeUrl, without which Strava silently returns the old
        // scope set and the zones calls keep 403-ing.
        reconnectUrl: buildConnectUrl(athleteCode, req),
      }),
    });
  } catch (err) {
    const fallback = unavailableActivitiesResponse(err);
    if (fallback) {
      warn({
        message: fallback.warning === 'strava_rate_limited'
          ? 'Strava activity sync rate limited'
          : "Strava refused the read — check the app's API access and granted scope",
        route: '/api/strava',
        requestId: requestId(req),
        stravaStatus: err.status || null,
        stravaBody: err.body || null,
        retryAfter: err.retryAfter || null,
      });
      return res.status(200).json(fallback);
    }
    if (refreshRequiresReconnect(err)) {
      warn({
        message: 'Strava refresh token rejected — athlete must reconnect',
        route: '/api/strava',
        requestId: requestId(req),
        stravaStatus: err.status,
        stravaBody: err.body || null,
      });
      return res.status(200).json({
        connected: false,
        reconnectRequired: true,
        connectUrl: buildConnectUrl(athleteCode, req),
      });
    }
    console.error('[strava]', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── Mode: webhook ────────────────────────────────────────────────────────────

/**
 * Strava's subscription validation. Echo hub.challenge within two seconds,
 * having first checked hub.verify_token — without that check anyone who guesses
 * the URL can complete a subscription handshake against this endpoint.
 */
export function webhookChallengeResponse(query, expectedToken) {
  const mode = String((query && query['hub.mode']) || '');
  const token = String((query && query['hub.verify_token']) || '');
  const challenge = String((query && query['hub.challenge']) || '');

  if (mode !== 'subscribe') return { status: 400, body: { error: 'unexpected_hub_mode' } };
  if (!expectedToken) return { status: 500, body: { error: 'verify_token_not_configured' } };
  if (token !== expectedToken) return { status: 403, body: { error: 'verify_token_mismatch' } };
  if (!challenge) return { status: 400, body: { error: 'missing_challenge' } };

  return { status: 200, body: { 'hub.challenge': challenge } };
}

async function handleWebhook(req, res) {
  // Strava is not a browser: no CORS, no athlete session. The GET is guarded by
  // the verify token; the POST is guarded by owner_id having to resolve to a
  // linked athlete, and by the fact that a forged event can only ever cause a
  // redundant read of our own data.
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    const result = webhookChallengeResponse(req.query, process.env.STRAVA_WEBHOOK_VERIFY_TOKEN);
    if (result.status !== 200) {
      warn({ message: 'Strava webhook validation refused', route: '/api/strava-webhook', reason: result.body.error });
    }
    return res.status(result.status).json(result.body);
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const event = (typeof req.body === 'object' && req.body) || {};

  const expectedSubscription = process.env.STRAVA_WEBHOOK_SUBSCRIPTION_ID;
  if (expectedSubscription && String(event.subscription_id || '') !== String(expectedSubscription)) {
    warn({
      message: 'Strava webhook event from an unexpected subscription',
      route: '/api/strava-webhook',
      subscriptionId: event.subscription_id || null,
    });
    // Still a 200: a non-200 makes Strava retry three times, and retrying will
    // not change whose subscription it came from.
    return res.status(200).json({ received: true, ignored: 'unexpected_subscription' });
  }

  if (!event.owner_id || !event.object_id || !event.object_type) {
    return res.status(200).json({ received: true, ignored: 'malformed_event' });
  }

  // Durability first, then speed. One insert is comfortably inside Strava's
  // two-second budget; fetching the activity is not, and a missed ack costs
  // three retries of the same event.
  let queued = null;
  try {
    queued = await enqueueEvent(event);
  } catch (error) {
    console.error('[strava-webhook] could not queue event', error);
    // 500 makes Strava retry, which is what we want: the event is not stored,
    // so a retry is the only way it is not lost.
    return res.status(500).json({ error: 'queue_failed' });
  }

  res.status(200).json({ received: true, id: queued && queued.id });

  // Past the ack. Best effort: anything that fails here stays pending and is
  // picked up by the next drain, so this is an optimisation, never the
  // guarantee. It is what makes a match land before the athlete opens the app.
  try {
    await drainEvents({ ownerId: event.owner_id, limit: 5 });
  } catch (error) {
    warn({ message: 'Strava post-ack drain failed', error: String(error.message || error).slice(0, 200) });
  }
}

// ── Mode: disconnect ─────────────────────────────────────────────────────────

async function handleDisconnect(req, res) {
  if (!allowPortalRequest(req, res, 'POST, OPTIONS')) return;
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const identity = await getRequestAthlete(req);
  if (!identity) return res.status(401).json({ error: 'invalid_session' });
  const athleteCode = String(identity.athlete.code).toUpperCase();

  try {
    const tokenRow = await getTokens(athleteCode);

    // Tell Strava first, but never let its answer block local cleanup: the
    // athlete asked to be disconnected, and leaving their data here because
    // Strava was slow is the wrong failure.
    if (tokenRow && tokenRow.access_token) {
      try {
        await deauthorize(tokenRow.access_token);
      } catch (error) {
        warn({
          message: 'Strava deauthorize failed — purging locally anyway',
          route: '/api/strava-disconnect',
          requestId: requestId(req),
          stravaStatus: error.status || null,
        });
      }
    }

    await deleteAllActivities(athleteCode);
    await deleteTokens(athleteCode);

    return res.status(200).json({ connected: false, disconnected: true, connectUrl: buildConnectUrl(athleteCode) });
  } catch (err) {
    console.error('[strava-disconnect]', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── Mode: callback ───────────────────────────────────────────────────────────

function shell(title, body, accent = 'rgba(255,255,255,.1)', redirectUrl = '') {
  const refresh = redirectUrl
    ? `<meta http-equiv="refresh" content="1;url=${escapeHtml(redirectUrl)}">`
    : '';
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
  .icon{font-size:48px;margin-bottom:16px}
  h1{font-size:22px;font-weight:900;letter-spacing:.04em;text-transform:uppercase;margin-bottom:8px}
  p{font-size:14px;color:rgba(255,255,255,.55);line-height:1.6;margin-top:8px}
  code{font-family:monospace;font-size:11px;color:#f87171;background:rgba(248,113,113,.08);
       padding:2px 6px;border-radius:4px}
  .brand{display:inline-flex;align-items:center;gap:6px;background:#fc4c02;
         color:#fff;font-size:11px;font-weight:700;text-transform:uppercase;
         letter-spacing:.1em;padding:5px 12px;border-radius:20px;margin-top:20px}
  .action{display:inline-flex;margin-top:20px;padding:10px 16px;border-radius:9px;
          background:#92d2ed;color:#0a0d10;text-decoration:none;font-size:13px;font-weight:800}
</style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
}

// NOTE ON THE COPY: this page used to say "Your coach can now view your activity
// data." Strava's API Agreement permits a user's data to be displayed back to
// that user only, so that promise was both a compliance problem and inaccurate.
// What the coach actually sees is the athlete's submitted training log. Keep the
// distinction — it is the whole basis of the boundary in this integration.
function successPage(returnUrl) {
  return shell('Strava Connected', `
  <div class="icon">✅</div>
  <h1>Strava Connected</h1>
  <p>Your runs will now sync into your portal automatically, and matching
     sessions will be marked off for you.</p>
  <p>Sessions you confirm are shared with your coach. You can disconnect at any
     time from the portal.</p>
  <p>Returning you to the portal now.</p>
  <a class="action" href="${escapeHtml(returnUrl)}">Return to portal</a>
  <div class="brand">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066z"/>
      <path d="M11.234 13.828L7.07 6h5.886l4.143 7.828z" opacity=".6"/>
    </svg>
    Powered by Strava
  </div>`, 'rgba(255,255,255,.1)', returnUrl);
}

function errorPage(message) {
  const returnUrl = `${portalUrl()}/?strava=error`;
  return shell('Connection Failed', `
  <h1 style="color:#f87171">Connection Failed</h1>
  <p>Something went wrong connecting your Strava account.</p>
  <p><code>${escapeHtml(message)}</code></p>
  <p>Return to the portal and try again. If it still fails, contact your coach.</p>
  <a class="action" href="${escapeHtml(returnUrl)}">Return to portal</a>`, 'rgba(248,113,113,.25)');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .slice(0, 500);
}

async function handleCallback(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  const { code, state, error } = req.query;

  info({
    message: 'Strava OAuth callback received',
    route: '/api/strava-callback',
    requestId: requestId(req),
    hasCode: !!code,
    hasState: !!state,
    hasError: !!error,
  });

  if (error) return res.status(400).send(errorPage('Strava access was denied'));

  if (!code || !state) {
    // Never log `code` itself. Which parameter is missing identifies the broken
    // link: no state at all means the authorize URL was not one this API minted,
    // since every minted URL carries a signed state token.
    warn({
      message: 'Strava callback missing OAuth parameters',
      route: '/api/strava-callback',
      requestId: requestId(req),
      hasCode: !!code,
      hasState: !!state,
      queryKeys: Object.keys(req.query || {}),
    });
    return res.status(400).send(errorPage('Missing code or athlete identifier'));
  }

  const verifiedState = verifyPortalSession(decodeURIComponent(state), 'strava');
  if (!verifiedState) {
    return res.status(400).send(errorPage('The connection link expired. Start again from the portal.'));
  }
  const athleteCode = String(verifiedState.code).toUpperCase();

  if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET) {
    return res.status(500).send(errorPage('Strava credentials not configured'));
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).send(errorPage('Supabase credentials not configured'));
  }

  try {
    const { access_token, refresh_token, expires_at, scope, athlete } = await exchangeCode(code);

    await saveTokens(athleteCode, {
      access_token,
      refresh_token,
      expires_at,
      // Recorded so the portal can tell "connected, but without zones access"
      // from "fully connected" instead of inferring intent from a bare 403.
      scope: scope || '',
      required_scopes: REQUIRED_SCOPES,
      strava_athlete_id: athlete?.id ?? null,
      athlete_name: athlete?.firstname ? `${athlete.firstname} ${athlete.lastname || ''}`.trim() : null,
      connected_at: new Date().toISOString(),
      // Cleared deliberately: a re-consent should be allowed to re-pull history
      // (the athlete may have widened scope or fixed old activities), and the
      // read path's catch-up backfill keys off this field.
      backfilled_at: null,
    });

    // Respond as soon as the durable OAuth tokens are saved. The authenticated
    // read path already performs a one-time self-healing backfill when it sees
    // an empty cache, so holding this mobile callback open for up to ten Strava
    // pages plus several Supabase writes only makes the consent hand-off fragile.
    info({
      message: 'Strava OAuth connection saved',
      route: '/api/strava-callback',
      requestId: requestId(req),
      athleteCode,
      scopeComplete: hasRequiredScopes(scope || ''),
    });
    return res.status(200).send(successPage(`${portalUrl()}/?strava=connected`));
  } catch (err) {
    console.error('[strava-callback]', err);
    return res.status(500).send(errorPage(err.message));
  }
}
