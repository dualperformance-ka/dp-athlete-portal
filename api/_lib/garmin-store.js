/**
 * Supabase persistence for the Garmin integration.
 *
 * Tables (see supabase/migrations/20261105090000_garmin_connect.sql):
 *   garmin_connections   OAuth tokens, Garmin user id, granted permissions
 *   garmin_activities    Activity API summaries
 *   garmin_dailies       Health API daily summaries
 *   garmin_sleeps        Health API sleep summaries
 *
 * Every function runs with the service key. None of these tables grant anon
 * or authenticated, so this module is the only way the data is reachable and
 * api/garmin.js is its only caller.
 */
import { select, upsert, patch, remove, supabaseRequest, tablePath } from './supabase-rest.js';
import { NORMALISERS } from './garmin-client.js';

export const DATA_TABLES = {
  activities: { table: 'garmin_activities', conflict: 'athlete_code,summary_id' },
  dailies: { table: 'garmin_dailies', conflict: 'athlete_code,calendar_date' },
  sleeps: { table: 'garmin_sleeps', conflict: 'athlete_code,calendar_date' },
};

function code(athleteCode) {
  return String(athleteCode || '').toUpperCase();
}

function first(rows) {
  return (Array.isArray(rows) && rows[0]) || null;
}

// ── Connections ──────────────────────────────────────────────────────────────

export async function getConnection(athleteCode) {
  return first(await select('garmin_connections', {
    athlete_code: `eq.${code(athleteCode)}`,
    select: '*',
    limit: '1',
  }));
}

export async function findConnectionByGarminUser(garminUserId) {
  const id = String(garminUserId || '').trim();
  if (!id) return null;
  return first(await select('garmin_connections', {
    garmin_user_id: `eq.${id}`,
    select: '*',
    limit: '1',
  }));
}

export async function saveConnection(athleteCode, values) {
  return first(await upsert('garmin_connections', {
    ...values,
    athlete_code: code(athleteCode),
    updated_at: new Date().toISOString(),
  }, 'athlete_code'));
}

export async function patchConnection(athleteCode, changes) {
  return first(await patch(
    'garmin_connections',
    { athlete_code: `eq.${code(athleteCode)}` },
    { ...changes, updated_at: new Date().toISOString() },
  ));
}

export async function deleteConnection(athleteCode) {
  return remove('garmin_connections', { athlete_code: `eq.${code(athleteCode)}` });
}

// ── Synced data ──────────────────────────────────────────────────────────────

/**
 * Upsert summaries of one kind for one athlete. Malformed summaries are dropped
 * by the normaliser rather than failing the batch. Records that share a key in
 * one batch (Garmin re-sending a day as it fills in) collapse to the last one,
 * because PostgREST rejects a single upsert that touches the same row twice.
 */
export async function saveRecords(athleteCode, kind, records) {
  const target = DATA_TABLES[kind];
  const normalise = NORMALISERS[kind];
  if (!target || !normalise) return { saved: 0 };

  const keyOf = kind === 'activities' ? (row) => row.summary_id : (row) => row.calendar_date;
  const byKey = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const row = normalise(athleteCode, record);
    if (row) byKey.set(keyOf(row), { ...row, received_at: new Date().toISOString() });
  }
  const rows = [...byKey.values()];
  if (!rows.length) return { saved: 0 };

  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await supabaseRequest(tablePath(target.table, { on_conflict: target.conflict }), {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: rows.slice(i, i + CHUNK),
    });
  }
  return { saved: rows.length };
}

export async function deleteData(athleteCode, kinds = Object.keys(DATA_TABLES)) {
  for (const kind of kinds) {
    const target = DATA_TABLES[kind];
    if (target) await remove(target.table, { athlete_code: `eq.${code(athleteCode)}` });
  }
}

/** Everything held for an athlete: data first, then the credential. */
export async function purgeAthlete(athleteCode) {
  await deleteData(athleteCode);
  await deleteConnection(athleteCode);
}

export async function listActivities(athleteCode, { limit = 60 } = {}) {
  const rows = await select('garmin_activities', {
    athlete_code: `eq.${code(athleteCode)}`,
    select: 'summary_id,activity_id,start_time,local_date,activity_type,name,duration_s,distance_m,active_kcal,avg_hr,max_hr,device_name,manual,received_at',
    order: 'start_time.desc',
    limit: String(limit),
  });
  return Array.isArray(rows) ? rows : [];
}

export async function latestDaily(athleteCode) {
  return first(await select('garmin_dailies', {
    athlete_code: `eq.${code(athleteCode)}`,
    select: 'calendar_date,active_kcal,bmr_kcal,steps,resting_hr,received_at',
    order: 'calendar_date.desc',
    limit: '1',
  }));
}
