// /api/auth-athlete.js — email-auth identity resolution for the portal.
//
// Actions:
//   GET ?action=eligibility&email=x@y.z
//     Pre-OTP gate used by the login screen BEFORE any code is sent.
//     → { ok, enabled, eligible, active }
//     `enabled`  = EMAIL_AUTH_ENABLED env flag (global rollout switch)
//     `eligible` = a non-archived roster row has this email with
//                  auth_mode 'both' or 'email' (per-athlete rollout switch)
//     Prevents OTP sends (and stray auth.users rows) for emails the coach has
//     not enrolled. Response is deliberately coarse — no names/codes leak.
//
//   GET (default, Authorization: Bearer <supabase access token>)
//     Verifies the session server-side, resolves (and on first sign-in links)
//     the auth user to their EXISTING athlete row, and returns the same shape
//     as /api/athletes?action=validate so the portal boots through the exact
//     same pipeline as a code login → identical UI + full data continuity.
//     Never creates athlete rows; never changes `code`.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (existing), EMAIL_AUTH_ENABLED (new).

import { select } from './_lib/supabase-rest.js';
import { bearerToken, getUserFromToken, resolveAthleteForUser, emailAuthEnabled, emailIlikePattern } from './_lib/auth.js';

function send(res, status, payload) {
  return res.status(status).json(payload);
}

function cleanEmail(v) {
  const e = String(v || '').trim().toLowerCase().slice(0, 254);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

async function handleEligibility(req) {
  const enabled = emailAuthEnabled();
  const email = cleanEmail(req.query && req.query.email);
  if (!enabled || !email) return { ok: true, enabled, eligible: false, active: false };
  const rows = await select('athletes', {
    email: `ilike.${emailIlikePattern(email)}`,
    archived_at: 'is.null',
    auth_mode: 'in.(both,email)',
    select: 'code,active',
    limit: 1,
  });
  const row = (rows || [])[0];
  return { ok: true, enabled, eligible: !!row, active: !!row && row.active === true };
}

async function handleMe(req) {
  const token = bearerToken(req);
  if (!token) return { status: 401, body: { ok: false, error: 'Missing bearer token' } };
  const user = await getUserFromToken(token);
  if (!user) return { status: 401, body: { ok: false, error: 'Invalid or expired session' } };

  const athlete = await resolveAthleteForUser(user);
  if (!athlete) {
    // Valid auth user but no enrolled athlete row — coach hasn't set the
    // email on the roster (or set auth_mode). Tell the client plainly so the
    // login UI can show a friendly "check with your coach" message.
    return { status: 403, body: { ok: false, error: 'no_linked_athlete' } };
  }
  return {
    status: 200,
    body: {
      ok: true,
      exists: true,
      active: athlete.active === true,
      code: athlete.code, // ← legacy business key; everything downstream keys off this
      name: athlete.name,
      start_date: athlete.start_date,
      race_target: athlete.race_target,
      email: athlete.email,
      auth_mode: athlete.auth_mode,
    },
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });

  try {
    const action = String((req.query && req.query.action) || 'me');
    if (action === 'eligibility') return send(res, 200, await handleEligibility(req));
    if (action === 'me') {
      const { status, body } = await handleMe(req);
      return send(res, status, body);
    }
    return send(res, 400, { ok: false, error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[auth-athlete]', err && err.message);
    return send(res, 502, { ok: false, error: err.message || 'Request failed' });
  }
}
