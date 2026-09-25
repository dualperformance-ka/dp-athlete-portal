import { expect, test } from '@playwright/test';

// Direction A: target-first logger. The exercise opens as its own full-screen
// view inside the focused session, and everything needed mid-set — the target,
// every set row and the log button — has to be on one phone screen without
// scrolling. These run at the phone sizes that matter and fail on any page
// error, because a view that throws halfway still passes every static check.

function localISO(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Adelaide', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
const today = localISO();
const athlete = { ok: true, exists: true, active: true, code: 'KARL', name: 'Karl', auth_mode: 'both', email: 'karl@example.com', access_token: 'signed-session' };

const row = { exercise: 'Low Machine Row', sets: '4', reps: '8', repRange: '8-12', warmupSets: '2', workingSets: '2', rest: '90s', notes: 'First 2 sets warm-up' };
const dips = { exercise: 'Machine Dips', sets: '2', reps: '8', repRange: '8-12', warmupSets: '0', workingSets: '2', rest: '90s', notes: '' };
const pec = { exercise: 'Pec Dec', sets: '3', reps: '8', repRange: '8-12', warmupSets: '1', workingSets: '2', rest: '90s', notes: 'First set warm-up' };

async function mockPortal(page, exercises) {
  await page.addInitScript(() => {
    window.supabase = { createClient() { return { auth: {
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async getSession() { return { data: { session: null } }; },
      async signOut() { return { error: null }; },
    } }; } };
  });
  for (const host of ['**/_vercel/**', 'https://fonts.googleapis.com/**', 'https://fonts.gstatic.com/**', 'https://browser.sentry-cdn.com/**', 'https://cdn.jsdelivr.net/**']) {
    await page.route(host, route => route.abort());
  }
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    let body = {};
    try { body = request.postDataJSON() || {}; } catch (error) {}
    let json = { ok: true };
    if (url.pathname === '/api/auth-athlete') {
      json = url.searchParams.get('action') === 'eligibility' ? { ok: true, enabled: true, eligible: true, active: true } : athlete;
    } else if (url.pathname === '/api/portal-data') {
      const action = body.action;
      if (action === 'bootstrap') json = { ok: true, state: { rows: [], checkins: [] }, bodyLogs: { rows: [] }, nutritionLogs: { rows: [] }, sessionLogs: { rows: [] }, dailyLogged: { body: [], nutrition: [] } };
      else if (action === 'training-read') json = {
        planned: { rows: [{ id: 'session-1', notion_page_id: 'session-1', title: 'Upper A', planned_date: today, session_type: 'strength', status: 'Planned', week_label: 'Week 3', notes: '' }], next: null, prescriptions: { exercises: {}, runSteps: {} } },
        splits: { rows: [{ name: 'Upper A', athlete_code: null, exercises }] },
        changes: { rows: [] }, library: { rows: [], revision: 'e2e', notModified: false }, errors: [],
      };
      else if (action === 'state-read') json = { ok: true, rows: [], checkins: [] };
      else if (['body-logs', 'nutrition-logs', 'session-logs-read', 'nutrition-week', 'weekly-sport-targets', 'programme-data', 'booking-sync', 'booking-read'].includes(action)) json = { ok: true, rows: [] };
      else if (action === 'daily-log-dates') json = { ok: true, body: [], nutrition: [] };
    } else if (url.pathname.startsWith('/api/strava')) {
      json = { ok: true, connected: false, activities: [] };
    }
    await route.fulfill({ json });
  });
}

async function login(page, exercises, history) {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await mockPortal(page, exercises);
  await page.goto('/index.html');
  await page.getByRole('button', { name: 'Use athlete access code' }).click();
  await page.getByLabel('Athlete access code').fill('KARL');
  await page.getByRole('button', { name: 'Enter Portal' }).click();
  await expect(page.locator('#portalScreen')).toBeVisible();
  await expect(page.getByText('Upper A', { exact: true }).first()).toBeVisible();
  if (history) {
    await page.evaluate((entries) => {
      entries.forEach(entry => {
        allSessions.push({ id: entry.id, date: entry.date });
        logs[entry.id] = { ...entry.log, __sessionDate: entry.date };
      });
    }, history);
  }
  await page.getByRole('button', { name: 'Open Upper A' }).click();
  await expect(page.locator('#focusOverlay')).toHaveClass(/open/);
  return errors;
}

const rowHistory = [{ id: 'past-row', date: '2026-09-21', log: { 'Low Machine Row': [
  { weight: '13.6', reps: '12', done: true }, { weight: '33.6', reps: '9', done: true },
  { weight: '38.6', reps: '9', done: true, effort: 'on_target' }, { weight: '38.6', reps: '9', done: true },
] } }];

const fits = [
  { width: 390, height: 844, rpe: false }, { width: 375, height: 812, rpe: false }, { width: 360, height: 780, rpe: false },
  { width: 390, height: 844, rpe: true }, { width: 360, height: 780, rpe: true },
];
for (const { rpe, ...size } of fits) {
  test(`the exercise view fits one screen at ${size.width}×${size.height}, RPE ${rpe ? 'on' : 'off'}`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.addInitScript((on) => localStorage.setItem('dp_strength_rpe_enabled', on ? 'true' : 'false'), rpe);
    const errors = await login(page, [row, dips], rowHistory);

    // The list leads with the Up next card; nothing is expanded inline.
    const up = page.locator('.exc.is-up-next');
    await expect(up).toContainText('Low Machine Row');
    await expect(up.locator('.exl-up-start')).toBeVisible();
    await up.locator('.exc-summary').click();

    const card = page.locator('.exc.is-focused');
    await expect(card.locator('.exl-target')).toContainText('Today’s target · per work set');
    await expect(card.locator('.exl-target')).toContainText('Stop with 2 reps left in the tank (RPE 8)');
    await expect(card.locator('.exl-rule')).toHaveText('Hit 12 on both work sets to go up');
    await expect(card.locator('.snum')).toHaveText(['WU 1', 'WU 2', 'Work 1', 'Work 2']);
    await expect(card.locator('.slast').nth(2)).toHaveText('38.6 × 9');
    // Nothing in the table is clipped: every LAST value and every input fits its cell.
    const clipped = await card.evaluate((node) => [...node.querySelectorAll('.slast, .sin, .rpe-in')]
      .filter(el => el.offsetParent && el.scrollWidth > el.clientWidth + 1).map(el => el.id || el.textContent));
    expect(clipped).toEqual([]);
    await expect(card.locator('.exl-log')).toHaveText(/Log WU 1/i);

    // Everything needed mid-set is on screen without scrolling: the title,
    // the target card, every set row and both tiles sit above the dock, and
    // the dock sits inside the viewport. Only "+ Add bonus set" may be below.
    const fit = await card.evaluate((node) => {
      const box = (sel) => { const el = node.querySelector(sel); return el ? el.getBoundingClientRect() : null; };
      const rows = node.querySelectorAll('.setrow');
      const scroll = document.getElementById('focusOverlayScroll');
      return {
        scrollTop: scroll.scrollTop,
        head: box('.exl-head').top,
        lastRow: rows[rows.length - 1].getBoundingClientRect().bottom,
        tiles: box('.exl-tiles').bottom, dock: box('.exl-dock').bottom, dockTop: box('.exl-dock').top,
        wide: document.documentElement.scrollWidth - window.innerWidth,
        small: [...node.querySelectorAll('.exl-view input, .exl-view button, .exl-dock button')]
          .filter(el => el.offsetParent && !el.closest('.set-effort') && !el.classList.contains('del-set'))
          .map(el => ({ id: el.id || el.className, h: Math.round(el.getBoundingClientRect().height) }))
          .filter(item => item.h < 44),
      };
    });
    expect(fit.scrollTop).toBe(0);
    expect(fit.head).toBeGreaterThanOrEqual(0);
    expect(fit.lastRow, 'last set row hidden behind the dock').toBeLessThanOrEqual(fit.dockTop);
    expect(fit.tiles, 'tiles hidden behind the dock').toBeLessThanOrEqual(fit.dockTop);
    expect(fit.dock).toBeLessThanOrEqual(size.height + 1);
    expect(fit.wide).toBeLessThanOrEqual(0);
    expect(fit.small, 'tap targets under 44px').toEqual([]);
    await page.screenshot({ path: `test-results/exercise-logger-${size.width}-rpe-${rpe ? 'on' : 'off'}.png` });
    expect(errors).toEqual([]);
  });
}

test('the dock logs the current row, advances, and finishes into one result card', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
  const errors = await login(page, [row, dips], rowHistory);
  await page.locator('.exc.is-up-next .exc-summary').click();
  const card = page.locator('.exc.is-focused');
  const dock = card.locator('.exl-log');

  await page.locator('#w_0_0_0').fill('23.6');
  await page.locator('#r_0_0_0').fill('10');
  await dock.click();
  await expect(page.locator('#st_0_0_0')).toHaveClass(/\bon\b/);
  await expect(card.locator('.exl-dock-note')).toContainText('sends to your coaches when you submit');
  await expect(dock).toHaveText(/Log WU 2/i);
  await expect(page.locator('#sr_0_0_1')).toHaveClass(/is-current/);

  await page.locator('#w_0_0_1').fill('33.6');
  await page.locator('#r_0_0_1').fill('8');
  await dock.click();
  await expect(dock).toHaveText(/Log Work set 1/i);

  // Work set 1: kg left as the target hint. Logging it records the target.
  await page.locator('#r_0_0_2').fill('12');
  await dock.click();
  await expect(page.getByRole('button', { name: /On target/ })).toBeVisible();
  await page.getByRole('button', { name: /On target/ }).click();
  if (!(await page.locator('#st_0_0_2').evaluate(el => el.classList.contains('on')))) await dock.click();
  await expect(page.locator('#w_0_0_2')).toHaveValue('38.6');
  await expect(dock).toHaveText(/Log Work set 2/i);

  await page.locator('#r_0_0_3').fill('11');
  await dock.click();
  await expect(dock).toHaveText(/Finish exercise/i);

  const result = card.locator('.exl-result');
  await expect(result).toBeVisible();
  await expect(result).toContainText('23 work reps · beat last session by 5');
  await expect(result.locator('.exl-next-action')).not.toBeEmpty();
  await expect(card.locator('.exl-target')).toBeHidden();
  await page.screenshot({ path: 'test-results/exercise-logger-finished.png' });

  // Finish returns to the list at the same place, with the next exercise up.
  await dock.click();
  await expect(page.locator('#focusOverlay')).not.toHaveClass(/exercise-open/);
  await expect(page.locator('.exc.is-up-next')).toContainText('Machine Dips');
  await expect(page.locator('.exlist-label[data-exl-label="done"]')).toContainText('Done · 1');
  await expect(page.locator('#focusFooterTitle')).toHaveText('Draft saved on this device');
  await page.screenshot({ path: 'test-results/exercise-logger-list.png' });
  expect(errors).toEqual([]);
});

test('next-time badges follow direction against the load just lifted, not the engine tone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
  // Today's sessions already logged: Pec Dec missed the floor (engine: red
  // "Build the reps", stay at 87) and Machine Dips is a rep build at 81.8.
  // Both next loads equal what was just lifted, so both are holds.
  const errors = await login(page, [pec, dips], [{ id: 'past', date: '2026-09-21', log: {
    'Pec Dec': [{ weight: '75', reps: '10', done: true }, { weight: '89', reps: '10', done: true, effort: 'on_target' }, { weight: '89', reps: '6', done: true }],
    'Machine Dips': [{ weight: '82.8', reps: '8', done: true, effort: 'on_target' }, { weight: '82.8', reps: '9', done: true }],
  } }]);
  await page.evaluate(() => {
    logs['session-1'] = {
      'Pec Dec': [{ weight: '59', reps: '12', done: true }, { weight: '87', reps: '8', done: true, effort: 'on_target' }, { weight: '87', reps: '7', done: true }],
      'Machine Dips': [{ weight: '81.8', reps: '8', done: true, effort: 'on_target' }, { weight: '81.8', reps: '10', done: true }],
      __sessionDate: document.getElementById('gym_date_0')?.value,
    };
  });
  await page.getByRole('button', { name: 'Close session' }).click();
  await page.getByRole('button', { name: /Open .*Upper A/ }).click();

  const pecBadge = page.locator('.exc[data-exercise-index="0"] .exl-badge');
  const dipsBadge = page.locator('.exc[data-exercise-index="1"] .exl-badge');
  await expect(pecBadge).toHaveAttribute('data-dir', 'hold');
  await expect(pecBadge).toHaveText('=87');
  await expect(dipsBadge).toHaveAttribute('data-dir', 'hold');
  await expect(dipsBadge).toHaveText('=81.8');
  await expect(page.locator('.exl-key')).toContainText('up');
  expect(errors).toEqual([]);
});

test('typed kg and reps survive closing the app until logged', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
  const errors = await login(page, [row], rowHistory);
  await page.locator('.exc.is-up-next .exc-summary').click();
  await page.locator('#w_0_0_0').fill('25');
  await page.locator('#r_0_0_0').fill('9');
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.locator('#portalScreen')).toBeVisible();
  await page.getByRole('button', { name: /Open .*Upper A/ }).click();
  await page.locator('.exc[data-exercise-index="0"] .exc-summary').click();
  await expect(page.locator('#w_0_0_0')).toHaveValue('25');
  await expect(page.locator('#r_0_0_0')).toHaveValue('9');
  expect(errors).toEqual([]);
});

test('back returns to the list at the same scroll position, and the sheet holds what moved', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
  const many = [row, dips, pec, { ...dips, exercise: 'Lat Pulldown' }, { ...dips, exercise: 'Cable Curl' }];
  const errors = await login(page, many, rowHistory);
  const scroll = page.locator('#focusOverlayScroll');
  const target = page.locator('.exc[data-exercise-index="4"] .exc-summary');
  await target.scrollIntoViewIfNeeded();
  const before = await scroll.evaluate(el => el.scrollTop);
  expect(before).toBeGreaterThan(0);
  await target.click();
  expect(await scroll.evaluate(el => el.scrollTop)).toBe(0);
  await expect(page.locator('#focusOverlay')).toHaveClass(/exercise-open/);

  await page.getByRole('button', { name: 'Why this load' }).click();
  const sheet = page.locator('#exlSheet_0_4');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Next session');
  await expect(sheet.getByRole('button', { name: 'Stats' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Close details' }).click();
  await expect(sheet).toBeHidden();

  await page.getByRole('button', { name: 'Back to session' }).click();
  await expect(page.locator('#focusOverlay')).not.toHaveClass(/exercise-open/);
  expect(await scroll.evaluate(el => el.scrollTop)).toBe(before);
  expect(errors).toEqual([]);
});

test('swapping from the sheet repaints the title, target and table in place', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await login(page, [{ ...pec, alts: ['Cable fly', 'Chest fly machine'] }], null);
  await page.locator('.exc.is-up-next .exc-summary').click();
  await page.locator('#w_0_0_1').fill('40');
  await page.getByRole('button', { name: 'Swap' }).click();
  const sheet = page.locator('#exlSheet_0_0');
  await expect(sheet.locator('[data-exl-section="swap"]')).toBeVisible();
  await sheet.getByRole('button', { name: 'Cable fly', exact: true }).click();
  await sheet.getByRole('button', { name: 'Close details' }).click();
  const card = page.locator('.exc.is-focused');
  await expect(card.locator('.exl-name')).toHaveText('Cable fly');
  await expect(card.locator('.exl-slbls')).toBeVisible();
  await expect(card.locator('.exl-target')).toBeVisible();
  await expect(card.locator('.snum')).toHaveText(['WU 1', 'Work 1', 'Work 2']);
  expect(errors).toEqual([]);
});
