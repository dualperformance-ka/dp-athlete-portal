// Authenticated athlete data gateway.
//
// `/api/portal-data` rewrites here with `?mode=portal`. The historic `/api/write`
// endpoint is intentionally retired and returns 410 so old unauthenticated
// Notion writes cannot be revived accidentally.

import { remove, select, upsert } from './_lib/supabase-rest.js';
import { bearerToken, getRequestAthlete } from './_lib/auth.js';
import { allowPortalRequest, safeError } from './_lib/http.js';
import { dispatchCoachAction, isCoachAction, resolveCoachMode } from './_lib/coach-proxy.js';
import { syncBookingsForAthlete } from './bookings.js';
import crypto from 'node:crypto';

const ALLOWED_STATE_KEYS = [
  /^goals$/,
  /^logs$/,
  /^ticked$/,
  /^reschedules$/,
  /^photos$/,
  /^ex_picks$/,
  /^strength_rpe_enabled$/,
  /^pending_writes$/,
  /^strava_ack$/,
  /^strava_match_rejections$/,
  // ISO week keys ("call_booked_2026_31") — the format the portal, the GHL
  // webhook and the backlog sync all write. The old date form is kept so any
  // historic row still round-trips.
  /^call_booked_\d{4}_\d{2}$/,
  /^call_booked_\d{4}-\d{2}-\d{2}$/,
  /^checkin_[a-z0-9_-]{1,80}$/i,
  /^daily_body_\d{4}-\d{2}-\d{2}$/,
  /^daily_nut_\d{4}-\d{2}-\d{2}$/,
];

function send(res, status, payload) {
  return res.status(status).json(payload);
}

function text(value, max = 100) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function date(value) {
  const candidate = text(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

function weekLabel(value) {
  const candidate = text(value, 30);
  return /^Week \d{1,2}$/i.test(candidate) ? candidate : null;
}

function safeStateKey(value) {
  const key = text(value, 120);
  return ALLOWED_STATE_KEYS.some((pattern) => pattern.test(key)) ? key : null;
}

const COACH_TARGET_SPORTS = new Set(['running', 'cycling', 'swimming']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function optionalWholeNumber(value, field) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw requestError(`Invalid ${field}`, 502);
  return parsed;
}

export function normalisePublishedCoachTarget(row) {
  const sport = String(row?.sport || '').toLowerCase();
  const weekIdentifier = String(row?.weekIdentifier || '');
  if (!COACH_TARGET_SPORTS.has(sport)) throw requestError('Invalid coach target sport', 502);
  if (!UUID_PATTERN.test(weekIdentifier)) throw requestError('Invalid coach target programme week', 502);
  // Row presence is the authority. The flags are still validated so a broken
  // dashboard contract fails closed instead of accidentally exposing future
  // athlete editing controls.
  if (row?.source !== 'coach' || row?.locked !== true) throw requestError('Invalid coach target lock', 502);
  const distanceTargetMetres = optionalWholeNumber(row.distanceTargetMetres, 'coach distance target');
  if (distanceTargetMetres === null) throw requestError('Coach distance target is required', 502);
  return {
    sport,
    weekIdentifier,
    distanceTargetMetres,
    sessionTarget: optionalWholeNumber(row.sessionTarget, 'coach session target'),
    durationTargetMinutes: optionalWholeNumber(row.durationTargetMinutes, 'coach duration target'),
    coachNote: text(row.coachNote, 2000) || null,
    source: 'coach',
    locked: true,
    publishedAt: row.publishedAt || null,
    updatedAt: row.updatedAt || null,
  };
}

export async function weeklySportTargetsRead(req, fetchImpl = fetch) {
  const token = bearerToken(req);
  if (!token) throw requestError('invalid_session', 401);
  const base = String(process.env.COACHES_API_BASE || process.env.COACH_API_URL || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw requestError('Coach target service is not configured', 503);
  let response;
  try {
    response = await fetchImpl(`${base}/api/my-logs?resource=weekly-sport-targets`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Cache-Control': 'no-store',
      },
      cache: 'no-store',
    });
  } catch {
    throw requestError('Coach targets are temporarily unavailable', 502);
  }
  let payload = {};
  try { payload = await response.json(); } catch { payload = {}; }
  if (response.status === 401) throw requestError('invalid_session', 401);
  if (!response.ok || payload.ok !== true || !Array.isArray(payload.targets)) {
    throw requestError('Coach targets are temporarily unavailable', 502);
  }
  return { targets: payload.targets.map(normalisePublishedCoachTarget) };
}

function assertValueSize(value) {
  let encoded = '';
  try {
    encoded = JSON.stringify(value);
  } catch {
    const error = new Error('State value must be valid JSON');
    error.status = 400;
    throw error;
  }
  if (encoded.length > 750_000) {
    const error = new Error('State value is too large');
    error.status = 413;
    throw error;
  }
}

export async function stateRead(code, selectRows = select) {
  const [stateRows, checkins] = await Promise.all([
    selectRows('athlete_data', {
      athlete_code: `eq.${code}`,
      key: 'neq.strava_tokens',
      select: 'key,value,updated_at',
      order: 'updated_at.asc',
      limit: '1000',
    }),
    // weekly_checkins is the coach-facing source of truth. Returning its
    // completion dates prevents a stale athlete_data cache flag from hiding a
    // form that was never actually submitted.
    selectRows('weekly_checkins', {
      athlete_code: `eq.${code}`,
      select: 'week_key,week_ending,submitted_at',
      order: 'submitted_at.desc',
      limit: '100',
    }),
  ]);
  const rows = (Array.isArray(stateRows) ? stateRows : [])
    .filter((row) => !String(row.key || '').startsWith('checkin_'));
  return { rows, checkins: Array.isArray(checkins) ? checkins : [] };
}

async function stateWrite(code, body) {
  const key = safeStateKey(body.key);
  if (!key) {
    const error = new Error('State key is not writable');
    error.status = 400;
    throw error;
  }
  assertValueSize(body.value);
  await upsert('athlete_data', {
    athlete_code: code,
    key,
    value: body.value,
    updated_at: new Date().toISOString(),
  }, 'athlete_code,key');
  return { key, synced_at: new Date().toISOString() };
}

// The client keys every session by `notion_page_id || id` (see
// loadPlannedSessions in js/01-core.js) — logs, drafts and reschedules all hang
// off that key. Prescriptions must be keyed identically or nothing lines up.
function sessionKey(row) {
  return row.notion_page_id || row.id;
}

function joinReps(exercise) {
  const min = exercise.rep_min;
  const max = exercise.rep_max;
  if (min == null && max == null) return '';
  if (min != null && max != null && max !== min) return `${min}-${max}`;
  return String(min != null ? min : max);
}

// One compact line describing everything the legacy split shape has no room
// for: superset grouping, tempo, RPE/RIR target and load. Rendered by the
// exercise card underneath the athlete note.
function prescriptionLine(exercise) {
  const parts = [];
  if (exercise.superset_group) parts.push(`Superset ${exercise.superset_group}`);
  if (exercise.circuit_group) parts.push(`Circuit ${exercise.circuit_group}`);
  if (exercise.tempo) parts.push(`Tempo ${exercise.tempo}`);
  if (exercise.rpe != null) parts.push(`RPE ${exercise.rpe}`);
  if (exercise.rir != null) parts.push(`RIR ${exercise.rir}`);
  if (exercise.percent_1rm != null) parts.push(`${exercise.percent_1rm}% 1RM`);
  else if (exercise.target_load != null) parts.push(`${exercise.target_load} kg`);
  return parts.join(' · ');
}

// Serialise a session_exercises row into EXACTLY the object shape the portal
// already uses for workout_splits entries. Every strength screen — rendering,
// set logging, progression, swaps, PB detection, muscle coverage — reads that
// shape through getSplit(), so matching it means none of them need to change.
//
// Numeric fields are emitted as strings because the existing split data is
// string-typed and consumers do esc(ex.sets) / parseInt(ex.workingSets, 10).
function toSplitExercise(exercise) {
  const reps = joinReps(exercise);
  const working = exercise.working_sets != null ? exercise.working_sets : exercise.sets;
  const line = prescriptionLine(exercise);
  return {
    exercise: exercise.exercise_name,
    sets: exercise.sets != null ? String(exercise.sets) : (working != null ? String(working) : ''),
    reps: exercise.rep_min != null ? String(exercise.rep_min) : '',
    repRange: reps,
    rest: exercise.rest_seconds != null ? `${exercise.rest_seconds}s` : '',
    warmupSets: String(exercise.warmup_sets == null ? 0 : exercise.warmup_sets),
    workingSets: working != null ? String(working) : '',
    // ATHLETE-FACING ONLY. coach_notes is never selected from the database in
    // this file — see the explicit column list in sessionPrescriptions().
    notes: exercise.athlete_notes || '',
    prescriptionLine: line,
    cues: exercise.technique_cues || '',
    progression: exercise.progression_rule || '',
    supersetGroup: exercise.superset_group || '',
    circuitGroup: exercise.circuit_group || '',
    repMode: exercise.rep_mode || 'reps',
    alts: Array.isArray(exercise.alternatives) ? exercise.alternatives : [],
    leftRightExercises: Array.isArray(exercise.left_right_exercises) ? exercise.left_right_exercises : [],
  };
}

function toRunStep(step) {
  return {
    id: step.id,
    parentId: step.parent_step_id || null,
    order: step.step_order,
    type: step.step_type,
    repeat: step.repeat_count || null,
    distanceKm: step.distance_km,
    durationSec: step.duration_sec,
    intensityType: step.intensity_type || '',
    paceMin: step.pace_min || '',
    paceMax: step.pace_max || '',
    hrZone: step.hr_zone || '',
    rpe: step.rpe,
    effort: step.effort || '',
    instructions: step.instructions || '',
  };
}

// Structured prescriptions for sessions the coach has built in the new builder.
//
// SECURITY: the session ids are derived here from rows already scoped to this
// athlete's code. They are never taken from the request body — otherwise an
// athlete could ask for another athlete's prescription by id.
//
// coach_notes is excluded from both column lists by hand. Never replace these
// with select:'*'.
export async function sessionPrescriptions(plannedRows, selectRows = select) {
  const structured = (Array.isArray(plannedRows) ? plannedRows : [])
    .filter((row) => row.prescription_mode === 'structured');

  const empty = { exercises: {}, runSteps: {} };
  if (!structured.length) return empty;

  // Newest first, bounded. A long-running athlete accumulates hundreds of
  // structured sessions and the portal only ever renders a few weeks of them.
  const scoped = structured
    .slice()
    .sort((a, b) => String(b.planned_date || '').localeCompare(String(a.planned_date || '')))
    .slice(0, 200);

  const byId = new Map(scoped.map((row) => [row.id, row]));
  const idList = `(${scoped.map((row) => row.id).join(',')})`;

  const [exerciseRows, stepRows] = await Promise.all([
    selectRows('session_exercises', {
      planned_session_id: `in.${idList}`,
      select: 'id,planned_session_id,exercise_name,position,superset_group,circuit_group,sets,warmup_sets,working_sets,rep_min,rep_max,rep_mode,target_load,percent_1rm,rpe,rir,tempo,rest_seconds,progression_rule,alternatives,left_right_exercises,athlete_notes,technique_cues',
      order: 'position.asc',
      limit: '2000',
    }).catch(() => []),
    selectRows('run_steps', {
      planned_session_id: `in.${idList}`,
      select: 'id,planned_session_id,parent_step_id,step_order,step_type,repeat_count,distance_km,duration_sec,intensity_type,pace_min,pace_max,hr_zone,rpe,effort,instructions',
      order: 'step_order.asc',
      limit: '2000',
    }).catch(() => []),
  ]);

  const result = { exercises: {}, runSteps: {} };

  (Array.isArray(exerciseRows) ? exerciseRows : []).forEach((row) => {
    const session = byId.get(row.planned_session_id);
    if (!session) return;
    const key = sessionKey(session);
    if (!result.exercises[key]) result.exercises[key] = [];
    result.exercises[key].push(toSplitExercise(row));
  });

  (Array.isArray(stepRows) ? stepRows : []).forEach((row) => {
    const session = byId.get(row.planned_session_id);
    if (!session) return;
    const key = sessionKey(session);
    if (!result.runSteps[key]) result.runSteps[key] = [];
    result.runSteps[key].push(toRunStep(row));
  });

  return result;
}

async function plannedSessions(code, body) {
  const start = date(body.start);
  const end = date(body.end);
  if (!start || !end || start > end) {
    const error = new Error('A valid date range is required');
    error.status = 400;
    throw error;
  }

  // Return the athlete's programme, not only the rows whose coach-planned date
  // falls inside the visible week. Athlete reschedules are stored separately in
  // athlete_data, so a session moved across a week boundary must still reach the
  // browser before that override can be applied.
  //
  // publish_state filter: a coach building next week in draft mode must stay
  // invisible here. This is the only place the portal learns a session exists,
  // so filtering at the query is the whole of the draft guarantee.
  const programme = await select('planned_sessions', {
    athlete_code: `eq.${code}`,
    publish_state: 'eq.published',
    select: 'id,notion_page_id,title,planned_date,session_type,status,library_id,run_details,intensity,week_label,programme_week_id,distance_km,target_pace,warm_up,intervals,working_pace,rest,cool_down,notes,prescription_mode,part_of_day,day_order,estimated_minutes',
    order: 'planned_date.asc',
    limit: '1000',
  });
  const rows = Array.isArray(programme) ? programme : [];
  const next = rows.find((row) => row.planned_date > end) || null;

  // Never let a prescription lookup take the training plan down with it: a
  // missing prescription degrades to the legacy title-matched split, which is
  // exactly what every session used before this feature existed.
  let prescriptions = { exercises: {}, runSteps: {} };
  try {
    prescriptions = await sessionPrescriptions(rows);
  } catch (error) {
    console.warn('[portal-data] prescription read failed:', error && error.message);
  }

  return {
    rows,
    next,
    prescriptions,
  };
}

async function workoutSplits(code) {
  const rows = await select('workout_splits', {
    archived: 'eq.false',
    or: `(athlete_code.is.null,athlete_code.eq.${code})`,
    select: 'name,athlete_code,exercises',
    order: 'name.asc',
    limit: '200',
  });
  return { rows: Array.isArray(rows) ? rows : [] };
}

function libraryRevision(rows) {
  return crypto.createHash('sha1').update(JSON.stringify(rows || [])).digest('hex').slice(0, 16);
}

export async function sessionLibrary(body = {}, selectRows = select) {
  const rows = await selectRows('session_library', {
    archived: 'eq.false',
    select: '*',
    order: 'name.asc',
    limit: '1000',
  });
  const safeRows = Array.isArray(rows) ? rows : [];
  const revision = libraryRevision(safeRows);
  if (text(body.libraryRevision, 80) === revision) {
    return { rows: [], revision, notModified: true };
  }
  return { rows: safeRows, revision, notModified: false };
}

async function nutritionProgramme(code, selectRows = select) {
  const rows = await selectRows('nutrition_plans', {
    athlete_code: `eq.${code}`,
    select: '*',
    order: 'week_label.asc',
    limit: '100',
  });
  return { rows: Array.isArray(rows) ? rows : [] };
}

async function nutritionWeek(code, body) {
  const label = weekLabel(body.weekLabel);
  if (!label) {
    const error = new Error('A valid programme week is required');
    error.status = 400;
    throw error;
  }
  const [plans, planned] = await Promise.all([
    select('nutrition_plans', {
      athlete_code: `eq.${code}`,
      week_label: `eq.${label}`,
      select: '*',
      limit: '1',
    }),
    // Drafts must not inflate the week's planned kilometres.
    select('planned_sessions', {
      athlete_code: `eq.${code}`,
      week_label: `eq.${label}`,
      publish_state: 'eq.published',
      select: 'distance_km,title,session_type,library_id,week_label',
      order: 'planned_date.asc',
      limit: '100',
    }),
  ]);
  return {
    plan: Array.isArray(plans) && plans[0] ? plans[0] : null,
    planned: Array.isArray(planned) ? planned : [],
  };
}

async function programmeData(code) {
  const [planned, nutrition, programmes] = await Promise.all([
    // Drafts must not appear in programme volume or the week strip.
    select('planned_sessions', {
      athlete_code: `eq.${code}`,
      publish_state: 'eq.published',
      select: 'week_label,programme_week_id,distance_km,title,session_type,library_id,planned_date,status',
      order: 'planned_date.asc',
      limit: '1000',
    }),
    select('nutrition_plans', {
      athlete_code: `eq.${code}`,
      select: 'week_label,weekly_km_target',
      order: 'week_label.asc',
      limit: '100',
    }),
    select('athlete_programmes', {
      athlete_code: `eq.${code}`,
      status: 'eq.active',
      select: 'id',
      order: 'updated_at.desc',
      limit: '1',
    }),
  ]);
  const programme = Array.isArray(programmes) ? programmes[0] : null;
  const programmeWeeks = programme ? await select('athlete_programme_weeks', {
    programme_id: `eq.${programme.id}`,
    select: 'id,programme_id,week_number,week_label,start_date',
    order: 'week_number.asc',
    limit: '100',
  }) : [];
  return {
    planned: Array.isArray(planned) ? planned : [],
    nutrition: Array.isArray(nutrition) ? nutrition : [],
    programmeWeeks: Array.isArray(programmeWeeks) ? programmeWeeks.map((week) => ({
      id: week.id,
      programmeId: week.programme_id,
      weekNumber: week.week_number,
      weekLabel: week.week_label,
      startDate: week.start_date,
    })) : [],
  };
}

async function sessionLogsRead(code) {
  const rows = await select('session_logs', {
    athlete_code: `eq.${code}`,
    select: 'session_key,logged_at',
    order: 'logged_at.desc',
    limit: '1000',
  });
  return { rows: Array.isArray(rows) ? rows : [] };
}

async function sessionLogWrite(code, body) {
  const sessionKey = text(body.sessionKey, 180);
  if (!sessionKey) {
    const error = new Error('sessionKey is required');
    error.status = 400;
    throw error;
  }
  await upsert('session_logs', {
    athlete_code: code,
    session_key: sessionKey,
    logged_at: new Date().toISOString(),
  }, 'athlete_code,session_key');
  return { session_key: sessionKey };
}

async function rejectStravaMatch(code, body) {
  const sessionKey = text(body.sessionKey, 180);
  const clientWriteId = text(body.clientWriteId, 120);
  if (!sessionKey || !clientWriteId || !clientWriteId.startsWith('strava_')) {
    const error = new Error('A valid Strava match is required');
    error.status = 400;
    throw error;
  }
  await Promise.all([
    remove('session_logs', { athlete_code: `eq.${code}`, session_key: `eq.${sessionKey}` }),
    remove('training_session_logs', { athlete_code: `eq.${code}`, client_write_id: `eq.${clientWriteId}` }),
  ]);
  return { session_key: sessionKey, client_write_id: clientWriteId };
}

async function bodyLogs(code) {
  const rows = await select('daily_body_logs', {
    athlete_code: `eq.${code}`,
    select: 'log_date,weight,sleep,energy,stress,soreness,notes,raw_payload,submitted_at',
    order: 'log_date.desc',
    limit: '400',
  });
  return { rows: Array.isArray(rows) ? rows : [] };
}

// Which days the server has ACTUALLY received a body or nutrition log for.
//
// The quick-log dock used to tick from a local storage key written before the
// request was even sent, so a submission that never left the phone looked
// identical to one that landed: the athlete saw a tick, the coach saw nothing,
// and neither had any way to tell. Confirmation has to come from the server.
//
// Dates only — the indicator needs nothing else, and nutrition notes run to
// several hundred words each, so pulling whole rows to answer "did this
// arrive?" would cost far more than it returns. Being server-side also makes
// the state identical on every device the athlete signs into.
export async function dailyLogDates(code, selectRows = select) {
  const structuredParams = {
    athlete_code: `eq.${code}`,
    select: 'log_date',
    order: 'log_date.desc',
    limit: '60',
  };
  const legacyParams = key => ({
    athlete_code: `eq.${code}`,
    key: `like.${key}_*`,
    select: 'key',
    order: 'key.desc',
    limit: '60',
  });
  const settled = await Promise.allSettled([
    selectRows('daily_body_logs', structuredParams),
    selectRows('daily_nutrition_logs', structuredParams),
    // Logs submitted by an older portal build may only exist in athlete_data.
    // Include those keys so deploying the confirmation UI also backfills the
    // green state for athletes who already checked in earlier that day.
    selectRows('athlete_data', legacyParams('daily_body')),
    selectRows('athlete_data', legacyParams('daily_nut')),
  ]);
  const rowsAt = index => settled[index].status === 'fulfilled' ? settled[index].value : [];
  const dates = rows => (Array.isArray(rows) ? rows : [])
    .map(row => String(row?.log_date || '').slice(0, 10))
    .filter(Boolean);
  const legacyDates = (rows, prefix) => (Array.isArray(rows) ? rows : [])
    .map(row => String(row?.key || '').replace(`${prefix}_`, '').slice(0, 10))
    .filter(Boolean);
  const unique = values => [...new Set(values)];
  return {
    body: unique([...dates(rowsAt(0)), ...legacyDates(rowsAt(2), 'daily_body')]),
    nutrition: unique([...dates(rowsAt(1)), ...legacyDates(rowsAt(3), 'daily_nut')]),
  };
}

export async function bookingRead(code, selectRows = select) {
  const rows = await selectRows('athlete_data', {
    athlete_code: `eq.${code}`,
    key: 'like.call_booked_*',
    select: 'key,value,updated_at',
    order: 'key.asc',
    limit: '100',
  });
  return { rows: Array.isArray(rows) ? rows : [] };
}

export async function bookingSync(code, syncBookings = syncBookingsForAthlete, readBookings = bookingRead) {
  const sync = await syncBookings(code);
  const current = await readBookings(code);
  return { ...current, synced: sync.updated || [] };
}

// Full read snapshot for the primary portal screen. Each section settles
// independently: a library or nutrition problem must not hide an otherwise
// valid training plan, and the client can retry only the missing legacy read.
export async function trainingRead(code, body = {}, readers = {}) {
  const readPlanned = readers.plannedSessions || plannedSessions;
  const readSplits = readers.workoutSplits || workoutSplits;
  const readLibrary = readers.sessionLibrary || sessionLibrary;
  const includeLibrary = body.includeLibrary === true;
  const names = ['planned', 'splits'];
  const tasks = [readPlanned(code, body), readSplits(code)];
  if (includeLibrary) {
    names.push('library');
    tasks.push(readLibrary({ libraryRevision: body.libraryRevision || '' }));
  }
  const settled = await Promise.allSettled(tasks);
  const result = { planned: null, splits: null, library: null, errors: [] };
  settled.forEach((entry, index) => {
    const name = names[index];
    if (entry.status === 'fulfilled') result[name] = entry.value;
    else result.errors.push(name);
  });
  return result;
}

// Combine the read-only hydration calls that previously blocked portal entry
// behind three separate authenticated requests. Keep each result in its
// original response shape so the browser can run the existing hydration logic
// unchanged. Reader injection makes the orchestration independently testable
// without touching Supabase or weakening the request authentication boundary.
export async function bootstrapRead(code, readers = {}) {
  const readState = readers.stateRead || stateRead;
  const readBodyLogs = readers.bodyLogs || bodyLogs;
  const readSessionLogs = readers.sessionLogsRead || sessionLogsRead;
  const readDailyLogDates = readers.dailyLogDates || dailyLogDates;
  const [state, bodyLogRows, sessionLogs, dailyLogged] = await Promise.all([
    readState(code),
    readBodyLogs(code),
    readSessionLogs(code),
    // Never let the confirmation lookup take the whole portal down with it: a
    // missing indicator is a small loss, a blocked entry screen is not.
    readDailyLogDates(code).catch(() => ({ body: [], nutrition: [] })),
  ]);
  return { state, bodyLogs: bodyLogRows, sessionLogs, dailyLogged };
}

async function dispatch(action, code, body) {
  if (action === 'bootstrap') return bootstrapRead(code);
  if (action === 'training-read') return trainingRead(code, body);
  if (action === 'booking-read') return bookingRead(code);
  if (action === 'booking-sync') return bookingSync(code);
  if (action === 'state-read') return stateRead(code);
  if (action === 'state-write') return stateWrite(code, body);
  if (action === 'planned-sessions') return plannedSessions(code, body);
  if (action === 'workout-splits') return workoutSplits(code);
  if (action === 'session-library') return sessionLibrary(body);
  if (action === 'nutrition-week') return nutritionWeek(code, body);
  if (action === 'programme-data') return programmeData(code);
  if (action === 'session-logs-read') return sessionLogsRead(code);
  if (action === 'session-log-write') return sessionLogWrite(code, body);
  if (action === 'strava-match-reject') return rejectStravaMatch(code, body);
  if (action === 'body-logs') return bodyLogs(code);
  if (action === 'daily-log-dates') return dailyLogDates(code);

  const error = new Error('Unknown portal action');
  error.status = 400;
  throw error;
}

export default async function handler(req, res) {
  if (String(req.query?.mode || '') !== 'portal') {
    return send(res, 410, {
      ok: false,
      error: 'This legacy write endpoint has been retired. Update the client to /api/portal-data.',
    });
  }
  if (!allowPortalRequest(req, res, 'POST, OPTIONS')) return;
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method_not_allowed' });

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const action = text(body.action, 60);

    // ── Coach mode ────────────────────────────────────────────────────────
    // Resolved before, and completely separately from, athlete identity. A
    // coach action needs a signed coach-edit token that an athlete session can
    // never satisfy; an athlete action never consults the coach path. Two
    // doors, neither opens the other.
    if (isCoachAction(action)) {
      const coach = resolveCoachMode(req);
      if (!coach) return send(res, 403, { ok: false, error: 'coach_link_invalid' });
      const result = await dispatchCoachAction(action, body, coach);
      return send(res, 200, { ok: true, ...result });
    }

    const identity = await getRequestAthlete(req);
    if (!identity) return send(res, 401, { ok: false, error: 'invalid_session' });

    const data = action === 'weekly-sport-targets'
      ? await weeklySportTargetsRead(req)
      : await dispatch(action, String(identity.athlete.code).toUpperCase(), body);
    return send(res, 200, { ok: true, ...data });
  } catch (error) {
    console.error('[portal-data]', error && error.message);
    const safe = safeError(error);
    return send(res, safe.status, { ok: false, error: safe.message });
  }
}
