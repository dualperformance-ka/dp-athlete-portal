import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coachChanges, sessionLibrary, trainingRead } from '../api/write.js';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const trainingSource = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');
const loginSource = readFileSync(join(root, 'public', 'js', '02-login-goals.js'), 'utf8');
const bootSource = readFileSync(join(root, 'public', 'js', '10-boot.js'), 'utf8');
const navSource = readFileSync(join(root, 'public', 'js', '03-nav-nudges.js'), 'utf8');
const indexSource = readFileSync(join(root, 'public', 'index.html'), 'utf8');

test('training snapshot settles sections independently and omits a warm cached library', async () => {
  let libraryCalls = 0;
  const result = await trainingRead('KARL', {
    start: '2026-08-03', end: '2026-08-09', includeLibrary: false,
  }, {
    plannedSessions: async () => ({ rows: [{ id: 'plan-1' }], next: null }),
    workoutSplits: async () => { throw new Error('temporary split failure'); },
    coachChanges: async () => ({ rows: [] }),
    sessionLibrary: async () => { libraryCalls++; return { rows: [] }; },
  });

  assert.deepEqual(result.planned.rows, [{ id: 'plan-1' }]);
  assert.equal(result.splits, null);
  assert.equal('nutrition' in result, false);
  assert.deepEqual(result.errors, ['splits']);
  assert.equal(libraryCalls, 0);
});

test('training snapshot includes the library only on a cold client', async () => {
  const result = await trainingRead('KARL', {
    start: '2026-08-03', end: '2026-08-09', includeLibrary: true, libraryRevision: 'old',
  }, {
    plannedSessions: async () => ({ rows: [] }),
    workoutSplits: async () => ({ rows: [] }),
    coachChanges: async () => ({ rows: [] }),
    sessionLibrary: async (body) => ({ rows: [{ id: 'run-1' }], revision: body.libraryRevision + '-new' }),
  });
  assert.equal(result.library.rows[0].id, 'run-1');
  assert.equal(result.library.revision, 'old-new');
});

test('coach change summaries are athlete-scoped, date-bounded and stripped to safe fields', async () => {
  let captured;
  const result = await coachChanges('KARL', { start: '2026-08-03', end: '2026-08-09' }, async (table, query) => {
    captured = { table, query };
    return [
      { source: 'programme', changed_at: '2026-08-04T02:00:00Z', detail: { date: '2026-08-04', item: 'Upper A', action: 'reps updated', internal_note: 'do not expose' }, secret: 'hidden' },
      { source: 'programme', changed_at: '2026-08-11T02:00:00Z', detail: { date: '2026-08-11', item: 'Outside week', action: 'updated' } },
    ];
  });
  assert.equal(captured.table, 'coach_change_log');
  assert.equal(captured.query.athlete_code, 'eq.KARL');
  assert.equal(captured.query.select, 'source,changed_at,detail');
  assert.deepEqual(result.rows, [{
    source: 'programme', changed_at: '2026-08-04T02:00:00Z',
    detail: { date: '2026-08-04', item: 'Upper A', action: 'reps updated' },
  }]);
});

test('session library revisions suppress unchanged response payloads', async () => {
  const rows = [{ id: 'run-1', name: 'Easy Run', archived: false }];
  const first = await sessionLibrary({}, async () => rows);
  const second = await sessionLibrary({ libraryRevision: first.revision }, async () => rows);
  assert.equal(first.notModified, false);
  assert.deepEqual(first.rows, rows);
  assert.equal(second.notModified, true);
  assert.deepEqual(second.rows, []);
});

test('client persists a compact athlete-scoped week snapshot and preserves compatibility fallbacks', () => {
  assert.match(trainingSource, /portalRequest\('training-read'/);
  assert.match(trainingSource, /loadRunningLibrary\(bundle&&bundle\.library\)/);
  assert.match(trainingSource, /loadWorkoutSplits\(bundle&&bundle\.splits\)/);
  assert.match(trainingSource, /registerCoachChanges\(bundle&&bundle\.changes\)/);
  assert.match(trainingSource, /loadPlannedSessions\([^\n]+bundle&&bundle\.planned\)/);
  assert.match(trainingSource, /dp_training_week_v1_/);
  assert.match(trainingSource, /source:'persistent'/);
  assert.match(trainingSource, /library:null/);
  assert.match(trainingSource, /refreshWeekInBackground/);
});

test('secondary metrics and Progress code stay off the primary render path', () => {
  assert.match(loginSource, /var hydrationPromise=hydratePortalData\(code\)/);
  assert.match(loginSource, /var initialWeekPromise=Promise\.resolve\(loadWeek\(\)\)/);
  assert.match(loginSource, /window\._stravaLoadPromise=window\.initStrava/);
  assert.ok(loginSource.indexOf('var initialWeekPromise=Promise.resolve(loadWeek())') < loginSource.indexOf('syncPushSubscription();'));
  assert.ok(loginSource.indexOf('var initialWeekPromise=Promise.resolve(loadWeek())') < loginSource.indexOf('retryPendingCoachWrites(true);'));
  assert.doesNotMatch(indexSource, /<script src="js\/07-progress\.js/);
  const progressAsset = indexSource.match(/data-src="\/js\/07-progress\.js\?v=(\d+)"/);
  assert.ok(progressAsset && Number(progressAsset[1]) >= 86);
  assert.match(navSource, /ensureProgressModule\(\)\.then\(function\(\)\{loadProgress\(\);\}\)/);
});

test('a resolved session athlete is reused instead of authenticated twice', () => {
  assert.match(bootSource, /doLogin\(me\.code,me\)/);
  assert.match(bootSource, /doLogin\(legacyMe\.code,legacyMe\)/);
  assert.match(loginSource, /async function doLogin\(code,prevalidatedRoster\)/);
  assert.match(loginSource, /var roster=prevalidatedRoster\|\|await validateRosterCode\(code\)/);
});
