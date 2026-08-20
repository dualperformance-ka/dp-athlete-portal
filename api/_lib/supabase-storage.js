function storageEnv() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase service credentials not configured');
  return { url, key };
}

function encodedPath(value) {
  return String(value || '').split('/').map(encodeURIComponent).join('/');
}

async function storageRequest(path, options = {}) {
  const { url, key } = storageEnv();
  const response = await fetch(`${url}/storage/v1/${path}`, {
    method: options.method || 'GET',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(options.headers || {}),
    },
    body: options.body,
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error(data?.message || data?.error || `Supabase Storage ${response.status}`);
  return data;
}

export async function uploadObject(bucket, path, bytes, contentType) {
  return storageRequest(`object/${encodeURIComponent(bucket)}/${encodedPath(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, 'x-upsert': 'true', 'Cache-Control': '3600' },
    body: bytes,
  });
}

export async function removeObjects(bucket, paths) {
  return storageRequest(`object/${encodeURIComponent(bucket)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: paths }),
  });
}

export async function createSignedObjectUrl(bucket, path, expiresIn = 3600) {
  const data = await storageRequest(`object/sign/${encodeURIComponent(bucket)}/${encodedPath(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn }),
  });
  const { url } = storageEnv();
  const signed = data?.signedURL || data?.signedUrl || '';
  if (!signed) throw new Error('Supabase Storage did not return a signed URL');
  return signed.startsWith('http') ? signed : `${url}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`;
}
