// Coach mode inside the athlete portal.
//
// A coach standing next to an athlete opens a link the dashboard minted for
// them. That link carries a signed, one-hour, SINGLE-ATHLETE token. This module
// turns that token into permission to edit one athlete's prescription from
// inside their app.
//
// The portal deliberately implements NO programming logic of its own. Every
// action is forwarded server-to-server to the coaches dashboard, which remains
// the single place where coach identity, athlete scope, edit scope and the
// audit trail are decided. This file's only jobs are:
//
//   1. prove the caller holds a valid coach token          (authenticate)
//   2. prove the thing they are editing belongs to THAT     (authorise)
//      token's athlete
//   3. forward, and hand back the answer                    (courier)
//
// Nothing here is reachable without the token. An athlete's own session, no
// matter how it is crafted, never satisfies step 1: the token is HMAC-signed
// with a secret only the two servers hold, and it is purpose-scoped, so even a
// valid athlete login token is rejected.

import { verifyPortalSession } from './legacy-session.js';

const DASHBOARD_URL = String(
  process.env.COACH_API_URL || 'https://dp-coaches-dashboard.vercel.app'
).replace(/\/+$/, '');

// Only these may be driven from the portal. An allowlist, not a denylist: a new
// dashboard action must be added here deliberately before it is reachable from
// an athlete's device.
const READ_ACTIONS = {
  'coach-prescription': 'prescription',
  'coach-exercise-library': 'exercise_library',
};

const WRITE_ACTIONS = {
  'coach-exercise-update': 'exercise_update',
  'coach-exercise-add': 'exercise_add',
  'coach-exercise-remove': 'exercise_remove',
  'coach-exercise-replace': 'exercise_replace',
  'coach-exercise-reorder': 'exercise_reorder',
  'coach-split-save': 'split_save_from_session',
};

export function isCoachAction(action) {
  return Boolean(READ_ACTIONS[action] || WRITE_ACTIONS[action]);
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function bearer(req) {
  const header = req.headers && (req.headers.authorization || req.headers.Authorization);
  const match = /^Bearer\s+(.+)$/i.exec(String(header || '').trim());
  return match ? match[1] : null;
}

// Returns { code, actor } or null. Never throws.
export function resolveCoachMode(req) {
  try {
    const session = verifyPortalSession(bearer(req), 'coach-edit');
    if (!session || !session.actor) return null;
    return { code: session.code, actor: session.actor, expiresAt: session.exp };
  } catch {
    return null;
  }
}

function dashboardKey() {
  const key = String(process.env.DASHBOARD_ACCESS_KEY || process.env.ADMIN_KEY || '').trim();
  if (!key) throw httpError('Coach mode is not configured on this deployment', 503);
  return key;
}

async function callDashboard(method, path, body, coach) {
  const response = await fetch(`${DASHBOARD_URL}/api/athletes${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Dashboard-Key': dashboardKey(),
      // The dashboard writes this into its own audit trail, so a change made
      // from the athlete's phone is still attributed to the coach.
      'X-Coach-Name': coach.actor,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }

  if (!response.ok || data.ok === false) {
    throw httpError(data.error || `Coach action failed (${response.status})`, response.status || 502);
  }
  return data;
}

// Load a session and prove it belongs to the athlete this token was minted for.
//
// This is the check the dashboard CANNOT make for us: it authorises the coach
// against the athlete, and a coach is typically allowed everyone. The token,
// though, is scoped to one athlete — so a link minted for Thomas must not be
// usable to edit Nate, even by a coach who is allowed to edit Nate elsewhere.
async function loadOwnedSession(sessionId, coach) {
  if (!sessionId) throw httpError('Session id is required', 400);
  const data = await callDashboard(
    'GET',
    `?action=prescription&session_id=${encodeURIComponent(sessionId)}`,
    undefined,
    coach
  );
  const athlete = data && data.session && data.session.athlete_code;
  if (String(athlete || '').toUpperCase() !== coach.code) {
    // Same message whether the session exists or belongs to someone else.
    throw httpError('That session is not part of this coaching link', 403);
  }
  return data;
}

export async function dispatchCoachAction(action, body, coach) {
  if (READ_ACTIONS[action] === 'exercise_library') {
    const term = String(body.q || '').slice(0, 60);
    return callDashboard('GET', `?action=exercise_library&q=${encodeURIComponent(term)}`, undefined, coach);
  }

  if (READ_ACTIONS[action] === 'prescription') {
    return loadOwnedSession(body.session_id, coach);
  }

  const target = WRITE_ACTIONS[action];
  if (!target) throw httpError('Unknown coach action', 400);

  // Every write must name its session, and that session must belong to the
  // token's athlete. This is what stops a crafted request from reaching another
  // athlete's prescription through a link minted for this one.
  const owned = await loadOwnedSession(body.session_id, coach);

  // Exercise-level actions additionally have to prove the exercise is IN that
  // session — otherwise a valid session id could be paired with someone else's
  // exercise id and the dashboard, which authorises by coach not by token,
  // would happily apply it.
  if (body.exercise_id) {
    const belongs = (owned.exercises || []).some((row) => row.id === body.exercise_id);
    if (!belongs) throw httpError('That exercise is not part of this session', 403);
  }
  if (Array.isArray(body.order)) {
    const ids = new Set((owned.exercises || []).map((row) => row.id));
    const foreign = body.order.some((item) => !ids.has(typeof item === 'string' ? item : item && item.id));
    if (foreign) throw httpError('That exercise is not part of this session', 403);
  }

  const payload = { ...body, action: target };

  // Scope is pinned to this session. "This and future" and "whole block" are
  // deliberately dashboard-only: a coach making a quick change on the gym floor
  // should not be able to rewrite a whole block from a phone by accident.
  payload.scope = 'session';

  // A split saved from the gym floor defaults to this athlete rather than the
  // whole squad, for the same reason.
  if (target === 'split_save_from_session' && !payload.athlete_code) {
    payload.athlete_code = coach.code;
  }

  return callDashboard('POST', '', payload, coach);
}
