// Privacy-safe operation timing for serverless routes.
//
// One structured log line per named operation: name, duration, outcome,
// whether a deadline fired, how many database round trips it made, and any
// numeric counts the caller passes. Never athlete codes, names, tokens, query
// strings, request bodies or programme content: `counts` is filtered to finite
// numbers and booleans so a caller cannot leak a string through it by accident.
//
// Volume is bounded. Cron operations always log (one line per run). Request
// operations log when they fail, time out or run slow, plus a small random
// sample of healthy ones (PERF_LOG_SAMPLE_RATE, default 0.05). Set
// PERF_LOG_SAMPLE_RATE=0 to keep only failures and slow calls.

import { addRequestObserver } from './supabase-rest.js';

const SLOW_MS = 2000;

function sampleRate() {
  const configured = Number(process.env.PERF_LOG_SAMPLE_RATE);
  if (Number.isFinite(configured) && configured >= 0 && configured <= 1) return configured;
  return 0.05;
}

export function safeCounts(counts) {
  const out = {};
  if (!counts || typeof counts !== 'object') return out;
  for (const [key, value] of Object.entries(counts)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(key)) continue;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
  }
  return out;
}

export function outcomeOf(error) {
  if (!error) return 'ok';
  if (error.kind === 'timeout' || error.name === 'AbortError') return 'timeout';
  if (error.kind) return error.kind;
  return 'error';
}

export function emitPerf(record, { always = false, log = console.log } = {}) {
  const line = {
    evt: 'perf',
    op: String(record.op || 'unknown').slice(0, 60),
    ms: Math.round(Number(record.ms) || 0),
    status: String(record.status || 'ok').slice(0, 24),
    timedOut: !!record.timedOut,
    dbCalls: Number.isFinite(record.dbCalls) ? record.dbCalls : undefined,
    ...safeCounts(record.counts),
  };
  const interesting = line.status !== 'ok' || line.timedOut || line.ms >= SLOW_MS;
  if (!always && !interesting && Math.random() >= sampleRate()) return null;
  try { log(JSON.stringify(line)); } catch { /* logging must never fail a request */ }
  return line;
}

// Time an async operation. The database call count is measured with a
// request observer for the duration of the call; concurrent operations in the
// same instance can inflate it slightly, which is fine for a diagnostic.
export async function timed(op, fn, { always = false, counts } = {}) {
  const started = Date.now();
  let dbCalls = 0;
  let timedOut = false;
  const stop = addRequestObserver((request) => {
    dbCalls++;
    if (request.outcome === 'timeout') timedOut = true;
  });
  try {
    const value = await fn();
    stop();
    emitPerf({ op, ms: Date.now() - started, status: 'ok', timedOut, dbCalls, counts: typeof counts === 'function' ? counts(value) : counts }, { always });
    return value;
  } catch (error) {
    stop();
    const status = outcomeOf(error);
    emitPerf({ op, ms: Date.now() - started, status, timedOut: timedOut || status === 'timeout', dbCalls }, { always: true });
    throw error;
  }
}
