import { expect, test } from '@playwright/test';

// Set entry in the exercise logger.
//
// 1. Retyping the planned load used to rewrite the remaining sets: clearing 50
//    and typing it again passes through "5", which was read as a deliberate
//    drop to 5kg, so WORK 2 and WORK 3 showed 5kg x 8 reps and stayed there
//    after the athlete finished typing 50.
// 2. A suggested value (the plan, shown as a hint in an empty box) must look
//    different from a number the athlete entered.

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


const ex = { exercise: 'Low Machine Row', sets: '4', reps: '8', repRange: '8-12', warmupSets: '1', workingSets: '3', rest: '90s', notes: '' };
const hist = [{ id: 'past', date: '2026-10-12', log: { 'Low Machine Row': [
  { weight: '35', reps: '12', done: true }, { weight: '50', reps: '10', done: true, effort: 'on_target' },
  { weight: '50', reps: '9', done: true }, { weight: '50', reps: '10', done: true },
] } }];
const hints = page => page.evaluate(() => [1, 2, 3].map(si => {
  const w = document.getElementById('w_0_0_' + si), r = document.getElementById('r_0_0_' + si);
  return { kg: w.value || w.placeholder, reps: r.value || r.placeholder, typed: !!w.value };
}));

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
});

test('retyping the planned load one key at a time leaves the remaining sets on the plan', async ({ page }) => {
  const errors = await login(page, [ex], hist);
  const before = await hints(page);
  expect(before.map(h => h.kg)).toEqual(['50', '50', '50']);
  await page.locator('#w_0_0_1').click();
  await page.keyboard.type('5');
  await page.waitForTimeout(250);
  // Half-typed: the remaining sets must not jump to 5kg.
  expect((await hints(page)).slice(1)).toEqual(before.slice(1));
  await page.keyboard.type('0');
  await page.waitForTimeout(1300); // past the settle pause
  expect((await hints(page)).slice(1)).toEqual(before.slice(1));
  await page.locator('#w_0_0_1').blur();
  await page.waitForTimeout(300);
  expect((await hints(page)).slice(1)).toEqual(before.slice(1));
  expect(errors).toEqual([]);
});

test('a deliberate load change still moves the remaining sets, and correcting it restores the plan', async ({ page }) => {
  const errors = await login(page, [ex], hist);
  const plan = await hints(page);
  const w1 = page.locator('#w_0_0_1');
  await w1.click();
  await page.keyboard.type('45');
  await w1.blur();
  await expect.poll(async () => (await hints(page)).slice(1).map(h => h.kg)).toEqual(['45', '45']);
  // Back to the planned 50: the abandoned 45 must not linger on WORK 2 / 3.
  await w1.click();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('50');
  await w1.blur();
  await expect.poll(async () => (await hints(page)).slice(1)).toEqual(plan.slice(1));
  expect(errors).toEqual([]);
});

for (const scheme of ['dark', 'light']) {
  test(`suggested values look different from entered values · ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.addInitScript(outdoor => localStorage.setItem('dp_outdoor_mode', outdoor ? '1' : '0'), scheme === 'light');
    const errors = await login(page, [ex], hist);
    await page.locator('#w_0_0_1').fill('50');
    await page.locator('#r_0_0_1').fill('10');
    await page.locator('#w_0_0_3').focus(); // move focus off the rows being measured
    const look = await page.evaluate(() => {
      const read = id => {
        const el = document.getElementById(id), cs = getComputedStyle(el), ph = getComputedStyle(el, '::placeholder');
        return { bg: cs.backgroundColor, weight: cs.fontWeight, hintWeight: ph.fontWeight, text: cs.webkitTextFillColor || cs.color, hint: ph.webkitTextFillColor || ph.color };
      };
      const t3 = getComputedStyle(document.documentElement).getPropertyValue('--t-3').trim();
      const probe = document.createElement('span'); probe.style.color = t3; document.body.appendChild(probe);
      const t3rgb = getComputedStyle(probe).color; probe.remove();
      return { typedKg: read('w_0_0_1'), typedReps: read('r_0_0_1'), hintKg: read('w_0_0_2'), hintReps: read('r_0_0_2'), t3rgb };
    });
    for (const typed of [look.typedKg, look.typedReps]) {
      expect(Number(typed.weight)).toBeGreaterThanOrEqual(700);
      expect(typed.bg).not.toBe('rgba(0, 0, 0, 0)');
    }
    for (const hint of [look.hintKg, look.hintReps]) {
      // What shows in an empty box is the placeholder, so that is what is read.
      expect(Number(hint.hintWeight)).toBeLessThan(700);
      expect(hint.bg).toBe('rgba(0, 0, 0, 0)');
      expect(hint.hint).toBe(look.t3rgb);
    }
    expect(errors).toEqual([]);
  });
}
