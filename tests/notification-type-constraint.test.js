import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { NOTIFICATION_TYPES, buildWeeklyReviewMessage, buildLoggingMessage } from '../api/_lib/notification-rules.js';
import { MANAGED_CATEGORIES } from '../api/_lib/push-devices.js';
import { saveInboxMessage } from '../api/reminders.js';

// weekly_review shipped in code while athlete_notifications_type_check still
// only allowed seven types. The unit suite was green; the Sunday 7pm inbox
// write would have failed in production. These tests tie the code to the
// schema so that cannot happen quietly again.

const root = new URL('..', import.meta.url).pathname;
const migrationsDir = path.join(root, 'supabase/migrations');

function constraintTypesFromMigrations() {
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  let latest = null;
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    // Either the original inline column check or a later named constraint.
    const inline = sql.match(/create table[^;]*athlete_notifications[\s\S]*?type text not null check \(type in \(([^)]*)\)\)/i);
    const named = sql.match(/add constraint athlete_notifications_type_check\s+check \(type in \(([^)]*)\)\)/i);
    const list = (named || inline)?.[1];
    if (list) latest = { file, types: [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) };
  }
  return latest;
}

function emittedTypeLiterals() {
  const files = ['api/reminders.js', 'api/notify.js', 'api/_lib/notification-rules.js'];
  const found = new Set();
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/\btype:\s*(?:[^,\n]*\?\s*)?'([a-z_]+)'/g)) found.add(match[1]);
    // The morning message chooses between several literals in a ternary.
    for (const match of source.matchAll(/type:\s*[\w.]+\s*\?[^\n]*/g)) {
      for (const literal of match[0].matchAll(/'([a-z_]+)'/g)) found.add(literal[1]);
    }
  }
  return found;
}

test('the newest migration allows exactly NOTIFICATION_TYPES', () => {
  const latest = constraintTypesFromMigrations();
  assert.ok(latest, 'a migration must define athlete_notifications_type_check');
  assert.deepEqual([...latest.types].sort(), [...NOTIFICATION_TYPES].sort(),
    `${latest.file} and NOTIFICATION_TYPES disagree`);
});

test('every managed category has schema support', () => {
  for (const category of MANAGED_CATEGORIES) {
    assert.ok(NOTIFICATION_TYPES.includes(category), `${category} is managed but not an allowed notification type`);
  }
});

test('every type literal the reminder and notify paths emit is allowed', () => {
  const emitted = emittedTypeLiterals();
  assert.ok(emitted.has('weekly_review'));
  assert.ok(emitted.has('custom'));
  for (const type of emitted) {
    assert.ok(NOTIFICATION_TYPES.includes(type), `code emits notification type '${type}' that the database rejects`);
  }
});

// A stand-in for PostgREST enforcing the real check constraint.
function constrainedUpsert(allowed) {
  const rows = [];
  const write = async (table, row, onConflict) => {
    assert.equal(table, 'athlete_notifications');
    assert.equal(onConflict, 'athlete_code,dedupe_key');
    if (!allowed.includes(row.type)) {
      throw new Error('new row for relation "athlete_notifications" violates check constraint "athlete_notifications_type_check"');
    }
    const stored = { id: `n${rows.length + 1}`, ...row };
    rows.push(stored);
    return [stored];
  };
  return { rows, write };
}

test('the weekly review message persists through the production inbox path', async () => {
  const { types } = constraintTypesFromMigrations();
  const { rows, write } = constrainedUpsert(types);
  const message = buildWeeklyReviewMessage('2026-09-27');
  const row = await saveInboxMessage('ATHLETE1', message, '2026-09-27', write);
  assert.equal(row.type, 'weekly_review');
  assert.equal(row.dedupe_key, 'weekly-review:2026-09-27');
  assert.equal(row.local_date, '2026-09-27');
  assert.equal(rows.length, 1);
});

test('the old seven-type constraint is what broke the weekly review', async () => {
  const { write } = constrainedUpsert(['sessions', 'logging', 'checkins', 'photos', 'calls', 'coach', 'custom']);
  await assert.rejects(saveInboxMessage('ATHLETE1', buildWeeklyReviewMessage('2026-09-27'), '2026-09-27', write),
    /athlete_notifications_type_check/);
  // Other types are unaffected.
  const logging = buildLoggingMessage([{ title: 'Easy run' }], '2026-09-27');
  if (logging) await saveInboxMessage('ATHLETE1', logging, '2026-09-27', write);
});

test('one failed inbox write does not abort the rest of the reminder run', () => {
  const source = fs.readFileSync(path.join(root, 'api/reminders.js'), 'utf8');
  const loop = source.slice(source.indexOf('for (const message of messages.filter(Boolean))'));
  assert.match(loop.slice(0, 800), /try \{\s*row = await saveInboxMessage/);
  assert.match(loop.slice(0, 800), /errors\.push\(\{ athlete: athlete\.code, type: message\.type, stage: 'inbox'/);
});
