import { expect, test } from '@playwright/test';
import { bootPortal } from './harness.mjs';

// A calendar row is three things on ONE line: the type mark, the session name
// and its detail, then the status marks. The grid that lays it out must declare
// a track for each of them — with one track missing the marks wrap onto a
// second implicit row and the name is pushed into the `auto` track, so the tick
// floats under the text and the name reads right-aligned.
const SIZES = [
  { name: 'iPhone SE', width: 375, height: 667 },
  { name: 'iPhone 15 Pro', width: 393, height: 852 },
  { name: 'iPhone 15 Pro Max', width: 430, height: 932 },
];

for (const size of SIZES) {
  for (const outdoor of [false, true]) {
    const theme = outdoor ? 'daylight' : 'night';
    test(`${theme}: every session row lays mark, name and status on one line on ${size.name}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await bootPortal(page, { outdoor });
      await page.evaluate(() => goTrainingPlan());
      await page.waitForTimeout(900);

      const rows = page.locator('#weeklyCalEl .mobile-week-session');
      expect(await rows.count()).toBeGreaterThan(0);

      const report = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('#weeklyCalEl .mobile-week-session').forEach((button) => {
          const style = getComputedStyle(button);
          const mark = button.querySelector('.session-mark');
          const copy = button.querySelector(':scope>span:not(.mobile-week-session-marks)');
          const marks = button.querySelector('.mobile-week-session-marks');
          const box = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
          out.push({
            name: (copy && copy.textContent.trim().slice(0, 24)) || '',
            tracks: style.gridTemplateColumns.split(' ').length,
            rowCount: style.gridTemplateRows.split(' ').length,
            mark: mark ? box(mark) : null,
            copy: copy ? box(copy) : null,
            marks: marks ? box(marks) : null,
            buttonWidth: button.getBoundingClientRect().width,
          });
        });
        return out;
      });

      for (const row of report) {
        expect(row.tracks, `${row.name}: the row needs a track for the mark, the copy and the status`).toBe(3);
        expect(row.rowCount, `${row.name}: nothing may wrap onto a second grid row`).toBe(1);
        // Reading order left to right, and the copy takes the slack.
        expect(row.mark.right, `${row.name}: the type mark sits left of the name`).toBeLessThanOrEqual(row.copy.left + 1);
        expect(row.copy.right, `${row.name}: the status marks sit right of the name`).toBeLessThanOrEqual(row.marks.left + 1);
        expect(row.copy.width, `${row.name}: the name takes the free space, not the mark`).toBeGreaterThan(row.buttonWidth * 0.45);
      }

      if (size.name === 'iPhone 15 Pro') await page.locator('#weeklyCalEl').screenshot({ path: `test-results/week-rows-${theme}.png` });
    });
  }
}

// Bite-proof: with a track missing, the same measurement must fail — the marks
// wrap to a second implicit row and the copy is squeezed into `auto`.
test('the row measurement actually bites when a grid track is missing', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await bootPortal(page, {});
  await page.evaluate(() => goTrainingPlan());
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.textContent = '#weeklyCalEl .mobile-week-session{grid-template-columns:minmax(0,1fr) auto!important}';
    document.head.appendChild(s);
  });
  const broken = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('#weeklyCalEl .mobile-week-session').forEach((b) => {
      const s = getComputedStyle(b);
      out.push({ tracks: s.gridTemplateColumns.split(' ').length, rows: s.gridTemplateRows.split(' ').length });
    });
    return out;
  });
  expect(broken.length).toBeGreaterThan(0);
  expect(broken.every(r => r.tracks === 2 && r.rows === 2), 'the marks should wrap onto a second row').toBe(true);
});
