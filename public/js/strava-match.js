function activityKey(activity) {
  if (activity && activity.id !== undefined && activity.id !== null) return String(activity.id);
  return [
    String(activity && (activity.start_date_local || activity.start_date) || '').slice(0, 19),
    String(activity && activity.distance || ''),
    String(activity && (activity.moving_time || activity.elapsed_time) || ''),
    String(activity && activity.name || ''),
  ].join('|');
}

function numericKm(value) {
  var n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 200 ? n : 0;
}

function plannedDistance(session, opts) {
  if (opts && typeof opts.plannedRunKm === 'function') return numericKm(opts.plannedRunKm(session));
  if (opts && opts.plannedKm !== undefined) return numericKm(opts.plannedKm);
  return numericKm(session && (session.plannedKm ?? session.distance_km ?? session.distanceKm));
}

function toKeySet(value) {
  if (value instanceof Set) return new Set(Array.from(value, String));
  if (Array.isArray(value)) return new Set(value.map(String));
  if (value && typeof value === 'object') {
    return new Set(Object.keys(value).filter(function (key) { return value[key]; }).map(String));
  }
  return new Set();
}

function rejectedKeys(session, opts) {
  var direct = toKeySet(opts && opts.rejectedActivityIds);
  var all = opts && opts.rejections;
  var sessionId = session && session.id !== undefined ? String(session.id) : '';
  if (!all || !sessionId) return direct;
  var stored = all[sessionId];
  toKeySet(stored).forEach(function (key) { direct.add(key); });
  return direct;
}

// Seed only. A future per-athlete calibration can replace this through
// opts.relativeEffortPerKmThreshold without changing the matching rules.
export const DEFAULT_RELATIVE_EFFORT_PER_KM_THRESHOLD = 3.0;
export const UNDERRUN_TOLERANCE_PERCENT = 0.15;
export const MIN_DISTANCE_TOLERANCE_KM = 1.5;

function addPrescriptionValue(parts, value) {
  if (typeof value === 'string' && value.trim()) parts.push(value.trim());
}

function addPrescriptionObject(parts, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  Object.values(value).forEach(function (item) { addPrescriptionValue(parts, item); });
}

export function classifyPrescribedIntensity(session) {
  session = session || {};
  var parts = [];
  [
    session.name, session.title, session.type, session.sessionType, session.intensity,
    session.runningSession, session.runDetails, session.resolvedName,
    session.resolvedType, session.resolvedIntensity, session.resolvedDescription,
  ].forEach(function (value) { addPrescriptionValue(parts, value); });
  addPrescriptionObject(parts, session.coachOverride || session.override);
  addPrescriptionObject(parts, session.resolvedMeta || session.meta);
  var text = parts.join(' ').toLowerCase();
  // Strides are not intervals. They are the standard finish to an easy run, and
  // the coach note that prescribes them ("finish with 4-6 × 20s strides") looks
  // exactly like rep notation to the regex below — which flagged every easy run
  // carrying that note as an under-run quality session. A 10 km easy run with
  // strides came back at 1.55 effort/km against a 3.0 threshold, so the flag was
  // guaranteed, not marginal.
  //
  // Remove the stride phrase and any rep count attached to it before
  // classifying. Genuine work in the same note still counts: strip only the
  // strides, never the whole sentence.
  var STRIDE_PHRASE = /(?:\b\d+\s*(?:[-–—]\s*\d+)?\s*[x×]\s*\d+\s*(?:s|sec|secs|seconds|m|min|mins)?\s*)?(?:\bhill\s+)?\bstrides?\b/gi;
  var classifiable = text.replace(STRIDE_PHRASE, ' ');
  var repNotation = /\b\d+\s*[x×]\s*\d+(?:\.\d+)?\s*(?:km|m|s|sec|secs|seconds|min|mins|minutes)?\b/i;
  var quality = /\b(?:tempo|threshold|intervals?|reps?|repeats?|hill|fartlek|track|race)\b|\btime[ -]?trial\b/i;
  var easy = /\b(?:easy|recovery|steady|shakeout)\b|\blong\s+run\b/i;
  if (repNotation.test(classifiable) || quality.test(classifiable)) return 'quality';
  if (easy.test(text)) return 'easy';
  return 'unknown';
}

/**
 * Strava's REST field for what the UI calls "Relative Effort" is `suffer_score`.
 * `relative_effort` has never been a field on the REST SummaryActivity — it is
 * what Strava's own MCP returns — so reading only that name yielded undefined on
 * every activity, which silently disabled every check built on top of it:
 * intensity_below_prescription and ran_above_prescription were both dead code.
 * Read the REST name first and keep the other as a fallback, so a payload from
 * either source works.
 *
 * Exported because "which field carries effort" is exactly the kind of thing
 * that breaks silently, and a test should be able to pin it.
 */
export function activityEffort(activity) {
  var raw = activity && (activity.suffer_score != null ? activity.suffer_score : activity.relative_effort);
  var effort = Number(raw);
  return Number.isFinite(effort) && effort > 0 ? effort : null;
}

/**
 * Returns null for "cannot tell", which is NOT the same as "easy".
 *
 * suffer_score is heart-rate derived, so it is legitimately absent for any
 * athlete who runs without a strap. Treating that absence as 'easy' would flag
 * every one of their quality sessions as under-run, so an unknown effort leaves
 * the match confidence untouched.
 */
function classifyExecutedIntensity(activity, threshold) {
  var effort = activityEffort(activity);
  var distanceKm = Number(activity && activity.distance) / 1000;
  if (effort === null || !Number.isFinite(distanceKm) || distanceKm <= 0) return null;
  return effort / distanceKm >= threshold ? 'quality' : 'easy';
}

/**
 * Match one planned run to the closest eligible Strava activity.
 *
 * Pure in/pure out: callers supply the planned distance plus already-claimed
 * and rejected activity ids through opts. No inputs are mutated.
 */
export function matchActivityToSession(session, activities, opts = {}) {
  var reasons = [];
  var sessionDate = String(session && (session.date || session.plannedDate) || '').slice(0, 10);
  if (!sessionDate) return { matched: false, reasons: ['missing_session_date'] };

  var plannedKm = plannedDistance(session, opts);
  var confidence = plannedKm ? 'high' : 'low';
  var underToleranceKm = plannedKm ? Math.max(plannedKm * UNDERRUN_TOLERANCE_PERCENT, MIN_DISTANCE_TOLERANCE_KM) : null;
  var claimed = toKeySet(opts.claimedActivityIds || opts.claimedActivities);
  var rejected = rejectedKeys(session, opts);
  var candidates = [];

  (Array.isArray(activities) ? activities : []).forEach(function (activity) {
    var type = String(activity && (activity.sport_type || activity.type) || '');
    if (type.toLowerCase().indexOf('run') < 0) { reasons.push('not_run'); return; }

    var activityDate = String(activity && (activity.start_date_local || activity.start_date) || '').slice(0, 10);
    if (activityDate !== sessionDate) { reasons.push('date_mismatch'); return; }

    var key = activityKey(activity);
    if (claimed.has(key)) { reasons.push('already_claimed'); return; }
    if (rejected.has(key)) { reasons.push('rejected'); return; }

    var distanceKm = Number(activity && activity.distance) / 1000;
    var distanceDeltaKm = distanceKm - plannedKm;
    // A run may exceed the prescription by any amount and still complete it.
    // Keep the lower bound so short runs and commutes do not claim the session.
    if (plannedKm && (!Number.isFinite(distanceKm) || distanceKm < 0 || distanceDeltaKm < -underToleranceKm - 1e-9)) {
      reasons.push('distance_outside_tolerance');
      return;
    }
    candidates.push({ activity: activity, key: key, distanceKm: distanceKm });
  });

  if (!candidates.length) return { matched: false, reasons: Array.from(new Set(reasons)) };
  candidates.sort(function (a, b) {
    if (plannedKm) {
      var delta = Math.abs(a.distanceKm - plannedKm) - Math.abs(b.distanceKm - plannedKm);
      if (delta) return delta;
    }
    return a.key.localeCompare(b.key);
  });
  var selected = candidates[0].activity;
  var threshold = Number(opts.relativeEffortPerKmThreshold);
  if (!Number.isFinite(threshold) || threshold <= 0) threshold = DEFAULT_RELATIVE_EFFORT_PER_KM_THRESHOLD;
  var prescribed = opts.prescribedIntensity || classifyPrescribedIntensity(session);
  var executed = classifyExecutedIntensity(selected, threshold);
  var matchReasons = [];
  if (prescribed === 'quality' && executed === 'easy') {
    confidence = 'low';
    matchReasons.push('intensity_below_prescription');
  } else if (prescribed === 'easy' && executed === 'quality') {
    matchReasons.push('ran_above_prescription');
  }
  return { matched: true, activity: selected, confidence: confidence, reasons: matchReasons };
}

export { activityKey as stravaActivityKey };

if (typeof window !== 'undefined') {
  window.matchActivityToSession = matchActivityToSession;
  window.stravaActivityKey = activityKey;
  window.classifyPrescribedIntensity = classifyPrescribedIntensity;
}
