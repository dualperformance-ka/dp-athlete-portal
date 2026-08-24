// Progress photos are stored in Cloudinary under a stable athlete/week/slot
// public ID. This keeps the athlete portal and coach dashboard on the same
// backend while the authenticated route prevents athletes accessing each
// other's photo inventory.
import crypto from 'node:crypto';
import { getRequestAthlete } from './_lib/auth.js';
import { allowPortalRequest, safeError } from './_lib/http.js';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const ALLOWED_SLOTS = new Set(['front', 'side', 'back', 'front_flexed', 'back_flexed']);

function send(res, status, payload) {
  return res.status(status).json(payload);
}

function cloudinaryConfig() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (cloudName && apiKey && apiSecret) return { cloudName, apiKey, apiSecret };

  const value = process.env.CLOUDINARY_URL;
  if (!value) throw new Error('Cloudinary credentials not configured');

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('CLOUDINARY_URL is invalid');
  }
  if (parsed.protocol !== 'cloudinary:' || !parsed.hostname || !parsed.username || !parsed.password) {
    throw new Error('CLOUDINARY_URL is invalid');
  }
  return {
    cloudName: parsed.hostname,
    apiKey: decodeURIComponent(parsed.username),
    apiSecret: decodeURIComponent(parsed.password),
  };
}

function cleanSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function cleanWeek(value) {
  const match = String(value || '').match(/\d+/);
  const number = match ? Math.max(1, Math.min(80, Number(match[0]))) : 1;
  return `week${number}`;
}

function cleanSlot(value) {
  const slot = cleanSlug(value || 'front');
  return ALLOWED_SLOTS.has(slot) ? slot : 'front';
}

function basicAuth(apiKey, apiSecret) {
  return `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`;
}

function signParams(params, apiSecret) {
  const payload = Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  return crypto.createHash('sha1').update(payload + apiSecret).digest('hex');
}

export function parseImageData(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([a-z0-9+/=]+)$/i);
  if (!match) throw new Error('Expected a jpeg, png, or webp data URL');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length) throw new Error('Image is empty');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Image is too large');
  const mimeType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  return { dataUrl: String(dataUrl), bytes, mimeType };
}

function normalizeResource(resource) {
  const parts = String(resource.public_id || '').split('/');
  const filename = parts.at(-1) || '';
  const week = parts.find((part) => /^week\d+$/i.test(part)) || '';
  const slot = filename.replace(/^.*?_week\d+_/i, '') || 'front';
  return {
    publicId: resource.public_id,
    secureUrl: resource.secure_url,
    createdAt: resource.created_at,
    week: week.toLowerCase(),
    slot: cleanSlot(slot),
    width: resource.width || null,
    height: resource.height || null,
  };
}

async function listPrefix(config, prefix) {
  const resources = [];
  let nextCursor = '';
  do {
    const url = new URL(`https://api.cloudinary.com/v1_1/${config.cloudName}/resources/image/upload`);
    url.searchParams.set('type', 'upload');
    url.searchParams.set('prefix', prefix);
    url.searchParams.set('max_results', '500');
    if (nextCursor) url.searchParams.set('next_cursor', nextCursor);
    const response = await fetch(url, {
      headers: { Authorization: basicAuth(config.apiKey, config.apiSecret) },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || 'Unable to list Cloudinary photos');
    resources.push(...(data.resources || []));
    nextCursor = String(data.next_cursor || '');
  } while (nextCursor);
  return resources;
}

async function listPhotos(config, athlete) {
  const prefixes = [`dp_progress/${athlete}/`, `dp_progress/${athlete.toUpperCase()}/`];
  const batches = await Promise.all(prefixes.map((prefix) => listPrefix(config, prefix)));
  const byPublicId = new Map(batches.flat().map((resource) => [resource.public_id, resource]));
  return [...byPublicId.values()]
    .map(normalizeResource)
    .sort((a, b) => a.week.localeCompare(b.week, undefined, { numeric: true }) || a.slot.localeCompare(b.slot));
}

async function uploadPhoto(config, athlete, payload) {
  const week = cleanWeek(payload.week);
  const slot = cleanSlot(payload.slot);
  const image = parseImageData(payload.imageData);
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `dp_progress/${athlete}/${week}/${athlete}_${week}_${slot}`;
  const tags = `dp_progress,${athlete},${week}`;
  const params = { overwrite: true, public_id: publicId, tags, timestamp };

  const form = new FormData();
  form.set('file', image.dataUrl);
  form.set('api_key', config.apiKey);
  form.set('timestamp', String(timestamp));
  form.set('public_id', publicId);
  form.set('overwrite', 'true');
  form.set('tags', tags);
  form.set('signature', signParams(params, config.apiSecret));

  const response = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/image/upload`, {
    method: 'POST',
    body: form,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || 'Unable to upload Cloudinary photo');
  return normalizeResource(data);
}

async function deletePhoto(config, athlete, payload) {
  const week = cleanWeek(payload.week);
  const slot = cleanSlot(payload.slot);
  const publicId = `dp_progress/${athlete}/${week}/${athlete}_${week}_${slot}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { public_id: publicId, timestamp };
  const form = new FormData();
  form.set('public_id', publicId);
  form.set('timestamp', String(timestamp));
  form.set('api_key', config.apiKey);
  form.set('signature', signParams(params, config.apiSecret));

  const response = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/image/destroy`, {
    method: 'POST',
    body: form,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || 'Unable to delete Cloudinary photo');
  return { deleted: data.result === 'ok' || data.result === 'not found', result: data.result };
}

export default async function handler(req, res) {
  if (!allowPortalRequest(req, res, 'POST, OPTIONS')) return;
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  try {
    const identity = await getRequestAthlete(req);
    if (!identity) return send(res, 401, { error: 'invalid_session' });
    const athlete = cleanSlug(identity.athlete.code);
    if (!athlete) return send(res, 400, { error: 'athleteCode is required' });
    const config = cloudinaryConfig();
    const body = req.body || {};
    const action = String(body.action || 'list');

    if (action === 'list') return send(res, 200, { photos: await listPhotos(config, athlete) });
    if (action === 'upload') return send(res, 201, { photo: await uploadPhoto(config, athlete, body) });
    if (action === 'delete') return send(res, 200, await deletePhoto(config, athlete, body));
    return send(res, 400, { error: 'Unknown action' });
  } catch (error) {
    const safe = safeError(error, 'Progress photo request failed');
    return send(res, safe.status, { error: safe.message });
  }
}
