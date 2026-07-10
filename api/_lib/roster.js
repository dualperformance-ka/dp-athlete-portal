// api/lib/roster.js — shared helpers for the Supabase athletes roster.
// public.athletes is the single source of truth for the roster. RLS has no
// anon policies by design: every read/write goes through serverless functions
// using the service role key (via supabase-rest.js).

import { select } from './supabase-rest.js';

export function normCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
}

// Fetch one roster row by code. Returns null when the code isn't in the roster.
export async function getRosterAthlete(code) {
  const c = normCode(code);
  if (!c) return null;
  const rows = await select('athletes', { code: `eq.${c}`, select: '*', limit: 1 });
  return (Array.isArray(rows) && rows[0]) || null;
}

// An athlete is blocked from writing fresh data when they are paused or archived.
// Unknown codes are NOT blocked here (legacy codes may predate the roster) —
// they keep flowing through the existing identity checks.
export function isBlockedRow(row) {
  return !!row && (row.archived_at != null || row.active === false);
}

// Guard used by write endpoints. Returns { blocked, row }. Fails OPEN on
// lookup errors so a transient Supabase hiccup never drops a submission.
export async function checkRosterAccess(code) {
  try {
    const row = await getRosterAthlete(code);
    return { blocked: isBlockedRow(row), row };
  } catch (e) {
    console.warn('[roster] access check failed (failing open):', e && e.message);
    return { blocked: false, row: null };
  }
}
