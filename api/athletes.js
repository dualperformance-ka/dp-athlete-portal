// /api/athletes.js — roster management on Supabase public.athletes.
// The athletes table is the single source of truth for the roster. RLS is
// enabled with NO anon policies on purpose — all access goes through this
// function with the service role key. Never query athletes from the browser.
//
// Actions:
//   GET  ?action=roster                → non-archived athletes (active + paused).
//                                        ?include=archived returns everything.
//   GET  ?action=validate&code=CODE    → { exists, active, name } for portal login.
//                                        Archived codes report exists:false.
//   POST { action:'add', name, start_date?, race_target?, coach?, notes? }
//        → generates code (uppercase first name, numeric suffix if taken:
//          THOMAS → THOMAS2), inserts row, returns { code, portalLink }. [admin]
//   POST { action:'update', code, fields:{ active?, name?, coach?, start_date?,
//          race_target?, notes?, ghl_contact_id? } }                     [admin]
//   POST { action:'archive', code }    → sets archived_at + active=false. [admin]
//   POST { action:'disconnect-strava', code, confirmed:true }
//                                      → revokes an inactive athlete's
//                                        Strava access and purges its cache. [admin]
//        NEVER hard-deletes: athlete_data, planned_sessions etc are keyed by
//        code and history must survive.
//
// Auth: mutations require header  x-admin-key === process.env.ADMIN_KEY
// (fail-closed if ADMIN_KEY is unset). Reads (roster/validate) are open, same
// as the other portal endpoints.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_KEY, STRAVA_CLIENT_ID,
//      STRAVA_CLIENT_SECRET (already configured), PORTAL_URL (optional,
//      defaults to the production portal).

import crypto from 'crypto';
import { select, insert, patch } from './_lib/supabase-rest.js';
import { normCode } from './_lib/roster.js';
import { allowPortalRequest } from './_lib/http.js';
import { deauthorize, refreshStravaToken } from './_lib/strava-client.js';
import {
  deleteAllActivities,
  deleteTokens,
  getTokens,
  mergeTokens,
} from './_lib/strava-store.js';

const PORTAL_URL = (process.env.PORTAL_URL || 'https://dp-athleteportal.vercel.app').replace(/\/+$/, '');

const ROSTER_FIELDS = 'code,name,active,coach,start_date,race_target,ghl_contact_id,notes,created_at,archived_at,email,auth_user_id,auth_mode,invited_at,email_verified_at';

function send(res, status, payload) {
  return res.status(status).json(payload);
}

const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const text = (v, max = 300) => (has(v) ? String(v).trim().slice(0, max) : null);

function dateStr(v) {
  const t = text(v, 40);
  return /^\d{4}-\d{2}-\d{2}$/.test(t || '') ? t : null;
}

function portalLink(code) {
  return `${PORTAL_URL}/?code=${encodeURIComponent(code)}`;
}

function requireAdmin(req, res) {
  const configured = process.env.ADMIN_KEY;
  if (!configured) {
    send(res, 500, { ok: false, error: 'ADMIN_KEY not configured' });
    return false;
  }
  const supplied = String(req.headers['x-admin-key'] || '');
  const left = Buffer.from(supplied);
  const right = Buffer.from(String(configured));
  if (!supplied || left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    send(res, 401, { ok: false, error: 'Invalid admin key' });
    return false;
  }
  return true;
}

// ── Code generation ──────────────────────────────────────────────────────────
// Uppercase first name, A-Z0-9 only. De-duped against ALL codes ever issued
// (including archived — codes are permanent keys into athlete history and must
// never be reused): THOMAS taken → THOMAS2 → THOMAS3 …
function baseCodeFromName(name) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  const code = normCode(first).slice(0, 12);
  return code || 'ATHLETE';
}

async function generateCode(name) {
  const base = baseCodeFromName(name);
  const rows = await select('athletes', { select: 'code' });
  const taken = new Set((rows || []).map((r) => String(r.code || '').toUpperCase()));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error('Could not generate a unique code');
}

// ── Handlers ─────────────────────────────────────────────────────────────────
async function handleRoster(req) {
  const includeArchived = String(req.query?.include || '') === 'archived';
  const query = { select: ROSTER_FIELDS, order: 'created_at.asc' };
  if (!includeArchived) query.archived_at = 'is.null';
  const rows = await select('athletes', query);
  return {
    ok: true,
    athletes: (rows || []).map((r) => ({ ...r, portalLink: portalLink(r.code) })),
  };
}

async function handleValidate(req) {
  const code = normCode(req.query?.code);
  if (!code) return { exists: false, active: false };
  const rows = await select('athletes', { code: `eq.${code}`, select: ROSTER_FIELDS, limit: 1 });
  const row = (rows || [])[0];
  if (!row || row.archived_at != null) return { exists: false, active: false };
  return {
    exists: true,
    active: row.active === true,
    code: row.code,
    name: row.name,
    start_date: row.start_date,
    race_target: row.race_target,
  };
}

async function handleAdd(payload) {
  const name = text(payload.name, 120);
  if (!name) throw httpError(400, 'name is required');

  const row = {
    code: await generateCode(name),
    name,
    active: true,
    coach: text(payload.coach, 60) || 'karl',
    start_date: dateStr(payload.start_date),
    race_target: text(payload.race_target, 200),
    notes: text(payload.notes, 2000),
    ghl_contact_id: text(payload.ghl_contact_id, 120),
  };

  // Retry on a rare concurrent-insert PK collision.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const inserted = await insert('athletes', row);
      const saved = (inserted || [])[0] || row;
      return { ok: true, code: saved.code, portalLink: portalLink(saved.code), athlete: saved };
    } catch (e) {
      if (/duplicate|conflict|23505/i.test(e.message || '') && attempt < 2) {
        row.code = await generateCode(name);
        continue;
      }
      throw e;
    }
  }
  throw new Error('Insert failed');
}

const UPDATABLE = [
  'name', 'active', 'coach', 'start_date', 'race_target', 'notes',
  'ghl_contact_id', 'email', 'auth_mode', 'invited_at',
];

async function handleUpdate(payload) {
  const code = normCode(payload.code);
  if (!code) throw httpError(400, 'code is required');

  const fields = payload.fields || {};
  const values = {};
  for (const key of UPDATABLE) {
    if (!(key in fields)) continue;
    if (key === 'active') {
      if (typeof fields.active !== 'boolean') throw httpError(400, 'active must be a boolean');
      values.active = fields.active;
    } else if (key === 'start_date') {
      values.start_date = dateStr(fields.start_date); // null clears it
    } else if (key === 'name') {
      const name = text(fields.name, 120);
      if (!name) throw httpError(400, 'name cannot be empty');
      values.name = name;
    } else if (key === 'email') {
      const email = text(fields.email, 254);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'email is invalid');
      values.email = email ? email.toLowerCase() : null;
    } else if (key === 'auth_mode') {
      const mode = text(fields.auth_mode, 20);
      if (!['code', 'both', 'email'].includes(mode)) throw httpError(400, 'auth_mode is invalid');
      values.auth_mode = mode;
    } else if (key === 'invited_at') {
      const invite = text(fields.invited_at, 50);
      if (invite && Number.isNaN(Date.parse(invite))) throw httpError(400, 'invited_at is invalid');
      values.invited_at = invite ? new Date(invite).toISOString() : null;
    } else {
      values[key] = text(fields[key], key === 'notes' ? 2000 : 200);
    }
  }
  if (!Object.keys(values).length) throw httpError(400, 'No valid fields to update');

  const rows = await patch('athletes', { code: `eq.${code}` }, values);
  if (!rows || !rows.length) throw httpError(404, `Unknown athlete code: ${code}`);
  return { ok: true, athlete: rows[0] };
}

async function handleArchive(payload) {
  const code = normCode(payload.code);
  if (!code) throw httpError(400, 'code is required');
  // Soft archive ONLY — history in athlete_data / planned_sessions / logs is
  // keyed by this code and must survive.
  const rows = await patch(
    'athletes',
    { code: `eq.${code}` },
    { archived_at: new Date().toISOString(), active: false }
  );
  if (!rows || !rows.length) throw httpError(404, `Unknown athlete code: ${code}`);
  return { ok: true, athlete: rows[0] };
}

/**
 * Admin-only escape hatch for an inactive athlete who can no longer use the
 * athlete-owned disconnect control. Strava counts an authorization against the
 * app's athlete capacity until Strava itself is deauthorized, so deleting the
 * Supabase row first would lose the only credential capable of freeing a slot.
 *
 * Exported with dependency injection so the destructive ordering is testable:
 * refresh (when needed) -> revoke at Strava -> purge local cache and tokens.
 */
export async function disconnectInactiveAthleteStrava(payload, deps = {}) {
  const code = normCode(payload.code);
  if (!code) throw httpError(400, 'code is required');
  if (payload.confirmed !== true) throw httpError(400, 'confirmed must be true');

  const {
    findAthlete = async (athleteCode) => {
      const rows = await select('athletes', {
        code: `eq.${athleteCode}`,
        select: 'code,name,active,archived_at',
        limit: 1,
      });
      return (rows || [])[0] || null;
    },
    readTokens = getTokens,
    refreshToken = refreshStravaToken,
    saveTokenChanges = mergeTokens,
    revoke = deauthorize,
    purgeActivities = deleteAllActivities,
    purgeTokens = deleteTokens,
    nowSeconds = () => Math.floor(Date.now() / 1000),
  } = deps;

  const athlete = await findAthlete(code);
  if (!athlete) throw httpError(404, `Unknown athlete code: ${code}`);
  if (athlete.active === true) {
    throw httpError(409, 'Only an inactive athlete can be disconnected by an administrator');
  }

  const stored = await readTokens(code);
  if (!stored || (!stored.access_token && !stored.refresh_token)) {
    await purgeActivities(code);
    await purgeTokens(code);
    return { ok: true, code, disconnected: true, alreadyDisconnected: true };
  }

  let accessToken = stored.access_token || '';
  let refreshed = false;
  const expiresAt = Number(stored.expires_at || 0);

  // Refresh before deauthorizing when the access token is expired (or inside
  // the same five-minute safety buffer used by the athlete read path). Strava
  // rejects an expired access token with 401; deleting locally after that 401
  // would leave the authorization consuming athlete capacity with no token to
  // revoke it later.
  if (!accessToken || !expiresAt || nowSeconds() > expiresAt - 300) {
    if (!stored.refresh_token) throw httpError(409, 'Strava refresh token is missing; nothing was deleted');
    const next = await refreshToken(stored.refresh_token);
    accessToken = next.access_token || '';
    if (!accessToken) throw httpError(502, 'Strava refresh returned no access token; nothing was deleted');
    await saveTokenChanges(code, {
      access_token: accessToken,
      refresh_token: next.refresh_token || stored.refresh_token,
      expires_at: next.expires_at,
      ...(next.scope ? { scope: next.scope } : {}),
    });
    refreshed = true;
  }

  // Do not catch this error. A transient Strava failure must leave the local
  // credential intact so the revocation can be retried instead of permanently
  // marooning an athlete-capacity slot.
  await revoke(accessToken);
  await purgeActivities(code);
  await purgeTokens(code);

  return { ok: true, code, disconnected: true, refreshed };
}

/**
 * Admin-only escape hatch for an inactive athlete who can no longer use the
 * athlete-owned disconnect control. Strava counts an authorization against the
 * app's athlete capacity until Strava itself is deauthorized, so deleting the
 * Supabase row first would lose the only credential capable of freeing a slot.
 *
 * Exported with dependency injection so the destructive ordering is testable:
 * refresh (when needed) -> revoke at Strava -> purge local cache and tokens.
 */
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ── Router ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (!allowPortalRequest(req, res, 'GET, POST, OPTIONS', 'Content-Type, X-Admin-Key')) return;

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const action = String(req.query?.action || 'roster');
      if (action === 'validate') {
        return send(res, 410, { ok: false, error: 'Use /api/auth-athlete for portal sign-in' });
      }
      if (action === 'roster') {
        if (!requireAdmin(req, res)) return;
        return send(res, 200, await handleRoster(req));
      }
      return send(res, 400, { ok: false, error: `Unknown action: ${action}` });
    }

    if (req.method === 'POST') {
      const payload = req.body || {};
      const action = String(payload.action || '').trim();
      if (!['add', 'update', 'archive', 'disconnect-strava'].includes(action)) {
        return send(res, 400, { ok: false, error: `Unknown action: ${action}` });
      }
      if (!requireAdmin(req, res)) return; // response already sent
      if (action === 'add') return send(res, 200, await handleAdd(payload));
      if (action === 'update') return send(res, 200, await handleUpdate(payload));
      if (action === 'archive') return send(res, 200, await handleArchive(payload));
      if (action === 'disconnect-strava') {
        return send(res, 200, await disconnectInactiveAthleteStrava(payload));
      }
    }

    return send(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (err) {
    const status = err.status || 502;
    console.error('[athletes]', err && err.message);
    return send(res, status, { ok: false, error: err.message || 'Request failed' });
  }
}
