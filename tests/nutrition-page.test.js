import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { nutritionHistory } from '../api/write.js';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const index = readFileSync(join(root, 'public', 'index.html'), 'utf8');
const writeSource = readFileSync(join(root, 'api', 'write.js'), 'utf8');

// The Nutrition page browses every week's macro targets beside what was logged.

test('nutrition history is scoped to the signed-in athlete and returns plans and logs', async () => {
  const seen = [];
  const result = await nutritionHistory('THOMAS', async (table, params) => {
    seen.push(table);
    assert.equal(params.athlete_code, 'eq.THOMAS');
    if (table === 'nutrition_plans') {
      for (const field of ['week_label', 'calories', 'protein', 'carbs', 'fats', 'fibre', 'notes']) {
        assert.ok(params.select.includes(field), field);
      }
      return [{ week_label: 'Week 12', calories: '2400' }];
    }
    return [{ log_date: '2026-09-22', calories: 2350 }];
  });
  assert.deepEqual(seen.sort(), ['daily_nutrition_logs', 'nutrition_plans']);
  assert.deepEqual(result.plans, [{ week_label: 'Week 12', calories: '2400' }]);
  assert.deepEqual(result.logs, [{ log_date: '2026-09-22', calories: 2350 }]);
});

test('log notes never travel to the nutrition page', async () => {
  await nutritionHistory('THOMAS', async (table, params) => {
    if (table === 'daily_nutrition_logs') {
      assert.doesNotMatch(params.select, /notes|raw_payload/);
    }
    return [];
  });
});

test('a non-array answer degrades to empty lists', async () => {
  const result = await nutritionHistory('THOMAS', async () => null);
  assert.deepEqual(result, { plans: [], logs: [] });
});

test('the action is routed and the page is reachable from the profile menu', () => {
  assert.match(writeSource, /action === 'nutrition-history'\) return nutritionHistory\(code\)/);
  const menu = index.slice(index.indexOf('class="profile-menu-list"'), index.indexOf('id="preferencesModal"'));
  assert.match(menu, /onclick="openNutritionPage\(\)"[\s\S]*?<strong>Nutrition<\/strong>/);
  assert.match(index, /id="nutritionModal"[^>]*onclick="if\(event\.target===this\)closeNutritionPage\(\)"/);
});
