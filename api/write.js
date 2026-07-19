// /api/write.js — Vercel serverless function  (dp-athlete-portal)
// -----------------------------------------------------------------------------
// Routed by a "type" field in the POSTed JSON payload.
//
// Handled types (payload.type):
//   "Run" | "Strength" | "training_log" -> 🏋️ Athlete Session Tracker (Notion)
//   "weekly_checkin"                     -> Supabase public.weekly_checkins  ← REPOINTED
//   "daily_body"                         -> 💪 Daily Athlete BODY Check-in (Notion)
//   "daily_nutrition"                    -> 🍽️ Daily Athlete NUTRITION Check-in (Notion)
//   "goals"                              -> updates the athlete's profile row (Notion)
//   "test_ping"                          -> ignored (returns ok)
//
// CHANGE (2026-07): Weekly check-ins now write DIRECTLY to Supabase
// (public.weekly_checkins) so the coaches dashboard sees them immediately and no
// longer depends on the nightly Notion→Supabase sync. Notion is written only as
// a best-effort backup during cutover and can be removed once confirmed.
//
// This file has NO npm dependencies (all Supabase calls use the PostgREST REST
// endpoint via fetch), so it works even though package.json doesn't declare
// @supabase/supabase-js.
//
// Env required: NOTION_TOKEN (Notion writes + best-effort backup).
// Env required for weekly check-ins: SUPABASE_URL, SUPABASE_SERVICE_KEY.
// Env required for GHL check-in tagging: SUPABASE_URL, SUPABASE_SERVICE_KEY, GHL_API_KEY.
// -----------------------------------------------------------------------------

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2022-06-28';

const SB_URL = process.env.SUPABASE_URL || 'https://rugdupplsswxmpoudhpv.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

// Database IDs (classic Notion API accepts the 32-char hyphenless form).
const DB = {
  athlete:   '4a25a96cc70b82ffa6790139eaa8b458', // Athlete DB (profile / goals target + relation source)
  training:  '1c55a96cc70b825b9bdf819abea4ef7c', // 🏋️ Athlete Session Tracker
  checkin:   '33e5a96cc70b8049b696d22e5920e0ee', // 🗓️ Weekly Check-in
  body:      '3405a96cc70b80a4b1b9cf5b9c236f18', // 💪 Daily Athlete BODY Check-in
  nutrition: '3405a96cc70b804baa9cf165f2d2e0e9', // 🍽️ Daily Athlete NUTRITION Check-in
};

// ── Notion REST helpers ────────────────────────────────────────────────────
async function notion(path, method, body) {
  const r = await fetch('https://api.notion.com/v1/' + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + NOTION_TOKEN,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (json && json.message) || ('Notion ' + r.status);
    throw new Error(msg);
  }
  return json;
}

// ── Property builders (only emit a property when the value is meaningful) ────
const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const rt   = (v) => has(v) ? { rich_text: [{ text: { content: String(v).slice(0, 2000) } }] } : null;
const title= (v) => ({ title: [{ text: { content: String(v == null ? '' : v).slice(0, 2000) } }] });
const num  = (v) => has(v) && !isNaN(Number(v)) ? { number: Number(v) } : null;
const sel  = (v) => has(v) ? { select: { name: String(v) } } : null;
const dat  = (v) => has(v) ? { date: { start: String(v) } } : null;

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const rel = (id) => (has(id) && UUID_RE.test(String(id).trim()))
  ? { relation: [{ id: String(id).trim() }] } : null;

// Assign only non-null properties.
function build(pairs) {
  const out = {};
  for (const [k, v] of pairs) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

function ddmmyyyy(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(iso || '');
}

async function createPage(databaseId, properties) {
  return notion('pages', 'POST', { parent: { database_id: databaseId }, properties });
}

// ── Supabase (PostgREST) helpers — no SDK required ──────────────────────────
const d10 = (v) => (v ? String(v).slice(0, 10) : '');
const nnum = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const txt = (v) => (has(v) ? String(v).slice(0, 4000) : null);

// Normalise the athlete code the same way api/sync-notion.js did, so a direct
// write upserts onto (and dedupes against) any historically synced row.
function canonCode(raw) {
  let v = String(raw || '').toUpperCase().trim().split('—')[0].split(' - ')[0].trim();
  if (!v) return '';
  if (v.startsWith('VINCENT') || v === 'VINO') return 'VINO';
  if (v.startsWith('THOMAS')) return 'THOMAS';
  if (v.startsWith('BRYAN')) return 'BRYAN';
  return v.split(/\s+/)[0].trim();
}

async function sbUpsertWeekly(row) {
  if (!SB_KEY) throw new Error('SUPABASE_SERVICE_KEY not configured');
  const url = `${SB_URL}/rest/v1/weekly_checkins?on_conflict=athlete_code,week_key`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify([row]),
  });
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`Supabase weekly upsert ${r.status}: ${JSON.stringify(json)}`);
  return Array.isArray(json) && json[0] ? json[0] : null;
}

// ── Per-type handlers ──────────────────────────────────────────────────────
async function handleTraining(p) {
  const name = p.name || [p.athleteName, p.session, p.date].filter(Boolean).join(' — ');
  const properties = build([
    ['Name', title(name)],
    ['Session', rt(p.session)],
    ['Session Category', sel(p.type)],
    ['Exercise Log', rt(p.exerciseLog)],
    ['Athlete Code', rt(p.athleteCode)],
    ['Date', dat(p.date)],
    ['Athlete', rel(p.athleteId)],
  ]);
  return createPage(DB.training, properties);
}

// Weekly check-in — Supabase is now the source of truth. We upsert straight
// into public.weekly_checkins so the dashboard sees the submission immediately.
// Notion is written only as a best-effort backup and never blocks the write.
async function handleCheckin(p) {
  const code = canonCode(p.athleteCode || p.athleteName || p.name);
  if (!code) throw new Error('weekly_checkin: missing athleteCode');
  const weekEnding = d10(p.weekEnding);
  if (!weekEnding) throw new Error('weekly_checkin: missing weekEnding');

  const nowIso = new Date().toISOString();
  const row = {
    athlete_code: code,
    athlete_name: p.athleteName || code,
    week_key: `week_ending_${weekEnding}`,
    week_ending: weekEnding,
    submitted_at: nowIso,
    run_completed: nnum(p.runCompleted),
    run_planned:   nnum(p.runPlanned),
    run_km:        nnum(p.runKm),
    run_feel:      nnum(p.runFeel),
    run_wins:      txt(p.runWins),
    run_niggles:   txt(p.runNiggles),
    lift_completed: nnum(p.liftCompleted),
    lift_planned:   nnum(p.liftPlanned),
    lift_feel:      nnum(p.liftFeel),
    lift_wins:      txt(p.liftWins),
    lift_niggles:   txt(p.liftNiggles),
    sleep:         txt(p.sleep),
    energy:        nnum(p.energy),
    soreness:      nnum(p.soreness),
    nutrition:     nnum(p.nutrition),
    fuelling:      txt(p.fuelling),
    social_eating: txt(p.socialEating),
    stress:        nnum(p.stress),
    motivation:    nnum(p.motivation),
    upcoming_impact: txt(p.upcomingImpact),
    testimonial:   txt(p.testimonial),
    raw_payload:   { source: 'portal', notion_name: p.name || null },
    updated_at:    nowIso,
  };

  const saved = await sbUpsertWeekly(row);

  // Best-effort Notion backup — safe to remove once the Supabase cutover is confirmed.
  try { if (NOTION_TOKEN) await handleCheckinNotion(p); }
  catch (e) { console.warn('[write] weekly Notion backup failed:', e && e.message); }

  return saved || { id: undefined };
}

async function handleCheckinNotion(p) {
  const name = p.name || (p.athleteName || '');
  const fullName = has(p.weekEnding) ? `${name} - ${ddmmyyyy(p.weekEnding)}` : name;
  const properties = build([
    ['Name', title(fullName)],
    ['Week Ending', rt(p.weekEnding)],
    ['Week Ending Date', dat(p.weekEnding)],
    ['Run Completed', rt(p.runCompleted)],
    ['Run Planned', rt(p.runPlanned)],
    ['Weekly Run KM', rt(p.runKm)],
    ['Run Feel /10', rt(p.runFeel)],
    ['Runs Wins', rt(p.runWins)],
    ['Run Niggles', rt(p.runNiggles)],
    ['Lift Completed', rt(p.liftCompleted)],
    ['Lift Planned', rt(p.liftPlanned)],
    ['Lift Feel /10', rt(p.liftFeel)],
    ['Lift Wins', rt(p.liftWins)],
    ['Lifts Niggles', rt(p.liftNiggles)],
    ['Sleep hrs', rt(p.sleep)],
    ['Energy /10', rt(p.energy)],
    ['Soreness /10', rt(p.soreness)],
    ['Nutrition Adherence /10', rt(p.nutrition)],
    ['Fuelling', rt(p.fuelling)],
    ['Upcoming Impact', rt(p.upcomingImpact)],
    ['Social Event Upcoming', rt(p.socialEating)],
    ['Stress', rt(p.stress)],
    ['Motivation', rt(p.motivation)],
    ['Testimonial', rt(p.testimonial)],
  ]);
  return createPage(DB.checkin, properties);
}

async function handleBody(p) {
  const properties = build([
    ['Name', title(`${p.athleteName || ''} — ${p.date || ''}`.trim())],
    ['AthleteID', rt(p.athleteName)],
    ['Weight', num(p.weight)],
    ['Date', dat(p.date)],
    ['Sleep Score', num(p.sleep)],
    ['Energy', num(p.energy)],
    ['Soreness', num(p.soreness)],
    ['Stress', num(p.stress)],
    ['Notes', rt(p.notes)],
  ]);
  return createPage(DB.body, properties);
}

async function handleNutrition(p) {
  const properties = build([
    ['Name', title(`${p.athleteName || ''} — ${p.date || ''}`.trim())],
    ['AthleteID', rt(p.athleteName)],
    ['Date', dat(p.date)],
    ['Calories', num(p.calories)],
    ['Protein', num(p.protein)],
    ['Carbs', num(p.carbs)],
    ['Fats', num(p.fat)],
    ['Fibre', num(p.fibre)],
    ['Notes', rt(p.notes)],
  ]);
  return createPage(DB.nutrition, properties);
}

async function handleGoals(p) {
  let pageId = (has(p.athleteId) && UUID_RE.test(String(p.athleteId).trim()))
    ? String(p.athleteId).trim() : '';

  if (!pageId) {
    if (!has(p.athleteCode)) throw new Error('goals: missing athleteId and athleteCode');
    const q = await notion(`databases/${DB.athlete}/query`, 'POST', {
      filter: { property: 'Code', rich_text: { equals: String(p.athleteCode) } },
      page_size: 1,
    });
    if (!q.results || !q.results.length) throw new Error('goals: athlete not found for code ' + p.athleteCode);
    pageId = q.results[0].id;
  }

  const properties = build([
    ['Goal Race', rt(p.goalRace)],
    ['Race Date', rt(p.raceDate)],
    ['Weekly KM Target', rt(p.peakWeek)],
    ['Body Weight (kg)', rt(p.weight)],
    ['Target Weight', rt(p.targetWeight)],
    ['Body Fat %', rt(p.bodyFat)],
    ['5km Time', rt(p.time5k)],
    ['10km Time', rt(p.time10k)],
    ['Half Marathon Time', rt(p.timeHalf)],
    ['Marathon Time', rt(p.timeMarathon)],
    ['Long Run Pace', rt(p.lrPace)],
    ['Your Why', rt(p.why)],
    ['Milestone W4', rt(p.m4)],
    ['Milestone W8', rt(p.m8)],
    ['Milestone W12', rt(p.m12)],
  ]);
  return notion(`pages/${pageId}`, 'PATCH', { properties });
}

// ── GHL check-in tagging (best-effort, no SDK) ──────────────────────────────
// Looks up the athlete's GHL contact via Supabase ghl_map (PostgREST) and adds
// the "checkin_done" tag. Any failure here must NOT block the check-in write.
async function tagGhlCheckinDone(athleteCode) {
  if (!has(athleteCode)) return;
  const GHL_API_KEY = process.env.GHL_API_KEY;
  if (!SB_URL || !SB_KEY || !GHL_API_KEY) {
    console.warn('[write] GHL tagging skipped — missing env vars');
    return;
  }

  const lookup = await fetch(
    `${SB_URL}/rest/v1/ghl_map?select=ghl_contact_id&athlete_code=eq.${encodeURIComponent(String(athleteCode))}&limit=1`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
  );
  const rows = await lookup.json().catch(() => []);
  const contactId = Array.isArray(rows) && rows[0] && rows[0].ghl_contact_id;
  if (!contactId) { console.warn('[write] no ghl_map row for code', athleteCode); return; }

  const resp = await fetch(
    `https://services.leadconnectorhq.com/contacts/${contactId}/tags`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        Version: '2021-07-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tags: ['checkin_done'] }),
    }
  );
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`GHL tag ${resp.status}: ${t}`);
  }
}

// ── Body parsing (robust to Vercel auto-parse or raw stream) ────────────────
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

// ── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  let p;
  try { p = await readBody(req); } catch { return res.status(400).json({ ok: false, error: 'Invalid JSON' }); }

  const type = String(p && p.type || '').trim();
  if (type === 'test_ping') return res.status(200).json({ ok: true, skipped: 'test_ping' });

  // Weekly check-ins write to Supabase; every other type still writes to Notion.
  if (type === 'weekly_checkin') {
    if (!SB_KEY) return res.status(500).json({ ok: false, error: 'SUPABASE_SERVICE_KEY not configured' });
  } else if (!NOTION_TOKEN) {
    return res.status(500).json({ ok: false, error: 'NOTION_TOKEN not configured' });
  }

  try {
    let result;
    switch (type) {
      case 'Run':
      case 'Strength':
      case 'training_log':
        result = await handleTraining(p); break;
      case 'weekly_checkin':
        result = await handleCheckin(p);
        try { await tagGhlCheckinDone(p.athleteCode); }
        catch (e) { console.warn('[write] GHL tag failed:', e && e.message); }
        break;
      case 'daily_body':
        result = await handleBody(p); break;
      case 'daily_nutrition':
        result = await handleNutrition(p); break;
      case 'goals':
        result = await handleGoals(p); break;
      default:
        return res.status(400).json({ ok: false, error: 'Unknown type: "' + type + '"' });
    }
    return res.status(200).json({ ok: true, type, id: result && result.id });
  } catch (err) {
    console.error('[write] type=' + type + ' error:', err && err.message);
    return res.status(502).json({ ok: false, type, error: (err && err.message) || 'Write failed' });
  }
}
