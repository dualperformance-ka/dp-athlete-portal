import { expect, test } from '@playwright/test';

// The weekly volume dropdown clipped its own data. Two places:
//
//   1. the current week's delta — "61.2 so far" in a 40px column rendered as
//      "61...." directly under the bar, so the one live number in the panel was
//      the one number an athlete could not read;
//   2. the collapsed head summary — "Run 61.2 km/64 km planned · Ride 51...."
//      cut mid-figure by a max-width, which reads as a broken app rather than a
//      deliberate abbreviation.
//
// Both are ellipsis on a numeral, and neither is visible in a screenshot at the
// one width a layout gets designed at. Measuring scrollWidth against
// clientWidth on every node that carries a figure catches them at every phone
// width that matters. The same technique guards the strength card's milestone
// ladder in strength-card-fit.spec.js.
const WIDTHS = [320, 360, 375, 390, 414, 430];

const athlete = { ok: true, exists: true, active: true, code: 'KARL', name: 'Karl', auth_mode: 'both', email: 'k@e.com', access_token: 'signed-session' };

// Karl's real block as of week 9: eight completed weeks, a live week at 64km
// planned with 61.2km run, a taper week planned and two weeks not yet written.
const WEEKS = [
  { week: 1, planned: 70, actual: 57.4, isPast: true },
  { week: 2, planned: 78, actual: 79.1, isPast: true },
  { week: 3, planned: 84, actual: 84.0, isPast: true },
  { week: 4, planned: 75, actual: 85.6, isPast: true },
  { week: 5, planned: 87, actual: 88.1, isPast: true },
  { week: 6, planned: 86, actual: 91, isPast: true },
  { week: 7, planned: 80, actual: 82.4, isPast: true },
  { week: 8, planned: 76, actual: 76.8, isPast: true },
  {
    week: 9, planned: 64, actual: 61.2, isCurrent: true,
    coachTargets: [],
    actualBySport: {
      running: { distanceMetres: 61200, sessions: 7, durationMinutes: 326 },
      cycling: { distanceMetres: 51400, sessions: 1, durationMinutes: 151 },
      swimming: { distanceMetres: 3025, sessions: 2, durationMinutes: 67 },
    },
  },
  { week: 10, planned: 40, actual: null, isFuture: true },
  { week: 11, planned: null, actual: null, isFuture: true },
  { week: 12, planned: null, actual: null, isFuture: true },
];

async function login(page) {
  await page.addInitScript(() => {
    window.supabase = { createClient: () => ({ auth: {
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async getSession() { return { data: { session: null } }; }, async signOut() { return { error: null }; } } }) };
  });
  await page.route('**/_vercel/**', r => r.abort());
  await page.route('https://**', r => r.abort());
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body = {}; try { body = route.request().postDataJSON() || {}; } catch (error) {}
    const planned = { rows: [], next: null, prescriptions: { exercises: {}, runSteps: {} } };
    let json = { ok: true };
    if (url.pathname === '/api/auth-athlete') json = url.searchParams.get('action') === 'eligibility' ? { ok: true, enabled: true, eligible: true, active: true } : athlete;
    else if (url.pathname.startsWith('/api/strava')) json = { connected: false, activities: [] };
    else if (url.pathname === '/api/reminders') json = { ok: true, notifications: [], unread: 0 };
    else if (url.pathname === '/api/portal-data') {
      if (body.action === 'bootstrap') json = { ok: true, state: { rows: [], checkins: [] }, bodyLogs: { rows: [] }, nutritionLogs: { rows: [] }, sessionLogs: { rows: [] }, dailyLogged: { body: [], nutrition: [] }, planned, splits: { rows: [] }, changes: { rows: [] }, library: { rows: [], revision: 'e2e' } };
      else json = { ok: true, rows: [], checkins: [], body: [], nutrition: [], planned, splits: { rows: [] }, changes: { rows: [] }, library: { rows: [], revision: 'e2e' } };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) });
  });
  await page.goto('/index.html');
  await page.getByRole('button', { name: 'Use athlete access code' }).click();
  await page.getByLabel('Athlete access code').fill('KARL');
  await page.getByRole('button', { name: 'Enter Portal' }).click();
  await expect(page.locator('#portalScreen')).toBeVisible();
  await page.waitForTimeout(1200);
}

// Mount the dropdown exactly as Training mounts it — same card classes, same
// width — and open it, because a collapsed body measures zero and would pass
// any fit assertion by being invisible.
async function mountStrip(page, { open }) {
  await page.evaluate(({ weeks, open }) => {
    const host = document.getElementById('fitProbe') || document.createElement('div');
    host.id = 'fitProbe';
    host.className = 'card vstrip-card is-collapsible' + (open ? ' is-open' : '');
    host.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99999;margin:0 14px';
    // volumeStripHtml resolves the open week through selectedVolumeWeek, which
    // reads the live programme offset. Pin it so the fixture is the week under
    // test rather than whatever week the clock says.
    window.selectedVolumeWeek = () => weeks.find(w => w.isCurrent);
    host.innerHTML = window.volumeStripHtml({ weeks, targetState: 'ok' }, 'training', true);
    if (!document.getElementById('fitProbe')) document.body.appendChild(host);
  }, { weeks: WEEKS, open });
}

// A node clips its own text when the text is wider than the box and the box is
// not a deliberate scroller. .vstrip-scroll is the one legitimate scroller in
// the panel, so anything inside it is measured but the scroller itself is not.
async function clippedFigures(page) {
  return page.evaluate(() => {
    const probe = document.getElementById('fitProbe');
    const offenders = [];
    probe.querySelectorAll([
      '.vstrip-delta', '.vstrip-km', '.vstrip-wk', '.vstrip-sum', '.vstrip-title', '.vstrip-readout',
      '.sport-target-distance', '.sport-target-distance strong', '.sport-target-name',
      '.sport-target-status', '.sport-target-lock', '.sport-target-record', '.sport-target-clock',
      '.sport-week-clock', '.sport-logged-label', '.sport-logged-sport', '.sport-logged-row b',
      '.sport-logged-meta span', '.vstrip-foot span', '.sport-target-meta span',
    ].join(', ')).forEach((node) => {
      if (node.offsetParent === null || node.clientWidth <= 1) return;
      if (node.scrollWidth > node.clientWidth + 1) {
        offenders.push({ selector: node.className, text: node.textContent.trim(), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth });
      }
    });
    return offenders;
  });
}

async function horizontalOverflow(page) {
  return page.evaluate(() => {
    const probe = document.getElementById('fitProbe');
    const offenders = [];
    probe.querySelectorAll('*').forEach((node) => {
      if (node.offsetParent === null) return;
      if (getComputedStyle(node).overflowX !== 'visible') return;
      if (node.scrollWidth > node.clientWidth + 1) offenders.push({ selector: node.className || node.tagName, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth });
    });
    return offenders;
  });
}

for (const width of WIDTHS) {
  test(`the open weekly volume dropdown never clips a figure at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page);
    await mountStrip(page, { open: true });
    expect(await clippedFigures(page), `clipped figures at ${width}px`).toEqual([]);
    expect(await horizontalOverflow(page), `horizontal overflow at ${width}px`).toEqual([]);
  });

  test(`the collapsed weekly volume head never clips a figure at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page);
    await mountStrip(page, { open: false });
    expect(await clippedFigures(page), `clipped head figures at ${width}px`).toEqual([]);
  });
}

// The live week is the only week whose number is still moving, and it is the
// number the panel exists to show. It must be legible in full, not abbreviated
// away, and it must be the week the eye lands on.
test('the live week reads as the focus of the chart', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await login(page);
  await mountStrip(page, { open: true });
  const current = page.locator('#fitProbe .vstrip-week.is-current');
  await expect(current).toHaveCount(1);
  const box = await current.boundingBox();
  const neighbour = await page.locator('#fitProbe .vstrip-week').nth(0).boundingBox();
  expect(box.width).toBeGreaterThan(neighbour.width);
});

// Opening the drawer used to land the scroller mid-column, cutting the leftmost
// figure through the middle of a digit — offsetLeft is measured from the nearest
// positioned ancestor, which for a week button is the page rather than the
// scroller, so the old arithmetic over-scrolled by the card's own offset.
test('opening the drawer never lands on half a figure', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await login(page);
  await mountStrip(page, { open: false });
  await page.locator('#fitProbe .vstrip-toggle').click();
  await page.waitForTimeout(250);
  const offset = await page.evaluate(() => {
    const scroller = document.querySelector('#fitProbe .vstrip-scroll');
    const edge = scroller.getBoundingClientRect().left;
    let nearest = Infinity;
    scroller.querySelectorAll('.vstrip-week').forEach((week) => {
      const gap = week.getBoundingClientRect().left - edge;
      if (Math.abs(gap) < Math.abs(nearest)) nearest = gap;
    });
    return { nearest, scrollLeft: scroller.scrollLeft, liveVisible: (() => {
      const live = scroller.querySelector('.vstrip-week.is-current').getBoundingClientRect();
      const box = scroller.getBoundingClientRect();
      return live.left >= box.left - 1 && live.right <= box.right + 1;
    })() };
  });
  // A column starts flush with the left edge of the frame...
  expect(Math.abs(offset.nearest), `left edge sits ${offset.nearest}px into a column`).toBeLessThan(1.5);
  // ...and the week the drawer was opened to read is fully in view.
  expect(offset.liveVisible, 'the live week should be wholly visible on open').toBe(true);
});
