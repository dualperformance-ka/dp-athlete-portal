import test from 'node:test';
import assert from 'node:assert/strict';
import { persistStructured } from '../api/ingest.js';

for (const type of ['Swim', 'Ride']) {
  test(`${type} feedback is accepted as a training session log`, async () => {
    const writes = [];
    const result = await persistStructured({
      clientWriteId: `strava-${type.toLowerCase()}-1`,
      athleteCode: 'KARL', athleteName: 'Karl', type,
      session: `${type} session`, sessionCategory: type,
      date: '2026-09-30', distanceKm: type === 'Swim' ? 1.5 : 26.7,
      durationMin: 35, rpe: 6, notes: 'Controlled effort',
    }, {
      upsert: async (table, row, onConflict) => {
        writes.push({ table, row, onConflict });
        return [row];
      },
    });

    assert.ok(result, `${type} must not be rejected as unsupported_write_type`);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].table, 'training_session_logs');
    assert.equal(writes[0].row.session_category, type);
    assert.equal(writes[0].row.rpe, 6);
  });
}
