import { insert, upsert } from './lib/supabase-rest.js';

const ALLOWED_TARGETS = new Set(['/api/write', '/api/notion']);

function send(res, status, payload) {
  return res.status(status).json(payload);
}

function has(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function text(value, max = 2000) {
  return has(value) ? String(value).trim().slice(0, max) : null;
}

function number(value) {
  if (!has(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function date(value) {
  const v = text(value, 40);
  return /^\d{4}-\d{2}-\d{2}/.test(v || '') ? v.slice(0, 10) : null;
}

function submittedAt(payload) {
  return text(payload.submittedAt || payload.savedAt, 80) || new Date().toISOString();
}

function athleteCode(payload) {
  return text(payload.athleteCode, 120);
}


const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2022-06-28';
const ATHLETE_DB_ID = '4a25a96cc70b82ffa6790139eaa8b458';

function normaliseId(value) {
  return String(value || '').replace(/-/g, '').trim().toLowerCase();
}

function notionPlainText(property) {
  if (!property) return '';

  if (property.type === 'title') {
    return (property.title || [])
      .map(item => item.plain_text || item.text?.content || '')
      .join('')
      .trim();
  }

  if (property.type === 'rich_text') {
    return (property.rich_text || [])
      .map(item => item.plain_text || item.text?.content || '')
      .join('')
      .trim();
  }

  return '';
}

async function notionIdentityRequest(path, method = 'GET', body) {
  if (!NOTION_TOKEN) {
    throw new Error('NOTION_TOKEN is required for athlete identity verification');
  }

  const response = await fetch(`https://api.notion.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.message ||
      `Athlete identity lookup failed with HTTP ${response.status}`
    );
  }

  return data;
}

async function findAthleteProfile(payload) {
  const suppliedPageId = text(payload.athleteId, 120);
  const suppliedCode = text(payload.athleteCode, 120)?.toUpperCase();

  if (suppliedPageId) {
    const page = await notionIdentityRequest(`pages/${suppliedPageId}`);

    if (
      page.parent?.type !== 'database_id' ||
      normaliseId(page.parent.database_id) !== normaliseId(ATHLETE_DB_ID)
    ) {
      throw new Error('The supplied athlete profile does not belong to the Athlete DB');
    }

    return page;
  }

  if (!suppliedCode) {
    throw new Error('athleteId or athleteCode is required');
  }

  const result = await notionIdentityRequest(
    `databases/${ATHLETE_DB_ID}/query`,
    'POST',
    {
      filter: {
        property: 'Code',
        rich_text: { equals: suppliedCode },
      },
      page_size: 2,
    }
  );

  if (!Array.isArray(result.results) || result.results.length !== 1) {
    throw new Error(`Unable to uniquely resolve athlete code ${suppliedCode}`);
  }

  return result.results[0];
}

async function resolveAthleteIdentity(payload) {
  const page = await findAthleteProfile(payload);
  const properties = page.properties || {};

  const resolvedCode = notionPlainText(properties.Code).toUpperCase().trim();
  const resolvedName = (
    notionPlainText(properties.Name) ||
    notionPlainText(properties.Athlete) ||
    resolvedCode
  ).trim();

  if (!resolvedCode) {
    throw new Error('The athlete profile has no Code value');
  }

  const suppliedCode = text(payload.athleteCode, 120)?.toUpperCase();

  if (suppliedCode && suppliedCode !== resolvedCode) {
    throw new Error(
      `Athlete identity mismatch: submitted ${suppliedCode}, profile resolves to ${resolvedCode}`
    );
  }

  return {
    ...payload,
    athleteId: page.id,
    athleteCode: resolvedCode,
    athleteName: resolvedName,
  };
}


function weekKey(payload) {
  if (payload.weekKey) return text(payload.weekKey, 80);
  if (payload.weekEnding) return `week_ending_${date(payload.weekEnding) || text(payload.weekEnding, 40)}`;
  return payload.clientWriteId || null;
}

async function persistStructured(payload) {
  const type = text(payload.type, 80);
  const code = athleteCode(payload);
  if (!code) return null;

  if (type === 'goals') {
    return upsert('athlete_goals', {
      athlete_code: code,
      athlete_name: text(payload.athleteName, 180),
      athlete_notion_id: text(payload.athleteId, 120),
      submitted_at: submittedAt(payload),
      goal_race: text(payload.goalRace, 240),
      race_date: date(payload.raceDate),
      peak_week: text(payload.peakWeek, 80),
      start_weight: number(payload.startWeight || payload.weight),
      target_weight: number(payload.targetWeight),
      body_fat: text(payload.bodyFat, 80),
      time_5k: text(payload.time5k, 80),
      time_10k: text(payload.time10k, 80),
      time_half: text(payload.timeHalf, 80),
      time_marathon: text(payload.timeMarathon, 80),
      long_run_pace: text(payload.lrPace, 80),
      why: text(payload.why, 2000),
      milestone_w4: text(payload.m4, 1000),
      milestone_w8: text(payload.m8, 1000),
      milestone_w12: text(payload.m12, 1000),
      raw_payload: payload,
      updated_at: new Date().toISOString(),
    }, 'athlete_code');
  }

  if (type === 'weekly_checkin') {
    return upsert('weekly_checkins', {
      athlete_code: code,
      athlete_name: text(payload.athleteName, 180),
      athlete_notion_id: text(payload.athleteId, 120),
      week_key: weekKey(payload),
      week_ending: date(payload.weekEnding),
      submitted_at: submittedAt(payload),
      run_completed: number(payload.runCompleted),
      run_planned: number(payload.runPlanned),
      run_km: number(payload.runKm),
      run_feel: number(payload.runFeel),
      run_wins: text(payload.runWins, 2000),
      run_niggles: text(payload.runNiggles, 2000),
      lift_completed: number(payload.liftCompleted),
      lift_planned: number(payload.liftPlanned),
      lift_feel: number(payload.liftFeel),
      lift_wins: text(payload.liftWins, 2000),
      lift_niggles: text(payload.liftNiggles, 2000),
      sleep: text(payload.sleep, 80),
      energy: number(payload.energy),
      soreness: number(payload.soreness),
      nutrition: number(payload.nutrition),
      fuelling: text(payload.fuelling, 1000),
      social_eating: text(payload.socialEating, 1000),
      stress: number(payload.stress),
      motivation: number(payload.motivation),
      upcoming_impact: text(payload.upcomingImpact, 2000),
      testimonial: text(payload.testimonial, 2000),
      raw_payload: payload,
      updated_at: new Date().toISOString(),
    }, 'athlete_code,week_key');
  }

  if (type === 'daily_body') {
    return upsert('daily_body_logs', {
      athlete_code: code,
      athlete_name: text(payload.athleteName, 180),
      athlete_notion_id: text(payload.athleteId, 120),
      log_date: date(payload.date) || new Date().toISOString().slice(0, 10),
      submitted_at: submittedAt(payload),
      weight: number(payload.weight),
      sleep: number(payload.sleep),
      energy: number(payload.energy),
      soreness: number(payload.soreness),
      stress: number(payload.stress),
      notes: text(payload.notes, 2000),
      raw_payload: payload,
      updated_at: new Date().toISOString(),
    }, 'athlete_code,log_date');
  }

  if (type === 'daily_nutrition') {
    return upsert('daily_nutrition_logs', {
      athlete_code: code,
      athlete_name: text(payload.athleteName, 180),
      athlete_notion_id: text(payload.athleteId, 120),
      log_date: date(payload.date) || new Date().toISOString().slice(0, 10),
      submitted_at: submittedAt(payload),
      calories: number(payload.calories),
      protein: number(payload.protein),
      carbs: number(payload.carbs),
      fat: number(payload.fat),
      fibre: number(payload.fibre),
      notes: text(payload.notes, 2000),
      raw_payload: payload,
      updated_at: new Date().toISOString(),
    }, 'athlete_code,log_date');
  }

  if (type === 'Run' || type === 'Strength' || type === 'training_log') {
    return upsert('training_session_logs', {
      client_write_id: text(payload.clientWriteId, 120),
      athlete_code: code,
      athlete_name: text(payload.athleteName, 180),
      athlete_notion_id: text(payload.athleteId, 120),
      session_name: text(payload.session, 240),
      session_category: text(payload.type, 80),
      session_date: date(payload.date),
      exercise_log: text(payload.exerciseLog, 2000),
      notes: text(payload.notes, 2000),
      raw_payload: payload,
      submitted_at: submittedAt(payload),
      updated_at: new Date().toISOString(),
    }, 'client_write_id');
  }

  return null;
}

async function queueOutbox(targetUrl, payload, error) {
  const now = new Date().toISOString();
  const clientWriteId = text(payload.clientWriteId, 120) || `server_${Date.now()}`;
  const row = {
    client_write_id: clientWriteId,
    athlete_code: athleteCode(payload),
    target_url: targetUrl,
    payload,
    status: 'pending',
    attempts: 0,
    last_error: text(error?.message || error || 'Write failed', 2000),
    next_attempt_at: now,
    updated_at: now,
  };
  return upsert('coach_write_outbox', row, 'client_write_id');
}

function absoluteUrl(req, targetUrl) {
  if (!ALLOWED_TARGETS.has(targetUrl)) throw new Error('Target endpoint is not allowed');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}${targetUrl}`;
}

async function postCoachWrite(req, targetUrl, payload) {
  const response = await fetch(absoluteUrl(req, targetUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const textBody = await response.text();
  const data = textBody ? JSON.parse(textBody) : {};
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || data.message || `Coach write failed ${response.status}`);
  }
  return data;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });

  const body = req.body || {};
  const targetUrl = text(body.targetUrl, 80);
  let payload = body.payload || {};

  if (!targetUrl || !ALLOWED_TARGETS.has(targetUrl)) {
    return send(res, 400, { ok: false, error: 'Invalid targetUrl' });
  }

  if (!athleteCode(payload) && targetUrl !== '/api/notion') {
    return send(res, 400, { ok: false, error: 'athleteCode is required' });
  }

  try {
    if (targetUrl === '/api/write') {
      payload = await resolveAthleteIdentity(payload);
    }
  } catch (error) {
    return send(res, 409, {
      ok: false,
      stage: 'identity',
      error: error.message,
    });
  }

  try {
    await persistStructured(payload);
  } catch (error) {
    return send(res, 502, { ok: false, stage: 'supabase', error: error.message });
  }

  try {
    const coach = await postCoachWrite(req, targetUrl, payload);
    return send(res, 200, { ok: true, queued: false, coach });
  } catch (error) {
    try {
      await queueOutbox(targetUrl, payload, error);
    } catch (queueError) {
      return send(res, 502, { ok: false, stage: 'outbox', error: queueError.message, coachError: error.message });
    }
    return send(res, 202, { ok: true, queued: true, error: error.message });
  }
}
