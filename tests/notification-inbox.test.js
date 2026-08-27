import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { clearInbox, dismissInboxNotification, listInbox, markInboxRead } from '../api/_lib/notification-inbox.js';

const firstId = '11111111-1111-4111-8111-111111111111';

function inboxDependencies(rows = []) {
  const calls = { select: [], patch: [] };
  return {
    calls,
    select: async (table, query) => {
      calls.select.push({ table, query });
      return query.select === 'id' ? rows.filter((row) => !row.read_at) : rows;
    },
    patch: async (table, query, values) => {
      calls.patch.push({ table, query, values });
      return [];
    },
    listInbox: async () => ({ notifications: [], unread: 0 }),
  };
}

test('visible inbox reads and unread count both exclude soft-dismissed rows', async () => {
  const dependencies = inboxDependencies([{ id: firstId, read_at: null }]);
  const inbox = await listInbox('KARL', dependencies);
  assert.equal(inbox.notifications.length, 1);
  assert.equal(inbox.unread, 1);
  assert.equal(dependencies.calls.select.length, 2);
  dependencies.calls.select.forEach(({ table, query }) => {
    assert.equal(table, 'athlete_notifications');
    assert.equal(query.athlete_code, 'eq.KARL');
    assert.equal(query.dismissed_at, 'is.null');
  });
});

test('one notification is dismissed only inside the authenticated athlete scope', async () => {
  const dependencies = inboxDependencies();
  const result = await dismissInboxNotification('KARL', firstId, dependencies);
  assert.deepEqual(result, { notifications: [], unread: 0 });
  assert.equal(dependencies.calls.patch.length, 1);
  const call = dependencies.calls.patch[0];
  assert.deepEqual(call.query, {
    id: `eq.${firstId}`,
    athlete_code: 'eq.KARL',
    dismissed_at: 'is.null',
  });
  assert.equal(call.values.dismissed_at, call.values.read_at);
  assert.ok(!Number.isNaN(new Date(call.values.dismissed_at).getTime()));
});

test('clear all soft-dismisses only the signed-in athlete visible rows', async () => {
  const dependencies = inboxDependencies();
  await clearInbox('KARL', dependencies);
  assert.deepEqual(dependencies.calls.patch[0].query, {
    athlete_code: 'eq.KARL',
    dismissed_at: 'is.null',
  });
});

test('read and dismiss reject malformed ids before touching Supabase', async () => {
  for (const operation of [markInboxRead, dismissInboxNotification]) {
    const dependencies = inboxDependencies();
    await assert.rejects(() => operation('KARL', 'not-an-id', dependencies), /valid notification id/i);
    assert.equal(dependencies.calls.patch.length, 0);
  }
});

test('reminder delivery and dashboard reporting honour athlete dismissal', () => {
  const reminders = readFileSync(new URL('../api/reminders.js', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../supabase/migrations/20260827142411_client_notification_dismissals.sql', import.meta.url), 'utf8');
  assert.match(reminders, /row\.pushed_at \|\| row\.dismissed_at/);
  assert.match(reminders, /dismissed_at: 'is\.null'/);
  assert.match(migration, /add column if not exists dismissed_at timestamptz/);
  assert.match(migration, /read_at is null\s+and athlete_notifications\.dismissed_at is null/);
  assert.match(migration, /with \(security_invoker = true\)/);
});
