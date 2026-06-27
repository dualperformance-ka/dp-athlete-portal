const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const ALLOWED_ENDPOINTS = [
  /^databases\/[a-f0-9-]+\/query$/i,
  /^pages\/[a-f0-9-]+$/i,
  /^pages$/i,
  /^blocks\/[a-f0-9-]+\/children$/i,
];

function getAllowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function setCorsHeaders(req, res) {
  const allowedOrigins = getAllowedOrigins();
  const requestOrigin = req.headers.origin;
  const fallbackOrigin = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : '';

  if (allowedOrigins.length === 0) {
    res.setHeader('Access-Control-Allow-Origin', fallbackOrigin || 'null');
  } else if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function isAllowedEndpoint(endpoint) {
  if (typeof endpoint !== 'string') return false;
  if (endpoint.includes('..') || endpoint.includes('?') || endpoint.includes('#')) {
    return false;
  }
  return ALLOWED_ENDPOINTS.some((pattern) => pattern.test(endpoint));
}

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

// Notion REST verbs depend on the endpoint:
//   databases/{id}/query   -> POST   (query)
//   pages                  -> POST   (create page)
//   pages/{id}             -> PATCH  (update page properties)  ← e.g. mark Status=Completed
//   blocks/{id}/children   -> PATCH  (append children)
// Previously every call used POST, so page-property updates (markSessionDone)
// always failed against Notion and piled up in coach_write_outbox.
function methodFor(endpoint) {
  if (/^pages\/[a-f0-9-]+$/i.test(endpoint)) return 'PATCH';
  if (/^blocks\/[a-f0-9-]+\/children$/i.test(endpoint)) return 'PATCH';
  return 'POST';
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return sendError(res, 405, 'Method not allowed');
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return sendError(res, 500, 'NOTION_TOKEN not set');
  }

  const { endpoint, body = {} } = req.body || {};

  if (!isAllowedEndpoint(endpoint)) {
    return sendError(res, 400, 'Notion endpoint is not allowed');
  }

  try {
    const response = await fetch(`${NOTION_API_BASE}/${endpoint}`, {
      method: methodFor(endpoint),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': NOTION_VERSION,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : {};

    return res.status(response.status).json(data);
  } catch (error) {
    return sendError(res, 500, 'Unable to reach Notion');
  }
}
