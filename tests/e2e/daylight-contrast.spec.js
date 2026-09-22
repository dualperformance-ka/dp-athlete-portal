import { expect, test } from '@playwright/test';
import { bootPortal } from './harness.mjs';

// Daylight ("Indoor" on the Theme control) flips --t-1 to near-black ink. Any
// panel that hard-codes a dark background without a daylight counterpart then
// paints dark ink on a near-black plate, which is what an athlete reports as
// "the card has gone dark and I cannot read it".
//
// This walks every tab in daylight and measures rendered text against the
// background actually painted behind it, rather than trusting the token.
const TABS = ['today', 'week', 'progress', 'nutrition', 'goals', 'handbook', 'comms', 'checkin'];

const PROBE = () => {
  const parseRGB = (value) => {
    const m = String(value).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.some(Number.isNaN)) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  // A gradient resets background-color to transparent, so read the first stop
  // out of the image instead: that is the colour actually painted behind the
  // text at the top of the card.
  const surfaceOf = (node) => {
    const style = getComputedStyle(node);
    const bg = parseRGB(style.backgroundColor);
    if (bg && bg.a >= 0.5) return bg;
    if (style.backgroundImage && style.backgroundImage !== 'none') {
      const stop = parseRGB(style.backgroundImage);
      if (stop && stop.a >= 0.5) return stop;
    }
    return null;
  };
  const behind = (node) => {
    let el = node;
    while (el && el !== document.documentElement) {
      const s = surfaceOf(el);
      if (s) return s;
      el = el.parentElement;
    }
    const root = parseRGB(getComputedStyle(document.body).backgroundColor);
    return root || { r: 255, g: 255, b: 255, a: 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

  const out = [];
  document.querySelectorAll('#portalScreen .tab-content.active *, #portalScreen .top-shell *, #portalScreen header *, .mobile-nav *').forEach((node) => {
    // Own text only: an element whose text lives in children is measured
    // through those children, but a control that mixes an icon with a bare
    // text node (the Strava chip) still has to be measured itself.
    const text = Array.from(node.childNodes)
      .filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    if (!text) return;
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.15) return;
    const box = node.getBoundingClientRect();
    if (box.width < 4 || box.height < 4) return;
    const fg = parseRGB(style.color);
    if (!fg || fg.a < 0.3) return;
    const bg = behind(node);
    const r = ratio(fg, bg);
    if (r < 3) {
      out.push({
        text: text.slice(0, 40),
        sel: node.className || node.tagName,
        color: style.color,
        surface: `rgb(${bg.r},${bg.g},${bg.b})`,
        ratio: Number(r.toFixed(2)),
      });
    }
  });
  return out;
};

test('daylight mode never paints dark ink on a dark panel', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await bootPortal(page, { outdoor: true });
  expect(await page.evaluate(() => document.documentElement.classList.contains('outdoor-mode'))).toBe(true);

  const offenders = {};
  for (const tab of TABS) {
    await page.evaluate(t => switchTab(t), tab);
    await page.waitForTimeout(500);
    const found = await page.evaluate(PROBE);
    if (found.length) offenders[tab] = found;
  }
  await page.screenshot({ path: 'test-results/daylight-progress.png', fullPage: true });
  expect(offenders, 'text below 3:1 against the panel painted behind it').toEqual({});
});

// Bite-proof: the same walk must FIND an offender when a panel is painted with
// night's plate in daylight, which is exactly the defect this guards against.
// If this passes, the measurement above proves nothing.
test('the daylight walk actually bites when a panel keeps night paint', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await bootPortal(page, { outdoor: true });
  await page.evaluate(t => switchTab(t), 'progress');
  await page.waitForTimeout(500);
  expect(await page.evaluate(PROBE)).toEqual([]);
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.textContent = '#tab-progress .progress-card{background:linear-gradient(155deg,rgba(26,25,24,.92),rgba(13,12,12,.92))!important}';
    document.head.appendChild(s);
  });
  const found = await page.evaluate(PROBE);
  expect(found.length, 'the walk should see dark ink on the night plate').toBeGreaterThan(0);
});
