import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contactCoach, exportData } from '../api/write.js';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);

const ok = () => [{ id: 7, created_at: '2026-08-26T05:00:00.000Z' }];

// ── The rule this enforces ───────────────────────────────────────────────────
//
// The table is the source of truth. Notification is best effort ON TOP of it,
// so a refused email loses a ping and never the message.

test('the note is persisted before any notification is attempted', async () => {
  const order = [];
  const result = await contactCoach('ABC123', { message: 'My knee has been sore since Tuesday.' }, {
    selectRows: async () => [],
    insertRow: async (table, row) => {
      order.push('insert');
      assert.equal(table, 'contact_messages');
      assert.equal(row.athlete_code, 'ABC123');
      assert.equal(row.body, 'My knee has been sore since Tuesday.');
      return ok();
    },
    notify: async () => {
      order.push('notify');
      return { sent: true };
    },
  });
  assert.deepEqual(order, ['insert', 'notify']);
  assert.equal(result.saved, true);
  assert.equal(result.notified, true);
});

test('a failed notification still reports the note as saved', async () => {
  const result = await contactCoach('ABC123', { message: 'I am thinking about stopping.' }, {
    selectRows: async () => [],
    insertRow: async () => ok(),
    notify: async () => { throw new Error('GHL 403: scope missing'); },
  });
  assert.equal(result.saved, true);
  assert.equal(result.notified, false);
});

test('an unconfigured notifier is not an error either', async () => {
  const result = await contactCoach('ABC123', { message: 'Quick question about the plan.' }, {
    selectRows: async () => [],
    insertRow: async () => ok(),
    notify: async () => ({ sent: false, reason: 'ghl_not_configured' }),
  });
  assert.equal(result.saved, true);
  assert.equal(result.notified, false);
});

// ── Input boundary ───────────────────────────────────────────────────────────

test('an empty message is rejected before it reaches the table', async () => {
  let inserted = false;
  await assert.rejects(
    contactCoach('ABC123', { message: '   ' }, {
      selectRows: async () => [],
      insertRow: async () => { inserted = true; return ok(); },
      notify: async () => ({ sent: false }),
    }),
    /A message is required/,
  );
  assert.equal(inserted, false);
});

test('an over-long message is truncated, not rejected', async () => {
  let stored = '';
  await contactCoach('ABC123', { message: 'x'.repeat(5000) }, {
    selectRows: async () => [],
    insertRow: async (table, row) => { stored = row.body; return ok(); },
    notify: async () => ({ sent: false }),
  });
  assert.equal(stored.length, 2000);
});

// ── Rate limit ───────────────────────────────────────────────────────────────

test('the daily limit is enforced server-side and scoped to the athlete', async () => {
  let query = null;
  await assert.rejects(
    contactCoach('ABC123', { message: 'Another one.' }, {
      selectRows: async (table, params) => {
        assert.equal(table, 'contact_messages');
        query = params;
        return [1, 2, 3, 4, 5].map((id) => ({ id }));
      },
      insertRow: async () => { throw new Error('must not insert past the limit'); },
      notify: async () => ({ sent: false }),
    }),
    /message limit/,
  );
  assert.equal(query.athlete_code, 'eq.ABC123');
  assert.match(query.created_at, /^gte\./);
});

test('under the limit the note goes through', async () => {
  const result = await contactCoach('ABC123', { message: 'Fourth note today.' }, {
    selectRows: async () => [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    insertRow: async () => ok(),
    notify: async () => ({ sent: true }),
  });
  assert.equal(result.saved, true);
});

test('an unreadable rate-limit query never blocks a real message', async () => {
  const result = await contactCoach('ABC123', { message: 'Something is wrong with my hip.' }, {
    selectRows: async () => { throw new Error('supabase unreachable'); },
    insertRow: async () => ok(),
    notify: async () => ({ sent: false }),
  });
  assert.equal(result.saved, true);
});

// ── Export ───────────────────────────────────────────────────────────────────

test('the export is scoped to the authenticated athlete on every table', async () => {
  const tables = [];
  const result = await exportData('ABC123', async (table, query) => {
    tables.push(table);
    if (table === 'athletes') {
      assert.equal(query.code, 'eq.ABC123');
      return [{ code: 'ABC123', name: 'Test Athlete' }];
    }
    assert.equal(query.athlete_code, 'eq.ABC123', `${table} was not scoped to the athlete`);
    return [];
  });
  assert.deepEqual(tables.sort(), [
    'athlete_data', 'athlete_goals', 'athletes', 'daily_body_logs',
    'daily_nutrition_logs', 'progress_photos', 'session_logs',
    'training_session_logs', 'weekly_checkins',
  ]);
  assert.equal(result.export.athlete_code, 'ABC123');
  assert.equal(result.export.profile.name, 'Test Athlete');
  assert.deepEqual(result.export.incomplete, []);
});

test('the export never returns the Strava OAuth credential', async () => {
  let stateQuery = null;
  await exportData('ABC123', async (table, query) => {
    if (table === 'athlete_data') stateQuery = query;
    return [];
  });
  assert.equal(stateQuery.key, 'neq.strava_tokens');
});

test('one unreachable table degrades to an empty list and is named', async () => {
  const result = await exportData('ABC123', async (table) => {
    if (table === 'weekly_checkins') throw new Error('timeout');
    return [];
  });
  assert.deepEqual(result.export.weekly_checkins, []);
  assert.deepEqual(result.export.incomplete, ['weekly_checkins']);
});

// ── Boundaries that must not drift ───────────────────────────────────────────

test('both actions are dispatched on the existing route, not a new one', () => {
  const source = readFileSync(join(root, 'api', 'write.js'), 'utf8');
  assert.match(source, /if \(action === 'export-data'\) return exportData\(code\);/);
  assert.match(source, /if \(action === 'contact-coach'\) return contactCoach\(code, body\);/);
  // The code is the handler's, derived from the session — never the client's.
  assert.doesNotMatch(source, /exportData\(body\.|contactCoach\(body\./);
});

test('the contact_messages table stays server-only', () => {
  const migration = readFileSync(
    join(root, 'supabase', 'migrations', '20260826060000_contact_messages.sql'),
    'utf8',
  );
  assert.match(migration, /create table if not exists public\.contact_messages/);
  assert.match(migration, /alter table public\.contact_messages enable row level security;/);
  assert.match(migration, /revoke all on public\.contact_messages from anon, authenticated;/);
  assert.doesNotMatch(migration, /create policy/i);
  assert.match(migration, /athlete_code/);
  assert.match(migration, /\bbody\b/);
  assert.match(migration, /created_at/);
  assert.match(migration, /read_at/);
});
