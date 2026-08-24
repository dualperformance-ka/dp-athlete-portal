import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const index = readFileSync(join(root, 'public', 'index.html'), 'utf8');
const loginGoals = readFileSync(join(root, 'public', 'js', '02-login-goals.js'), 'utf8');
const desktop = readFileSync(join(root, 'public', 'desktop.css'), 'utf8');
const ingest = readFileSync(join(root, 'api', 'ingest.js'), 'utf8');

const strengthFields = [
  ['gStrengthLift', 'strengthLift'],
  ['gStrengthCurrentLoad', 'strengthCurrentLoad'],
  ['gStrengthTargetLoad', 'strengthTargetLoad'],
  ['gStrengthReps', 'strengthReps'],
];

test('Goals includes a compact working-set strength section', () => {
  assert.match(index, /Strength Goals/);
  assert.match(index, /normal working set, not a one-rep max/i);
  for (const [id] of strengthFields) assert.match(index, new RegExp(`id="${id}"`));
});

test('strength goals hydrate and save with the existing goals payload', () => {
  for (const [id, key] of strengthFields) {
    assert.match(loginGoals, new RegExp(`getElementById\\('${id}'\\)\\.value=saved\\.${key}`));
    assert.match(loginGoals, new RegExp(`${key}:document\\.getElementById\\('${id}'\\)\\.value\\.trim\\(\\)`));
  }
});

test('milestones stay full width without relying on sibling position', () => {
  assert.match(index, /goals-milestones-card/);
  assert.match(desktop, />\.goals-milestones-card\{grid-column:1\/-1\}/);
  assert.doesNotMatch(desktop, /goals-section-card:nth-of-type/);
});

test('strength section captures a single primary intent', () => {
  assert.match(index, /id="strengthIntentOptions"/);
  for (const val of ['Injury Resilience', 'Get Stronger', 'Build Muscle', 'Keep Muscle']) {
    assert.match(index, new RegExp(`data-val="${val}" onclick="selectGoalChip\\(this\\)"`));
  }
});

test('priority areas are multi-select and capped at two', () => {
  assert.match(index, /id="strengthPriorityOptions"/);
  const priorities = ['Glutes', 'Hamstrings', 'Quads', 'Calves &amp; Achilles', 'Core', 'Upper Body', 'Back &amp; Posture'];
  for (const val of priorities) {
    assert.match(index, new RegExp(`data-val="${val}" onclick="toggleGoalChip\\(this,2\\)"`));
  }
});

test('intent and priorities hydrate and save with the goals payload', () => {
  assert.match(loginGoals, /setGoalChipsFromValue\('strengthIntentOptions',saved\.strengthIntent/);
  assert.match(loginGoals, /setGoalChipsFromValue\('strengthPriorityOptions',saved\.strengthPriorities/);
  assert.match(loginGoals, /strengthIntent:goalChipValue\('strengthIntentOptions'\)/);
  assert.match(loginGoals, /strengthPriorities:goalChipValues\('strengthPriorityOptions'\)/);
});

test('race chips stay scoped so new chip groups cannot clear them', () => {
  assert.match(loginGoals, /document\.querySelectorAll\('#raceOptions \.race-opt'\)/);
  assert.doesNotMatch(loginGoals, /document\.querySelectorAll\('\.race-opt'\)/);
  // saveGoals reads the race chip document-wide, so an unscoped selector would
  // read a strength chip as the goal race whenever no race is picked.
  assert.match(loginGoals, /document\.querySelector\('#raceOptions \.race-opt\.selected'\)/);
  assert.doesNotMatch(loginGoals, /document\.querySelector\('\.race-opt\.selected'\)/);
});

test('every strength field reaches a typed column, not just raw_payload', () => {
  // athlete_goals maps field by field, so an unmapped field is invisible to the
  // coaches dashboard even though the write succeeds.
  const mapped = [
    ['strength_intent', 'text(payload.strengthIntent'],
    ['strength_priorities', 'text(payload.strengthPriorities'],
    ['strength_lift', 'text(payload.strengthLift'],
    ['strength_current_load', 'number(payload.strengthCurrentLoad'],
    ['strength_target_load', 'number(payload.strengthTargetLoad'],
    ['strength_reps', 'number(payload.strengthReps'],
  ];
  for (const [column, mapping] of mapped) {
    assert.ok(ingest.includes(`${column}: ${mapping}`), `athlete_goals.${column} is not mapped in ingest.js`);
  }
});
