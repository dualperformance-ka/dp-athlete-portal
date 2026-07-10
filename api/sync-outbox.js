import { patch, select } from './_lib/supabase-rest.js';

const ALLOWED_TARGETS = new Set(['/api/write', '/api/notion']);

function send(res, status, payload) {
  return res.status(status).json(payload);
}

function absoluteUrl(req, targetUrl) {
  if (!ALLOWED_TARGETS.has(targetUrl)) throw new Error('Target endpoint is not allowed');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}${targetUrl}`;
}

function nextAttempt(attempts) {
  const minutes = Math.min(240, Math.max(1, 2 ** Math.min(attempts, 7)));
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

async function postTarget(req, row) {
  const response = await fetch(absoluteUrl(req, row.target_url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(row.payload),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || data.message || `Coach write failed ${response.status}`);
  }
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return send(res, 405, { ok: false, error: 'Method not allowed' });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token !== cronSecret) return send(res, 401, { ok: false, error: 'Unauthorized' });
  }

  const limit = Math.max(1, Math.min(25, Number(req.query?.limit || 10)));
  let rows;
  try {
    rows = await select('coach_write_outbox', {
      status: 'eq.pending',
      next_attempt_at: `lte.${new Date().toISOString()}`,
      order: 'created_at.asc',
      limit: String(limit),
    });
  } catch (error) {
    return send(res, 502, { ok: false, stage: 'load', error: error.message });
  }

  let synced = 0;
  const failed = [];

  for (const row of rows || []) {
    const now = new Date().toISOString();
    try {
      await patch('coach_write_outbox', { id: `eq.${row.id}` }, { status: 'processing', updated_at: now });
      await postTarget(req, row);
      await patch('coach_write_outbox', { id: `eq.${row.id}` }, {
        status: 'synced',
        synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      synced++;
    } catch (error) {
      const attempts = Number(row.attempts || 0) + 1;
      await patch('coach_write_outbox', { id: `eq.${row.id}` }, {
        status: attempts >= 10 ? 'failed' : 'pending',
        attempts,
        last_error: String(error.message || error).slice(0, 2000),
        next_attempt_at: nextAttempt(attempts),
        updated_at: new Date().toISOString(),
      });
      failed.push({ id: row.id, error: error.message });
    }
  }

  return send(res, 200, { ok: true, scanned: (rows || []).length, synced, failed });
}
