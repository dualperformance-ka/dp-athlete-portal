// Server-side PostgREST client.
//
// Every request has a deadline. Supabase on shared compute can stall a REST
// call for minutes when the database is saturated, and a serverless function
// that waits on it holds a connection slot, keeps the athlete on a spinner and
// stacks up behind the next request. The deadline ABORTS the underlying fetch
// (body read included) rather than ignoring a late answer, so the socket and
// the PostgREST worker are both released.
//
// Failures are classified so callers and the browser can tell them apart:
//   kind 'timeout'           deadline hit             -> status 504
//   kind 'network'           fetch itself failed      -> status 503
//   kind 'upstream'          PostgREST 5xx            -> status 503
//   kind 'missing_function'  RPC not deployed yet     -> no status (caller decides)
//   kind 'http'              PostgREST 4xx            -> no status (500 to the browser,
//                                                        message never forwarded)
// Nothing here retries. A retry inside a request path multiplies load on a
// database that is already struggling; the browser falls back to its cache
// and the cron simply runs again on its next tick.

export const DEFAULT_TIMEOUT_MS = 8000;

function env() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase service credentials not configured');
  return { url: url.replace(/\/+$/, ''), key };
}

function qs(params) {
  return Object.entries(params || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

// Observers receive one privacy-safe record per request: the table (or rpc
// name), method, duration and outcome. Never the query string, body or key.
// Used by telemetry and by tests that count database round trips.
const observers = new Set();
export function addRequestObserver(fn) {
  if (typeof fn !== 'function') return () => {};
  observers.add(fn);
  return () => observers.delete(fn);
}
function notify(record) {
  for (const fn of observers) {
    try { fn(record); } catch { /* an observer must never break a request */ }
  }
}

function resourceName(path) {
  return String(path || '').split('?')[0].slice(0, 80);
}

function upstreamError(kind, message, extra = {}) {
  const error = new Error(message);
  error.kind = kind;
  if (kind === 'timeout') { error.status = 504; error.code = 'upstream_timeout'; }
  else if (kind === 'network' || kind === 'upstream') { error.status = 503; error.code = 'upstream_unavailable'; }
  Object.assign(error, extra);
  return error;
}

export function isInfrastructureError(error) {
  return !!error && ['timeout', 'network', 'upstream'].includes(error.kind);
}

export function timeoutMsFor(options = {}) {
  const value = Number(options.timeoutMs);
  if (Number.isFinite(value) && value > 0) return Math.min(value, 60000);
  const configured = Number(process.env.SUPABASE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.min(configured, 60000) : DEFAULT_TIMEOUT_MS;
}

export async function supabaseRequest(path, options = {}) {
  const { url, key } = env();
  const method = options.method || 'GET';
  const timeoutMs = timeoutMsFor(options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // A caller-supplied signal (the reminder run's overall budget) aborts too.
  const outer = options.signal;
  const onOuterAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  const started = Date.now();
  const resource = resourceName(path);
  let status = 0;
  try {
    let response;
    let text;
    try {
      response = await fetch(`${url}/rest/v1/${path}`, {
        method,
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: options.prefer || 'return=representation',
          ...(options.headers || {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      status = response.status;
      if (typeof options.onHeaders === 'function' && response.headers) options.onHeaders(response.headers);
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted) {
        throw upstreamError('timeout', `Supabase ${resource} timed out after ${timeoutMs}ms`, { timeoutMs });
      }
      throw upstreamError('network', `Supabase ${resource} unreachable`);
    }
    let data = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch {
        if (!response.ok) throw upstreamError(status >= 500 ? 'upstream' : 'http', `Supabase ${status}`, { upstreamStatus: status });
        throw upstreamError('upstream', 'Supabase returned an unreadable response', { upstreamStatus: status });
      }
    }
    if (!response.ok) {
      const message = data?.message || data?.error || `Supabase ${status}`;
      if (status >= 500) throw upstreamError('upstream', message, { upstreamStatus: status, pgCode: data?.code });
      // PGRST202: the function is not in the schema cache, i.e. a migration
      // that has not been applied yet. Callers can decide how to degrade.
      if (data?.code === 'PGRST202' || (status === 404 && /^rpc\//.test(path))) {
        throw upstreamError('missing_function', message, { upstreamStatus: status, pgCode: data?.code });
      }
      throw upstreamError('http', message, { upstreamStatus: status, pgCode: data?.code });
    }
    notify({ resource, method, ms: Date.now() - started, status, outcome: 'ok' });
    return data;
  } catch (error) {
    notify({ resource, method, ms: Date.now() - started, status, outcome: error.kind || 'error' });
    throw error;
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener('abort', onOuterAbort);
  }
}

export function tablePath(table, query) {
  const queryString = qs(query);
  return queryString ? `${table}?${queryString}` : table;
}

export async function upsert(table, rows, onConflict, options = {}) {
  const path = tablePath(table, onConflict ? { on_conflict: onConflict } : {});
  return supabaseRequest(path, {
    ...options,
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: Array.isArray(rows) ? rows : [rows],
  });
}

export async function insert(table, rows, options = {}) {
  return supabaseRequest(table, {
    ...options,
    method: 'POST',
    prefer: 'return=representation',
    body: Array.isArray(rows) ? rows : [rows],
  });
}

export async function patch(table, query, values, options = {}) {
  return supabaseRequest(tablePath(table, query), {
    ...options,
    method: 'PATCH',
    prefer: 'return=representation',
    body: values,
  });
}

export async function remove(table, query, options = {}) {
  return supabaseRequest(tablePath(table, query), {
    ...options,
    method: 'DELETE',
    prefer: 'return=minimal',
  });
}

export async function select(table, query, options = {}) {
  return supabaseRequest(tablePath(table, query), { ...options, method: 'GET' });
}

export async function rpc(fn, args = {}, options = {}) {
  return supabaseRequest(`rpc/${fn}`, { ...options, method: 'POST', prefer: 'return=representation', body: args });
}
