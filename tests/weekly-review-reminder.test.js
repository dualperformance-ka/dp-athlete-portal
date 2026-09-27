import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DAILY_PUSH_CAP,
  LOGGING_HOUR,
  LOGGING_MINUTE,
  MORNING_HOUR,
  MORNING_MINUTE,
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
// so the Monday/7am gate can be exercised against real instants in real zones —
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
  // No number may be baked in: a back-dated log could change the card after the
  // push lands, and the push would then contradict it.
  assert.equal(/\d/.test(message.title + message.body), false, `${message.title} / ${message.body}`);
  // Factual and calm, like the card it opens.
  assert.equal(/well done|great|smashed|crushed|amazing|keep it up|proud/i.test(message.title + message.body), false);
});

test('a week label is used when one is supplied and omitted when it is not', () => {
  assert.equal(buildWeeklyReviewMessage('2026-09-27').title, 'Last week in review');
  assert.match(buildWeeklyReviewMessage('2026-09-27').body, /last week/i);
  assert.equal(buildWeeklyReviewMessage('2026-09-27', 'Week 8').title, 'Week 8 in review');
  assert.equal(buildWeeklyReviewMessage('2026-09-27', 'Discovery Week').title, 'Discovery Week in review');
  assert.equal(buildWeeklyReviewMessage('2026-09-27', '   ').title, 'Last week in review');
});

// ── Monday, 7am, local — reviewing the week just gone ────────────────────────

test('it fires at 7am on a Monday and at no other time that week', () => {
  const tz = 'Australia/Adelaide';
  // 2026-09-28 is a Monday. 07:00 ACST is 21:30Z on the Sunday.
  assert.equal(fires(tz, new Date('2026-09-27T21:30:00Z')), true, '7:00am Monday');
  assert.equal(fires(tz, new Date('2026-09-27T21:31:00Z')), true, 'inside the 2-minute window');
  assert.equal(fires(tz, new Date('2026-09-27T21:29:00Z')), false, '6:59am');
  assert.equal(fires(tz, new Date('2026-09-27T21:32:00Z')), false, '7:02am, window closed');
  assert.equal(fires(tz, new Date('2026-09-27T20:00:00Z')), false, '5:30am, the plan push slot');
  assert.equal(fires(tz, new Date('2026-09-27T09:30:00Z')), false, 'the old Sunday 7pm slot');
  // Every other day at exactly the same local time.
  for (let day = 28; day <= 30; day += 1) {
    assert.equal(fires(tz, new Date(`2026-09-${day}T21:30:00Z`)), false, `7am the day after the ${day}th is not a Monday`);
  }
  for (let day = 1; day <= 3; day += 1) {
    assert.equal(fires(tz, new Date(`2026-10-0${day}T21:30:00Z`)), false, `7am the day after ${day} Oct is not a Monday`);
  }
});

test('the week it reviews is the one that just ended', () => {
  const monday = localNow('Australia/Adelaide', new Date('2026-09-27T21:30:00Z'));
  assert.equal(monday.dow, 1);
  assert.equal(monday.iso, '2026-09-28', 'the Monday after the Mon 21 – Sun 27 Sep week');
});

test('it stays at 7am local across the daylight-saving switch', () => {
  const tz = 'Australia/Adelaide';
  // South Australia moves to ACDT (UTC+10:30) on the first Sunday in October.
  const beforeDst = new Date('2026-09-27T21:30:00Z');   // Mon 28 Sep, ACST
  const afterDst = new Date('2026-10-11T20:30:00Z');    // Mon 12 Oct, ACDT
  assert.equal(localNow(tz, beforeDst).hour, 7);
  assert.equal(localNow(tz, afterDst).hour, 7);
  assert.equal(fires(tz, beforeDst), true, 'Monday 7am before the switch');
  assert.equal(fires(tz, afterDst), true, 'Monday 7am after the switch');
  // The UTC instant that used to be 7am is now 8am, so it must NOT fire.
  assert.equal(localNow(tz, new Date('2026-10-11T21:30:00Z')).hour, 8);
  assert.equal(fires(tz, new Date('2026-10-11T21:30:00Z')), false, 'the old UTC slot is 8am after the switch');
});

test('an athlete in another zone gets 7am in theirs, not in Adelaide', () => {
  assert.equal(fires('Australia/Adelaide', new Date('2026-09-27T21:30:00Z')), true);
  assert.equal(fires('Europe/London', new Date('2026-09-27T21:30:00Z')), false);
  // London's own Monday 7am is 06:00Z in BST.
  assert.equal(fires('Europe/London', new Date('2026-09-28T06:00:00Z')), true);
});

// ── How it sits with the rest of Monday ──────────────────────────────────────

test('7am is awake and after the 5:30am plan push', () => {
  const monday = localNow('Australia/Adelaide', new Date('2026-09-27T21:30:00Z'));
  assert.equal(isQuietTime(monday), false, 'the review must not land in quiet hours');
  assert.ok(WEEKLY_REVIEW_HOUR * 60 + WEEKLY_REVIEW_MINUTE > MORNING_HOUR * 60 + MORNING_MINUTE,
    'the plan for today lands first, the review of last week second');
  assert.ok(WEEKLY_REVIEW_HOUR * 60 + WEEKLY_REVIEW_MINUTE < LOGGING_HOUR * 60 + LOGGING_MINUTE);
});

test('a Monday cannot exceed the daily push cap', () => {
  // morning (5:30) + weekly review (7:00) + logging (19:30) is the worst case.
  const mondaySlots = 3;
  assert.ok(mondaySlots <= DAILY_PUSH_CAP, `${mondaySlots} scheduled Monday pushes against a cap of ${DAILY_PUSH_CAP}`);
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
  // Monday AND 7am, both.
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
  assert.match(options, /7 am Monday/);
  // The list shown to athletes and the list the server delivers must not drift.
  const listed = [...options.matchAll(/key:'([a-z_]+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(listed, [...MANAGED_CATEGORIES].sort());
});
