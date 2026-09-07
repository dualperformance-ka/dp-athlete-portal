import { expect, test } from '@playwright/test';

// The milestone ladder ran off the right edge of the recommendation card:
// four flex-shrink:0 nodes with white-space:nowrap labels cannot fit "Increase
// next" once the card is narrow. Measuring scrollWidth against clientWidth
// catches that at every width that matters, not just the one it was designed
// at. A screenshot alone would not: the overflow is clipped, not visible.
const WIDTHS = [320, 360, 390, 414, 430];

const EXERCISE = {
  exercise: 'Rear Delt Fly', sets: '2', workingSets: '2', reps: '10', repRange: '10-14',
};
// Two logged sessions, so the card renders the fullest state it has: a status,
// today's target, the per-set grid, the milestone ladder, the reason, the live
// line and the progress strip.
const HISTORY = [
  { date: '2026-09-01', sets: [{ weight: '39', reps: '13' }, { weight: '39', reps: '14' }] },
  { date: '2026-08-25', sets: [{ weight: '36', reps: '12' }, { weight: '36', reps: '12' }] },
  { date: '2026-08-18', sets: [{ weight: '34', reps: '11' }, { weight: '34', reps: '10' }] },
];

async function renderCard(page) {
  return page.evaluate(({ exercise, history }) => {
    const recommendation = _nsRecommendation(exercise, history[0].sets, exercise.exercise, history);
    recommendation.live = _nsLiveProgress(exercise, [{ weight: '39', reps: '14' }], recommendation, exercise.exercise, history, history[0].sets);
    const host = document.createElement('div');
    host.id = 'fitProbe';
    // The card lives inside .exc .exc-body in the real page; mirror that so the
    // measurement runs against the same cascade and the same width.
    host.className = 'exc open';
    host.style.cssText = 'position:fixed;inset:0 0 auto 0;z-index:99999;background:var(--bg,#111)';
    host.innerHTML = '<div class="exc-body">' + _nsBody(recommendation) + '</div>';
    document.body.appendChild(host);
    return recommendation.milestone ? recommendation.milestone.stage : 0;
  }, { exercise: EXERCISE, history: HISTORY });
}

async function overflowReport(page) {
  return page.evaluate(() => {
    const probe = document.getElementById('fitProbe');
    const offenders = [];
    probe.querySelectorAll('*').forEach((node) => {
      if (node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX === 'visible') {
        offenders.push({
          selector: node.className || node.tagName,
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
        });
      }
    });
    // A label that fits only by splitting a word ("UNLOCKE / D") is still a
    // fitting bug, so measure the longest word against the box it must sit in.
    const splitWords = [];
    probe.querySelectorAll('.ns-ml, .ns-mcur').forEach((label) => {
      // Skip the visually-hidden labels: below 410px the ladder shows one
      // full-width .ns-mcur line instead, and that is what must fit.
      if (label.clientWidth <= 2 || label.offsetParent === null) return;
      const style = getComputedStyle(label);
      const ruler = document.createElement('span');
      ruler.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
      ruler.style.font = style.font;
      ruler.style.letterSpacing = style.letterSpacing;
      ruler.style.textTransform = style.textTransform;
      document.body.appendChild(ruler);
      const longest = label.textContent.trim().split(/\s+/).reduce((widest, word) => {
        ruler.textContent = word;
        return Math.max(widest, ruler.offsetWidth);
      }, 0);
      ruler.remove();
      if (longest > label.clientWidth + 1) {
        splitWords.push({ text: label.textContent.trim(), longestWord: Math.ceil(longest), available: label.clientWidth });
      }
    });

    const block = probe.querySelector('.ns-block');
    const blockBox = block.getBoundingClientRect();
    let widest = 0;
    block.querySelectorAll('*').forEach((node) => {
      const box = node.getBoundingClientRect();
      if (box.width > 0) widest = Math.max(widest, box.right - blockBox.left);
    });
    return { offenders, splitWords, blockWidth: blockBox.width, widestChild: widest, documentScroll: document.documentElement.scrollWidth, viewport: window.innerWidth };
  });
}

for (const width of WIDTHS) {
  test(`the recommendation card fits inside ${width}px without overhang`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/index.html');
    await page.waitForFunction(() => typeof _nsBody === 'function');
    const stage = await renderCard(page);
    expect(stage, 'the milestone ladder should be rendered for this fixture').toBeGreaterThan(0);

    const report = await overflowReport(page);
    expect(report.offenders, `elements overflowing at ${width}px`).toEqual([]);
    expect(report.splitWords, `labels forced to break mid-word at ${width}px`).toEqual([]);
    // Nothing inside the card may extend past the card's own right edge.
    expect(report.widestChild).toBeLessThanOrEqual(report.blockWidth + 1);
    // And the card must never make the page itself scroll sideways.
    expect(report.documentScroll).toBeLessThanOrEqual(report.viewport + 1);

    if (width === 390) await page.locator('#fitProbe .ns-block').screenshot({ path: 'test-results/strength-card-fit-390.png' });
  });
}

test('the milestone labels stay inside the card at a large text setting', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto('/index.html');
  await page.waitForFunction(() => typeof _nsBody === 'function');
  await renderCard(page);
  // Larger type is where the old nowrap labels failed first.
  await page.evaluate(() => {
    const probe = document.getElementById('fitProbe');
    probe.querySelectorAll('.ns-ml').forEach((label) => { label.style.fontSize = '13px'; });
  });
  const report = await overflowReport(page);
  expect(report.offenders).toEqual([]);
  expect(report.widestChild).toBeLessThanOrEqual(report.blockWidth + 1);
  await page.locator('#fitProbe .ns-block').screenshot({ path: 'test-results/strength-card-fit-largetype.png' });
});
