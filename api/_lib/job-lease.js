// Database-backed single-flight lease for scheduled jobs.
//
// pg_cron calls /api/reminders over HTTP and does not wait for the previous
// call to finish, so a slow run used to overlap the next one, which made the
// database slower, which made the next run slower still. Each run now has to
// win a lease row first. Acquisition is one INSERT ... ON CONFLICT DO UPDATE
// WHERE expires_at <= now() inside public.acquire_job_lease(), which Postgres
// serialises on the row, so exactly one caller wins however many Vercel
// instances race. The lease carries an expiry, so a crashed or killed function
// frees it on its own; release happens in a finally block when it can.
//
// Nothing in-memory is involved: serverless instances share nothing, and a
// session-scoped advisory lock would be dropped between PostgREST requests.

import crypto from 'node:crypto';
import { rpc } from './supabase-rest.js';

// Longer than the function's maxDuration (vercel.json) so a lease can never
// expire under a run that is still legitimately working.
export const REMINDER_LEASE_SECONDS = 120;
export const REMINDER_JOB = 'send-athlete-reminders';

export function newLeaseOwner() {
  return crypto.randomUUID();
}

// { acquired: true } | { acquired: false, reason: 'held' }
// | { acquired: false, reason: 'unavailable', kind } on timeout / 5xx
// | { acquired: true, degraded: 'lease_function_missing' } when the migration
//   has not been applied yet, so deploying code before the migration does not
//   switch reminders off. Overlap protection starts once it is applied.
export async function acquireLease(job, owner, ttlSeconds, { call = rpc, timeoutMs = 5000 } = {}) {
  try {
    const result = await call('acquire_job_lease', {
      p_job: job, p_owner: owner, p_ttl_seconds: ttlSeconds,
    }, { timeoutMs });
    const acquired = result === true || (Array.isArray(result) && result[0] === true)
      || (result && typeof result === 'object' && result.acquire_job_lease === true);
    return acquired ? { acquired: true } : { acquired: false, reason: 'held' };
  } catch (error) {
    if (error && error.kind === 'missing_function') return { acquired: true, degraded: 'lease_function_missing' };
    return { acquired: false, reason: 'unavailable', kind: (error && error.kind) || 'error' };
  }
}

// Releases only if this owner still holds it, and records safe run metadata.
export async function releaseLease(job, owner, outcome, counts = {}, { call = rpc, timeoutMs = 5000 } = {}) {
  try {
    await call('release_job_lease', {
      p_job: job,
      p_owner: owner,
      p_outcome: String(outcome || 'ok').slice(0, 40),
      p_counts: counts,
    }, { timeoutMs });
    return true;
  } catch {
    // The lease expires by itself; a failed release only delays the next run.
    return false;
  }
}
