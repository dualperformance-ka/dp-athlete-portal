import { expect, test } from '@playwright/test';

function localISO(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Adelaide', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function isoWeekSuffix(date = new Date()) {
  const local = new Date(localISO(date));
  local.setDate(local.getDate() + 3 - ((local.getDay() + 6) % 7));
  const weekOne = new Date(local.getFullYear(), 0, 4);
  const week = 1 + Math.round(((local - weekOne) / 86400000 - 3 + ((weekOne.getDay() + 6) % 7)) / 7);
  return `${local.getFullYear()}_${String(week).padStart(2, '0')}`;
}

const today = localISO();
const athlete = { ok: true, exists: true, active: true, code: 'KARL', name: 'Karl', auth_mode: 'both', email: 'karl@example.com', access_token: 'signed-session' };
const exercise = { exercise: 'Leg Extension', sets: '3', reps: '8', repRange: '8-12', warmupSets: '0', workingSets: '3', rest: '0s', notes: '' };

function trainingBundle(note = '', exercises = [exercise], changes = []) {
  return {
    planned: {
      rows: [{ id: 'session-1', notion_page_id: 'session-1', title: 'Lower A', planned_date: today, session_type: 'strength', status: 'Planned', week_label: 'Week 3', notes: note }],
      next: null,
      prescriptions: { exercises: {}, runSteps: {} },
    },
    splits: { rows: [{ name: 'Lower A', athlete_code: null, exercises }] },
    changes: { rows: changes },
    library: { rows: [], revision: 'e2e', notModified: false },
    errors: [],
  };
}

async function installSupabaseStub(page) {
  await page.addInitScript(() => {
    const listeners = [];
    const session = { access_token: 'email-session' };
    window.supabase = {
      createClient() {
        return { auth: {
          onAuthStateChange(callback) { listeners.push(callback); return { data: { subscription: { unsubscribe() {} } } }; },
          async signInWithOtp() { return { data: {}, error: null }; },
          async verifyOtp() { listeners.forEach(callback => callback('SIGNED_IN', session)); return { data: { session }, error: null }; },
          async getSession() { return { data: { session: null } }; },
          async signOut() { listeners.forEach(callback => callback('SIGNED_OUT', null)); return { error: null }; },
        } };
      },
    };
  });
}

async function mockPortal(page, options = {}) {
  const state = { offline: false, note: options.note || '', exercises: options.exercises || [exercise], changes: options.changes || [], bookingRows: options.bookingRows || [], notifications: options.notifications || [] };
  await installSupabaseStub(page);
  await page.route('**/_vercel/**', route => route.abort());
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('https://fonts.gstatic.com/**', route => route.abort());
  await page.route('https://browser.sentry-cdn.com/**', route => route.abort());
  await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    let body = {};
    try { body = request.postDataJSON() || {}; } catch (error) {}
    if (url.pathname === '/api/ingest' && state.offline) { await route.abort('internetdisconnected'); return; }
    if (url.pathname === '/api/portal-data' && body.action === 'state-write' && state.offline) { await route.abort('internetdisconnected'); return; }
    let json = { ok: true };
    if (url.pathname === '/api/auth-athlete') {
      json = url.searchParams.get('action') === 'eligibility' ? { ok: true, enabled: true, eligible: true, active: true } : athlete;
    } else if (url.pathname === '/api/portal-data') {
      const action = body.action;
      if (action === 'bootstrap') json = { ok: true, state: { rows: [], checkins: [] }, bodyLogs: { rows: [] }, nutritionLogs: { rows: [] }, sessionLogs: { rows: [] }, dailyLogged: { body: [], nutrition: [] } };
      else if (action === 'training-read') json = trainingBundle(state.note, state.exercises, state.changes);
      else if (action === 'state-read') json = { ok: true, rows: [], checkins: [] };
      else if (action === 'body-logs' || action === 'nutrition-logs' || action === 'session-logs-read') json = { ok: true, rows: [] };
      else if (action === 'daily-log-dates') json = { ok: true, body: [], nutrition: [] };
      else if (action === 'nutrition-week') json = { ok: true, rows: [] };
      else if (action === 'weekly-sport-targets') json = { ok: true, rows: [] };
      else if (action === 'programme-data') json = { ok: true, rows: [] };
      else if (action === 'booking-sync' || action === 'booking-read') json = { ok: true, rows: state.bookingRows };
    } else if (url.pathname.startsWith('/api/strava')) {
      json = { connected: false, activities: [] };
    } else if (url.pathname === '/api/reminders') {
      if (request.method() === 'GET') {
        json = { ok: true, notifications: state.notifications, unread: state.notifications.filter(item => !item.read_at).length };
      } else if (body.action === 'read-notification') {
        state.notifications = state.notifications.map(item => item.id === body.id ? { ...item, read_at: new Date().toISOString() } : item);
        json = { ok: true, notifications: state.notifications, unread: state.notifications.filter(item => !item.read_at).length };
      } else if (body.action === 'dismiss-notification') {
        state.notifications = state.notifications.filter(item => item.id !== body.id);
        json = { ok: true, notifications: state.notifications, unread: state.notifications.filter(item => !item.read_at).length };
      } else if (body.action === 'clear-notifications') {
        state.notifications = [];
        json = { ok: true, notifications: [], unread: 0 };
      }
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) });
  });
  return state;
}

async function codeLogin(page, options = {}) {
  const state = await mockPortal(page, options);
  await page.goto('/index.html');
  await page.getByRole('button', { name: 'Use athlete access code' }).click();
  await page.getByLabel('Athlete access code').fill('KARL');
  await page.getByRole('button', { name: 'Enter Portal' }).click();
  await expect(page.locator('#portalScreen')).toBeVisible();
  await expect(page.getByText('Lower A', { exact: true }).first()).toBeVisible();
  return state;
}

// Exercises are an accordion: the session opens with the next exercise
// already expanded. This only taps it when it is not open yet.
async function openUpNext(page) {
  const up = page.locator('.exc.is-up-next');
  if (!(await up.evaluate(el => el.classList.contains('open')))) await up.locator('.exc-summary').click();
  await expect(up).toHaveClass(/\bopen\b/);
}

test('1. code login renders the portal and today’s session', async ({ page }) => {
  await codeLogin(page);
  await expect(page.getByText('Sign in with your email next time')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss email sign-in suggestion' }).click();
  await expect(page.locator('#emailUpgradePrompt')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open Lower A' })).toBeVisible();
  expect(await page.evaluate(async () => !!(await navigator.serviceWorker.ready).active)).toBe(true);
});

test('mobile Home keeps two sessions, Strava progress and every macro above the navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await codeLogin(page);
  const emailPrompt = page.getByRole('button', { name: 'Dismiss email sign-in suggestion' });
  if (await emailPrompt.isVisible()) await emailPrompt.click();
  await expect.poll(() => page.evaluate(() => _nutLastLoad > 0)).toBe(true);
  await page.evaluate(() => {
    // Connected athletes keep a useful Strava readout even in a week where a
    // coach distance target has not been published yet.
    renderKmTracker({ target: null, completed: 12.5, source: 'strava' });
    renderNavigationFuelTargets({
      cal: { display: '2300', min: 2300 },
      pro: { display: '160', min: 160 },
      carb: { display: '275', min: 275 },
      fat: { display: '70', min: 70 },
      fibre: { display: '30', min: 30 },
    });
    const list = document.querySelector('#todayEl .todaylist');
    if (list && list.firstElementChild) {
      const second = list.firstElementChild.cloneNode(true);
      second.querySelector('.todayname').textContent = 'Easy Run';
      second.querySelector('.todaymeta').textContent = '30 min · Planned';
      list.appendChild(second);
    }
    syncTodayPlacement();
  });

  const fuel = page.locator('#todayFuelTarget');
  await expect(fuel).toBeVisible();
  await expect(page.locator('#kmBar')).toBeVisible();
  await expect(page.locator('#kmSrcStrava')).toBeVisible();
  await expect(page.locator('#kmDoneVal')).toHaveText('12.5');
  await expect(page.locator('#kmTargetSep')).toBeHidden();
  await expect(page.locator('#todayEl .todayitem')).toHaveCount(2);
  await expect(page.locator('#todayFuelTarget .fuel-target-grid > div')).toHaveCount(5);

  const layout = await page.evaluate(() => {
    const fuelCard = document.getElementById('todayFuelTarget');
    const bottomNav = document.querySelector('.mobile-nav');
    const readiness = document.getElementById('heroReadinessCard');
    return {
      fuelParent: fuelCard.parentElement.className,
      fuelBottom: fuelCard.getBoundingClientRect().bottom,
      navTop: bottomNav.getBoundingClientRect().top,
      readinessHeight: readiness.getBoundingClientRect().height,
      fuelOverflow: fuelCard.scrollWidth - fuelCard.clientWidth,
    };
  });
  expect(layout.fuelParent).toContain('top-shell');
  expect(layout.fuelBottom).toBeLessThanOrEqual(layout.navTop - 6);
  expect(layout.readinessHeight).toBeLessThanOrEqual(34);
  expect(layout.fuelOverflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: 'test-results/mobile-home-opening.png', fullPage: false });

  await page.evaluate(() => applyOutdoorMode(false, false));
  await page.waitForTimeout(350);
  const darkFuelBottom = await fuel.evaluate(node => node.getBoundingClientRect().bottom);
  const darkNavTop = await page.locator('.mobile-nav').evaluate(node => node.getBoundingClientRect().top);
  expect(darkFuelBottom).toBeLessThanOrEqual(darkNavTop - 6);
  await page.screenshot({ path: 'test-results/mobile-home-opening-dark.png', fullPage: false });

  const collapsedHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.locator('#nudgeSummaryRow').click();
  await expect(page.locator('#nudgeSummaryRow')).toHaveAttribute('aria-expanded', 'true');
  const expandedHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(expandedHeight).toBeGreaterThan(collapsedHeight);
});

test('2. email OTP login lands on the same portal state', async ({ page }) => {
  await mockPortal(page);
  await page.goto('/index.html');
  await page.getByLabel('Email address').fill('karl@example.com');
  await page.getByRole('button', { name: 'Send Code' }).click();
  await page.getByLabel('One-time email code').fill('123456');
  await expect(page.locator('#portalScreen')).toBeVisible();
  await expect(page.getByText('Lower A', { exact: true }).first()).toBeVisible();
});

test('3. three strength sets submit and persist across reload', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
  await codeLogin(page);
  await page.getByRole('button', { name: 'Open Lower A' }).click();
  await openUpNext(page);
  for (let set = 0; set < 3; set++) {
    await page.locator(`#w_0_0_${set}`).fill(String(40 + set * 5));
    await page.locator(`#r_0_0_${set}`).fill(String(10 - set));
  }
  await page.getByRole('button', { name: /On target/ }).click();
  await page.locator('#focusFooterAction').click();
  await expect(page.locator('#strengthReviewTitle')).toHaveText('Review session');
  await expect(page.getByText('Adaptive coaching')).toBeVisible();
  await expect(page.getByText('1 followed')).toBeVisible();
  await page.getByRole('button', { name: 'Submit to coaches' }).click();
  await expect(page.getByText('Your coaches can now review the full session.')).toBeVisible();
  await expect(page.getByText('1 followed')).toBeVisible();
  await expect(page.locator('#gym_saved_0')).toContainText('Session submitted');

  await page.reload();
  await expect(page.locator('#portalScreen')).toBeVisible();
  await page.getByRole('button', { name: /Open (completed )?Lower A/ }).click();
  await page.locator('.exc[data-exercise-index="0"] .exc-summary').click();
  await page.getByRole('button', { name: 'Edit sets' }).click();
  await expect(page.locator('#w_0_0_0')).toHaveValue('40');
  await expect(page.locator('#w_0_0_2')).toHaveValue('50');
});

test('unlocking the next load gives brief encouragement without interrupting the session', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
  await codeLogin(page);
  await page.getByRole('button', { name: 'Open Lower A' }).click();
  await openUpNext(page);
  await page.locator('#w_0_0_0').fill('40');
  await page.locator('#r_0_0_0').fill('12');
  await page.getByRole('button', { name: /On target/ }).click();
  for (let set = 1; set < 3; set++) {
    await page.locator(`#w_0_0_${set}`).fill('40');
    await page.locator(`#r_0_0_${set}`).fill('12');
  }

  await expect(page.locator('#toast')).toContainText(/Nice work.*unlocked for next session/);
  await expect(page.locator('.exc').first()).toHaveClass(/ns-unlock-celebrate/);
  // The finished exercise closes itself; reopening it shows one result card
  // with one next step.
  await page.locator('#r_0_0_2').blur();
  const done = page.locator('.exc[data-exercise-index="0"]');
  await expect(done).not.toHaveClass(/\bopen\b/);
  await done.locator('.exc-summary').click();
  const result = done.locator('.exl-result');
  await expect(result).toBeVisible();
  await expect(result.locator('.exl-next-action')).toHaveText(/Increase to/);
  await expect(page.locator('#focusOverlay')).toHaveClass(/open/);
});

test('a locally saved workout awaits submission and does not count as complete', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
  await codeLogin(page);
  await page.getByRole('button', { name: 'Open Lower A' }).click();
  await openUpNext(page);
  await page.locator('#w_0_0_0').fill('40');
  await page.locator('#r_0_0_0').fill('10');
  await page.getByRole('button', { name: /On target/ }).click();
  await page.getByRole('button', { name: 'Close session' }).click();
  await page.evaluate(() => renderTodaySection());

  await expect(page.locator('.todaymeta')).toContainText('Awaiting submission');
  await expect(page.getByRole('button', { name: 'Open awaiting submission Lower A' })).toHaveText(/Review & submit/);
  await expect(page.locator('#heroStatCompliance')).toHaveText('0/1');
});

test('focused strength flow shows coach context, live progress, calm stats and the next exercise', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
  const secondExercise = { ...exercise, exercise: 'Leg Curl', sets: '2', workingSets: '2', rest: '90s' };
  await codeLogin(page, {
    exercises: [exercise, secondExercise],
    changes: [{ source: 'programme', changed_at: `${today}T01:00:00Z`, detail: { date: today, item: 'Leg Extension', action: 'load target updated' } }],
  });
  await page.getByRole('button', { name: 'Open Lower A' }).click();

  await expect(page.getByText('Your coach adjusted this session')).toBeVisible();
  await expect(page.locator('#focusOverlayMeta')).toHaveText('0 of 2');
  await expect(page.locator('#focusOverlayTime')).toContainText('min left');
  await openUpNext(page);
  // Stats moved into the details sheet, one tap from the Best tile.
  await page.locator('.exc.open .exl-best').click();
  await expect(page.locator('#exlSheet_0_0').getByRole('button', { name: 'Stats' })).toBeVisible();
  await page.locator('#exlSheet_0_0').getByRole('button', { name: 'Close details' }).click();

  for (let set = 0; set < 3; set++) {
    await page.locator(`#w_0_0_${set}`).fill('40');
    await page.locator(`#r_0_0_${set}`).fill('10');
  }
  await page.getByRole('button', { name: /On target/ }).click();
  await page.locator('#r_0_0_2').blur();

  // No finish step: the done exercise closes itself and the next is up.
  await expect(page.locator('.exc[data-exercise-index="0"]')).not.toHaveClass(/\bopen\b/);
  await expect(page.locator('.exc.is-up-next')).toContainText('Leg Curl');
  await expect(page.locator('#focusOverlayMeta')).toHaveText('1 of 2');
  await expect(page.getByRole('button', { name: 'Review & submit' }).last()).toBeVisible();
});

test('first-set calibration reads as effort and quality, never as a failure test', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
  await codeLogin(page);
  await page.getByRole('button', { name: 'Open Lower A' }).click();

  // The prompt calibrates against the prescribed effort, with no failure copy
  // anywhere on the athlete's screen.
  // One line on the list; the full calibration text is one tap away.
  await expect(page.getByText('First work set calibrates the load. Stop with 2 reps left.')).toBeVisible();
  await page.getByRole('button', { name: 'How calibration works' }).click();
  await expect(page.locator('#exlCal_0').getByText('Calibrate the first working set').first()).toBeVisible();
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/technical failure/i);
  expect(body).not.toMatch(/0 RIR/);
  expect(body).toMatch(/two more clean reps/);
  await page.locator('#exlCal_0').getByRole('button', { name: 'Close details' }).click();
  await openUpNext(page);

  // Target first; the full recommendation (target, next session, why) sits
  // behind the Why tile.
  const card = page.locator('.exc').first();
  await expect(card.locator('.exl-target')).toContainText('Today’s target · per work set');
  await card.getByRole('button', { name: 'Why this load' }).click();
  const sheet = page.locator('#exlSheet_0_0');
  await expect(sheet.getByText('Today’s target')).toBeVisible();
  await expect(sheet.getByText('Next session')).toBeVisible();
  await expect(sheet.getByText('Why', { exact: true })).toBeVisible();
  await sheet.getByRole('button', { name: 'Close details' }).click();
  await page.screenshot({ path: 'test-results/strength-card-mobile.png' });

  await page.locator('#w_0_0_0').fill('40');
  await page.locator('#r_0_0_0').fill('10');
  await expect(page.getByRole('button', { name: /On target/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Too easy/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Too hard/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Technique/ })).toBeVisible();
  await expect(page.getByText(/aim for 2 reps in reserve/)).toBeVisible();

  // Too easy moves only the sets that are still empty, and resets their rep
  // prompt to the floor of the range.
  await page.getByRole('button', { name: /Too easy/ }).click();
  await expect(page.locator('#w_0_0_1')).toHaveValue('45');
  await expect(page.locator('#w_0_0_2')).toHaveValue('45');
  await expect(page.locator('#w_0_0_0')).toHaveValue('40');
  await expect(page.locator('#r_0_0_1')).toHaveAttribute('placeholder', '8');
  await page.screenshot({ path: 'test-results/strength-calibration-mobile.png', fullPage: false });
});

test('a manual live load increase resets only remaining targets on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
  const hip = { exercise: 'Hip Abduction', sets: '4', reps: '15', repRange: '15-20', warmupSets: '0', workingSets: '4', targetRir: 2, rest: '0s', notes: '' };
  await codeLogin(page, { exercises: [hip] });
  await page.evaluate(() => {
    allSessions.push({ id: 'past-hip', date: '2026-09-01' });
    logs['past-hip'] = {
      'Hip Abduction': [
        { weight: '63', reps: '19', done: true }, { weight: '63', reps: '15', done: true },
        { weight: '63', reps: '15', done: true }, { weight: '63', reps: '15', done: true },
      ],
      __sessionDate: '2026-09-01',
    };
  });
  await page.getByRole('button', { name: 'Open Lower A' }).click();
  await openUpNext(page);

  await page.locator('#w_0_0_0').fill('63');
  await page.locator('#r_0_0_0').fill('19');
  await page.getByRole('button', { name: /On target/ }).click();
  await page.locator('#w_0_0_1').fill('68');

  const card = page.locator('.exc').first();
  const target = card.locator('.exl-target');
  await expect(target.getByText('Load Increased', { exact: true })).toBeVisible();
  await expect(target.getByText('Aim for 15 clean reps', { exact: true })).toBeVisible();
  await expect(target.getByText(/Maintain approximately 2 reps in reserve/)).toBeVisible();
  await expect(card).not.toContainText('Beat Last Week');
  await expect(page.locator('#r_0_0_0')).toHaveValue('19');
  await expect(page.locator('#w_0_0_0')).toHaveValue('63');
  await expect(page.locator('#r_0_0_1')).toHaveAttribute('placeholder', '15');
  await expect(page.locator('#w_0_0_2')).toHaveAttribute('placeholder', '68');

  const overflow = await card.evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
  await card.screenshot({ path: 'test-results/strength-live-load-mobile.png' });
});

test('a manual live load decrease is kept and updates remaining targets on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
  const hip = { exercise: 'Hip Abduction', sets: '4', reps: '15', repRange: '15-20', warmupSets: '0', workingSets: '4', targetRir: 2, rest: '0s', notes: '' };
  await codeLogin(page, { exercises: [hip] });
  await page.evaluate(() => {
    allSessions.push({ id: 'past-hip-heavy', date: '2026-09-01' });
    logs['past-hip-heavy'] = {
      'Hip Abduction': [
        { weight: '68', reps: '18', done: true }, { weight: '68', reps: '16', done: true },
        { weight: '68', reps: '15', done: true }, { weight: '68', reps: '15', done: true },
      ],
      __sessionDate: '2026-09-01',
    };
  });
  await page.getByRole('button', { name: 'Open Lower A' }).click();
  await openUpNext(page);

  await page.locator('#w_0_0_0').fill('68');
  await page.locator('#r_0_0_0').fill('18');
  await page.getByRole('button', { name: /On target/ }).click();
  await page.locator('#w_0_0_1').fill('63');

  const card = page.locator('.exc').first();
  const target = card.locator('.exl-target');
  await expect(target.getByText('Load Reduced', { exact: true })).toBeVisible();
  await expect(target.getByText('Aim for at least 15 clean reps', { exact: true })).toBeVisible();
  await expect(target.getByText(/Maintain approximately 2 reps in reserve/)).toBeVisible();
  await expect(page.locator('#w_0_0_1')).toHaveValue('63');
  await expect(page.locator('#r_0_0_1')).toHaveAttribute('placeholder', '15');
  await expect(page.locator('#w_0_0_2')).toHaveAttribute('placeholder', '63');
  await expect(page.locator('#w_0_0_0')).toHaveValue('68');
  await expect(page.locator('#r_0_0_0')).toHaveValue('18');
  await expect(card).not.toContainText('Beat Last Week');
});

test('a technique or niggle answer never earns more load', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
  await codeLogin(page);
  await page.getByRole('button', { name: 'Open Lower A' }).click();
  await openUpNext(page);
  await page.locator('#w_0_0_0').fill('40');
  await page.locator('#r_0_0_0').fill('10');
  await page.getByRole('button', { name: /Technique/ }).click();

  // One rung easier for the sets still to come, and never an increase.
  await expect(page.locator('#w_0_0_1')).toHaveValue('35');
  await expect(page.locator('#w_0_0_2')).toHaveValue('35');
  const advice = await page.locator('#effort_advice_0_0_0').textContent();
  expect(advice).toMatch(/tell your coach/i);
  expect(advice).toMatch(/stop/i);
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/Ready to Increase/);
});

test('4. body check-in updates the Log sheet tab state', async ({ page }) => {
  await codeLogin(page);
  await page.evaluate(() => openLogSheet('body'));
  await page.locator('#qlbWeight').fill('72.4');
  await page.getByRole('button', { name: 'Save body check-in' }).click();
  await expect(page.locator('#qlDockBody')).toHaveClass(/is-done/);
});

test('5. offline submit shows pending state and online recovery drains it', async ({ page, context }) => {
  const state = await codeLogin(page);
  state.offline = true;
  await context.setOffline(true);
  await page.evaluate(() => openLogSheet('body'));
  await page.locator('#qlbWeight').fill('72.5');
  await page.getByRole('button', { name: 'Save body check-in' }).click();
  await expect(page.locator('#queuePendingBanner')).toBeVisible();
  const initialPending = await page.evaluate(() => pendingCoachWriteCount());
  expect(initialPending).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#queuePendingBanner')).toContainText(`${initialPending} updates waiting to send`);

  // Keep writes unavailable while allowing the cached app to perform its
  // normal authenticated reload. The state outbox must survive that reload.
  await context.setOffline(false);
  await page.evaluate(() => localStorage.setItem('dp_reschedules_KARL', JSON.stringify({ 'session-1': '2026-08-28' })));
  await expect.poll(() => page.evaluate(() => pendingCoachWriteCount())).toBe(initialPending + 1);
  await expect(page.locator('#queuePendingBanner')).toContainText(`${initialPending + 1} updates waiting to send`);
  await page.reload();
  await expect(page.locator('#portalScreen')).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('dp_reschedules_KARL') || '{}')['session-1'])).toBe('2026-08-28');
  await expect.poll(() => page.evaluate(() => pendingCoachWriteCount())).toBe(initialPending + 1);
  await expect(page.locator('#queuePendingBanner')).toContainText(`${initialPending + 1} updates waiting to send`);

  state.offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#queuePendingBanner')).toBeHidden({ timeout: 10_000 });
});

test('6. coach cue avatars appear only for a real override note', async ({ page }) => {
  const state = await codeLogin(page, { note: 'Keep the first set controlled and own the final two.' });
  await expect(page.getByText('Coach cue for today')).toBeVisible();
  await expect(page.locator('.coach-avatars')).toBeVisible();

  state.note = '';
  await page.evaluate(() => refreshWeekInBackground());
  await expect(page.getByText('Today’s focus')).toBeVisible();
  await expect(page.locator('.coach-avatars')).toHaveCount(0);
});

test('7. a booking sits under the slot and a cancellation clears the stale confirmation', async ({ page }) => {
  const suffix = isoWeekSuffix();
  const localKey = `dp_call_booked_KARL_${suffix}`;
  const state = await codeLogin(page, {
    bookingRows: [{
      key: `call_booked_${suffix}`,
      value: { time: 'Sat 29 Aug · 9:30 am', startsAt: '2026-08-29T00:00:00.000Z', eventId: 'event-123' },
    }],
  });

  await expect.poll(() => page.evaluate(key => !!localStorage.getItem(key), localKey)).toBe(true);
  await expect(page.locator('#callConfirmedNudge')).toBeVisible();
  // A confirmation is status, not a demand: it sits at the foot of the card now.
  await expect.poll(() => page.locator('.top-shell-priority > .nudge-strip:visible').last().getAttribute('id')).toBe('callConfirmedNudge');

  state.bookingRows = [];
  await page.evaluate(() => refreshCallBookingsFromCloud(0, true));

  await expect(page.locator('#callConfirmedNudge')).toBeHidden();
  // Cancelling makes the call due again. It no longer leads the card — the
  // check-in outranks it — so assert it is back in the demand stack, not first.
  await expect(page.locator('#callNudge')).toHaveClass(/is-due/);
  await expect.poll(() => page.evaluate(() => {
    const el = document.getElementById('callNudge');
    return el.style.display !== 'none' && el.classList.contains('is-due');
  })).toBe(true);
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), localKey)).toBe(null);
});

test('8. athlete can clear one notification or clear the whole inbox', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await codeLogin(page, {
    notifications: [
      { id: '11111111-1111-4111-8111-111111111111', title: 'Programme published', body: 'Your next training block is live.', url: '/', created_at: '2026-08-27T07:15:00Z', read_at: null, pushed_at: null },
      { id: '22222222-2222-4222-8222-222222222222', title: "Today's training", body: 'VO2 5×1km + 4×200m', url: '/?tab=training', created_at: '2026-08-27T06:00:00Z', read_at: null, pushed_at: '2026-08-27T06:00:05Z' },
    ],
  });

  await expect(page.getByRole('button', { name: 'Open notifications, 2 unread' })).toBeVisible();
  await page.getByRole('button', { name: 'Open notifications, 2 unread' }).click();
  await expect(page.getByRole('button', { name: 'Clear Programme published notification' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear Programme published notification' }).click();
  await expect(page.getByText('Programme published', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open notifications, 1 unread' })).toBeVisible();

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Clear all' }).click();
  await expect(page.getByText('You’re all caught up')).toBeVisible();
  await expect(page.locator('#notificationCount')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Clear all' })).toBeHidden();
});

test('9. the Calls tab routes to the one check-in rather than asking again', async ({ page }) => {
  // The Calls tab used to collect its own wins/niggles prep answers, duplicating
  // the weekly check-in and syncing them through a state key that never reached
  // the database. It now reports the check-in's status and links to it, and the
  // one question that had no home elsewhere lives in the check-in's last step.
  const ingested = [];
  const stateRows = [];
  await installSupabaseStub(page);
  await page.route('**/_vercel/**', route => route.abort());
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch (error) {}
    let json = { ok: true };
    if (url.pathname === '/api/auth-athlete') {
      json = url.searchParams.get('action') === 'eligibility' ? { ok: true, enabled: true, eligible: true, active: true } : athlete;
    } else if (url.pathname === '/api/ingest') {
      ingested.push(body.payload || {});
      json = { ok: true };
    } else if (url.pathname === '/api/portal-data') {
      if (body.action === 'state-write') { stateRows.push({ key: body.key, value: body.value }); json = { key: body.key, synced_at: 'now' }; }
      else if (body.action === 'state-read') json = { ok: true, rows: stateRows, checkins: [] };
      else if (body.action === 'bootstrap') json = { ok: true, state: { rows: stateRows, checkins: [] }, bodyLogs: { rows: [] }, nutritionLogs: { rows: [] }, sessionLogs: { rows: [] }, dailyLogged: { body: [], nutrition: [] } };
      else json = { ok: true, rows: [], checkins: [], body: [], nutrition: [] };
    } else if (url.pathname.startsWith('/api/strava')) json = { connected: false, activities: [] };
    else if (url.pathname === '/api/reminders') json = { ok: true, notifications: [], unread: 0 };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) });
  });

  await page.goto('/index.html');
  await page.getByRole('button', { name: 'Use athlete access code' }).click();
  await page.getByLabel('Athlete access code').fill('KARL');
  await page.getByRole('button', { name: 'Enter Portal' }).click();
  await expect(page.locator('#portalScreen')).toBeVisible();

  // No second set of questions on the Calls tab, just the check-in's state.
  await page.evaluate(() => switchTab('coaching'));
  const calls = page.locator('#callsSurface');
  await expect(calls).toContainText('Weekly check-in');
  await expect(calls).toContainText('Not yet');
  await expect(page.locator('#callsPrep0')).toHaveCount(0);

  await calls.getByRole('button', { name: 'Complete your check-in' }).click();
  // Opens in place as a sheet rather than switching tabs, and the form is moved
  // in rather than copied: a second copy would mean duplicate element ids.
  await expect(page.locator('#checkinModal')).toHaveClass(/open/);
  await expect(page.locator('#checkinModalBody #ciFormContent')).toBeVisible();
  expect(await page.locator('#ciFormContent').count()).toBe(1);
  expect(await page.locator('#ciRunKm').count()).toBe(1);

  // The one prep question that survived, drafted like every other field. It
  // opens the wizard's last step, so walk there the way an athlete would.
  await page.evaluate(() => ciGoStep(4));
  await expect(page.locator('.ci-step-panel[data-step="4"]')).toHaveClass(/active/);
  await expect(page.locator('#ciStepCounter')).toHaveText('Step 4 of 4');
  await expect(page.locator('#ciCallDecision')).toBeVisible();
  await page.locator('#ciCallDecision').fill('Whether to move Thursday intervals to Friday.');
  await expect.poll(async () => page.evaluate(() => {
    const raw = localStorage.getItem('dp_ci_draft_KARL_' + checkinWeekSuffix());
    return raw ? (JSON.parse(raw).ciCallDecision || '') : '';
  }), { timeout: 8000 }).toContain('Thursday intervals');

  await page.evaluate(() => { document.getElementById('ciName').value = 'Karl Sexon'; });
  await page.evaluate(() => submitCheckin());
  await expect.poll(() => ingested.filter(p => p.type === 'weekly_checkin').length, { timeout: 8000 }).toBeGreaterThan(0);
  const submitted = ingested.find(p => p.type === 'weekly_checkin');
  expect(submitted.callDecision).toContain('Thursday intervals');
  // The neighbouring field keeps its own meaning rather than being overloaded.
  expect(submitted).toHaveProperty('upcomingImpact');
});

test('10. the check-in sheet drafts, confirms delivery, and hands the form back', async ({ page }) => {
  const ingested = [];
  const stateRows = [];
  await installSupabaseStub(page);
  await page.route('**/_vercel/**', route => route.abort());
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch (error) {}
    let json = { ok: true };
    if (url.pathname === '/api/auth-athlete') {
      json = url.searchParams.get('action') === 'eligibility' ? { ok: true, enabled: true, eligible: true, active: true } : athlete;
    } else if (url.pathname === '/api/ingest') { ingested.push(body.payload || {}); json = { ok: true }; }
    else if (url.pathname === '/api/portal-data') {
      if (body.action === 'state-write') { stateRows.push({ key: body.key, value: body.value }); json = { key: body.key, synced_at: 'now' }; }
      else if (body.action === 'state-read') json = { ok: true, rows: stateRows, checkins: [] };
      else if (body.action === 'bootstrap') json = { ok: true, state: { rows: stateRows, checkins: [] }, bodyLogs: { rows: [] }, nutritionLogs: { rows: [] }, sessionLogs: { rows: [] }, dailyLogged: { body: [], nutrition: [] } };
      else json = { ok: true, rows: [], checkins: [], body: [], nutrition: [] };
    } else if (url.pathname.startsWith('/api/strava')) json = { connected: false, activities: [] };
    else if (url.pathname === '/api/reminders') json = { ok: true, notifications: [], unread: 0 };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) });
  });

  await page.goto('/index.html');
  await page.getByRole('button', { name: 'Use athlete access code' }).click();
  await page.getByLabel('Athlete access code').fill('KARL');
  await page.getByRole('button', { name: 'Enter Portal' }).click();
  await expect(page.locator('#portalScreen')).toBeVisible();

  // Closing the sheet must never cost the athlete what they typed.
  await page.evaluate(() => switchTab('coaching'));
  await page.evaluate(() => openCheckinSheet());
  await page.locator('#ciRunWins').fill('Negative split on the long run.');
  await page.evaluate(() => closeCheckinSheet());
  await expect(page.locator('#checkinModal')).not.toHaveClass(/open/);
  // The form goes home rather than being left orphaned inside a closed sheet.
  await expect(page.locator('#tab-checkin #ciFormContent')).toHaveCount(1);

  await page.evaluate(() => openCheckinSheet());
  await expect(page.locator('#ciRunWins')).toHaveValue(/Negative split/);

  await page.evaluate(() => { document.getElementById('ciName').value = 'Karl Sexon'; });
  await page.evaluate(() => submitCheckin());
  await expect(page.locator('#ciSuccess')).toBeVisible();
  await expect.poll(() => ingested.filter(p => p.type === 'weekly_checkin').length, { timeout: 8000 }).toBeGreaterThan(0);

  // Submitted means the draft is gone.
  await expect.poll(async () => page.evaluate(() => localStorage.getItem(ciDraftKey())), { timeout: 8000 }).toBeNull();

  // The testimonial is asked here, after the confirmation, and the sheet holds
  // still for it rather than closing itself out from under the ask.
  await expect(page.locator('#ciSuccess')).toContainText('Check-in received');
  await expect(page.locator('#ciTestimonialAsk')).toBeVisible();
  await expect(page.locator('#checkinModal')).toHaveClass(/open/);
  // Declining costs nothing and leaves the submitted check-in exactly as it is.
  await page.locator('#ciTestimonialSkip').click();
  await expect(page.locator('#ciTestimonialAsk')).toBeHidden();
  expect(ingested.filter(p => p.type === 'weekly_checkin').length).toBe(1);
  await expect(page.locator('#checkinModal')).not.toHaveClass(/open/, { timeout: 8000 });
  await expect(page.locator('#callsSurface')).toContainText('Submitted');
});

// The testimonial goes back as the same check-in, so the coaches keep one row
// per week instead of a second kind of message to reconcile by hand.
test('11. a testimonial sent after submit is the same check-in, with the one empty column filled', async ({ page }) => {
  const ingested = [];
  const stateRows = [];
  await installSupabaseStub(page);
  await page.route('**/_vercel/**', route => route.abort());
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch (error) {}
    let json = { ok: true };
    if (url.pathname === '/api/auth-athlete') {
      json = url.searchParams.get('action') === 'eligibility' ? { ok: true, enabled: true, eligible: true, active: true } : athlete;
    } else if (url.pathname === '/api/ingest') { ingested.push(body.payload || {}); json = { ok: true }; }
    else if (url.pathname === '/api/portal-data') {
      if (body.action === 'state-write') { stateRows.push({ key: body.key, value: body.value }); json = { key: body.key, synced_at: 'now' }; }
      else if (body.action === 'state-read') json = { ok: true, rows: stateRows, checkins: [] };
      else if (body.action === 'bootstrap') json = { ok: true, state: { rows: stateRows, checkins: [] }, bodyLogs: { rows: [] }, nutritionLogs: { rows: [] }, sessionLogs: { rows: [] }, dailyLogged: { body: [], nutrition: [] } };
      else json = { ok: true, rows: [], checkins: [], body: [], nutrition: [] };
    } else if (url.pathname.startsWith('/api/strava')) json = { connected: false, activities: [] };
    else if (url.pathname === '/api/reminders') json = { ok: true, notifications: [], unread: 0 };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) });
  });

  await page.goto('/index.html');
  await page.getByRole('button', { name: 'Use athlete access code' }).click();
  await page.getByLabel('Athlete access code').fill('KARL');
  await page.getByRole('button', { name: 'Enter Portal' }).click();
  await expect(page.locator('#portalScreen')).toBeVisible();

  await page.evaluate(() => switchTab('coaching'));
  await page.evaluate(() => openCheckinSheet());
  await page.evaluate(() => { document.getElementById('ciName').value = 'Karl Sexon'; });
  await page.locator('#ciRunWins').fill('Negative split on the long run.');
  await page.evaluate(() => submitCheckin());
  await expect.poll(() => ingested.filter(p => p.type === 'weekly_checkin').length, { timeout: 8000 }).toBe(1);
  const first = ingested.find(p => p.type === 'weekly_checkin');
  expect(first.testimonial).toBe('');

  await expect(page.locator('#ciTestimonialAsk')).toBeVisible();
  await page.locator('#ciTestimonial').fill('Three weeks ago I could not run 2km. This week I hit a PB.');
  // A half-written testimonial survives, and drafting it cannot resurrect the
  // check-in that has already gone.
  await expect.poll(async () => page.evaluate(() => {
    const raw = localStorage.getItem(ciDraftKey());
    return raw ? JSON.parse(raw) : null;
  }), { timeout: 8000 }).toMatchObject({ ciTestimonial: /PB/ });
  expect(await page.evaluate(() => {
    const raw = localStorage.getItem(ciDraftKey());
    return raw ? Object.keys(JSON.parse(raw)).sort().join(',') : '';
  })).toBe('_savedAt,ciTestimonial');

  await page.locator('#ciTestimonialSend').click();
  await expect.poll(() => ingested.filter(p => p.type === 'weekly_checkin').length, { timeout: 8000 }).toBe(2);
  const second = ingested.filter(p => p.type === 'weekly_checkin')[1];
  expect(second.testimonial).toContain('hit a PB');
  // Same shape, same week, same row: everything but the testimonial is identical.
  expect(Object.keys(second).sort()).toEqual(Object.keys(first).sort());
  expect(second.weekEnding).toBe(first.weekEnding);
  expect(second.runWins).toBe(first.runWins);
  await expect(page.locator('#ciTestimonialThanks')).toBeVisible();
});
