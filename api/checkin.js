const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function send(res, status, payload) {
  return res.status(status).json(payload);
}

function getAllowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function setCorsHeaders(req, res) {
  const allowedOrigins = getAllowedOrigins();
  const requestOrigin = req.headers.origin;
  const fallbackOrigin = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '';

  if (allowedOrigins.length === 0) {
    res.setHeader('Access-Control-Allow-Origin', fallbackOrigin || 'null');
  } else if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function cleanText(value, maxLength = 800) {
  if (value == null) return '';
  return String(value).trim().slice(0, maxLength);
}

function cleanNumber(value, min = 1, max = 10) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function richText(content) {
  return { rich_text: [{ text: { content: cleanText(content, 1800) } }] };
}

function numberProp(value) {
  return value == null ? undefined : { number: value };
}

function selectProp(value) {
  return value ? { select: { name: value } } : undefined;
}

function buildAlertLevel({ energy, soreness, painFlag, motivation }) {
  if (painFlag) return 'Coach Review';
  if ((energy != null && energy <= 3) || (motivation != null && motivation <= 3)) return 'Watch';
  if (soreness != null && soreness >= 8) return 'Watch';
  return 'Normal';
}

function compactProperties(properties) {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));
}

async function createNotionPage(token, databaseId, properties) {
  const response = await fetch(`${NOTION_API_BASE}/pages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_VERSION,
    },
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties,
    }),
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const message = data.message || 'Unable to save check-in';
    throw new Error(message);
  }

  return data;
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  const token = process.env.NOTION_TOKEN;
  const databaseId = process.env.CHECKIN_DATABASE_ID;

  if (!token) return send(res, 500, { error: 'NOTION_TOKEN not set' });
  if (!databaseId) return send(res, 500, { error: 'CHECKIN_DATABASE_ID not set' });

  const payload = req.body || {};
  const athleteCode = cleanText(payload.athleteCode, 80);
  const athleteName = cleanText(payload.athleteName, 120) || athleteCode || 'Athlete';
  const energy = cleanNumber(payload.energy);
  const sleep = cleanNumber(payload.sleep);
  const soreness = cleanNumber(payload.soreness);
  const motivation = cleanNumber(payload.motivation);
  const rpe = cleanNumber(payload.rpe);
  const painFlag = Boolean(payload.painFlag);
  const notes = cleanText(payload.notes, 1400);
  const sessionTitle = cleanText(payload.sessionTitle, 180);
  const alertLevel = buildAlertLevel({ energy, soreness, painFlag, motivation });

  if (!athleteCode) {
    return send(res, 400, { error: 'athleteCode is required' });
  }

  const properties = compactProperties({
    Name: {
      title: [{ text: { content: `${athleteName} check-in` } }],
    },
    'Athlete Code': richText(athleteCode),
    Athlete: richText(athleteName),
    Date: { date: { start: new Date().toISOString() } },
    Session: sessionTitle ? richText(sessionTitle) : undefined,
    Energy: numberProp(energy),
    Sleep: numberProp(sleep),
    Soreness: numberProp(soreness),
    Motivation: numberProp(motivation),
    RPE: numberProp(rpe),
    Pain: { checkbox: painFlag },
    Notes: notes ? richText(notes) : undefined,
    'Coach Alert': selectProp(alertLevel),
  });

  try {
    const page = await createNotionPage(token, databaseId, properties);
    return send(res, 201, {
      ok: true,
      id: page.id,
      alertLevel,
      coachReview: alertLevel === 'Coach Review',
    });
  } catch (error) {
    return send(res, 500, { error: error.message });
  }
}
