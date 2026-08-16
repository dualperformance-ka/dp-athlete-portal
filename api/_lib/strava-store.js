/**
 * Supabase persistence for the Strava integration.
 *
 * Tables (see supabase/migrations/20260816120000_strava_activity_cache.sql):
 *   athlete_data            key='strava_tokens'  — OAuth tokens + granted scope
 *   strava_activities                            — the activity cache
 *   strava_webhook_events                        — the inbound event queue
 *
 * Every function here runs with the service key. None of these tables grant
 * anon or authenticated, so this module is the ONLY way the data is reachable,
 * and api/strava.js is the only caller — which is what keeps the "athlete's own
 * data only" boundary in one auditable place.
 */
import { select, upsert, patch, remove, supabaseRequest, tablePath } from './supabase-rest.js';
import { normaliseActivity } from './strava-client.js';

const TOKEN_KEY = 'strava_tokens';

function code(athleteCode) {
  return String(athleteCode || '').toUpperCase();
}

// ── Tokens ───────────────────────────────────────────────────────────────────

export async function getTokens(athleteCode) {
  const rows = await select('athlete_data', {
    athlete_code: `eq.${code(athleteCode)}`,
    key: `eq.${TOKEN_KEY}`,
    select: 'id,value',
    limit: 1,
  });
  const row = Array.isArray(rows) && rows[0];
  if (!row || !row.value) return null;
  return { id: row.id, ...row.value };
}

export async function saveTokens(athleteCode, tokens) {
  return upsert(
    'athlete_data',
    {
      athlete_code: code(athleteCode),
      key: TOKEN_KEY,
      value: tokens,
      updated_at: new Date().toISOString(),
    },
    'athlete_code,key',
  );
}

/**
 * Merge-patch the token row. Used by the refresh path, which must replace the
 * access token WITHOUT clobbering strava_athlete_id, scope or connected_at —
 * the fields the webhook and the scope check depend on.
 */
export async function mergeTokens(athleteCode, changes) {
  const current = await getTokens(athleteCode);
  if (!current) return null;
  const { id, ...value } = current;
  const merged = { ...value, ...changes };
  await patch(
    'athlete_data',
    { athlete_code: `eq.${code(athleteCode)}`, key: `eq.${TOKEN_KEY}` },
    { value: merged, updated_at: new Date().toISOString() },
  );
  return merged;
}

export async function deleteTokens(athleteCode) {
  return remove('athlete_data', { athlete_code: `eq.${code(athleteCode)}`, key: `eq.${TOKEN_KEY}` });
}

/**
 * Webhook events identify the athlete only by their Strava id. Backed by the
 * partial index on athlete_data((value->>'strava_athlete_id')).
 */
export async function findAthleteCodeByStravaId(stravaAthleteId) {
  const id = String(stravaAthleteId || '').trim();
  if (!id) return null;
  const rows = await select('athlete_data', {
    key: `eq.${TOKEN_KEY}`,
    'value->>strava_athlete_id': `eq.${id}`,
    select: 'athlete_code',
    limit: 1,
  });
  const row = Array.isArray(rows) && rows[0];
  return row ? code(row.athlete_code) : null;
}

// ── Activity cache ───────────────────────────────────────────────────────────

/**
 * Upsert summary activities. Malformed entries are dropped by normaliseActivity
 * rather than failing the batch — one bad activity must not block a whole
 * backfill.
 */
export async function saveActivities(athleteCode, activities) {
  const rows = (Array.isArray(activities) ? activities : [])
    .map((activity) => normaliseActivity(athleteCode, activity))
    .filter(Boolean)
    .map((row) => ({ ...row, synced_at: new Date().toISOString() }));

  if (!rows.length) return { saved: 0 };

  // Chunked: a backfill can be 1,000+ activities and PostgREST has a request
  // size ceiling well below that.
  //
  // return=minimal, not the shared upsert() helper's representation: nothing
  // reads the result, and echoing a thousand full activity payloads back over
  // the wire is pure cost on the slowest request in the whole flow.
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await supabaseRequest(
      tablePath('strava_activities', { on_conflict: 'athlete_code,strava_activity_id' }),
      {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: rows.slice(i, i + CHUNK),
      },
    );
  }
  return { saved: rows.length };
}

export async function deleteActivity(athleteCode, stravaActivityId) {
  return remove('strava_activities', {
    athlete_code: `eq.${code(athleteCode)}`,
    strava_activity_id: `eq.${Number(stravaActivityId)}`,
  });
}

export async function deleteAllActivities(athleteCode) {
  return remove('strava_activities', { athlete_code: `eq.${code(athleteCode)}` });
}

export async function listActivities(athleteCode, { since, limit = 400 } = {}) {
  const query = {
    athlete_code: `eq.${code(athleteCode)}`,
    // synced_at is in the projection because the read route reports it as the
    // "last synced" timestamp. Leaving it out silently reported null forever.
    select: 'strava_activity_id,start_date_local,sport_type,name,distance_m,moving_time_s,elapsed_time_s,suffer_score,gear_id,summary,synced_at',
    order: 'start_date_local.desc',
    limit: String(limit),
  };
  if (since) query.start_date_local = `gte.${since}`;
  const rows = await select('strava_activities', query);
  return Array.isArray(rows) ? rows : [];
}

// ── Webhook event queue ──────────────────────────────────────────────────────

export async function enqueueEvent(event) {
  const rows = await supabaseRequest('strava_webhook_events', {
    method: 'POST',
    prefer: 'return=representation',
    body: [{
      subscription_id: event.subscription_id ?? null,
      owner_id:        Number(event.owner_id),
      object_type:     String(event.object_type || ''),
      object_id:       Number(event.object_id),
      aspect_type:     String(event.aspect_type || ''),
      updates:         event.updates && typeof event.updates === 'object' ? event.updates : {},
      event_time:      event.event_time ? new Date(Number(event.event_time) * 1000).toISOString() : null,
    }],
  });
  return (Array.isArray(rows) && rows[0]) || null;
}

export const MAX_EVENT_ATTEMPTS = 5;

/**
 * Pending events, oldest first. Scoped to one athlete when ownerId is given
 * (the read-path drain), or global (the cron drain).
 *
 * Events past MAX_EVENT_ATTEMPTS are left behind deliberately: something about
 * them is permanently broken, and retrying forever would starve good events out
 * of every drain window.
 */
export async function pendingEvents({ ownerId, limit = 25 } = {}) {
  const query = {
    processed_at: 'is.null',
    attempts: `lt.${MAX_EVENT_ATTEMPTS}`,
    order: 'received_at.asc',
    limit: String(limit),
    select: '*',
  };
  if (ownerId) query.owner_id = `eq.${Number(ownerId)}`;
  const rows = await select('strava_webhook_events', query);
  return Array.isArray(rows) ? rows : [];
}

export async function markEventProcessed(id, athleteCode) {
  return patch('strava_webhook_events', { id: `eq.${Number(id)}` }, {
    processed_at: new Date().toISOString(),
    athlete_code: athleteCode ? code(athleteCode) : null,
    last_error: null,
  });
}

export async function markEventFailed(id, attempts, error) {
  return patch('strava_webhook_events', { id: `eq.${Number(id)}` }, {
    attempts: Number(attempts || 0) + 1,
    last_error: String((error && error.message) || error || '').slice(0, 300),
  });
}
