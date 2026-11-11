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

// ── Every Garmin data type this integration takes in ────────────────────────
//
// kind        what is stored. activities/dailies/sleeps keep their own tables
//             with promoted columns; every other kind is one row per summary
//             in garmin_summaries, whole payload kept, so nothing Garmin sends
//             is dropped and new Garmin fields need no migration.
// permission  the consent toggle that covers it. Unticking it in Garmin
//             Connect deletes every kind it covers.
// backfill    the history endpoint's name for it (differs from the webhook
//             key for respiration, pulse ox and Move IQ), or null.
//
// Webhook keys Garmin has used for the same data are listed as aliases.
export const GARMIN_TYPES = {
  activities:        { permission: 'ACTIVITY_EXPORT', backfill: 'activities', aliases: ['manuallyUpdatedActivities'] },
  activityDetails:   { permission: 'ACTIVITY_EXPORT', backfill: 'activityDetails' },
  activityFiles:     { permission: 'ACTIVITY_EXPORT', backfill: null },
  dailies:           { permission: 'HEALTH_EXPORT', backfill: 'dailies' },
  sleeps:            { permission: 'HEALTH_EXPORT', backfill: 'sleeps' },
  epochs:            { permission: 'HEALTH_EXPORT', backfill: 'epochs' },
  bodyComps:         { permission: 'HEALTH_EXPORT', backfill: 'bodyComps' },
  hrv:               { permission: 'HEALTH_EXPORT', backfill: 'hrv' },
  stressDetails:     { permission: 'HEALTH_EXPORT', backfill: 'stressDetails' },
  allDayRespiration: { permission: 'HEALTH_EXPORT', backfill: 'respiration', aliases: ['respiration'] },
  pulseox:           { permission: 'HEALTH_EXPORT', backfill: 'pulseOx', aliases: ['pulseOx'] },
  healthSnapshot:    { permission: 'HEALTH_EXPORT', backfill: 'healthSnapshot' },
  skinTemp:          { permission: 'HEALTH_EXPORT', backfill: 'skinTemp' },
  userMetrics:       { permission: 'HEALTH_EXPORT', backfill: 'userMetrics' },
  bloodPressures:    { permission: 'HEALTH_EXPORT', backfill: 'bloodPressures' },
  moveIQActivities:  { permission: 'HEALTH_EXPORT', backfill: 'moveiq', aliases: ['moveiq', 'moveIQ'] },
};

// Kinds with their own table. Everything else in GARMIN_TYPES is generic.
export const DEDICATED_KINDS = ['activities', 'dailies', 'sleeps'];

// Deliberately never stored, whatever the Garmin app is set to send.
// Menstrual cycle and pregnancy data (Women's Health API) is not something
// Dual Performance coaches on, and the privacy policy does not cover it.
export const EXCLUDED_KEYS = new Set(['mct', 'menstrualCycleTracking', 'pregnancySnapshot']);

export const BACKFILL_TYPES = Object.values(GARMIN_TYPES).map((type) => type.backfill).filter(Boolean);

// Which stored data each consent permission covers. When an athlete unticks a
// permission in Garmin Connect, the data it covered is deleted here.
export const PERMISSION_DATA = Object.entries(GARMIN_TYPES).reduce((map, [kind, type]) => {
  (map[type.permission] = map[type.permission] || []).push(kind);
  return map;
}, {});

const KIND_BY_KEY = Object.entries(GARMIN_TYPES).reduce((map, [kind, type]) => {
  map[kind] = kind;
  for (const alias of type.aliases || []) map[alias] = kind;
  return map;
}, {});

export function kindForKey(key) {
  return KIND_BY_KEY[String(key || '')] || null;
}

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

/**
 * Whether this athlete is offered Garmin at all. False until the keys are
 * configured, so the code can deploy before the env vars exist without showing
 * every athlete a button that cannot work. The same allowlist decides whether
 * the weekly review and reminders read an athlete's Garmin activities.
 */
export function garminAvailableFor(athleteCode, env = process.env) {
  if (!garminConfigured(env)) return false;
  const list = String(env.GARMIN_ALLOWED_ATHLETES || '').split(',')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  if (!list.length || list.includes('*')) return true;
  return list.includes(String(athleteCode || '').toUpperCase());
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

/**
 * Split a webhook body into what this integration acts on. Pure.
 *
 * A body is an object of arrays keyed by summary type. In PUSH mode each entry
 * is the summary itself; in PING mode each entry is {userId, callbackURL} and
 * the summaries have to be fetched. Both are handled so the endpoint keeps
 * working whichever mode the Garmin app is configured with.
 */
export function parseNotification(body) {
  const result = { records: [], pings: [], files: [], deregistrations: [], permissionChanges: [], ignored: [], excluded: [] };
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

    if (EXCLUDED_KEYS.has(key)) { result.excluded.push(key); continue; }
    const kind = kindForKey(key);
    if (!kind) { result.ignored.push(key); continue; }

    for (const entry of entries) {
      if (!entry || !entry.userId) continue;
      // An activity file is always a callback to download (a FIT, TCX or GPX
      // file), never a JSON summary, so it has its own path.
      if (kind === 'activityFiles') {
        if (entry.callbackURL) result.files.push({ userId: String(entry.userId), callbackURL: String(entry.callbackURL), meta: fileMeta(entry) });
        continue;
      }
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

// Activity files: the metadata that travels with the callback, never the URL
// (it carries a short-lived token and is useless once fetched).
function fileMeta(entry) {
  const meta = {};
  for (const key of ['summaryId', 'activityId', 'fileType', 'activityName', 'activityType', 'startTimeInSeconds', 'startTimeOffsetInSeconds', 'manual']) {
    if (entry[key] !== undefined && entry[key] !== null) meta[key] = entry[key];
  }
  return meta;
}

export const ACTIVITY_FILE_TYPES = { FIT: 'application/vnd.ant.fit', TCX: 'application/vnd.garmin.tcx+xml', GPX: 'application/gpx+xml' };

// Download an activity file. Same host rule as a ping: the bearer token only
// ever goes to apis.garmin.com.
export async function fetchFile(callbackURL, token, fetchImpl = fetch) {
  if (!isGarminCallbackUrl(callbackURL)) {
    const error = new Error('Refusing a file callback outside apis.garmin.com');
    error.status = 400;
    throw error;
  }
  const res = await fetchImpl(callbackURL, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw garminError(`Garmin activity file download failed (${res.status})`, res, await res.text().catch(() => ''));
  return Buffer.from(await res.arrayBuffer());
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

/**
 * Any Garmin summary that has no dedicated table → a garmin_summaries row.
 * Pure. The whole payload is kept; the columns only exist to key, date and
 * index it. activityDetails nests its summary one level down, and body
 * composition and blood pressure are stamped with a measurement time instead
 * of a start time, so each is read where Garmin puts it.
 *
 * A record with no usable key and no time is dropped rather than stored under
 * a key that could collide with another.
 */
export function normaliseSummary(athleteCode, kind, record) {
  if (!record || typeof record !== 'object' || !GARMIN_TYPES[kind] || DEDICATED_KINDS.includes(kind)) return null;
  const nested = record.summary && typeof record.summary === 'object' ? record.summary : {};
  const startS = Number(record.startTimeInSeconds ?? record.measurementTimeInSeconds ?? nested.startTimeInSeconds);
  const offsetS = record.startTimeOffsetInSeconds ?? record.measurementTimeOffsetInSeconds ?? nested.startTimeOffsetInSeconds;
  const hasStart = Number.isFinite(startS) && startS > 0;
  const date = isoDate(record.calendarDate) || (hasStart ? localDateFrom(startS, offsetS) : null);
  const activityId = Number(record.activityId ?? nested.activityId);
  const summaryId = String(record.summaryId || nested.summaryId || '').trim();
  const key = summaryId || (Number.isFinite(activityId) && activityId > 0 ? `activity-${activityId}` : '') ||
    (hasStart ? `t-${Math.floor(startS)}` : (date ? `d-${date}` : ''));
  if (!key || (!date && !hasStart)) return null;
  // The Garmin user id and any token Garmin echoes back are dropped: the row is
  // already keyed to the athlete, and a token has no place in stored data.
  const { userId, userAccessToken, ...payload } = record;
  return {
    athlete_code: String(athleteCode).toUpperCase(),
    summary_type: kind,
    summary_id: key.slice(0, 200),
    calendar_date: date,
    start_time: hasStart ? new Date(startS * 1000).toISOString() : null,
    duration_s: int(record.durationInSeconds ?? nested.durationInSeconds),
    activity_id: Number.isFinite(activityId) && activityId > 0 ? activityId : null,
    summary: payload,
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

// ── Garmin activities beside Strava (weekly review, reminders) ───────────────
//
// Server-side counterpart of public/js/connected-activities.js. A Garmin row is
// reshaped like a strava_activities cache row so the existing rules read it
// unchanged, and a recording both services hold is counted once, as Garmin.
// Only aggregates and push wording come from these rows: never AI inputs.

const ADELAIDE = 'Australia/Adelaide';

// Seconds the zone was ahead of UTC at that instant. Used only when a stored
// summary lacks startTimeOffsetInSeconds; DP athletes train on Adelaide time.
function zoneOffsetSeconds(ms, timeZone = ADELAIDE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 1000);
}

// Garmin activityType → the Strava sport_type the existing rules understand.
export function garminSportType(activityType) {
  const type = String(activityType || '').toLowerCase();
  if (/swim/.test(type)) return 'Swim';
  if (/cycl|bik|ride/.test(type)) return 'Ride';
  if (/run/.test(type)) return 'Run';
  if (/walk/.test(type)) return 'Walk';
  if (/hik/.test(type)) return 'Hike';
  if (/row/.test(type)) return 'Rowing';
  return activityType ? String(activityType) : null;
}

/**
 * garmin_activities row → strava_activities shape. start_date_local is the
 * athlete's wall-clock time with a Z label, exactly like Strava's cache, from
 * Garmin's own offset (selected as `offset`) or Adelaide time without one.
 */
export function garminActivityAsStravaRow(row) {
  const startMs = Date.parse(row && row.start_time);
  if (!Number.isFinite(startMs)) return null;
  const given = row.offset == null ? NaN : Number(row.offset);
  const offset = Number.isFinite(given) ? given : zoneOffsetSeconds(startMs);
  const seconds = row.duration_s == null ? NaN : Number(row.duration_s);
  return {
    provider: 'garmin',
    garmin_summary_id: row.summary_id == null ? null : String(row.summary_id),
    athlete_code: row.athlete_code,
    sport_type: garminSportType(row.activity_type),
    start_date_local: new Date(startMs + offset * 1000).toISOString().slice(0, 19) + 'Z',
    distance_m: row.distance_m == null ? null : Number(row.distance_m),
    moving_time_s: Number.isFinite(seconds) ? seconds : null,
    elapsed_time_s: Number.isFinite(seconds) ? seconds : null,
  };
}

function sportFamily(value) {
  const type = String(value || '').toLowerCase();
  if (/swim/.test(type)) return 'swim';
  if (/ride|cycl|bik/.test(type)) return 'ride';
  if (/run/.test(type)) return 'run';
  return type;
}

const wallClockMs = (value) => Date.parse(String(value || '').slice(0, 19) + 'Z');

/** One recording held by both services: same sport, start within 10 minutes, distance within 3%. */
export function sameConnectedRecording(a, b) {
  if (!a || !b || sportFamily(a.sport_type) !== sportFamily(b.sport_type)) return false;
  const startA = wallClockMs(a.start_date_local);
  const startB = wallClockMs(b.start_date_local);
  if (!Number.isFinite(startA) || !Number.isFinite(startB) || Math.abs(startA - startB) > 10 * 60000) return false;
  const distanceA = Number(a.distance_m) || 0;
  const distanceB = Number(b.distance_m) || 0;
  if (distanceA < 50 && distanceB < 50) return true;
  return Math.abs(distanceA - distanceB) <= Math.max(distanceA, distanceB) * 0.03;
}

/**
 * Strava cache rows plus Garmin rows, each recording once, Garmin preferred.
 * `stravaRows` null means Strava could not be read; the Garmin rows still
 * count. Returns rows in start order.
 */
export function mergeGarminWithStrava(stravaRows, garminRows) {
  const garmin = (Array.isArray(garminRows) ? garminRows : []).map(garminActivityAsStravaRow).filter(Boolean);
  const used = new Set();
  const out = garmin.slice();
  (Array.isArray(stravaRows) ? stravaRows : []).forEach((row) => {
    const index = garmin.findIndex((candidate, i) => !used.has(i) && sameConnectedRecording(candidate, row));
    if (index >= 0) used.add(index);
    else out.push(row);
  });
  return out.sort((a, b) => wallClockMs(a.start_date_local) - wallClockMs(b.start_date_local));
}
