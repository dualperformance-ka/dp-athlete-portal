// Authenticated athlete data gateway.
//
// `/api/portal-data` rewrites here with `?mode=portal`. The historic `/api/write`
// endpoint is intentionally retired and returns 410 so old unauthenticated
// Notion writes cannot be revived accidentally.

import { select, upsert } from './_lib/supabase-rest.js';
import { getRequestAthlete } from './_lib/auth.js';
import { allowPortalRequest, safeError } from './_lib/http.js';

const ALLOWED_STATE_KEYS = [
  /^goals$/,
  /^logs$/,
  /^ticked$/,
  /^reschedules$/,
  /^photos$/,
  /^ex_picks$/,
  /^pending_writes$/,
  /^strava_ack$/,
  /^call_booked_\d{4}-\d{2}-\d{2}$/,
  /^checkin_[a-z0-9_-]{1,80}$/i,
  /^daily_body_\d{4}-\d{2}-\d{2}$/,
  /^daily_nut_\d{4}-\d{2}-\d{2}$/,
];

function send(res, status, payload) {
  return res.status(status).json(payload);
}

function text(value, max = 100) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function date(value) {
  const candidate = text(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

function weekLabel(value) {
  const candidate = text(value, 30);
  return /^Week \d{1,2}$/i.test(candidate) ? candidate : null;
}

function safeStateKey(value) {
  const key = text(value, 120);
  return ALLOWED_STATE_KEYS.some((pattern) => pattern.test(key)) ? key : null;
}

function assertValueSize(value) {
  let encoded = '';
  try {
    encoded = JSON.stringify(value);
  } catch {
    const error = new Error('State value must be valid JSON');
    error.status = 400;
    throw error;
  }
  if (encoded.length > 750_000) {
    const error = new Error('State value is too large');
    error.status = 413;
    throw error;
  }
}

async function stateRead(code) {
  const rows = await select('athlete_data', {
    athlete_code: `eq.${code}`,
    key: 'neq.strava_tokens',
    select: 'key,value,updated_at',
    order: 'updated_at.asc',
    limit: '1000',
  });
  return { rows: Array.isArray(rows) ? rows : [] };
}

async function stateWrite(code, body) {
  const key = safeStateKey(body.key);
  if (!key) {
    const error = new Error('State key is not writable');
    error.status = 400;
    throw error;
  }
  assertValueSize(body.value);
  await upsert('athlete_data', {
    athlete_code: code,
    key,
    value: body.value,
    updated_at: new Date().toISOString(),
  }, 'athlete_code,key');
  return { key, synced_at: new Date().toISOString() };
}

async function plannedSessions(code, body) {
  const start = date(body.start);
  const end = date(body.end);
  if (!start || !end || start > end) {
    const error = new Error('A valid date range is required');
    error.status = 400;
    throw error;
  }

  // Return the athlete's programme, not only the rows whose coach-planned date
  // falls inside the visible week. Athlete reschedules are stored separately in
  // athlete_data, so a session moved across a week boundary must still reach the
  // browser before that override can be applied.
  const programme = await select('planned_sessions', {
    athlete_code: `eq.${code}`,
    select: '*',
    order: 'planned_date.asc',
    limit: '1000',
  });
  const rows = Array.isArray(programme) ? programme : [];
  const next = rows.find((row) => row.planned_date > end) || null;

  return {
    rows,
    next,
  };
}

async function workoutSplits(code) {
  const rows = await select('workout_splits', {
    archived: 'eq.false',
    or: `(athlete_code.is.null,athlete_code.eq.${code})`,
    select: 'name,athlete_code,exercises',
    order: 'name.asc',
    limit: '200',
  });
  return { rows: Array.isArray(rows) ? rows : [] };
}

async function sessionLibrary() {
  const rows = await select('session_library', {
    archived: 'eq.false',
    select: '*',
    order: 'name.asc',
    limit: '1000',
  });
  return { rows: Array.isArray(rows) ? rows : [] };
}

async function nutritionWeek(code, body) {
  const label = weekLabel(body.weekLabel);
  if (!label) {
    const error = new Error('A valid programme week is required');
    error.status = 400;
    throw error;
  }
  const [plans, planned] = await Promise.all([
    select('nutrition_plans', {
      athlete_code: `eq.${code}`,
      week_label: `eq.${label}`,
      select: '*',
      limit: '1',
    }),
    select('planned_sessions', {
      athlete_code: `eq.${code}`,
      week_label: `eq.${label}`,
      select: 'distance_km,title,session_type,library_id,week_label',
      order: 'planned_date.asc',
      limit: '100',
    }),
  ]);
  return {
    plan: Array.isArray(plans) && plans[0] ? plans[0] : null,
    planned: Array.isArray(planned) ? planned : [],
  };
}

async function programmeData(code) {
  const [planned, nutrition] = await Promise.all([
    select('planned_sessions', {
      athlete_code: `eq.${code}`,
      select: 'week_label,distance_km,title,session_type,library_id,planned_date,status',
      order: 'planned_date.asc',
      limit: '1000',
    }),
    select('nutrition_plans', {
      athlete_code: `eq.${code}`,
      select: 'week_label,weekly_km_target',
      order: 'week_label.asc',
      limit: '100',
    }),
  ]);
  return {
    planned: Array.isArray(planned) ? planned : [],
    nutrition: Array.isArray(nutrition) ? nutrition : [],
  };
}

async function sessionLogsRead(code) {
  const rows = await select('session_logs', {
    athlete_code: `eq.${code}`,
    select: 'session_key,logged_at',
    order: 'logged_at.desc',
    limit: '1000',
  });
  return { rows: Array.isArray(rows) ? rows : [] };
}

async function sessionLogWrite(code, body) {
  const sessionKey = text(body.sessionKey, 180);
  if (!sessionKey) {
    const error = new Error('sessionKey is required');
    error.status = 400;
    throw error;
  }
  await upsert('session_logs', {
    athlete_code: code,
    session_key: sessionKey,
    logged_at: new Date().toISOString(),
  }, 'athlete_code,session_key');
  return { session_key: sessionKey };
}

async function bodyLogs(code) {
  const rows = await select('daily_body_logs', {
    athlete_code: `eq.${code}`,
    select: 'log_date,weight,sleep,energy,stress,soreness,notes,raw_payload,submitted_at',
    order: 'log_date.desc',
    limit: '400',
  });
  return { rows: Array.isArray(rows) ? rows : [] };
}

async function dispatch(action, code, body) {
  if (action === 'state-read') return stateRead(code);
  if (action === 'state-write') return stateWrite(code, body);
  if (action === 'planned-sessions') return plannedSessions(code, body);
  if (action === 'workout-splits') return workoutSplits(code);
  if (action === 'session-library') return sessionLibrary();
  if (action === 'nutrition-week') return nutritionWeek(code, body);
  if (action === 'programme-data') return programmeData(code);
  if (action === 'session-logs-read') return sessionLogsRead(code);
  if (action === 'session-log-write') return sessionLogWrite(code, body);
  if (action === 'body-logs') return bodyLogs(code);

  const error = new Error('Unknown portal action');
  error.status = 400;
  throw error;
}

export default async function handler(req, res) {
  if (String(req.query?.mode || '') !== 'portal') {
    return send(res, 410, {
      ok: false,
      error: 'This legacy write endpoint has been retired. Update the client to /api/portal-data.',
    });
  }
  if (!allowPortalRequest(req, res, 'POST, OPTIONS')) return;
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method_not_allowed' });

  try {
    const identity = await getRequestAthlete(req);
    if (!identity) return send(res, 401, { ok: false, error: 'invalid_session' });

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const action = text(body.action, 60);
    const data = await dispatch(action, String(identity.athlete.code).toUpperCase(), body);
    return send(res, 200, { ok: true, ...data });
  } catch (error) {
    console.error('[portal-data]', error && error.message);
    const safe = safeError(error);
    return send(res, safe.status, { ok: false, error: safe.message });
  }
}
