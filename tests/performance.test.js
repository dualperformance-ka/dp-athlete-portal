import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionLibrary, trainingRead } from '../api/write.js';

const root = new URL('..', import.meta.url).pathname;
const trainingSource = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');
const loginSource = readFileSync(join(root, 'public', 'js', '02-login-goals.js'), 'utf8');
const nutritionSource = readFileSync(join(root, 'public', 'js', '06-nutrition.js'), 'utf8');
const programmeSource = readFileSync(join(root, 'public', 'js', '05-handbook.js'), 'utf8');
const navSource = readFileSync(join(root, 'public', 'js', '03-nav-nudges.js'), 'utf8');
const indexSource = readFileSync(join(root, 'public', 'index.html'), 'utf8');

test('training snapshot settles sections independently and omits a warm cached library', async () => {
  let libraryCalls = 0;
  const result = await trainingRead('KARL', {
    start: '2026-08-03', end: '2026-08-09', includeLibrary: false,
  }, {
    plannedSessions: async () => ({ rows: [{ id: 'plan-1' }], next: null }),
    workoutSplits: async () => { throw new Error('temporary split failure'); },
    nutritionProgramme: async () => ({ rows: [{ week_label: 'Week 2' }] }),
    sessionLibrary: async () => { libraryCalls++; return { rows: [] }; },
  });

  assert.deepEqual(result.planned.rows, [{ id: 'plan-1' }]);
  assert.equal(result.splits, null);
  assert.deepEqual(result.nutrition.rows, [{ week_label: 'Week 2' }]);
  assert.deepEqual(result.errors, ['splits']);
  assert.equal(libraryCalls, 0);
});

test('training snapshot includes the library only on a cold client', async () => {
  const result = await trainingRead('KARL', {
    start: '2026-08-03', end: '2026-08-09', includeLibrary: true, libraryRevision: 'old',
  }, {
    plannedSessions: async () => ({ rows: [] }),
    workoutSplits: async () => ({ rows: [] }),
    nutritionProgramme: async () => ({ rows: [] }),
    sessionLibrary: async (body) => ({ rows: [{ id: 'run-1' }], revision: body.libraryRevision + '-new' }),
  });
  assert.equal(result.library.rows[0].id, 'run-1');
  assert.equal(result.library.revision, 'old-new');
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

test('client reuses the training snapshot and preserves compatibility fallbacks', () => {
  assert.match(trainingSource, /portalRequest\('training-read'/);
  assert.match(trainingSource, /loadRunningLibrary\(bundle&&bundle\.library\)/);
  assert.match(trainingSource, /loadWorkoutSplits\(bundle&&bundle\.splits\)/);
  assert.match(trainingSource, /loadPlannedSessions\([^\n]+bundle&&bundle\.planned\)/);
  assert.match(nutritionSource, /snapshot\.nutritionRows\.find/);
  assert.match(programmeSource, /hasSnapshot\?\{planned:snapshot\.plannedRows,nutrition:snapshot\.nutritionRows\}:await portalRequest\('programme-data'\)/);
});

test('secondary metrics and Progress code stay off the primary render path', () => {
  assert.match(loginSource, /Promise\.resolve\(loadWeek\(\)\)\.finally/);
  assert.match(loginSource, /window\._stravaLoadPromise=window\.initStrava/);
  assert.doesNotMatch(indexSource, /<script src="js\/07-progress\.js/);
  assert.match(indexSource, /data-src="\/js\/07-progress\.js\?v=86"/);
  assert.match(navSource, /ensureProgressModule\(\)\.then\(function\(\)\{loadProgress\(\);\}\)/);
});
