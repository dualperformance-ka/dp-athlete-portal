import crypto from 'node:crypto';

export const MORNING_HOUR = 5;
export const MORNING_MINUTE = 30;
export const LOGGING_HOUR = 19;
export const LOGGING_MINUTE = 30;
export const QUIET_HOUR = 21;
// The cap applies to AUTOMATED reminders only. Anything a coach does (a
// personal message, a programme change), a booked call and the weekly review
// are never held back by it: those are the pushes an athlete most needs, and
// they were the ones the old flat cap of three silently dropped.
export const DAILY_PUSH_CAP = 5;
export const CAP_EXEMPT_TYPES = Object.freeze(['custom', 'coach', 'calls', 'weekly_review']);
export function isCapExempt(type) {
  return CAP_EXEMPT_TYPES.includes(String(type || ''));
}
// Mid-morning readiness nudge, only when today's body check is not logged.
export const READINESS_HOUR = 10;
export const READINESS_MINUTE = 0;
// Evening fuel nudge, only for athletes on macros with nothing logged today.
// 20:30: after the 19:30 session nudge and before 21:00 quiet hours.
export const FUEL_HOUR = 20;
export const FUEL_MINUTE = 30;
// Monday midday: last week's check-in is still not in.
export const CHECKIN_OVERDUE_DOW = 1;
export const CHECKIN_OVERDUE_HOUR = 12;
export const CHECKIN_OVERDUE_MINUTE = 0;
// A Strava activity is announced once, and only while it is fresh: an activity
// that started more than this long ago (a backfill, a first connect) is not.
export const STRAVA_FRESH_HOURS = 18;
// Endurance sports only. Strength is logged set by set in the portal, so a
// WeightTraining upload has nothing new to tell the athlete.
export const STRAVA_PUSH_SPORTS = Object.freeze(['Run', 'TrailRun', 'VirtualRun', 'Ride', 'VirtualRide', 'GravelRide', 'MountainBikeRide', 'EBikeRide', 'Swim', 'Walk', 'Hike', 'Rowing']);
// A coach's personal message sent during quiet hours is pushed when they end,
// as long as the athlete has not already opened it in the inbox.
export const HELD_MESSAGE_HOURS = 12;
// The weekly review lands on Monday morning and reviews the week just gone, so
// every number in it is final, Sunday's long run included. `dow` is the index
// localNow() produces, so Monday is 1. 07:00 sits after the 05:30 plan push, so
// Monday spends at most three pushes: plan, review and the 19:30 log nudge.
// Every notification type any code path may write to athlete_notifications.
// It must equal the athlete_notifications_type_check list in the newest
// migration that defines it; tests/notification-type-constraint.test.js fails
// the build if a new type is emitted without schema support (the weekly_review
// reminder shipped once without it and would have failed at 7pm Sunday).
export const NOTIFICATION_TYPES = Object.freeze([
  'sessions', 'logging', 'checkins', 'photos', 'calls', 'coach', 'custom', 'weekly_review',
  'strava', 'readiness', 'fuel',
]);

export const WEEKLY_REVIEW_DOW = 1;
export const WEEKLY_REVIEW_HOUR = 7;
export const WEEKLY_REVIEW_MINUTE = 0;

export function minuteMatches(now, hour, minute, windowMinutes = 2) {
  if (!now) return false;
  const current = Number(now.hour) * 60 + Number(now.minute);
  const target = hour * 60 + minute;
  return current >= target && current < target + windowMinutes;
}

export function isQuietTime(now) {
  if (!now) return true;
  const current = Number(now.hour) * 60 + Number(now.minute);
  return current >= QUIET_HOUR * 60 || current < MORNING_HOUR * 60 + MORNING_MINUTE;
}

export function sessionLabel(session) {
  const title = String(session?.title || session?.session_type || 'Session').trim();
  const part = String(session?.part_of_day || '').trim().toUpperCase();
  return title + (part ? ` (${part})` : '');
}

export function buildMorningMessage(due = {}) {
  const parts = [];
  const sessions = Array.isArray(due.sessions) ? due.sessions : [];
  if (sessions.length) {
    const totalMinutes = sessions.reduce((sum, row) => sum + (Number(row?.estimated_minutes) || 0), 0);
    parts.push(sessions.map(sessionLabel).join(' · ') + (totalMinutes ? ` — ${totalMinutes} min total` : ''));
  }
  if (due.checkin) parts.push('Weekly check-in due');
  if (due.photos) parts.push('Progress photo week');
  if (Array.isArray(due.callsToday) && due.callsToday.length) {
    parts.push(`Coaching call today, ${due.callsToday[0].displayTime}`);
  } else if (due.noCallBooked) {
    parts.push('No call booked this week — grab a slot');
  }
  if (due.futureProgrammeLive) parts.push(due.futureProgrammeLive);
  if (due.missedSummary) parts.push(due.missedSummary);
  if (!parts.length) return null;
  return {
    type: sessions.length ? 'sessions' : due.checkin ? 'checkins' : due.photos ? 'photos' : 'calls',
    title: sessions.length ? "Today's training" : 'Your coaching week',
    body: parts.join(' · '),
    url: sessions.length ? `/?tab=training&date=${due.iso || ''}` : due.checkin ? '/?tab=checkin' : due.photos ? '/?tab=progress' : '/?tab=checkin',
    dedupeKey: `morning:${due.iso || ''}`,
  };
}

export function buildLoggingMessage(sessions = [], iso = '') {
  if (!sessions.length) return null;
  const names = sessions.map((row) => String(row?.title || row?.session_type || 'Session').trim());
  return {
    type: 'logging',
    title: names.length === 1 ? `${names[0]} still open` : `${names.length} sessions still open`,
    body: names.length === 1
      ? "Two minutes to log it and it's in your week's numbers."
      : `${names.join(' · ')} — tap to log.`,
    url: `/?tab=training&date=${iso}`,
    dedupeKey: `logging:${iso}`,
  };
}

function dateDistance(date, iso) {
  const left = Date.parse(`${date}T00:00:00Z`);
  const right = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.round((left - right) / 86400000);
}

export function partitionCoachChanges(changes = [], iso = '') {
  const seen = new Set();
  const near = [];
  const nextWeek = [];
  const future = [];
  const undated = [];
  for (const change of changes) {
    const detail = change?.detail || {};
    const key = `${change?.source || ''}|${detail.action || ''}|${detail.item || ''}|${detail.date || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const days = detail.date ? dateDistance(detail.date, iso) : null;
    if (days !== null && days >= 0 && days <= 7) near.push(change);
    else if (days !== null && days > 7 && days <= 14) nextWeek.push(change);
    else if (days !== null && days > 14) future.push(change);
    else if (change?.source === 'training') future.push(change);
    else undated.push(change);
  }
  return { near, nextWeek, future, undated };
}

function shortDate(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date);
}

export function buildCoachMessage(changes = [], iso = '', options = {}) {
  if (!changes.length) return null;
  const named = changes.map((change) => {
    const detail = change.detail || {};
    const date = detail.date ? ` (${shortDate(detail.date)})` : '';
    return `${detail.item || change.source || 'Programme'}${date} ${detail.action || 'updated'}`;
  });
  let body;
  if (named.length <= 3 && named.join(' · ').length <= 180) body = named.join(' · ');
  else {
    const dated = changes.map((row) => row?.detail?.date).filter(Boolean).sort();
    const range = dated.length ? ` between ${shortDate(dated[0])} and ${shortDate(dated[dated.length - 1])}` : '';
    body = `${changes.length} programme changes${range} — tap to review.`;
  }
  const newest = changes.map((row) => String(row.changed_at || '')).sort().at(-1) || iso;
  const digest = crypto.createHash('sha1').update(changes.map((row) => `${row.source}|${JSON.stringify(row.detail || {})}`).sort().join('\n')).digest('hex').slice(0, 16);
  return {
    type: 'coach',
    title: options.future ? 'Programme published' : changes.length === 1 ? 'Your programme changed' : 'Your week ahead changed',
    body: options.future ? 'Your next training block is live in the portal.' : body,
    url: changes.find((row) => row?.detail?.date)?.detail?.date ? `/?tab=training&date=${changes.find((row) => row?.detail?.date).detail.date}` : '/',
    dedupeKey: `coach:${options.future ? 'future:' : ''}${newest}:${digest}`,
    push: !options.future,
  };
}

// The notification deliberately carries NO figures. Computing the summary for
// every athlete inside the cron would duplicate the whole metric layer on a
// path that runs every minute, and any number baked in here could disagree with
// the card by the time it is opened, and a late back-dated log would make the
// push a lie. It says the review is ready and deep-links to it; the card is the
// single place the numbers are produced.
export function buildWeeklyReviewMessage(iso = '', weekLabel = '') {
  const label = String(weekLabel || '').trim();
  return {
    type: 'weekly_review',
    title: label ? `${label} in review` : 'Last week in review',
    body: 'Sessions, distance, strength and recovery from last week, in one place.',
    url: '/?tab=progress',
    dedupeKey: `weekly-review:${iso}`,
  };
}

export function buildCallMessage(call, iso = '') {
  if (!call) return null;
  return {
    type: 'calls',
    title: 'Call in 2 hours',
    body: `${call.displayTime || 'Your coaching call'} — anything you want to cover, jot it now.`,
    url: '/?tab=checkin',
    dedupeKey: `call:two-hours:${call.startsAt || iso}`,
  };
}

// ── Next week is live ────────────────────────────────────────────────────────
// Sessions published for 8 to 14 days out: the coming week landing. It pushes,
// unlike a block further ahead, which stays in the inbox as "Programme
// published". It names the first day so the athlete knows which week it is.
export function buildNextWeekMessage(changes = [], iso = '') {
  const dated = changes.map((row) => row?.detail?.date).filter(Boolean).sort();
  if (!dated.length) return null;
  const newest = changes.map((row) => String(row.changed_at || '')).sort().at(-1) || iso;
  const digest = crypto.createHash('sha1').update(changes.map((row) => `${row.source}|${JSON.stringify(row.detail || {})}`).sort().join('\n')).digest('hex').slice(0, 16);
  return {
    type: 'coach',
    title: 'Next week is live',
    body: `Your training from ${shortDate(dated[0])} is in the portal. Have a look before the week starts.`,
    url: `/?tab=week&date=${dated[0]}`,
    dedupeKey: `coach:next:${newest}:${digest}`,
  };
}

// ── Strava activity synced ───────────────────────────────────────────────────
function stravaSportLabel(sport) {
  const value = String(sport || '');
  if (/run/i.test(value)) return 'Run';
  if (/ride/i.test(value)) return 'Ride';
  if (/swim/i.test(value)) return 'Swim';
  if (/walk|hike/i.test(value)) return 'Walk';
  if (/row/i.test(value)) return 'Row';
  return 'Activity';
}
function formatDuration(seconds) {
  const total = Math.round(Number(seconds) || 0);
  if (total <= 0) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
export function buildStravaMessage(activity = {}) {
  const id = String(activity.strava_activity_id || '').trim();
  if (!/^\d+$/.test(id)) return null;
  const date = String(activity.start_date_local || '').slice(0, 10);
  const km = Number(activity.distance_m) > 0 ? Math.round(Number(activity.distance_m) / 100) / 10 : null;
  const time = formatDuration(activity.moving_time_s || activity.elapsed_time_s);
  const label = stravaSportLabel(activity.sport_type);
  const facts = [km ? `${km} km` : '', time].filter(Boolean).join(' in ');
  return {
    type: 'strava',
    title: km ? `${label} synced · ${km} km` : `${label} synced`,
    body: `${facts ? `${facts}. ` : ''}Open it to add how it felt while it is fresh.`,
    url: /^\d{4}-\d{2}-\d{2}$/.test(date) ? `/?tab=training&date=${date}` : '/?tab=training',
    dedupeKey: `strava:${id}`,
  };
}

// ── Readiness, fuel and an overdue check-in ─────────────────────────────────
export function buildReadinessMessage(iso = '') {
  return {
    type: 'readiness',
    title: 'Body check not logged',
    body: 'Sleep, energy, soreness and stress in thirty seconds. It is what your recovery numbers are built from.',
    url: '/?tab=log&log=body',
    dedupeKey: `readiness:${iso}`,
  };
}
export function buildFuelMessage(iso = '') {
  return {
    type: 'fuel',
    title: 'Log today\u2019s fuel',
    body: 'Nothing logged against your macros today. Two minutes now keeps your week honest.',
    url: '/?tab=log&log=fuel',
    dedupeKey: `fuel:${iso}`,
  };
}
export function buildCheckinOverdueMessage(iso = '') {
  return {
    type: 'checkins',
    title: 'Weekly check-in still open',
    body: 'Last week\u2019s check-in is not in yet. Your coaches review it before planning your week.',
    url: '/?tab=checkin',
    dedupeKey: `checkin-overdue:${iso}`,
  };
}
