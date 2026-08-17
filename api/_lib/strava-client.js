/**
 * Strava REST client + pure helpers.
 *
 * Everything that talks to Strava lives here so that api/strava.js is only
 * routing and policy. Every pure function in this file is exported and unit
 * tested — the network functions are thin wrappers over them.
 */

// Strava is migrating from www.strava.com/api/v3 to api-v3.strava.com, which
// becomes available 4 Jan 2027. Keeping it in an env var means the cutover is a
// Vercel config change and a redeploy, not a code change under time pressure.
export const STRAVA_API = (process.env.STRAVA_API_BASE || 'https://www.strava.com/api/v3').replace(/\/+$/, '');
export const STRAVA_AUTH = 'https://www.strava.com/oauth/token';
export const STRAVA_DEAUTH = 'https://www.strava.com/oauth/deauthorize';
export const STRAVA_AUTHORIZE = 'https://www.strava.com/oauth/authorize';
export const STRAVA_MOBILE_AUTHORIZE = 'https://www.strava.com/oauth/mobile/authorize';

// activity:read_all — private activities included, which matters because
//   plenty of athletes default their runs to private.
// profile:read_all — heart-rate and run pace zones (GET /athlete/zones), needed
//   for time-in-zone and the polarisation check.
// Adding a scope invalidates nothing, but Strava will NOT grant it to an
// already-connected athlete: they have to re-authorise. hasRequiredScopes()
// below is what drives the portal's reconnect prompt.
export const REQUIRED_SCOPES = ['activity:read_all', 'profile:read_all'];

// Strava has used both space and comma separators for the granted scope string
// across API versions. Parse both rather than betting on one.
export function parseScopes(scope) {
  return String(scope || '')
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function hasRequiredScopes(scope, required = REQUIRED_SCOPES) {
  const granted = new Set(parseScopes(scope));
  return required.every((needed) => granted.has(needed));
}

export function missingScopes(scope, required = REQUIRED_SCOPES) {
  const granted = new Set(parseScopes(scope));
  return required.filter((needed) => !granted.has(needed));
}

/**
 * Strava's REST field for what the UI calls "Relative Effort" is `suffer_score`.
 * `relative_effort` is what Strava's own MCP returns — it has never been a field
 * on the REST SummaryActivity, so reading it here yields undefined on every
 * activity and silently disables any check built on it.
 *
 * Returns null, never 0, when the value is unusable: suffer_score is heart-rate
 * derived and is genuinely absent for athletes running without a strap. Null
 * must read as "unknown", because treating it as 0 would classify every
 * strapless quality session as easy.
 */
export function activitySufferScore(activity) {
  const raw = activity && (activity.suffer_score ?? activity.relative_effort);
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function isRunActivity(activity) {
  const type = String((activity && (activity.sport_type || activity.type)) || '');
  return type.toLowerCase().includes('run');
}

/**
 * Summary activity → strava_activities row. Pure; no clock, no network.
 * Returns null for anything without a usable id or start date, so a malformed
 * payload can never poison the cache with a row nothing can match against.
 */
export function normaliseActivity(athleteCode, activity) {
  const id = Number(activity && activity.id);
  if (!Number.isFinite(id) || id <= 0) return null;

  const start = String((activity && (activity.start_date_local || activity.start_date)) || '').trim();
  if (!start) return null;

  const number = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const integer = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  };

  return {
    athlete_code:       String(athleteCode).toUpperCase(),
    strava_activity_id: id,
    start_date_local:   start,
    sport_type:         String((activity.sport_type || activity.type) || '') || null,
    name:               activity.name ? String(activity.name).slice(0, 300) : null,
    distance_m:         number(activity.distance),
    moving_time_s:      integer(activity.moving_time),
    elapsed_time_s:     integer(activity.elapsed_time),
    suffer_score:       activitySufferScore(activity),
    gear_id:            activity.gear_id ? String(activity.gear_id) : null,
    summary:            activity,
  };
}

/**
 * strava_activities row → the activity shape the portal front-end already
 * expects. The stored `summary` is the source of truth; the promoted columns
 * exist for indexing. Keeping this shape identical to Strava's is what lets the
 * read path flip from live-fetch to cache without touching 09-logging.js,
 * 05-handbook.js or 06-nutrition.js.
 */
export function rowToActivity(row) {
  if (!row) return null;
  const summary = (row.summary && typeof row.summary === 'object') ? row.summary : {};

  // Number(null) is 0, which would turn "we do not have this value" into a real
  // measurement — a null distance becoming a 0 km run would let the matcher
  // claim a session that was never done.
  const num = (value) => (value === null || value === undefined ? null : Number(value));

  const effort = num(row.suffer_score);

  return {
    ...summary,
    id:               Number(row.strava_activity_id),
    name:             summary.name ?? row.name,
    distance:         summary.distance ?? num(row.distance_m),
    moving_time:      summary.moving_time ?? num(row.moving_time_s),
    elapsed_time:     summary.elapsed_time ?? num(row.elapsed_time_s),
    sport_type:       summary.sport_type ?? row.sport_type,
    type:             summary.type ?? row.sport_type,
    start_date_local: summary.start_date_local ?? row.start_date_local,
    start_date:       summary.start_date ?? row.start_date_local,
    // Surfaced under BOTH names so the matcher works whether it reads the REST
    // name or the UI name. See activitySufferScore above.
    suffer_score:     effort,
    relative_effort:  effort,
  };
}

// ── Errors ───────────────────────────────────────────────────────────────────

function stravaError(message, res, body) {
  const error = new Error(message);
  error.status = res.status;
  error.body = String(body || '').slice(0, 300);
  error.retryAfter = res.headers && res.headers.get ? res.headers.get('retry-after') : null;
  return error;
}

// A stored refresh token that Strava rejects outright is dead: the athlete
// revoked the app, the client secret was rotated, or the app lost API access.
// None of those are retryable, and all are fixed by reconnecting — so they must
// not surface as a 500 that leaves the athlete with no way back. Transient
// failures (429, 5xx) are NOT this: keep the connection and retry.
export function refreshRequiresReconnect(error) {
  const status = Number(error && error.status);
  return status === 400 || status === 401;
}

// ── OAuth ────────────────────────────────────────────────────────────────────

function credentials() {
  const id = process.env.STRAVA_CLIENT_ID;
  const secret = process.env.STRAVA_CLIENT_SECRET;
  if (!id || !secret) {
    const error = new Error('Strava credentials not configured');
    error.status = 500;
    throw error;
  }
  return { client_id: id, client_secret: secret };
}

export function isMobileUserAgent(userAgent) {
  return /android|iphone|ipad|ipod|mobile/i.test(String(userAgent || ''));
}

export function buildAuthorizeUrl(redirectUri, state, scopes = REQUIRED_SCOPES, options = {}) {
  const { client_id } = credentials();
  // Strava publishes a dedicated mobile endpoint that hands off to the native
  // Strava app when available and falls back to mobile web otherwise. Using the
  // desktop endpoint from an installed iOS PWA can strand the athlete between
  // the consent screen and our HTTPS callback.
  const authorizeEndpoint = options.mobile ? STRAVA_MOBILE_AUTHORIZE : STRAVA_AUTHORIZE;
  return `${authorizeEndpoint}` +
    `?client_id=${encodeURIComponent(client_id)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    // approval_prompt=force makes Strava re-show the consent screen to an
    // already-connected athlete. Without it, adding profile:read_all would
    // silently return the OLD scope set and the new zones calls would 403.
    `&approval_prompt=force` +
    `&scope=${encodeURIComponent(scopes.join(','))}` +
    `&state=${encodeURIComponent(state)}`;
}

export async function exchangeCode(code) {
  const res = await fetch(STRAVA_AUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...credentials(), code, grant_type: 'authorization_code' }),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw stravaError(`Strava token exchange failed: ${res.status}`, res, text);
  return JSON.parse(text);
}

export async function refreshStravaToken(refreshToken) {
  const res = await fetch(STRAVA_AUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...credentials(), grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw stravaError(`Strava token refresh failed: ${res.status}`, res, text);
  return JSON.parse(text);
}

/**
 * Tell Strava to drop the app's access. Added to the API in June 2026; before
 * it, "disconnect" could only be done from Strava's own settings, which left
 * orphaned tokens sitting in athlete_data forever.
 *
 * Deliberately tolerant: if Strava says the token is already invalid, the
 * athlete's intent (be disconnected) is satisfied, so local cleanup must still
 * proceed. Only genuine transport failures throw.
 */
export async function deauthorize(accessToken) {
  const res = await fetch(STRAVA_DEAUTH, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.ok) return { revoked: true };
  if (res.status === 400 || res.status === 401) return { revoked: true, alreadyInvalid: true };
  const text = await res.text().catch(() => '');
  throw stravaError(`Strava deauthorize failed: ${res.status}`, res, text);
}

// ── Reads ────────────────────────────────────────────────────────────────────

export const MAX_PER_PAGE = 200;

/**
 * One page of the athlete's activities.
 * `after` is epoch SECONDS (Strava's unit), not milliseconds.
 */
export async function fetchActivityPage(accessToken, { after, page = 1, perPage = MAX_PER_PAGE } = {}) {
  const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
  if (Number.isFinite(Number(after)) && Number(after) > 0) params.set('after', String(Math.floor(after)));

  const res = await fetch(`${STRAVA_API}/athlete/activities?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw stravaError(`Strava activities fetch failed: ${res.status}`, res, text);
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Every activity since `after`, paged.
 *
 * maxPages is a hard stop, not a tuning knob: without it a bad `after` (or an
 * athlete with a decade of history) could walk the entire account and burn the
 * app's whole daily budget — which is shared across every athlete, so one
 * runaway backfill would take the cohort's sync down with it.
 */
export async function fetchAllActivities(accessToken, { after, maxPages = 10, perPage = MAX_PER_PAGE } = {}) {
  const all = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await fetchActivityPage(accessToken, { after, page, perPage });
    all.push(...batch);
    if (batch.length < perPage) return { activities: all, truncated: false, pages: page };
    if (page === maxPages) truncated = true;
  }
  return { activities: all, truncated, pages: maxPages };
}

export async function fetchActivityById(accessToken, activityId) {
  const res = await fetch(`${STRAVA_API}/activities/${encodeURIComponent(activityId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw stravaError(`Strava activity fetch failed: ${res.status}`, res, text);
  return JSON.parse(text);
}
