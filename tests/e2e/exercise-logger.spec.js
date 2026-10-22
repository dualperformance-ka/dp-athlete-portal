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

    // The session opens with the next exercise already expanded in the list.
    const card = page.locator('.exc.is-up-next');
    await expect(card).toContainText('Low Machine Row');
    await expect(card).toHaveClass(/\bopen\b/);
    // Today's plan: the load, the engine's exact target for each working set,
    // then the range and effort, then the condition that moves the load.
    const target = card.locator('.exl-target');
    await expect(target.locator('.exl-label')).toHaveText('Today’s plan');
    await expect(target.locator('.exl-now')).toHaveText('Now: warm-up 1 of 2');
    await expect(target.locator('.exl-big').first()).toHaveText('38.6');
    await expect(target.locator('.exl-set')).toHaveText([/^Work 1 10 reps$/, /^Work 2 9 reps$/]);
    await expect(target.locator('.exl-effort')).toContainText('Range 8–12 · Stop with about 2 clean reps left');
    await expect(card.locator('.exl-rule')).toHaveText('Reach 12 / 12 at this effort to unlock the next weight.');
    await expect(card.locator('.exl-stage')).toHaveText('Build reps');
    // The target is visible text, not only input placeholders.
    expect(await target.evaluate(el => el.querySelectorAll('input').length)).toBe(0);
    await expect(card.locator('.snum')).toHaveText(['WU 1', 'WU 2', 'Work 1', 'Work 2']);
    await expect(card.locator('.slast').nth(2)).toHaveText('38.6 × 9');
    // Nothing in the table is clipped: every LAST value and every input fits its cell.
    const clipped = await card.evaluate((node) => [...node.querySelectorAll('.slast, .sin, .rpe-in, .exl-set, .exl-now, .exl-line, .exl-rule, .exl-effort')]
      .filter(el => el.offsetParent && el.scrollWidth > el.clientWidth + 1).map(el => el.id || el.textContent));
    expect(clipped).toEqual([]);
    // No Log button: finishing a row logs it. The dock only holds the rest timer.
    await expect(page.locator('.exl-log')).toHaveCount(0);
    await expect(card.locator('.exl-dock .exl-rest')).toBeVisible();

    // Everything needed mid-set is on screen without scrolling: the exercise
    // row, the target card, every set row and both tiles sit between the
    // header and the dock. Only "+ Add bonus set" may be below.
    const fit = await card.evaluate((node) => {
      const box = (sel) => { const el = node.querySelector(sel); return el ? el.getBoundingClientRect() : null; };
      const rows = node.querySelectorAll('.setrow');
      const scroll = document.getElementById('focusOverlayScroll');
      return {
        head: node.querySelector('.exc-summary').getBoundingClientRect().top - scroll.getBoundingClientRect().top,
        lastRow: rows[rows.length - 1].getBoundingClientRect().bottom,
        tiles: box('.exl-tiles').bottom, dock: box('.exl-dock').bottom, dockTop: box('.exl-dock').top,
        wide: document.documentElement.scrollWidth - window.innerWidth,
        small: [...node.querySelectorAll('.exl-view input, .exl-view button, .exl-dock button')]
          .filter(el => el.offsetParent && !el.closest('.set-effort') && !el.classList.contains('del-set') && !el.classList.contains('exl-pref') /* 26px pill, 44px touch area via ::after */)
          .map(el => ({ id: el.id || el.className, h: Math.round(el.getBoundingClientRect().height) }))
          .filter(item => item.h < 44),
      };
    });
    expect(fit.head, 'exercise row hidden under the header').toBeGreaterThanOrEqual(0);
    expect(fit.lastRow, 'last set row hidden behind the dock').toBeLessThanOrEqual(fit.dockTop);
    expect(fit.tiles, 'tiles hidden behind the dock').toBeLessThanOrEqual(fit.dockTop);
    expect(fit.dock).toBeLessThanOrEqual(size.height + 1);
    expect(fit.wide).toBeLessThanOrEqual(0);
    expect(fit.small, 'tap targets under 44px').toEqual([]);
    await page.screenshot({ path: `test-results/exercise-logger-${size.width}-rpe-${rpe ? 'on' : 'off'}.png` });
    expect(errors).toEqual([]);
  });
}

for (const size of [{ width: 360, height: 740 }, { width: 390, height: 800 }, { width: 360, height: 780 }, { width: 375, height: 812 }, { width: 390, height: 844 }]) {
  test(`the final working set stays on screen while the effort question is open · ${size.width}×${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
    const errors = await login(page, [row, dips], rowHistory);
    for (const [si, reps] of [[0, '10'], [1, '8'], [2, '12']]) {
      await page.locator(`#r_0_0_${si}`).fill(reps);
      await page.locator(`#r_0_0_${si}`).blur();
    }
    // Include shorter viewports: the picker must not leave later sets
    // behind the sticky rest dock after focus leaves the set inputs.
    const options = page.locator('#effort_0_0_2 .set-effort-options');
    await expect(options).toBeVisible();
    await page.waitForTimeout(400);
    const m = await page.locator('.exc.exl.open').evaluate((node) => {
      const rows = node.querySelectorAll('.setrow');
      return {
        last: rows[rows.length - 1].getBoundingClientRect().bottom,
        dockTop: node.querySelector('.exl-dock').getBoundingClientRect().top,
        wide: document.documentElement.scrollWidth - window.innerWidth,
        buttons: [...node.querySelectorAll('#effort_0_0_2 .set-effort-options button')].map(b => Math.round(b.getBoundingClientRect().height)),
      };
    });
    expect(m.last, 'final working set hidden behind the dock with the question open').toBeLessThanOrEqual(m.dockTop);
    expect(m.wide).toBeLessThanOrEqual(0);
    expect(Math.min(...m.buttons), 'answer buttons under 44px').toBeGreaterThanOrEqual(44);
    expect(errors).toEqual([]);
  });
}

for (const size of [{ width: 390, height: 844 }, { width: 360, height: 780 }]) {
  test(`a submit control is always reachable, even with an exercise open · ${size.width}×${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
    const errors = await login(page, [row, dips], rowHistory);
    // Entering the session opens the first exercise, which stands the footer down.
    await expect(page.locator('#focusOverlay')).toHaveClass(/has-open-exercise/);
    await expect(page.locator('#focusFooterAction')).toBeHidden();
    // Log a set so there is something to send.
    await page.locator('#w_0_0_0').fill('13.6');
    await page.locator('#r_0_0_0').fill('12');
    await expect(page.locator('#st_0_0_0')).toHaveClass(/\bon\b/, { timeout: 3000 });
    // At the end of the list, where an athlete looks for it, submit is there.
    const inline = page.locator('#sb_0');
    await inline.scrollIntoViewIfNeeded();
    await expect(inline).toBeVisible();
    await expect(inline).toHaveText(/Review & submit/i);
    const box = await inline.boundingBox();
    expect(box.height, 'submit under 44px').toBeGreaterThanOrEqual(44);
    await inline.click();
    await expect(page.locator('#strengthReviewTitle')).toHaveText('Review session');
    await page.locator('.strength-review-secondary').click();
    // With no exercise open the footer returns and the inline copy steps back,
    // so there is never a second, competing submit on screen.
    await page.locator('.exc.exl.open .exc-summary').click();
    await expect(page.locator('#focusOverlay')).not.toHaveClass(/has-open-exercise/);
    await expect(page.locator('#focusFooterAction')).toBeVisible();
    await expect(inline).toBeHidden();
    expect(errors).toEqual([]);
  });
}

test('ticking a row logs it, advances, and the done exercise closes itself', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
  const errors = await login(page, [row, dips], rowHistory);
  const card = page.locator('.exc[data-exercise-index="0"]');
  await expect(card).toHaveClass(/\bopen\b/);
  await expect(page.locator('.exl-log')).toHaveCount(0);

  // Type, then tap the tick straight away. The tap blurs the reps box, whose
  // change event can already tick the row; the tap must not untick it again.
  await page.locator('#w_0_0_0').fill('23.6');
  await page.locator('#r_0_0_0').fill('10');
  await page.locator('#st_0_0_0').click();
  await expect(page.locator('#st_0_0_0')).toHaveClass(/\bon\b/);
  await page.waitForTimeout(400);
  await expect(page.locator('#st_0_0_0')).toHaveClass(/\bon\b/);
  await expect(card.locator('.exl-dock .exl-rest')).toHaveClass(/is-running/);
  await expect(card.locator('.exl-dock .exl-rest span')).not.toHaveText('1:30');
  await expect(card.locator('.exl-dock-note')).toContainText('Set saved');
  await expect(page.locator('#sr_0_0_1')).toHaveClass(/is-current/);

  await page.locator('#w_0_0_1').fill('33.6');
  await page.locator('#r_0_0_1').fill('8');
  await page.locator('#st_0_0_1').click();
  await expect(page.locator('#st_0_0_1')).toHaveClass(/\bon\b/);
  await expect(page.locator('#sr_0_0_2')).toHaveClass(/is-current/);

  // Work set 1: kg left as the target hint. Ticking it records the target.
  await page.locator('#r_0_0_2').fill('12');
  await page.locator('#st_0_0_2').click();
  await expect(page.locator('#effort_0_0_2').getByText('How many clean reps did you have left?')).toBeVisible();
  await expect(page.getByRole('button', { name: /^About 2 reps left/ })).toBeVisible();
  await page.getByRole('button', { name: /^About 2 reps left/ }).click();
  if (!(await page.locator('#st_0_0_2').evaluate(el => el.classList.contains('on')))) await page.locator('#st_0_0_2').click();
  await expect(page.locator('#st_0_0_2')).toHaveClass(/\bon\b/);
  await expect(page.locator('#w_0_0_2')).toHaveValue('38.6');

  // Last set: no finish or submit step. The exercise closes itself, the
  // next one is up, and nothing is sent until Review & submit at the end.
  await page.locator('#r_0_0_3').fill('11');
  await page.locator('#st_0_0_3').click();
  await expect(card).not.toHaveClass(/\bopen\b/);
  await expect(page.locator('#w_0_0_3')).toHaveValue('38.6');
  await expect(card.locator('.exl-badge')).toBeVisible();
  // The collapsed line is working sets only: the 23.6 × 10 and 33.6 × 8
  // warm-ups are not progression evidence.
  await expect(card.locator('.ns-sum')).toHaveText('38.6kg × 12 · 11');
  await expect(page.locator('.exc.is-up-next')).toContainText('Machine Dips');
  await expect(page.locator('.exc.is-up-next')).toBeInViewport();

  // Reopening a done exercise shows its one result card; tapping it closes it.
  await card.locator('.exc-summary').click();
  const result = card.locator('.exl-result');
  await expect(result).toBeVisible();
  await expect(result).toContainText('23 working-set reps · beat last session by 5');
  await expect(result.locator('.exl-next-action')).toHaveText('Stay at 38.6kg');
  await expect(result.locator('.exl-next-kind')).toHaveText('Stay at this weight');
  await expect(result.locator('.exl-next .exl-set')).toHaveText([/^Work 1 12 reps$/, /^Work 2 12 reps$/]);
  await expect(result.locator('.exl-next-rule')).toHaveText('One more clean rep on Work 2 at this effort unlocks the next weight.');
  await expect(card.locator('.exl-target')).toBeHidden();
  await page.screenshot({ path: 'test-results/exercise-logger-finished.png' });
  await card.locator('.exc-summary').click();
  await expect(card).not.toHaveClass(/\bopen\b/);
  await expect(page.locator('.exlist-label[data-exl-label="done"]')).toContainText('Done · 1');
  await expect(page.locator('#focusFooterTitle')).toHaveText('Draft saved on this device');
  await page.screenshot({ path: 'test-results/exercise-logger-list.png' });
  expect(errors).toEqual([]);
});

test('a ticked row can still be unticked on purpose', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
  const errors = await login(page, [row, dips], rowHistory);
  await page.locator('#w_0_0_0').fill('23.6');
  await page.locator('#r_0_0_0').fill('10');
  await page.locator('#st_0_0_0').click();
  await expect(page.locator('#st_0_0_0')).toHaveClass(/\bon\b/);
  await page.waitForTimeout(2200); // well past the blur guard
  await page.locator('#st_0_0_0').click();
  await expect(page.locator('#st_0_0_0')).not.toHaveClass(/\bon\b/);
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
  // Unsent sets: leaving asks first; keep them as a draft.
  await page.getByRole('button', { name: 'Keep draft & close' }).click();
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
  await page.locator('#w_0_0_0').fill('25');
  await page.locator('#r_0_0_0').fill('9');
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.locator('#portalScreen')).toBeVisible();
  await page.getByRole('button', { name: /Open .*Upper A/ }).click();
  await expect(page.locator('#w_0_0_0')).toHaveValue('25');
  await expect(page.locator('#r_0_0_0')).toHaveValue('9');
  expect(errors).toEqual([]);
});

test('the accordion opens one exercise at a time in place, and the sheet holds what moved', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
  const many = [row, dips, pec, { ...dips, exercise: 'Lat Pulldown' }, { ...dips, exercise: 'Cable Curl' }];
  const errors = await login(page, many, rowHistory);
  const first = page.locator('.exc[data-exercise-index="0"]');
  const last = page.locator('.exc[data-exercise-index="4"]');
  await expect(first).toHaveClass(/\bopen\b/);

  // Jumping straight to another exercise closes the first; nothing to back out of.
  await last.locator('.exc-summary').click();
  await expect(last).toHaveClass(/\bopen\b/);
  await expect(first).not.toHaveClass(/\bopen\b/);
  await expect(page.locator('.exc.exl.open')).toHaveCount(1);
  await expect(last.locator('.exl-dock')).toBeInViewport();

  await last.getByRole('button', { name: 'Why this load' }).click();
  const sheet = page.locator('#exlSheet_0_4');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Next session');
  await expect(sheet.getByRole('button', { name: 'Stats' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Close details' }).click();
  await expect(sheet).toBeHidden();

  // Tapping the open exercise's row closes it again.
  await last.locator('.exc-summary').click();
  await expect(page.locator('.exc.exl.open')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('swapping from the sheet repaints the title, target and table in place', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await login(page, [{ ...pec, alts: ['Cable fly', 'Chest fly machine'] }], null);
  await page.locator('#w_0_0_1').fill('40');
  // Swap goes straight to the options, and picking one closes the sheet.
  await page.getByRole('button', { name: 'Swap exercise' }).click();
  const sheet = page.locator('#exlSwap_0_0');
  await expect(sheet.getByRole('button', { name: 'Cable fly', exact: true })).toBeVisible();
  await expect(sheet).not.toContainText('Why this load');
  await sheet.getByRole('button', { name: 'Cable fly', exact: true }).click();
  await expect(sheet).toBeHidden();
  const card = page.locator('.exc.open');
  await expect(card.locator('.exn')).toHaveText('Cable fly');
  await expect(card.locator('.exl-slbls')).toBeVisible();
  await expect(card.locator('.exl-target')).toBeVisible();
  await expect(card.locator('.snum')).toHaveText(['WU 1', 'Work 1', 'Work 2']);
  expect(errors).toEqual([]);
});

test('a row ticks itself once reps are in, with no button pressed', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
  const errors = await login(page, [row, dips], rowHistory);
  // WU 1: kg left as the hint, reps typed. The row ticks and records the hint.
  await page.locator('#r_0_0_0').fill('12');
  await expect(page.locator('#st_0_0_0')).toHaveClass(/\bon\b/, { timeout: 3000 });
  await expect(page.locator('#w_0_0_0')).toHaveValue('13.6');
  await expect(page.locator('#sr_0_0_1')).toHaveClass(/is-current/);

  // Typing "1" then "2" in quick succession never ticks at "1".
  await page.locator('#r_0_0_1').pressSequentially('12', { delay: 250 });
  await page.waitForTimeout(1500);
  await expect(page.locator('#st_0_0_1')).toHaveClass(/\bon\b/);
  await expect(page.locator('#r_0_0_1')).toHaveValue('12');

  // First work set: reps in, then the effort answer ticks it. Still no Log press.
  await page.locator('#r_0_0_2').fill('11');
  await expect(page.getByRole('button', { name: /^About 2 reps left/ })).toBeVisible({ timeout: 3000 });
  await expect(page.locator('#st_0_0_2')).not.toHaveClass(/\bon\b/);
  await page.getByRole('button', { name: /^About 2 reps left/ }).click();
  await expect(page.locator('#st_0_0_2')).toHaveClass(/\bon\b/);
  await expect(page.locator('#w_0_0_2')).toHaveValue('38.6');

  // Last set: the exercise closes itself and the next one is up.
  await page.locator('#r_0_0_3').fill('10');
  await expect(page.locator('.exc[data-exercise-index="0"]')).not.toHaveClass(/\bopen\b/, { timeout: 3000 });
  await expect(page.locator('.exc.is-up-next')).toContainText('Machine Dips');
  expect(errors).toEqual([]);
});

test('with RPE on, the first working set’s RPE answers the effort question — no second question', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'true'));
  const errors = await login(page, [dips, row], null);
  const card = page.locator('.exc[data-exercise-index="0"]');
  await page.locator('#w_0_0_0').fill('80');
  await page.locator('#r_0_0_0').fill('10');
  // Weight and reps alone: the read-back opens, the reps-left question does not.
  const panel = page.locator('#effort_0_0_0');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.set-effort-options')).toBeHidden();
  await expect(panel.getByText('How many clean reps did you have left?')).toBeHidden();
  await expect(panel.getByRole('button', { name: 'Form or pain stopped me' })).toBeVisible();
  // The RPE completes the set by itself: nothing else to answer.
  await page.locator('#rpe_0_0_0').fill('8');
  await expect(page.locator('#st_0_0_0')).toHaveClass(/\bon\b/, { timeout: 3000 });
  await expect(panel.locator('.set-effort-rpe-text')).toHaveText('RPE 8 · about 2 reps left');
  await page.waitForTimeout(400);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('dp_logs_KARL') || '{}')['session-1']['Machine Dips'][0]);
  expect(saved.rpe).toBe('8');
  expect(saved.effort).toBe('on_target');
  expect(saved.effortSource).toBe('rpe');
  // Changing the RPE re-reads it; 6 is four reps left, so the next empty
  // working set is moved up the same way the reps-left answer would.
  await page.locator('#rpe_0_0_0').fill('6');
  await page.locator('#rpe_0_0_0').blur();
  await expect(panel.locator('.set-effort-rpe-text')).toHaveText('RPE 6 · 4+ clean reps left');
  await expect(page.locator('#sr_0_0_0')).toHaveAttribute('data-effort', 'too_easy');
  await expect(page.locator('#w_0_0_1')).not.toHaveValue('');
  expect(Number(await page.locator('#w_0_0_1').inputValue())).toBeGreaterThan(80);
  await expect(card.locator('.exl-target')).toContainText('Load Increased');
  expect(errors).toEqual([]);
});

test('with RPE on, form or pain is still one tap away and overrides the RPE', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'true'));
  const errors = await login(page, [dips, row], null);
  await page.locator('#w_0_0_0').fill('80');
  await page.locator('#r_0_0_0').fill('10');
  await page.locator('#rpe_0_0_0').fill('6');
  await page.locator('#rpe_0_0_0').blur();
  await expect(page.locator('#sr_0_0_0')).toHaveAttribute('data-effort', 'too_easy');
  const pain = page.locator('#effort_0_0_0').getByRole('button', { name: 'Form or pain stopped me' });
  const box = await pain.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  await pain.click();
  await expect(pain).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#sr_0_0_0')).toHaveAttribute('data-effort', 'form_pain');
  await expect(page.locator('#effort_0_0_0 .set-effort-rpe-text')).toHaveText('Form or pain stopped this set');
  // A later RPE edit never overwrites the athlete's own report.
  await page.locator('#rpe_0_0_0').fill('7');
  await page.locator('#rpe_0_0_0').blur();
  await expect(page.locator('#sr_0_0_0')).toHaveAttribute('data-effort', 'form_pain');
  // Withdrawing it hands the answer back to the RPE.
  await pain.click();
  await expect(pain).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#sr_0_0_0')).toHaveAttribute('data-effort', 'on_target');
  expect(errors).toEqual([]);
});

test('screen readers get the plan, the current set and the next-session direction in words', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
  const errors = await login(page, [dips, row], [{ id: 'past-dips', date: '2026-09-21', log: { 'Machine Dips': [
    { weight: '82.8', reps: '8', done: true, effort: 'on_target' }, { weight: '82.8', reps: '9', done: true },
  ] } }]);
  const card = page.locator('.exc[data-exercise-index="0"]');
  const plan = card.getByRole('group', { name: 'Today’s plan' });
  await expect(plan).toBeVisible();
  const chips = plan.getByRole('list', { name: 'Reps on each working set' }).getByRole('listitem');
  await expect(chips.first()).toHaveText(/Work 1\s*9 reps, current set/);
  await expect(plan.getByRole('img', { name: 'Progress step 1 of 3: Build reps' })).toBeVisible();
  await page.locator('#r_0_0_0').fill('12');
  await page.getByRole('button', { name: /^About 2 reps left/ }).click();
  await page.locator('#r_0_0_1').fill('12');
  await expect(card).not.toHaveClass(/\bopen\b/, { timeout: 3000 });
  // Direction is carried in words on the collapsed badge and the result card.
  await expect(card.locator('.exl-badge')).toHaveAttribute('aria-label', /^Next time: (up to|hold at|down to) /);
  await card.locator('.exc-summary').click();
  const next = card.locator('.exl-next');
  await expect(next).toHaveAttribute('aria-label', /^Next session: Increase earned\. Increase to [\d.]+kg\. Working set 1: 8 reps, Working set 2: 8 reps\.$/);
  expect(errors).toEqual([]);
});

test('RPE and rest timer switches sit in the open exercise and stay in sync', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'true'));
  const errors = await login(page, [row, dips], rowHistory);
  const card = page.locator('.exc[data-exercise-index="0"]');
  const rpe = card.getByRole('button', { name: 'RPE logging', exact: true });
  const timer = card.getByRole('button', { name: 'Rest timer', exact: true });
  await expect(rpe).toBeVisible();
  await expect(timer).toBeVisible();
  await expect(rpe).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#rpe_0_0_0')).toBeVisible();

  await rpe.click();
  await expect(rpe).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#rpe_0_0_0')).toBeHidden();
  await expect(page.locator('.exc[data-exercise-index="1"] [data-strength-rpe-toggle]')).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => localStorage.getItem('dp_strength_rpe_enabled'))).toBe('false');

  await timer.click();
  await expect(timer).toHaveAttribute('aria-pressed', 'false');
  // The switches sit under Swap, above the target card.
  const order = await card.evaluate(node => {
    const y = sel => node.querySelector(sel).getBoundingClientRect().top;
    return { swap: y('.exl-swap'), prefs: y('.exl-prefs'), target: y('.exl-target') };
  });
  expect(order.prefs).toBeGreaterThan(order.swap);
  expect(order.target).toBeGreaterThan(order.prefs);
  expect(errors).toEqual([]);
});
