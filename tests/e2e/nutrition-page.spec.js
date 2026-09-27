import { test, expect } from '@playwright/test';
import { bootPortal, localISO, monday } from './harness.mjs';

// The Nutrition page: opened from the profile menu, it walks the athlete's
// weeks — past, this one and upcoming — showing the coaches' macro targets and
// what was logged against them. The harness athlete is on Week 12.

function day(offsetFromThisMonday) {
  const d = monday();
  d.setDate(d.getDate() + offsetFromThisMonday);
  return localISO(d);
}

const history = () => ({
  ok: true,
  plans: [
    // Created but never filled in: not a plan, so it must not add a week.
    { week_label: 'Week 10', calories: null, protein: null, carbs: null, fats: null, fibre: null, notes: '' },
    { week_label: 'Week 11', calories: '2300', protein: '160', carbs: '260', fats: '70', fibre: '30', notes: '' },
    { week_label: 'Week 12', calories: '2,400', protein: '165', carbs: '280', fats: '70', fibre: '35-38', notes: 'Carbs up around the long run.\nKeep protein spread across four meals.' },
    { week_label: 'Week 13', calories: '2500', protein: '170', carbs: '300', fats: '72', fibre: '35', notes: 'Taper week fuel.' },
  ],
  logs: [
    { log_date: day(0), calories: 2300, protein: 160, carbs: 270, fat: 68, fibre: 33 },
    { log_date: day(1), calories: 2500, protein: 170, carbs: 290, fat: 72, fibre: 36 },
    { log_date: day(-7), calories: 2200, protein: 150, carbs: 250, fat: 70, fibre: 28 },
  ],
});

async function openNutrition(page, options = {}) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await bootPortal(page, {
    ...options,
    onPortalAction: async (action) => {
      if (action === 'nutrition-history') {
        if (options.fail) return { status: 500, json: { ok: false, error: 'down' } };
        return { json: history() };
      }
      return undefined;
    },
  });
  await page.locator('#profileAvatar').click();
  await page.locator('#profileMenu .profile-menu-list button', { hasText: 'Nutrition' }).click();
  await expect(page.locator('#nutritionModal')).toHaveClass(/open/);
  await expect(page.locator('#profileMenu')).not.toHaveClass(/open/);
  return errors;
}

const body = (page) => page.locator('#nutritionBody');

test('opens on this week with targets, the coach note and what was logged', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await openNutrition(page);
  await expect(page.locator('#nhWeekLabel')).toHaveText('Week 12');
  await expect(page.locator('#nhWeekMarker')).toHaveText('This week');
  await expect(body(page)).toContainText('2,400 kcal');
  await expect(body(page)).toContainText('35-38 g');
  await expect(body(page)).toContainText('Carbs up around the long run.');
  await expect(body(page)).toContainText('2 of 7 days logged');
  // (2300 + 2500) / 2 against a 2,400 target.
  await expect(body(page)).toContainText('2,400 kcal / 2,400 · 100%');
  expect(errors).toEqual([]);
});

test('walks back to a past week and forward to an upcoming one', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openNutrition(page);
  await page.locator('#nhPrevBtn').click();
  await expect(page.locator('#nhWeekLabel')).toHaveText('Week 11');
  await expect(page.locator('#nhWeekMarker')).toBeHidden();
  await expect(body(page)).toContainText('1 of 7 days logged');
  await expect(page.locator('#nhPrevBtn')).toBeDisabled();

  await page.locator('#nhNextBtn').click();
  await page.locator('#nhNextBtn').click();
  await expect(page.locator('#nhWeekLabel')).toHaveText('Week 13');
  await expect(page.locator('#nhWeekMarker')).toHaveText('Upcoming');
  await expect(body(page)).toContainText('Taper week fuel.');
  await expect(body(page)).toContainText('2,500 kcal');
  await expect(body(page)).not.toContainText('What you logged');
  await expect(page.locator('#nhNextBtn')).toBeDisabled();
});

test('a failed read offers a retry instead of a blank sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openNutrition(page, { fail: true });
  await expect(body(page)).toContainText('Nutrition unavailable');
  await expect(body(page).getByRole('button', { name: 'Try again' })).toBeVisible();
});

for (const width of [320, 390]) {
  for (const outdoor of [false, true]) {
    const theme = outdoor ? 'daylight' : 'night';
    test(`${theme}: fits at ${width}px with no horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const errors = await openNutrition(page, { outdoor });
      await expect(body(page)).toContainText('2 of 7 days logged');
      const overflow = await page.evaluate(() => {
        const inner = document.querySelector('#nutritionModal .ql-modal-inner');
        const offenders = [];
        inner.querySelectorAll('*').forEach((node) => {
          if (getComputedStyle(node).overflowX !== 'visible') return;
          if (node.scrollWidth > node.clientWidth + 1) offenders.push(node.className || node.tagName);
        });
        return { page: document.documentElement.scrollWidth > innerWidth + 1, offenders };
      });
      expect(overflow).toEqual({ page: false, offenders: [] });
      await page.screenshot({ path: test.info().outputPath(`nutrition-${theme}-${width}.png`), fullPage: false });
      expect(errors).toEqual([]);
    });
  }
}
