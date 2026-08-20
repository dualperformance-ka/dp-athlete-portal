import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCallMessage, buildCoachMessage, buildLoggingMessage, buildMorningMessage,
  isQuietTime, minuteMatches, partitionCoachChanges,
} from '../api/_lib/notification-rules.js';

test('morning reminders merge training, check-in, photos and calls into one push', () => {
  const message = buildMorningMessage({
    iso: '2026-08-20',
    sessions: [
      { title: 'Threshold', part_of_day: 'am', estimated_minutes: 45 },
      { title: 'Lower B', part_of_day: 'pm', estimated_minutes: 30 },
    ],
    checkin: true,
    photos: true,
    callsToday: [{ displayTime: '6:30 pm' }],
  });
  assert.equal(message.title, "Today's training");
  assert.match(message.body, /Threshold \(AM\) · Lower B \(PM\) — 75 min total/);
  assert.match(message.body, /Weekly check-in due/);
  assert.match(message.body, /Progress photo week/);
  assert.match(message.body, /Coaching call today, 6:30 pm/);
  assert.equal(message.dedupeKey, 'morning:2026-08-20');
});

test('the evening reminder is silent on a rest day and names open training', () => {
  assert.equal(buildLoggingMessage([], '2026-08-20'), null);
  const one = buildLoggingMessage([{ title: 'Threshold' }], '2026-08-20');
  assert.equal(one.title, 'Threshold still open');
  assert.equal(one.url, '/?tab=training&date=2026-08-20');
});

test('coach changes inside seven days push while future block edits stay inbox-only', () => {
  const changes = [
    { source: 'training', changed_at: '2026-08-20T01:00:00Z', detail: { item: 'Threshold', action: 'updated', date: '2026-08-21' } },
    { source: 'training', changed_at: '2026-08-20T01:00:01Z', detail: { item: 'Long Run', action: 'added', date: '2026-09-12' } },
    // Duplicate trigger output must collapse.
    { source: 'training', changed_at: '2026-08-20T01:00:02Z', detail: { item: 'Long Run', action: 'added', date: '2026-09-12' } },
  ];
  const split = partitionCoachChanges(changes, '2026-08-20');
  assert.equal(split.near.length, 1);
  assert.equal(split.future.length, 1);
  assert.equal(buildCoachMessage(split.near, '2026-08-20').push, true);
  assert.equal(buildCoachMessage(split.future, '2026-08-20', { future: true }).push, false);
});

test('quiet hours are hard and scheduled minute windows are bounded', () => {
  assert.equal(isQuietTime({ hour: 5, minute: 29 }), true);
  assert.equal(isQuietTime({ hour: 5, minute: 30 }), false);
  assert.equal(isQuietTime({ hour: 21, minute: 0 }), true);
  assert.equal(minuteMatches({ hour: 5, minute: 30 }, 5, 30), true);
  assert.equal(minuteMatches({ hour: 5, minute: 32 }, 5, 30), false);
});

test('call reminders are durable and deep-link to coaching', () => {
  const message = buildCallMessage({ startsAt: '2026-08-20T09:00:00Z', displayTime: '6:30 pm' });
  assert.equal(message.type, 'calls');
  assert.equal(message.title, 'Call in 2 hours');
  assert.equal(message.url, '/?tab=checkin');
});
