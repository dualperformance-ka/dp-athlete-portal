// ── REMINDER PLANNING ───────────────────────────────────────────────────────
// Everything the reminder cron decides, separated from the web-push delivery
// in api/reminders.js so it can be tested with a counting fake database.
//
// Shape of one run (see docs/reminder-scheduling.md):
//   1. Work out each athlete's local time and which reminder windows are open.
//   2. Load the inputs those windows need, ONCE per run (or once per distinct
//      local date), for the athletes who can actually receive that reminder,
//      and filter them in memory. A zone with no open window costs no
//      time-window reads at all.
//   3. Build candidate messages per athlete. No candidates, no further reads.
//   4. One batched read of athlete_notifications for every candidate athlete:
//      existing rows for the candidate dedupe keys (so a wider window or a
//      retried run never sends twice) plus today's capped push count.
//
// The old every-minute loop re-read planned sessions, logs, Strava, bookings,
// coach changes and held messages for every timezone every minute, and asked
// athlete_notifications for each athlete's push count even when nothing was
// due. That per-athlete, per-minute read is what this module removes.

import {
  CAP_EXEMPT_TYPES,
  CHECKIN_OVERDUE_DOW,
  CHECKIN_OVERDUE_HOUR,
  CHECKIN_OVERDUE_MINUTE,
  FUEL_HOUR,
  FUEL_MINUTE,
  HELD_MESSAGE_HOURS,
  LOGGING_HOUR,
  LOGGING_MINUTE,
  MORNING_HOUR,
  MORNING_MINUTE,
  READINESS_HOUR,
  READINESS_MINUTE,
  STRAVA_FRESH_HOURS,
  STRAVA_PUSH_SPORTS,
  WEEKLY_REVIEW_DOW,
  WEEKLY_REVIEW_HOUR,
  WEEKLY_REVIEW_MINUTE,
  buildCallMessage,
  buildCheckinOverdueMessage,
  buildCoachMessage,
  buildFuelMessage,
  buildLoggingMessage,
  buildMorningMessage,
  buildNextWeekMessage,
  buildReadinessMessage,
  buildStravaMessage,
  buildWeeklyReviewMessage,
  isQuietTime,
  minuteMatches,
  partitionCoachChanges,
} from './notification-rules.js';

export const DEFAULT_TZ = 'Australia/Adelaide';
const DONE_STATUS = /^(done|completed?|complete|skipped|missed)$/i;

// pg_cron calls the endpoint every five minutes. Each time-of-day reminder is
// eligible for fifteen minutes from its target, so it gets three chances and a
// single skipped or failed run (lease held, database slow) cannot lose it.
// The batched dedupe read below is what stops the second and third chance from
// sending again; the history key in push_subscriptions.last_sent backs it up.
export const REMINDER_CADENCE_MINUTES = 5;
export const REMINDER_WINDOW_MINUTES = 15;
// "Call in 2 hours" goes out between 1h50 and 2h05 before the call. The old
// window (118-122 min) assumed a run every minute.
export const CALL_SOON_MIN_MINUTES = 110;
export const CALL_SOON_MAX_MINUTES = 125;
export const STRAVA_LOOKBACK_MINUTES = 45;

// ── Local time ──────────────────────────────────────────────────────────────

export function localNow(tz, at = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(at);
    const get = (t) => { const p = parts.find((x) => x.type === t); return p ? p.value : null; };
    return {
      tz,
      iso: `${get('year')}-${get('month')}-${get('day')}`,
      dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
      hour: parseInt(get('hour'), 10),
      minute: parseInt(get('minute'), 10),
    };
  } catch (e) { return null; }
}

export function safeTz(tz) {
  return (tz && localNow(tz)) ? tz : DEFAULT_TZ;
}

export function inList(values) {
  return `in.(${[...new Set(values)].map((v) => `"${String(v).replace(/["\\]/g, '')}"`).join(',')})`;
}

function quotedList(values) {
  return [...new Set(values)].map((v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',');
}

// Which time-of-day windows are open for one local clock. The weekly review is
// Monday 07:00 in the athlete's OWN zone, so it stays 7am across daylight
// saving instead of drifting an hour like a fixed UTC schedule would.
export function zoneWindows(now, windowMinutes = REMINDER_WINDOW_MINUTES) {
  const at = (hour, minute) => minuteMatches(now, hour, minute, windowMinutes);
  const weeklyReview = now.dow === WEEKLY_REVIEW_DOW
    && minuteMatches(now, WEEKLY_REVIEW_HOUR, WEEKLY_REVIEW_MINUTE, windowMinutes);
  return {
    morning: at(MORNING_HOUR, MORNING_MINUTE),
    logging: at(LOGGING_HOUR, LOGGING_MINUTE),
    weeklyReview,
    readiness: at(READINESS_HOUR, READINESS_MINUTE),
    fuel: at(FUEL_HOUR, FUEL_MINUTE),
    checkinOverdue: now.dow === CHECKIN_OVERDUE_DOW && at(CHECKIN_OVERDUE_HOUR, CHECKIN_OVERDUE_MINUTE),
    quiet: isQuietTime(now),
  };
}

export function hasTimeWindow(windows) {
  return !!(windows.morning || windows.logging || windows.weeklyReview
    || windows.readiness || windows.fuel || windows.checkinOverdue);
}

// Attach local time and open windows to every roster athlete, computed once
// per distinct timezone.
export function placeAthletes(roster, at = new Date()) {
  const zones = new Map();
  const placed = [];
  let skippedZones = 0;
  for (const athlete of roster) {
    if (!zones.has(athlete.tz)) {
      const now = localNow(athlete.tz, at);
      zones.set(athlete.tz, now ? { now, windows: zoneWindows(now) } : null);
      if (!now) skippedZones++;
    }
    const zone = zones.get(athlete.tz);
    if (zone) placed.push({ ...athlete, now: zone.now, windows: zone.windows });
  }
  const activeZones = [...zones.values()].filter((zone) => zone && hasTimeWindow(zone.windows)).length;
  return { placed, zones: zones.size, activeZones, skippedZones };
}

export function emptyDue(iso) {
  return {
    iso, sessions: [], unlogged: [], checkin: false, photos: false, coach: [],
    callsToday: [], callsSoon: [], noCallBooked: false,
    readiness: false, fuel: false, checkinOverdue: false, strava: [], heldMessages: [],
    missed: 0,
  };
}

function groupByIso(athletes) {
  const groups = new Map();
  for (const athlete of athletes) {
    if (!groups.has(athlete.now.iso)) groups.set(athlete.now.iso, []);
    groups.get(athlete.now.iso).push(athlete);
  }
  return groups;
}

const upper = (value) => String(value || '').toUpperCase();
const asRows = (rows) => (Array.isArray(rows) ? rows : []);

// ── Inputs ──────────────────────────────────────────────────────────────────
// `read(table, query)` is the database. Every read here is batched across the
// athletes who need it; none is per athlete.
export async function loadReminderInputs(athletes, { read, nowMs = Date.now() }) {
  const due = {};
  athletes.forEach((a) => { due[a.code] = emptyDue(a.now.iso); });
  const wantsMorning = (a) => a.windows.morning && a.lastSent.morning !== a.now.iso;

  // 1. Sessions planned today, for the morning plan and the evening log nudge.
  const sessionAthletes = athletes.filter((a) => (wantsMorning(a) && a.prefs.sessions)
    || (a.windows.logging && a.prefs.logging && a.lastSent.logging !== a.now.iso));
  for (const [iso, group] of groupByIso(sessionAthletes)) {
    const rows = await read('planned_sessions', {
      athlete_code: inList(group.map((a) => a.code)), planned_date: `eq.${iso}`, publish_state: 'eq.published',
      select: 'athlete_code,title,session_type,status,part_of_day,estimated_minutes',
    });
    for (const row of asRows(rows)) {
      if (row.status && DONE_STATUS.test(String(row.status).trim())) continue;
      const target = due[upper(row.athlete_code)];
      if (target && target.iso === iso) target.sessions.push(row);
    }
  }

  // 2. Evening log nudge: only athletes with an open session today need the
  // "anything logged?" read. A structured log or any Strava activity counts.
  const loggingAthletes = athletes.filter((a) => a.windows.logging && a.prefs.logging
    && a.lastSent.logging !== a.now.iso && due[a.code].sessions.length);
  for (const [iso, group] of groupByIso(loggingAthletes)) {
    const list = inList(group.map((a) => a.code));
    const [loggedRows, activityRows] = await Promise.all([
      read('training_session_logs', { athlete_code: list, session_date: `eq.${iso}`, select: 'athlete_code', limit: '1000' }),
      read('strava_activities', { athlete_code: list, start_date_local: `gte.${iso}T00:00:00`, select: 'athlete_code,start_date_local', limit: '1000' }),
    ]);
    const logged = new Set(asRows(loggedRows).map((row) => upper(row.athlete_code)));
    for (const row of asRows(activityRows)) {
      if (String(row.start_date_local || '').slice(0, 10) === iso) logged.add(upper(row.athlete_code));
    }
    group.forEach((a) => { if (!logged.has(a.code)) due[a.code].unlogged = due[a.code].sessions.slice(); });
  }

  // 3. Sunday morning: weekly check-in not yet submitted in the last six days.
  const sundayCheckin = athletes.filter((a) => wantsMorning(a) && a.now.dow === 0 && a.prefs.checkins);
  if (sundayCheckin.length) {
    const rows = await read('weekly_checkins', {
      athlete_code: inList(sundayCheckin.map((a) => a.code)),
      submitted_at: `gte.${new Date(nowMs - 6 * 864e5).toISOString()}`, select: 'athlete_code',
    });
    const submitted = new Set(asRows(rows).map((r) => upper(r.athlete_code)));
    sundayCheckin.forEach((a) => { due[a.code].checkin = !submitted.has(a.code); });
  }

  // 4. Monday morning: progress photo week. No read.
  athletes.forEach((a) => { if (wantsMorning(a) && a.now.dow === 1) due[a.code].photos = true; });

  // 5. Calls. GHL bookings are mirrored into athlete_data by the webhook and
  // the daily sync; the cron only ever reads that copy, once per run.
  const callAthletes = athletes.filter((a) => a.prefs.calls);
  if (callAthletes.length) {
    const rows = await read('athlete_data', {
      athlete_code: inList(callAthletes.map((a) => a.code)), key: 'like.call_booked_*',
      select: 'athlete_code,key,value', limit: '2000',
    });
    const byCode = new Map(callAthletes.map((a) => [a.code, a]));
    const weekEndMs = nowMs + 7 * 86400000;
    const hasUpcoming = new Set();
    for (const row of asRows(rows)) {
      const athlete = byCode.get(upper(row.athlete_code));
      if (!athlete) continue;
      const startsAt = row?.value?.startsAt || row?.value?.startTime || row?.value?.start_time;
      const startMs = Date.parse(startsAt || '');
      if (!Number.isFinite(startMs) || startMs < nowMs - 6 * 3600000) continue;
      const target = due[athlete.code];
      if (startMs <= weekEndMs) hasUpcoming.add(athlete.code);
      const call = { startsAt: new Date(startMs).toISOString(), displayTime: row?.value?.time || row?.value?.displayTime || 'time in the portal' };
      if (wantsMorning(athlete) && localNow(athlete.tz, new Date(startMs))?.iso === athlete.now.iso) target.callsToday.push(call);
      const minutesAway = (startMs - nowMs) / 60000;
      if (minutesAway >= CALL_SOON_MIN_MINUTES && minutesAway <= CALL_SOON_MAX_MINUTES) target.callsSoon.push(call);
    }
    callAthletes.forEach((a) => {
      if (wantsMorning(a) && a.now.dow === 0) due[a.code].noCallBooked = !hasUpcoming.has(a.code);
    });
  }

  // 6. Readiness (10:00), fuel (20:30), overdue check-in (Monday 12:00).
  await addDailyNudges(due, athletes, { read, nowMs });

  // 7. Coach changes from the last 24h, once for the whole roster. The lower
  // bound tightens to the oldest change anyone has not yet been sent.
  const coachAthletes = athletes.filter((a) => a.prefs.coach);
  if (coachAthletes.length) {
    const floor = nowMs - 24 * 36e5;
    const oldestUnsent = Math.min(...coachAthletes.map((a) => {
      const t = a.lastSent.coach ? Date.parse(a.lastSent.coach) : 0;
      return Number.isFinite(t) ? t : 0;
    }));
    const since = new Date(Math.max(floor, oldestUnsent)).toISOString();
    const rows = await read('coach_change_log', {
      athlete_code: inList(coachAthletes.map((a) => a.code)), changed_at: `gte.${since}`,
      select: 'athlete_code,source,changed_at,detail', limit: '2000',
    });
    for (const c of asRows(rows)) {
      const target = due[upper(c.athlete_code)];
      if (target) target.coach.push({ source: c.source, at: c.changed_at, detail: c.detail });
    }
  }

  // 8. Strava activities synced in the last 45 minutes.
  await addStravaSynced(due, athletes.filter((a) => a.prefs.strava), { read, nowMs });

  // 9. Coach messages held through quiet hours. Only athletes outside quiet
  // hours with a device can receive them, so only they are asked about.
  await addHeldMessages(due, athletes.filter((a) => !a.windows.quiet && a.devices.length), { read, nowMs });

  // 10. Unread updates from earlier days, summarised in the morning push.
  const morning = athletes.filter(wantsMorning);
  for (const [iso, group] of groupByIso(morning)) {
    const rows = await read('athlete_notifications', {
      athlete_code: inList(group.map((a) => a.code)), local_date: `lt.${iso}`,
      pushed_at: 'is.null', read_at: 'is.null', dismissed_at: 'is.null',
      select: 'athlete_code', limit: String(25 * group.length),
    });
    for (const row of asRows(rows)) {
      const target = due[upper(row.athlete_code)];
      if (target && target.missed < 25) target.missed++;
    }
  }

  return due;
}

export async function addDailyNudges(due, athletes, { read, nowMs = Date.now() }) {
  const readiness = athletes.filter((a) => a.windows.readiness && a.prefs.readiness && a.lastSent.readiness !== a.now.iso);
  for (const [iso, group] of groupByIso(readiness)) {
    const rows = await read('daily_body_logs', {
      athlete_code: inList(group.map((a) => a.code)), log_date: `eq.${iso}`, select: 'athlete_code', limit: '1000',
    });
    const logged = new Set(asRows(rows).map((row) => upper(row.athlete_code)));
    group.forEach((a) => { due[a.code].readiness = !logged.has(a.code); });
  }

  const fuel = athletes.filter((a) => a.windows.fuel && a.prefs.fuel && a.lastSent.fuel !== a.now.iso);
  if (fuel.length) {
    const plans = await read('nutrition_plans', {
      athlete_code: inList(fuel.map((a) => a.code)), calories: 'not.is.null', select: 'athlete_code', limit: '2000',
    });
    const onMacros = new Set(asRows(plans).map((row) => upper(row.athlete_code)));
    const eligible = fuel.filter((a) => onMacros.has(a.code));
    for (const [iso, group] of groupByIso(eligible)) {
      const logs = await read('daily_nutrition_logs', {
        athlete_code: inList(group.map((a) => a.code)), log_date: `eq.${iso}`, select: 'athlete_code', limit: '1000',
      });
      const logged = new Set(asRows(logs).map((row) => upper(row.athlete_code)));
      group.forEach((a) => { due[a.code].fuel = !logged.has(a.code); });
    }
  }

  const overdue = athletes.filter((a) => a.windows.checkinOverdue && a.prefs.checkins && a.lastSent.checkinOverdue !== a.now.iso);
  if (overdue.length) {
    const rows = await read('weekly_checkins', {
      athlete_code: inList(overdue.map((a) => a.code)),
      submitted_at: `gte.${new Date(nowMs - 7 * 864e5).toISOString()}`, select: 'athlete_code',
    });
    const submitted = new Set(asRows(rows).map((row) => upper(row.athlete_code)));
    overdue.forEach((a) => { due[a.code].checkinOverdue = !submitted.has(a.code); });
  }
}

// Each activity is announced at most once (its dedupe key is the Strava id).
// An activity that started long ago, from a backfill or a first connect, is
// never announced. start_date_local is the athlete's wall-clock time stored
// with a +00 label, so it is compared with the athlete's wall clock.
export async function addStravaSynced(due, athletes, { read, nowMs = Date.now() }) {
  if (!athletes.length) return;
  const rows = await read('strava_activities', {
    athlete_code: inList(athletes.map((a) => a.code)),
    synced_at: `gte.${new Date(nowMs - STRAVA_LOOKBACK_MINUTES * 60000).toISOString()}`,
    select: 'strava_activity_id,athlete_code,start_date_local,sport_type,distance_m,moving_time_s,elapsed_time_s',
    limit: '200',
  });
  const byCode = new Map(athletes.map((a) => [a.code, a]));
  for (const row of asRows(rows)) {
    const athlete = byCode.get(upper(row.athlete_code));
    const target = athlete && due[athlete.code];
    if (!target || !STRAVA_PUSH_SPORTS.includes(String(row.sport_type || ''))) continue;
    const { now } = athlete;
    const wallNow = Date.parse(`${now.iso}T${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}:00Z`);
    const started = Date.parse(String(row.start_date_local || '').slice(0, 19) + 'Z');
    if (!Number.isFinite(started) || !Number.isFinite(wallNow)) continue;
    if (wallNow - started > STRAVA_FRESH_HOURS * 3600000 || started - wallNow > 3600000) continue;
    target.strava.push(row);
  }
}

// A coach's personal message that arrived in quiet hours is pushed once they
// end, unless the athlete already opened or cleared it.
export async function addHeldMessages(due, athletes, { read, nowMs = Date.now() }) {
  if (!athletes.length) return;
  const rows = await read('athlete_notifications', {
    athlete_code: inList(athletes.map((a) => a.code)),
    type: 'eq.custom',
    pushed_at: 'is.null',
    read_at: 'is.null',
    dismissed_at: 'is.null',
    created_at: `gte.${new Date(nowMs - HELD_MESSAGE_HOURS * 3600000).toISOString()}`,
    select: 'id,athlete_code,type,title,body,url,pushed_at,dismissed_at',
    limit: '200',
  });
  for (const row of asRows(rows)) {
    const target = due[upper(row.athlete_code)];
    if (target) target.heldMessages.push(row);
  }
}

// ── Candidate messages ──────────────────────────────────────────────────────
// Pure: no database. The rules are the ones the every-minute loop used; only
// the window width changed.
export function buildAthleteMessages(athlete, athleteDue, { nowMs = Date.now() } = {}) {
  const { now, windows, prefs, lastSent } = athlete;
  const messages = [];
  const weeklyReview = windows.weeklyReview;

  if (windows.morning && lastSent.morning !== now.iso) {
    const missed = athleteDue.missed || 0;
    const morningDue = {
      ...athleteDue,
      sessions: prefs.sessions ? athleteDue.sessions : [],
      checkin: prefs.checkins && athleteDue.checkin,
      photos: prefs.photos && athleteDue.photos,
      callsToday: prefs.calls ? athleteDue.callsToday : [],
      noCallBooked: prefs.calls && athleteDue.noCallBooked,
      missedSummary: missed ? `${missed} coaching update${missed === 1 ? '' : 's'} waiting in your inbox` : '',
    };
    const message = buildMorningMessage(morningDue);
    if (message) messages.push({ ...message, historyKey: 'morning' });
  }
  if (windows.logging && prefs.logging) {
    const message = buildLoggingMessage(athleteDue.unlogged, now.iso);
    if (message && lastSent.logging !== now.iso) messages.push({ ...message, historyKey: 'logging' });
  }
  if (prefs.calls) {
    for (const call of athleteDue.callsSoon || []) messages.push({ ...buildCallMessage(call, now.iso), historyKey: 'calls' });
  }
  // Sent whether or not the week has anything in it. An athlete who logged
  // nothing is the one most worth reaching.
  if (weeklyReview && prefs.weekly_review) {
    const message = buildWeeklyReviewMessage(now.iso);
    if (message && lastSent.weeklyReview !== now.iso) {
      messages.push({ ...message, historyKey: 'weeklyReview' });
    }
  }
  if (athleteDue.readiness && prefs.readiness && lastSent.readiness !== now.iso) {
    messages.push({ ...buildReadinessMessage(now.iso), historyKey: 'readiness' });
  }
  if (athleteDue.fuel && prefs.fuel && lastSent.fuel !== now.iso) {
    messages.push({ ...buildFuelMessage(now.iso), historyKey: 'fuel' });
  }
  if (athleteDue.checkinOverdue && prefs.checkins && lastSent.checkinOverdue !== now.iso) {
    messages.push({ ...buildCheckinOverdueMessage(now.iso), historyKey: 'checkinOverdue' });
  }
  if (prefs.strava) {
    for (const activity of athleteDue.strava || []) {
      const message = buildStravaMessage(activity);
      if (message) messages.push({ ...message, tag: `dp-strava-${activity.strava_activity_id}`, historyKey: null });
    }
  }

  // A coach edit is processed once it is two minutes old, so a save burst
  // becomes one useful batch. Only the next fourteen days can spend a push;
  // future block publication remains durable in the inbox.
  const coachEntries = athleteDue.coach || [];
  const lastCoach = lastSent.coach ? new Date(lastSent.coach).getTime() : 0;
  const freshChanges = coachEntries.filter((c) => new Date(c.at).getTime() > lastCoach);
  const newest = freshChanges.length ? Math.max(...freshChanges.map((c) => new Date(c.at).getTime())) : 0;
  const coachChanges = (freshChanges.length && nowMs - newest >= 2 * 60 * 1000)
    ? freshChanges.slice().sort((a, b) => new Date(b.at) - new Date(a.at)) : [];
  if (prefs.coach && coachChanges.length) {
    const partitioned = partitionCoachChanges(coachChanges, now.iso);
    const near = buildCoachMessage([...partitioned.near, ...partitioned.undated], now.iso);
    const nextWeek = buildNextWeekMessage(partitioned.nextWeek, now.iso);
    const future = buildCoachMessage(partitioned.future, now.iso, { future: true });
    if (near) messages.push({ ...near, historyKey: 'coach', historyValue: new Date(newest).toISOString() });
    if (nextWeek) messages.push({ ...nextWeek, historyKey: 'coach', historyValue: new Date(newest).toISOString() });
    if (future) messages.push({ ...future, historyKey: null, push: false });
  }
  return messages.filter(Boolean);
}

// ── Delivery state ──────────────────────────────────────────────────────────

export function dedupeKeyFor(message, localDate) {
  return String(message.dedupeKey || `${message.type}:${localDate}`).slice(0, 240);
}

// ONE read for every candidate athlete: any existing inbox row for a candidate
// dedupe key, and every capped push already made on the athletes' local dates.
// Replaces one pushedToday() read per athlete per minute.
export async function loadDeliveryState(candidates, { read }) {
  const existing = new Map();
  const pushed = new Map();
  if (!candidates.length) return { existing, pushed };
  const codes = candidates.map((c) => c.athlete.code);
  const keys = [];
  const isos = new Set();
  for (const { athlete, messages } of candidates) {
    isos.add(athlete.now.iso);
    for (const message of messages) keys.push(dedupeKeyFor(message, athlete.now.iso));
  }
  const or = [
    keys.length ? `dedupe_key.in.(${quotedList(keys)})` : null,
    `and(local_date.in.(${quotedList([...isos])}),pushed_at.not.is.null)`,
  ].filter(Boolean).join(',');
  const rows = await read('athlete_notifications', {
    athlete_code: inList(codes),
    or: `(${or})`,
    select: 'id,athlete_code,type,dedupe_key,local_date,pushed_at,dismissed_at',
    limit: String(Math.max(200, codes.length * 60)),
  });
  for (const row of asRows(rows)) {
    const code = upper(row.athlete_code);
    existing.set(`${code}|${row.dedupe_key}`, row);
    if (row.pushed_at && !CAP_EXEMPT_TYPES.includes(String(row.type || ''))) {
      const key = `${code}|${String(row.local_date || '').slice(0, 10)}`;
      pushed.set(key, (pushed.get(key) || 0) + 1);
    }
  }
  return { existing, pushed };
}

// What to do with one candidate given its existing inbox row.
//   'insert'        no row yet: write it, then push if allowed
//   'push-existing' row exists, never pushed, and a push is possible now
//   'skip'          already pushed, dismissed, or nothing new can happen
export function deliveryAction(message, existingRow, { quiet, canPush }) {
  if (!existingRow) return 'insert';
  if (existingRow.pushed_at || existingRow.dismissed_at) return 'skip';
  const wantsPush = message.push !== false && !quiet && !!canPush;
  return wantsPush ? 'push-existing' : 'skip';
}
