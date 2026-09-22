import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DAILY_PUSH_CAP,
  LOGGING_HOUR,
  LOGGING_MINUTE,
  QUIET_HOUR,
  WEEKLY_REVIEW_DOW,
  WEEKLY_REVIEW_HOUR,
  WEEKLY_REVIEW_MINUTE,
  buildWeeklyReviewMessage,
  isQuietTime,
  minuteMatches,
} from '../api/_lib/notification-rules.js';
import { MANAGED_CATEGORIES, resolvePrefs } from '../api/_lib/push-devices.js';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);

// localNow() in api/reminders.js is not exported. This is the same derivation,
// so the Sunday/7pm gate can be exercised against real instants in real zones —
// which is the only way to prove the daylight-saving behaviour.
function localNow(tz, instant) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type) => (parts.find((part) => part.type === type) || {}).value;
  return {
    tz,
    iso: `${get('year')}-${get('month')}-${get('day')}`,
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
    hour: parseInt(get('hour'), 10),
    minute: parseInt(get('minute'), 10),
  };
}

const fires = (tz, instant) => {
  const now = localNow(tz, instant);
  return now.dow === WEEKLY_REVIEW_DOW && minuteMatches(now, WEEKLY_REVIEW_HOUR, WEEKLY_REVIEW_MINUTE);
};

// ── The message ──────────────────────────────────────────────────────────────

test('the weekly review notification points at Progress and carries no figures', () => {
  const message = buildWeeklyReviewMessage('2026-09-27');
  assert.equal(message.type, 'weekly_review');
  assert.equal(message.url, '/?tab=progress');
  assert.equal(message.dedupeKey, 'weekly-review:2026-09-27');
  // No number may be baked in: the week is still open at 7pm Sunday, so a
  // figure here could be contradicted by the card minutes later.
  assert.equal(/\d/.test(message.title + message.body), false, `${message.title} / ${message.body}`);
  // Factual and calm, like the card it opens.
  assert.equal(/well done|great|smashed|crushed|amazing|keep it up|proud/i.test(message.title + message.body), false);
});

test('a week label is used when one is supplied and omitted when it is not', () => {
  assert.equal(buildWeeklyReviewMessage('2026-09-27').title, 'Your week in review');
  assert.equal(buildWeeklyReviewMessage('2026-09-27', 'Week 8').title, 'Week 8 in review');
  assert.equal(buildWeeklyReviewMessage('2026-09-27', 'Discovery Week').title, 'Discovery Week in review');
  assert.equal(buildWeeklyReviewMessage('2026-09-27', '   ').title, 'Your week in review');
});

// ── Sunday, 7pm, local ───────────────────────────────────────────────────────

test('it fires at 7pm on a Sunday and at no other time that week', () => {
  const tz = 'Australia/Adelaide';
  // 2026-09-27 is a Sunday. 19:00 ACST is 09:30Z.
  assert.equal(fires(tz, new Date('2026-09-27T09:30:00Z')), true, '7:00pm Sunday');
  assert.equal(fires(tz, new Date('2026-09-27T09:31:00Z')), true, 'inside the 2-minute window');
  assert.equal(fires(tz, new Date('2026-09-27T09:29:00Z')), false, '6:59pm');
  assert.equal(fires(tz, new Date('2026-09-27T09:32:00Z')), false, '7:02pm, window closed');
  assert.equal(fires(tz, new Date('2026-09-27T08:30:00Z')), false, '6pm');
  assert.equal(fires(tz, new Date('2026-09-27T10:30:00Z')), false, '8pm');
  // Every other day at exactly the same local time.
  for (let day = 21; day <= 26; day += 1) {
    assert.equal(fires(tz, new Date(`2026-09-${day}T09:30:00Z`)), false, `7pm on the ${day}th is not a Sunday`);
  }
});

test('it stays at 7pm local across the daylight-saving switch', () => {
  const tz = 'Australia/Adelaide';
  // South Australia moves to ACDT (UTC+10:30) on the first Sunday in October.
  // A fixed UTC schedule would drift an hour here; resolving the athlete's own
  // local time does not.
  const beforeDst = new Date('2026-09-27T09:30:00Z');   // ACST, UTC+9:30
  const afterDst = new Date('2026-10-11T08:30:00Z');    // ACDT, UTC+10:30
  assert.equal(localNow(tz, beforeDst).hour, 19);
  assert.equal(localNow(tz, afterDst).hour, 19);
  assert.equal(fires(tz, beforeDst), true, 'Sunday 7pm before the switch');
  assert.equal(fires(tz, afterDst), true, 'Sunday 7pm after the switch');
  // And the UTC instant that used to be 7pm is now 6pm, so it must NOT fire.
  assert.equal(localNow(tz, new Date('2026-10-11T09:30:00Z')).hour, 20);
  assert.equal(fires(tz, new Date('2026-10-11T09:30:00Z')), false, 'the old UTC slot is 8pm after the switch');
});

test('an athlete in another zone gets 7pm in theirs, not in Adelaide', () => {
  // 2026-09-27T09:30Z is 7pm in Adelaide and the small hours in London.
  assert.equal(fires('Australia/Adelaide', new Date('2026-09-27T09:30:00Z')), true);
  assert.equal(fires('Europe/London', new Date('2026-09-27T09:30:00Z')), false);
  // London's own Sunday 7pm is 18:00Z in BST.
  assert.equal(fires('Europe/London', new Date('2026-09-27T18:00:00Z')), true);
});

// ── How it sits with the rest of Sunday ──────────────────────────────────────

test('7pm is awake, and ahead of the 7:30pm logging nudge', () => {
  const sunday = localNow('Australia/Adelaide', new Date('2026-09-27T09:30:00Z'));
  assert.equal(isQuietTime(sunday), false, 'the review must not land in quiet hours');
  assert.ok(
    WEEKLY_REVIEW_HOUR * 60 + WEEKLY_REVIEW_MINUTE < LOGGING_HOUR * 60 + LOGGING_MINUTE,
    'the review should arrive before "you still have a session open", not after it',
  );
  assert.ok(WEEKLY_REVIEW_HOUR < QUIET_HOUR);
});

test('a Sunday cannot exceed the daily push cap', () => {
  // morning (5:30) + weekly review (19:00) + logging (19:30) is the worst case.
  const sundaySlots = 3;
  assert.ok(sundaySlots <= DAILY_PUSH_CAP, `${sundaySlots} scheduled Sunday pushes against a cap of ${DAILY_PUSH_CAP}`);
});

// ── Delivery, preferences and the once-a-week guard ──────────────────────────

test('every managed athlete gets it with no migration and no re-consent', () => {
  assert.ok(MANAGED_CATEGORIES.includes('weekly_review'));
  const managed = resolvePrefs([], { managed: true });
  assert.equal(managed.weekly_review, true);
  // An athlete explicitly exempted in the database still gets nothing new.
  const exempt = resolvePrefs([{ prefs: { sessions: true }, updated_at: '2026-09-01T00:00:00Z' }], { managed: false });
  assert.equal(!!exempt.weekly_review, false);
});

test('the cron gate, the preference and the once-per-day guard are all wired', () => {
  const reminders = readFileSync(join(root, 'api', 'reminders.js'), 'utf8');
  // Sunday AND 7pm, both.
  assert.match(reminders, /now\.dow === WEEKLY_REVIEW_DOW\s*\n\s*&& minuteMatches\(now, WEEKLY_REVIEW_HOUR, WEEKLY_REVIEW_MINUTE\)/);
  // Gated on the athlete's preference.
  assert.match(reminders, /if \(weeklyReview && athlete\.prefs\.weekly_review\)/);
  // The 2-minute window means the cron can match twice; the history key is what
  // stops a second push landing in the same minute-and-a-bit.
  assert.match(reminders, /lastSent\.weeklyReview !== now\.iso/);
  assert.match(reminders, /historyKey: 'weeklyReview'/);
});

test('the athlete can see the reminder in Preferences', () => {
  const nav = readFileSync(join(root, 'public', 'js', '03-nav-nudges.js'), 'utf8');
  const options = nav.slice(nav.indexOf('var REMINDER_OPTIONS='), nav.indexOf('function getReminderPreferences'));
  assert.match(options, /key:'weekly_review'/);
  assert.match(options, /7 pm Sunday/);
  // The list shown to athletes and the list the server delivers must not drift.
  const listed = [...options.matchAll(/key:'([a-z_]+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(listed, [...MANAGED_CATEGORIES].sort());
});
