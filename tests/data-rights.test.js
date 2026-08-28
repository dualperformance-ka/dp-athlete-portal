import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataRequest } from '../api/write.js';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

const saved = (at = '2026-08-27T23:00:00.000Z') => [{ id: 'req-1', requested_at: at }];
const noPrior = async () => [];

// ── The rule this enforces ───────────────────────────────────────────────────
//
// dualperformance.au/support tells athletes they can request deletion from
// inside the portal, and that verified requests complete within 30 days. Both
// claims need a durable row with a timestamp. The row is the source of truth;
// notification is best effort on top of it.

test('the request is persisted before any notification is attempted', async () => {
  const order = [];
  const result = await dataRequest('ABC123', { kind: 'account_deletion' }, {
    selectRows: noPrior,
    insertRow: async (table, row) => {
      order.push('insert');
      assert.equal(table, 'data_requests');
      assert.equal(row.athlete_code, 'ABC123');
      assert.equal(row.kind, 'account_deletion');
      return saved();
    },
    notify: async () => { order.push('notify'); return { sent: true }; },
  });
  assert.deepEqual(order, ['insert', 'notify']);
  assert.equal(result.saved, true);
  assert.equal(result.requested_at, '2026-08-27T23:00:00.000Z');
});

test('a failed notification still reports the request as saved', async () => {
  const result = await dataRequest('ABC123', { kind: 'account_deletion' }, {
    selectRows: noPrior,
    insertRow: async () => saved(),
    notify: async () => { throw new Error('GHL 403: scope missing'); },
  });
  assert.equal(result.saved, true);
  assert.equal(result.notified, false);
});

test('both published kinds are accepted and routed to their own address', async () => {
  const account = await dataRequest('ABC123', { kind: 'account_deletion' }, {
    selectRows: noPrior, insertRow: async () => saved(), notify: async () => ({ sent: true }),
  });
  assert.equal(account.contact, 'delete@dualperformance.au');

  const wearable = await dataRequest('ABC123', { kind: 'wearable_deletion' }, {
    selectRows: noPrior, insertRow: async () => saved(), notify: async () => ({ sent: true }),
  });
  assert.equal(wearable.contact, 'data@dualperformance.au');
});

test('an unknown kind is rejected before anything is written', async () => {
  for (const kind of ['delete_everything', '', null, 'ACCOUNT_DELETION']) {
    await assert.rejects(
      () => dataRequest('ABC123', { kind }, {
        selectRows: noPrior,
        insertRow: async () => { throw new Error('must not write'); },
        notify: async () => { throw new Error('must not notify'); },
      }),
      (error) => error.status === 400,
      `kind ${JSON.stringify(kind)} should be refused`,
    );
  }
});

test('the note is trimmed, capped, and stored as null when empty', async () => {
  let stored;
  await dataRequest('ABC123', { kind: 'wearable_deletion', note: '   ' }, {
    selectRows: noPrior,
    insertRow: async (_t, row) => { stored = row; return saved(); },
    notify: async () => ({ sent: true }),
  });
  assert.equal(stored.note, null);

  await dataRequest('ABC123', { kind: 'wearable_deletion', note: 'x'.repeat(5000) }, {
    selectRows: noPrior,
    insertRow: async (_t, row) => { stored = row; return saved(); },
    notify: async () => ({ sent: true }),
  });
  assert.equal(stored.note.length, 1000);
});

test('the rate limit is scoped per kind, so a wearable request cannot block a deletion', async () => {
  // Three wearable requests already today.
  const priorWearable = async (_table, query) => (
    query.kind === 'eq.wearable_deletion' ? [{ id: 1 }, { id: 2 }, { id: 3 }] : []
  );

  await assert.rejects(
    () => dataRequest('ABC123', { kind: 'wearable_deletion' }, {
      selectRows: priorWearable,
      insertRow: async () => saved(),
      notify: async () => ({ sent: true }),
    }),
    (error) => error.status === 429,
  );

  // Account deletion is a right and must not be rationed by unrelated traffic.
  const stillAllowed = await dataRequest('ABC123', { kind: 'account_deletion' }, {
    selectRows: priorWearable,
    insertRow: async () => saved(),
    notify: async () => ({ sent: true }),
  });
  assert.equal(stillAllowed.saved, true);
});

test('the athlete code comes from the caller, never from the request body', async () => {
  let stored;
  await dataRequest('REALCODE', { kind: 'account_deletion', athlete_code: 'SOMEONEELSE', code: 'SOMEONEELSE' }, {
    selectRows: noPrior,
    insertRow: async (_t, row) => { stored = row; return saved(); },
    notify: async () => ({ sent: true }),
  });
  assert.equal(stored.athlete_code, 'REALCODE');
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test('data-request is dispatched through the authenticated portal gateway', () => {
  const write = read('api', 'write.js');
  assert.match(write, /if \(action === 'data-request'\) return dataRequest\(code, body\);/);
});

test('the migration keeps the project-wide deny-by-default posture', () => {
  const migration = read('supabase', 'migrations', '20260827230000_data_requests.sql');
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on public\.data_requests from anon, authenticated/);
  assert.doesNotMatch(migration, /create policy/i);
  // The timestamps that evidence the published 30-day commitment.
  assert.match(migration, /requested_at timestamptz not null default now\(\)/);
  assert.match(migration, /completed_at timestamptz/);
});

test('the portal publishes the same addresses as the support page', () => {
  const index = read('public', 'index.html');
  const write = read('api', 'write.js');
  // Account deletion moved off privacy@ to the address the support page names.
  assert.doesNotMatch(index, /mailto:privacy@dualperformance\.au\?subject=Account/);
  assert.match(write, /account_deletion: 'delete@dualperformance\.au'/);
  assert.match(write, /wearable_deletion: 'data@dualperformance\.au'/);
  // And the portal points at the page rather than restating its policy.
  assert.match(index, /https:\/\/dualperformance\.au\/support/);
});

test('deletion is never one tap and never happens client-side', () => {
  const nav = read('public', 'js', '03-nav-nudges.js');
  // A confirm step exists between the button and the request.
  assert.match(nav, /function openDataRequest\(kind\)/);
  assert.match(nav, /function submitDataRequest\(\)/);
  // The client raises a request; it must not purge anything itself.
  assert.doesNotMatch(nav, /localStorage\.clear\(\)/);
});
