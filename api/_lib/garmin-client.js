/**
 * Garmin Connect REST client + pure helpers.
 *
 * Everything that talks to Garmin lives here so api/garmin.js is only routing
 * and policy. Pure functions are exported and unit tested; the network
 * functions are thin wrappers that take an injectable fetch.
 *
 * Contract (Garmin Connect Developer Program, OAuth 2.0 with PKCE):
 *   authorize   GET  https://connect.garmin.com/oauth2Confirm
 *   token       POST https://connectapi.garmin.com/di-oauth2-service/oauth/token
 *   user id     GET  https://apis.garmin.com/partner-gateway/rest/user/id
 *   permissions GET  https://apis.garmin.com/partner-gateway/rest/user/permissions
 *   deregister  DEL  https://apis.garmin.com/partner-gateway/rest/user/registration
 *   backfill    GET  https://apis.garmin.com/wellness-api/rest/backfill/{type}
 *
 * Access tokens last about 24 hours and Garmin asks that at least 600 seconds
 * be taken off expires_in. Refresh tokens last about 90 days and ROTATE: every
 * refresh returns a new one, and only the newest is valid.
 */
import crypto from 'crypto';
import { authFingerprint } from './legacy-session.js';

export const GARMIN_AUTHORIZE = 'https://connect.garmin.com/oauth2Confirm';
export const GARMIN_TOKEN = 'https://connectapi.garmin.com/di-oauth2-service/oauth/token';
export const GARMIN_API = 'https://apis.garmin.com';

// Garmin's recommended safety margin on the access token's lifetime.
export const EXPIRY_MARGIN_S = 600;

// Garmin accepts one backfill window of up to 30 days per request.
export const BACKFILL_DAYS = 30;
export const BACKFILL_TYPES = ['activities', 'dailies', 'sleeps'];

// Which stored data each consent permission covers. When an athlete unticks a
// permission in Garmin Connect, the data it covered is deleted here.
export const PERMISSION_DATA = {
  ACTIVITY_EXPORT: ['activities'],
  HEALTH_EXPORT: ['dailies', 'sleeps'],
};

// ── PKCE ─────────────────────────────────────────────────────────────────────
//
// The verifier has to survive the round trip to Garmin and back. Rather than
// storing it, it is DERIVED from the signed state token with a server-side
// HMAC: the callback receives the state back, recomputes the same verifier,
// and nothing is persisted between the two requests. Without the server secret
// the verifier cannot be computed from the state, so an intercepted code is
// useless to anyone else, which is the whole point of PKCE.
//
// authFingerprint is HMAC-SHA256 as 64 hex characters: inside Garmin's 43-128
// length limit and entirely within its allowed character set.

export function pkceVerifier(state) {
  if (!state) throw new Error('PKCE verifier needs a state token');
  return authFingerprint(`garmin-pkce:${state}`);
}

export function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(String(verifier)).digest('base64url');
}

export function isValidVerifier(verifier) {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(String(verifier || ''));
}

// ── OAuth ────────────────────────────────────────────────────────────────────

export function garminConfigured(env = process.env) {
  return !!(env.GARMIN_CLIENT_ID && env.GARMIN_CLIENT_SECRET);
}

function credentials() {
  const id = process.env.GARMIN_CLIENT_ID;
  const secret = process.env.GARMIN_CLIENT_SECRET;
  if (!id || !secret) {
    const error = new Error('Garmin credentials not configured');
    error.status = 500;
    throw error;
  }
  return { client_id: id, client_secret: secret };
}

export function buildAuthorizeUrl(redirectUri, state, clientId = process.env.GARMIN_CLIENT_ID) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: String(clientId || ''),
    code_challenge: pkceChallenge(pkceVerifier(state)),
    code_challenge_method: 'S256',
    redirect_uri: redirectUri,
    state,
  });
  return `${GARMIN_AUTHORIZE}?${params.toString()}`;
}

function garminError(message, res, body) {
  const error = new Error(message);
  error.status = res.status;
  error.body = String(body || '').slice(0, 300);
  return error;
}

async function tokenRequest(form, fetchImpl) {
  const res = await fetchImpl(GARMIN_TOKEN, {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw garminError(`Garmin token request failed (${res.status})`, res, text);
  try {
    return JSON.parse(text);
  } catch {
    throw garminError('Garmin token response was not JSON', res, text);
  }
}

export async function exchangeCode({ code, verifier, redirectUri }, fetchImpl = fetch) {
  return tokenRequest({
    grant_type: 'authorization_code',
    ...credentials(),
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  }, fetchImpl);
}

export async function refreshGarminToken(refreshToken, fetchImpl = fetch) {
  return tokenRequest({
    grant_type: 'refresh_token',
    ...credentials(),
    refresh_token: refreshToken,
  }, fetchImpl);
}

/**
 * Token response → the columns stored on garmin_connections. Pure: the clock
 * is passed in. The access expiry has Garmin's 600s margin already taken off,
 * so callers compare against it directly.
 */
export function tokenFields(response, nowMs = Date.now()) {
  const expiresIn = Number(response && response.expires_in);
  const refreshIn = Number(response && response.refresh_token_expires_in);
  const life = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 86400;
  return {
    access_token: String(response.access_token || ''),
    refresh_token: String(response.refresh_token || ''),
    access_expires_at: new Date(nowMs + Math.max(60, life - EXPIRY_MARGIN_S) * 1000).toISOString(),
    refresh_expires_at: Number.isFinite(refreshIn) && refreshIn > 0
      ? new Date(nowMs + refreshIn * 1000).toISOString()
      : null,
    scope: response.scope ? String(response.scope) : null,
  };
}

export function accessTokenFresh(row, nowMs = Date.now()) {
  if (!row || !row.access_token || !row.access_expires_at) return false;
  return Date.parse(row.access_expires_at) > nowMs;
}

// A refresh token Garmin rejects outright is dead: the athlete revoked the
// app, it passed its 90 days, or a newer rotation superseded it. Reconnecting
// fixes all of those; retrying fixes none. 429 and 5xx are NOT this.
export function refreshRequiresReconnect(error) {
  const status = Number(error && error.status);
  return status === 400 || status === 401;
}

// ── Wellness API ─────────────────────────────────────────────────────────────

async function apiRequest(path, token, { method = 'GET', fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${GARMIN_API}${path}`, {
    method,
    signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw garminError(`Garmin ${method} ${path.split('?')[0]} failed (${res.status})`, res, text);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

export async function fetchUserId(token, fetchImpl = fetch) {
  const body = await apiRequest('/partner-gateway/rest/user/id', token, { fetchImpl });
  const id = body && body.userId;
  if (!id) throw new Error('Garmin did not return a user id');
  return String(id);
}

export async function fetchPermissions(token, fetchImpl = fetch) {
  const body = await apiRequest('/partner-gateway/rest/user/permissions', token, { fetchImpl });
  return normalisePermissions(body);
}

export async function deregister(token, fetchImpl = fetch) {
  return apiRequest('/partner-gateway/rest/user/registration', token, { method: 'DELETE', fetchImpl });
}

/**
 * Ask Garmin to replay a window of history through the webhook. Asynchronous:
 * Garmin answers 202 and the data arrives as pushes over the next minutes.
 * 409 means the same window was already requested, which is also done.
 */
export async function requestBackfill(token, type, { startS, endS }, fetchImpl = fetch) {
  const path = `/wellness-api/rest/backfill/${encodeURIComponent(type)}` +
    `?summaryStartTimeInSeconds=${Math.floor(startS)}&summaryEndTimeInSeconds=${Math.floor(endS)}`;
  try {
    await apiRequest(path, token, { fetchImpl });
    return 'accepted';
  } catch (error) {
    if (Number(error.status) === 409) return 'duplicate';
    // No HISTORICAL_DATA_EXPORT consent. Not an error to retry: the athlete
    // chose not to share history, and new activity still arrives normally.
    if (Number(error.status) === 403) return 'not_permitted';
    throw error;
  }
}

export function normalisePermissions(value) {
  const list = Array.isArray(value) ? value : (value && Array.isArray(value.permissions) ? value.permissions : []);
  return [...new Set(list.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean))].sort();
}

// ── Push / ping notifications ────────────────────────────────────────────────

// Notification keys → the data kind stored here. Anything else is acknowledged
// and ignored (activityDetails, epochs and the rest are not stored yet).
const DATA_KEYS = {
  activities: 'activities',
  manuallyUpdatedActivities: 'activities',
  dailies: 'dailies',
  sleeps: 'sleeps',
};

/**
 * Split a webhook body into what this integration acts on. Pure.
 *
 * A body is an object of arrays keyed by summary type. In PUSH mode each entry
 * is the summary itself; in PING mode each entry is {userId, callbackURL} and
 * the summaries have to be fetched. Both are handled so the endpoint keeps
 * working whichever mode the Garmin app is configured with.
 */
export function parseNotification(body) {
  const result = { records: [], pings: [], deregistrations: [], permissionChanges: [], ignored: [] };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return result;

  for (const [key, entries] of Object.entries(body)) {
    if (!Array.isArray(entries)) { result.ignored.push(key); continue; }

    if (key === 'deregistrations') {
      for (const entry of entries) {
        if (entry && entry.userId) result.deregistrations.push(String(entry.userId));
      }
      continue;
    }

    if (key === 'userPermissionsChange') {
      for (const entry of entries) {
        if (entry && entry.userId) {
          result.permissionChanges.push({ userId: String(entry.userId), permissions: normalisePermissions(entry.permissions) });
        }
      }
      continue;
    }

    const kind = DATA_KEYS[key];
    if (!kind) { result.ignored.push(key); continue; }

    for (const entry of entries) {
      if (!entry || !entry.userId) continue;
      if (entry.callbackURL) {
        result.pings.push({ kind, userId: String(entry.userId), callbackURL: String(entry.callbackURL) });
      } else {
        result.records.push({ kind, userId: String(entry.userId), record: entry });
      }
    }
  }
  return result;
}

/**
 * A ping's callbackURL is fetched with an athlete's bearer token, so it must be
 * Garmin's own API host and nothing else. Otherwise a forged ping could make
 * this server send a live Garmin token to any URL it names.
 */
export function isGarminCallbackUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname === 'apis.garmin.com' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export async function fetchCallback(callbackURL, token, fetchImpl = fetch) {
  if (!isGarminCallbackUrl(callbackURL)) {
    const error = new Error('Refusing a ping callback outside apis.garmin.com');
    error.status = 400;
    throw error;
  }
  const res = await fetchImpl(callbackURL, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw garminError(`Garmin ping callback failed (${res.status})`, res, text);
  const parsed = text ? JSON.parse(text) : [];
  return Array.isArray(parsed) ? parsed : [];
}

// ── Normalisers ──────────────────────────────────────────────────────────────
//
// Garmin summary → table row. Pure. Each returns null for a record with no
// usable key, so one malformed summary can never fail a batch or poison the
// table with a row nothing can be matched against.

function int(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoDate(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

// Garmin gives UTC seconds plus the device's offset at the time. The athlete's
// calendar day is the UTC instant shifted by that offset, which is what lets a
// 5:30am Adelaide run land on the right day instead of the previous UTC one.
export function localDateFrom(startS, offsetS) {
  const start = Number(startS);
  if (!Number.isFinite(start) || start <= 0) return null;
  const offset = Number.isFinite(Number(offsetS)) ? Number(offsetS) : 0;
  return new Date((start + offset) * 1000).toISOString().slice(0, 10);
}

export function normaliseActivity(athleteCode, record) {
  if (!record) return null;
  const summaryId = String(record.summaryId || record.activityId || '').trim();
  const startS = Number(record.startTimeInSeconds);
  if (!summaryId || !Number.isFinite(startS) || startS <= 0) return null;
  const activityId = Number(record.activityId);
  return {
    athlete_code: String(athleteCode).toUpperCase(),
    summary_id: summaryId,
    activity_id: Number.isFinite(activityId) && activityId > 0 ? activityId : null,
    start_time: new Date(startS * 1000).toISOString(),
    local_date: localDateFrom(startS, record.startTimeOffsetInSeconds),
    activity_type: record.activityType ? String(record.activityType).slice(0, 80) : null,
    name: record.activityName ? String(record.activityName).slice(0, 300) : null,
    duration_s: int(record.durationInSeconds),
    distance_m: num(record.distanceInMeters),
    active_kcal: int(record.activeKilocalories),
    avg_hr: int(record.averageHeartRateInBeatsPerMinute),
    max_hr: int(record.maxHeartRateInBeatsPerMinute),
    device_name: record.deviceName ? String(record.deviceName).slice(0, 120) : null,
    manual: typeof record.manual === 'boolean' ? record.manual : null,
    summary: record,
  };
}

export function normaliseDaily(athleteCode, record) {
  if (!record) return null;
  const date = isoDate(record.calendarDate) || localDateFrom(record.startTimeInSeconds, record.startTimeOffsetInSeconds);
  if (!date) return null;
  return {
    athlete_code: String(athleteCode).toUpperCase(),
    calendar_date: date,
    summary_id: record.summaryId ? String(record.summaryId) : null,
    active_kcal: int(record.activeKilocalories),
    bmr_kcal: int(record.bmrKilocalories),
    steps: int(record.steps),
    resting_hr: int(record.restingHeartRateInBeatsPerMinute),
    // Garmin reports -1 when there was not enough data to score stress.
    avg_stress: (() => { const value = int(record.averageStressLevel); return value !== null && value >= 0 ? value : null; })(),
    summary: record,
  };
}

export function normaliseSleep(athleteCode, record) {
  if (!record) return null;
  const date = isoDate(record.calendarDate) || localDateFrom(record.startTimeInSeconds, record.startTimeOffsetInSeconds);
  if (!date) return null;
  return {
    athlete_code: String(athleteCode).toUpperCase(),
    calendar_date: date,
    summary_id: record.summaryId ? String(record.summaryId) : null,
    duration_s: int(record.durationInSeconds),
    deep_s: int(record.deepSleepDurationInSeconds),
    light_s: int(record.lightSleepDurationInSeconds),
    rem_s: int(record.remSleepInSeconds),
    awake_s: int(record.awakeDurationInSeconds),
    summary: record,
  };
}

export const NORMALISERS = {
  activities: normaliseActivity,
  dailies: normaliseDaily,
  sleeps: normaliseSleep,
};

/** garmin_activities row → the compact shape the portal shows the athlete. */
export function rowToActivity(row) {
  if (!row) return null;
  const nullable = (value) => (value === null || value === undefined ? null : Number(value));
  return {
    id: String(row.summary_id),
    activityId: nullable(row.activity_id),
    name: row.name || null,
    type: row.activity_type || null,
    startTime: row.start_time,
    localDate: row.local_date,
    durationS: nullable(row.duration_s),
    distanceM: nullable(row.distance_m),
    activeKcal: nullable(row.active_kcal),
    avgHr: nullable(row.avg_hr),
    maxHr: nullable(row.max_hr),
    device: row.device_name || null,
    manual: row.manual === null || row.manual === undefined ? null : !!row.manual,
  };
}
