/**
 * Supabase persistence for the Garmin integration.
 *
 * Tables (see supabase/migrations/20261105090000_garmin_connect.sql):
 *   garmin_connections   OAuth tokens, Garmin user id, granted permissions
 *   garmin_activities    Activity API summaries
 *   garmin_dailies       Health API daily summaries
 *   garmin_sleeps        Health API sleep summaries
 *   garmin_summaries     every other Garmin summary type, whole payload kept
 *                        (see GARMIN_TYPES in garmin-client.js)
 *   storage garmin-activity-files   the FIT/TCX/GPX file of each activity
 *
 * Every function runs with the service key. None of these tables grant anon
 * or authenticated, so this module is the only way the data is reachable and
 * api/garmin.js is its only caller.
 */
import { select, upsert, patch, remove, supabaseRequest, tablePath } from './supabase-rest.js';
import { ACTIVITY_FILE_TYPES, DEDICATED_KINDS, GARMIN_TYPES, NORMALISERS, normaliseSummary } from './garmin-client.js';
import { removeObjects, uploadObject } from './supabase-storage.js';

export const SUMMARIES_TABLE = 'garmin_summaries';
export const FILE_BUCKET = 'garmin-activity-files';

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
// PostgREST takes one JSON body per upsert. activityDetails carries per-second
// samples, so batches are cut by size as well as count.
const CHUNK_ROWS = 200;
const CHUNK_BYTES = 3 * 1024 * 1024;

function chunkRows(rows) {
  const chunks = [];
  let current = [], bytes = 0;
  for (const row of rows) {
    const size = JSON.stringify(row).length;
    if (current.length && (current.length >= CHUNK_ROWS || bytes + size > CHUNK_BYTES)) {
      chunks.push(current); current = []; bytes = 0;
    }
    current.push(row); bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function saveSummaries(athleteCode, kind, records) {
  const byKey = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const row = normaliseSummary(athleteCode, kind, record);
    if (row) byKey.set(row.summary_id, { ...row, received_at: new Date().toISOString() });
  }
  const rows = [...byKey.values()];
  for (const chunk of chunkRows(rows)) {
    await supabaseRequest(tablePath(SUMMARIES_TABLE, { on_conflict: 'athlete_code,summary_type,summary_id' }), {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: chunk,
    });
  }
  return { saved: rows.length };
}

export async function saveRecords(athleteCode, kind, records) {
  if (GARMIN_TYPES[kind] && !DEDICATED_KINDS.includes(kind) && kind !== 'activityFiles') {
    return saveSummaries(athleteCode, kind, records);
  }
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

  for (const chunk of chunkRows(rows)) {
    await supabaseRequest(tablePath(target.table, { on_conflict: target.conflict }), {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: chunk,
    });
  }
  return { saved: rows.length };
}

/**
 * Store one downloaded activity file and its row. The object path is keyed by
 * athlete so a purge can find every file without listing the bucket.
 */
export async function saveActivityFile(athleteCode, meta, bytes) {
  const fileType = String(meta.fileType || 'FIT').toUpperCase();
  const id = String(meta.summaryId || meta.activityId || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) return { saved: 0 };
  const path = `${code(athleteCode)}/${id}.${fileType.toLowerCase()}`;
  await uploadObject(FILE_BUCKET, path, bytes, ACTIVITY_FILE_TYPES[fileType] || 'application/octet-stream');
  const row = normaliseSummary(athleteCode, 'activityFiles', { ...meta, summaryId: id, storagePath: path, sizeBytes: bytes.length });
  if (!row) return { saved: 0 };
  await supabaseRequest(tablePath(SUMMARIES_TABLE, { on_conflict: 'athlete_code,summary_type,summary_id' }), {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: [{ ...row, received_at: new Date().toISOString() }],
  });
  return { saved: 1 };
}

async function deleteActivityFiles(athleteCode) {
  const rows = await select(SUMMARIES_TABLE, {
    athlete_code: `eq.${code(athleteCode)}`,
    summary_type: 'eq.activityFiles',
    select: 'summary',
  });
  const paths = (Array.isArray(rows) ? rows : []).map((row) => row.summary && row.summary.storagePath).filter(Boolean);
  for (let i = 0; i < paths.length; i += 100) await removeObjects(FILE_BUCKET, paths.slice(i, i + 100));
}

export async function deleteData(athleteCode, kinds = Object.keys(GARMIN_TYPES)) {
  const generic = [];
  for (const kind of kinds) {
    const target = DATA_TABLES[kind];
    if (target) await remove(target.table, { athlete_code: `eq.${code(athleteCode)}` });
    else if (GARMIN_TYPES[kind]) generic.push(kind);
  }
  // Files before their rows: the rows are how the files are found.
  if (generic.includes('activityFiles')) await deleteActivityFiles(athleteCode);
  if (generic.length) {
    await remove(SUMMARIES_TABLE, { athlete_code: `eq.${code(athleteCode)}`, summary_type: `in.(${generic.join(',')})` });
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
