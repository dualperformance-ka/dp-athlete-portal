// /api/my-logs.js — athlete-facing read of the structured, source-of-truth logs.
// The progress tab cannot read daily_body_logs directly (anon access is revoked
// by design), so this serverless function returns the athlete's own body logs
// using the service key, scoped to their athlete_code. This keeps the athlete's
// progress view in sync with exactly what the coach dashboard sees.
//
// Env required: SUPABASE_URL, SUPABASE_SERVICE_KEY (already set for /api/ingest).
import { select } from './_lib/supabase-rest.js';
import { getAuthedAthlete, bearerToken } from './_lib/auth.js';

function send(res, status, payload) {
  return res.status(status).json(payload);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });

  // Email-auth path: when a Supabase session token is supplied, identity comes
  // from the session (auth user → linked athlete row → its legacy code), never
  // from the query string. Token-less requests keep the legacy ?code= path so
  // non-migrated athletes are untouched.
  let code = String((req.query && req.query.code) || '').trim();
  if (bearerToken(req)) {
    const authed = await getAuthedAthlete(req);
    if (!authed) return send(res, 401, { ok: false, error: 'Invalid session', body: [] });
    code = authed.athlete.code;
  }
  if (!code) return send(res, 400, { ok: false, error: 'code is required' });

  try {
    const body = await select('daily_body_logs', {
      athlete_code: `eq.${code}`,
      select: 'log_date,weight,sleep,energy,stress,soreness,notes,raw_payload,submitted_at',
      order: 'log_date.desc',
      limit: '400',
    });
    return send(res, 200, { ok: true, body: Array.isArray(body) ? body : [] });
  } catch (e) {
    // Soft-fail to empty so the progress tab cleanly falls back to athlete_data + Notion.
    return send(res, 200, { ok: false, error: e.message, body: [] });
  }
}
