import assert from 'node:assert/strict';
import test from 'node:test';
import { bootstrapRead } from '../api/write.js';

// Each section keeps the response shape the client already knows how to
// hydrate. dailyLogged was added alongside them rather than folded into an
// existing section, so nothing that was reading state/bodyLogs/sessionLogs has
// to change to accommodate it.
test('bootstrap combines read-only startup data without changing response shapes', async () => {
  const calls = [];
  const result = await bootstrapRead('ATHLETE1', {
    stateRead: async (code) => {
      calls.push(['state', code]);
      return { rows: [{ key: 'logs', value: { a: 1 } }], checkins: [] };
    },
    bodyLogs: async (code) => {
      calls.push(['body', code]);
      return { rows: [{ log_date: '2026-08-04', sleep: 8 }] };
    },
    sessionLogsRead: async (code) => {
      calls.push(['sessions', code]);
      return { rows: [{ session_key: 'session_ATHLETE1_1' }] };
    },
    dailyLogDates: async (code) => {
      calls.push(['dailyLogged', code]);
      return { body: ['2026-08-04'], nutrition: [] };
    },
  });

  assert.deepEqual(result, {
    state: { rows: [{ key: 'logs', value: { a: 1 } }], checkins: [] },
    bodyLogs: { rows: [{ log_date: '2026-08-04', sleep: 8 }] },
    sessionLogs: { rows: [{ session_key: 'session_ATHLETE1_1' }] },
    dailyLogged: { body: ['2026-08-04'], nutrition: [] },
  });
  assert.deepEqual(calls.sort(), [
    ['body', 'ATHLETE1'],
    ['dailyLogged', 'ATHLETE1'],
    ['sessions', 'ATHLETE1'],
    ['state', 'ATHLETE1'],
  ]);
});
