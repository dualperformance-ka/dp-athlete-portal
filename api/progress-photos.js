// Private progress-photo storage. Image bytes live in Supabase Storage and
// queryable metadata lives in Postgres; the browser only receives short-lived
// signed URLs through this authenticated athlete-scoped route.
import { getRequestAthlete } from './_lib/auth.js';
import { allowPortalRequest, safeError } from './_lib/http.js';
import { remove, select, upsert } from './_lib/supabase-rest.js';
import { createSignedObjectUrl, removeObjects, uploadObject } from './_lib/supabase-storage.js';

const BUCKET = 'progress-photos';
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const ALLOWED_SLOTS = new Set(['front', 'side', 'back', 'front_flexed', 'back_flexed']);
const LEGACY_MIGRATION_KEY = '_progress_photos_migrated_v1';

function send(res, status, payload) {
  return res.status(status).json(payload);
}

function cleanCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, '_').slice(0, 80);
}

function weekNumber(value) {
  const match = String(value || '').match(/\d+/);
  return match ? Math.max(1, Math.min(80, Number(match[0]))) : 1;
}

function cleanSlot(value) {
  const slot = String(value || 'front').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  return ALLOWED_SLOTS.has(slot) ? slot : 'front';
}

export function parseImageData(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([a-z0-9+/=]+)$/i);
  if (!match) throw new Error('Expected a jpeg, png, or webp data URL');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length) throw new Error('Image is empty');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Image is too large');
  const mimeType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  return { bytes, mimeType };
}

// One-time compatibility bridge for photos stored before Supabase Storage was
// adopted. On the athlete's first list request, copy the old Cloudinary objects
// into the private bucket and write their metadata. All subsequent recall and
// every new mutation use Supabase only; the legacy source can then be removed.
function legacyCloudinaryConfig() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  return cloudName && apiKey && apiSecret ? { cloudName, apiKey, apiSecret } : null;
}

async function migrateLegacyPhotos(code) {
  const config = legacyCloudinaryConfig();
  if (!config) return { complete: false, found: 0, migrated: 0 };
  const all = new Map();
  let complete = true;
  for (const candidate of [code.toLowerCase(), code.toUpperCase()]) {
    const url = new URL(`https://api.cloudinary.com/v1_1/${config.cloudName}/resources/image/upload`);
    url.searchParams.set('type', 'upload');
    url.searchParams.set('prefix', `dp_progress/${candidate}/`);
    url.searchParams.set('max_results', '100');
    const response = await fetch(url, {
      headers: { Authorization: `Basic ${Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString('base64')}` },
    });
    if (!response.ok) { complete = false; continue; }
    const data = await response.json();
    for (const resource of data.resources || []) all.set(resource.public_id, resource);
  }

  const resources = [...all.values()];
  let migrated = 0;
  for (let offset = 0; offset < resources.length; offset += 4) {
    await Promise.all(resources.slice(offset, offset + 4).map(async (resource) => {
      try {
        const publicId = String(resource.public_id || '');
        const weekMatch = publicId.match(/\/week(\d+)\//i);
        const slotMatch = publicId.match(/_week\d+_(front_flexed|back_flexed|front|side|back)$/i);
        if (!weekMatch || !slotMatch || !resource.secure_url) return;
        const week = weekNumber(weekMatch[1]);
        const slot = cleanSlot(slotMatch[1]);
        const response = await fetch(resource.secure_url);
        if (!response.ok) { complete = false; return; }
        const bytes = Buffer.from(await response.arrayBuffer());
        const mimeType = String(response.headers.get('content-type') || resource.format && `image/${resource.format}` || 'image/jpeg').split(';')[0];
        if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || !['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) return;
        const storagePath = `${code.toLowerCase()}/week${week}/${slot}`;
        await uploadObject(BUCKET, storagePath, bytes, mimeType);
        await upsert('progress_photos', {
          athlete_code: code, week_number: week, slot, storage_path: storagePath,
          mime_type: mimeType, size_bytes: bytes.length,
          width: resource.width || null, height: resource.height || null,
          created_at: resource.created_at || new Date().toISOString(), updated_at: new Date().toISOString(),
        }, 'athlete_code,week_number,slot');
        migrated++;
      } catch {
        // A single corrupt or temporarily unavailable legacy object must not
        // take the athlete's gallery down. Leave the marker unset and retry it
        // on the next recall.
        complete = false;
      }
    }));
  }
  return { complete, found: resources.length, migrated };
}

async function normalizePhoto(row) {
  return {
    publicId: row.storage_path,
    secureUrl: await createSignedObjectUrl(BUCKET, row.storage_path, 3600),
    createdAt: row.created_at,
    week: `week${row.week_number}`,
    slot: row.slot,
    width: row.width || null,
    height: row.height || null,
  };
}

async function listPhotos(code) {
  const query = {
    athlete_code: `eq.${code}`, select: 'storage_path,week_number,slot,mime_type,size_bytes,width,height,created_at,updated_at',
    order: 'week_number.asc,slot.asc', limit: '500',
  };
  let rows = await select('progress_photos', query);
  const marker = await select('athlete_data', {
    athlete_code: `eq.${code}`, key: `eq.${LEGACY_MIGRATION_KEY}`, select: 'key', limit: '1',
  });
  if (!marker?.length) {
    const result = await migrateLegacyPhotos(code);
    if (result.complete) {
      await upsert('athlete_data', {
        athlete_code: code, key: LEGACY_MIGRATION_KEY,
        value: { found: result.found, migrated: result.migrated, completedAt: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      }, 'athlete_code,key');
    }
    if (result.migrated) rows = await select('progress_photos', query);
  }
  return Promise.all((Array.isArray(rows) ? rows : []).map(normalizePhoto));
}

async function uploadPhoto(code, payload) {
  const week = weekNumber(payload.week);
  const slot = cleanSlot(payload.slot);
  const image = parseImageData(payload.imageData);
  const storagePath = `${code.toLowerCase()}/week${week}/${slot}`;
  await uploadObject(BUCKET, storagePath, image.bytes, image.mimeType);
  const rows = await upsert('progress_photos', {
    athlete_code: code,
    week_number: week,
    slot,
    storage_path: storagePath,
    mime_type: image.mimeType,
    size_bytes: image.bytes.length,
    updated_at: new Date().toISOString(),
  }, 'athlete_code,week_number,slot');
  return normalizePhoto(rows[0]);
}

async function deletePhoto(code, payload) {
  const week = weekNumber(payload.week);
  const slot = cleanSlot(payload.slot);
  const rows = await select('progress_photos', {
    athlete_code: `eq.${code}`, week_number: `eq.${week}`, slot: `eq.${slot}`,
    select: 'storage_path', limit: '1',
  });
  const storagePath = rows?.[0]?.storage_path || `${code.toLowerCase()}/week${week}/${slot}`;
  await removeObjects(BUCKET, [storagePath]);
  await remove('progress_photos', { athlete_code: `eq.${code}`, week_number: `eq.${week}`, slot: `eq.${slot}` });
  return { deleted: true };
}

export default async function handler(req, res) {
  if (!allowPortalRequest(req, res, 'POST, OPTIONS')) return;
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  try {
    const identity = await getRequestAthlete(req);
    if (!identity) return send(res, 401, { error: 'invalid_session' });
    const code = cleanCode(identity.athlete.code);
    if (!code) return send(res, 400, { error: 'athleteCode is required' });
    const body = req.body || {};
    const action = String(body.action || 'list');
    if (action === 'list') return send(res, 200, { photos: await listPhotos(code) });
    if (action === 'upload') return send(res, 201, { photo: await uploadPhoto(code, body) });
    if (action === 'delete') return send(res, 200, await deletePhoto(code, body));
    return send(res, 400, { error: 'Unknown action' });
  } catch (error) {
    const safe = safeError(error, 'Progress photo request failed');
    return send(res, safe.status, { error: safe.message });
  }
}
