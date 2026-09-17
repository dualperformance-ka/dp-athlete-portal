import { expect, test } from '@playwright/test';

// Phase 1 step 1 raised three 10px declarations to the 12px floor. Both sit in
// tight tracks: .focus-overlay-meta is the `auto` column of a 3-column grid
// whose middle track is minmax(0,1fr), and .exercise-history-mini is a
// space-between flex row next to a fixed 78px sparkline. Measure, at every
// phone width, that nothing overflows and that the meta text is not clipped.
const WIDTHS = [320, 360, 390, 414, 430];

const OVERLAY = `
<div class="focus-overlay-bar">
  <button class="focus-close" aria-label="Close session">&times;</button>
  <div class="focus-overlay-title"><small>Session</small><strong>Lower Body Strength A</strong>
    <div class="focus-progress"><i style="width:40%"></i></div></div>
  <div class="focus-overlay-meta"><strong>3 of 7 done</strong><small>42:18 elapsed</small></div>
</div>`;

const HISTORY = `
<div class="exercise-history-mini"><div><small>Top-load trend</small><strong>34 &rarr; 39kg</strong></div>
<svg viewBox="0 0 100 32" role="img" aria-label="Recent top load trend"><polyline points="0,28 33,20 66,10 100,4"></polyline></svg></div>`;

async function mount(page, outdoor) {
  await page.evaluate(({ overlay, history, outdoor }) => {
    document.documentElement.classList.toggle('outdoor-mode', outdoor);
    const host = document.createElement('div');
    host.id = 'fitProbe';
    host.style.cssText = 'position:fixed;inset:0 0 auto 0;z-index:99999;background:var(--g-0,#111)';
    host.innerHTML = overlay + '<div class="exc open" style="padding:12px"><div class="exc-body">' + history + '</div></div>';
    document.body.appendChild(host);
  }, { overlay: OVERLAY, history: HISTORY, outdoor });
}

async function report(page) {
  return page.evaluate(() => {
    const probe = document.getElementById('fitProbe');
    const offenders = [];
    probe.querySelectorAll('*').forEach((node) => {
      const style = getComputedStyle(node);
      if (style.overflowX !== 'visible' || node.tagName === 'svg') return;
      if (node.scrollWidth > node.clientWidth + 1) offenders.push({ sel: node.className || node.tagName, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth });
      if (node.scrollHeight > node.clientHeight + 1 && style.overflowY === 'visible' && node.children.length === 0) {
        offenders.push({ sel: node.className || node.tagName, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, axis: 'y' });
      }
    });
    const sizes = {};
    ['.focus-overlay-meta strong', '.focus-overlay-meta small', '.exercise-history-mini small'].forEach((sel) => {
      const el = probe.querySelector(sel);
      sizes[sel] = el ? getComputedStyle(el).fontSize : null;
    });
    return { offenders, sizes, documentScroll: document.documentElement.scrollWidth, viewport: window.innerWidth };
  });
}

for (const outdoor of [false, true]) {
  const theme = outdoor ? 'outdoor' : 'indoor';
  for (const width of WIDTHS) {
    test(`${theme}: the 12px floor does not clip the focus overlay or history row at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/index.html');
      await mount(page, outdoor);
      const r = await report(page);
      expect(r.sizes['.focus-overlay-meta strong'], 'meta strong must sit on the 12px floor').toBe('12px');
      expect(r.sizes['.focus-overlay-meta small'], 'meta small must sit on the 12px floor').toBe('12px');
      expect(r.sizes['.exercise-history-mini small'], 'history label must sit on the 12px floor').toBe('12px');
      expect(r.offenders, `overflowing at ${width}px`).toEqual([]);
      expect(r.documentScroll).toBeLessThanOrEqual(r.viewport + 1);
      if (width === 390) await page.locator('#fitProbe').screenshot({ path: `test-results/contrast-fit-${theme}-390.png` });
    });
  }
}

// Bite-proof: the same measurement must FAIL when the type is pushed past what
// the tracks can hold. If this passes, the probe above proves nothing.
test('the overflow probe actually bites when the type is pushed too far', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/index.html');
  await mount(page, false);
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.textContent = '#fitProbe .focus-overlay-meta strong,#fitProbe .focus-overlay-meta small,#fitProbe .exercise-history-mini small{font-size:34px}';
    document.head.appendChild(s);
  });
  const r = await report(page);
  expect(r.offenders.length, 'the probe should see overflow at 34px').toBeGreaterThan(0);
});
