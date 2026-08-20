import crypto from 'node:crypto';

export const MORNING_HOUR = 5;
export const MORNING_MINUTE = 30;
export const LOGGING_HOUR = 19;
export const LOGGING_MINUTE = 30;
export const QUIET_HOUR = 21;
export const DAILY_PUSH_CAP = 3;

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
  const future = [];
  const undated = [];
  for (const change of changes) {
    const detail = change?.detail || {};
    const key = `${change?.source || ''}|${detail.action || ''}|${detail.item || ''}|${detail.date || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const days = detail.date ? dateDistance(detail.date, iso) : null;
    if (days !== null && days >= 0 && days <= 7) near.push(change);
    else if (days !== null && days > 7) future.push(change);
    else if (change?.source === 'training') future.push(change);
    else undated.push(change);
  }
  return { near, future, undated };
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
