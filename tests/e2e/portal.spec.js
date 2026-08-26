import { expect, test } from '@playwright/test';

function localISO(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Adelaide', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

const today = localISO();
const athlete = { ok: true, exists: true, active: true, code: 'KARL', name: 'Karl', auth_mode: 'both', email: 'karl@example.com', access_token: 'signed-session' };
const exercise = { exercise: 'Leg Extension', sets: '3', reps: '8', repRange: '8-12', warmupSets: '0', workingSets: '3', rest: '0s', notes: '' };

function trainingBundle(note = '') {
  return {
    planned: {
      rows: [{ id: 'session-1', notion_page_id: 'session-1', title: 'Lower A', planned_date: today, session_type: 'strength', status: 'Planned', week_label: 'Week 3', notes: note }],
      next: null,
      prescriptions: { exercises: {}, runSteps: {} },
    },
    splits: { rows: [{ name: 'Lower A', athlete_code: null, exercises: [exercise] }] },
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
  const state = { offline: false, note: options.note || '' };
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
    let json = { ok: true };
    if (url.pathname === '/api/auth-athlete') {
      json = url.searchParams.get('action') === 'eligibility' ? { ok: true, enabled: true, eligible: true, active: true } : athlete;
    } else if (url.pathname === '/api/portal-data') {
      const action = body.action;
      if (action === 'bootstrap') json = { ok: true, state: { rows: [], checkins: [] }, bodyLogs: { rows: [] }, nutritionLogs: { rows: [] }, sessionLogs: { rows: [] }, dailyLogged: { body: [], nutrition: [] } };
      else if (action === 'training-read') json = trainingBundle(state.note);
      else if (action === 'state-read') json = { ok: true, rows: [], checkins: [] };
      else if (action === 'body-logs' || action === 'nutrition-logs' || action === 'session-logs-read') json = { ok: true, rows: [] };
      else if (action === 'daily-log-dates') json = { ok: true, body: [], nutrition: [] };
      else if (action === 'nutrition-week') json = { ok: true, rows: [] };
      else if (action === 'weekly-sport-targets') json = { ok: true, rows: [] };
      else if (action === 'programme-data') json = { ok: true, rows: [] };
      else if (action === 'booking-sync') json = { ok: true, rows: [] };
    } else if (url.pathname.startsWith('/api/strava')) {
      json = { connected: false, activities: [] };
    } else if (url.pathname === '/api/reminders') {
      json = request.method() === 'GET' ? { ok: true, notifications: [] } : { ok: true };
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

test('1. code login renders the portal and today’s session', async ({ page }) => {
  await codeLogin(page);
  await expect(page.getByRole('button', { name: 'Open Lower A' })).toBeVisible();
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
  for (let set = 0; set < 3; set++) {
    await page.locator(`#w_0_0_${set}`).fill(String(40 + set * 5));
    await page.locator(`#r_0_0_${set}`).fill(String(10 - set));
  }
  await page.getByRole('button', { name: /Right load/ }).click();
  await page.getByRole('button', { name: 'Save session' }).click();
  await expect(page.getByText('Session submitted', { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.locator('#portalScreen')).toBeVisible();
  await page.getByRole('button', { name: /Open (completed )?Lower A/ }).click();
  await expect(page.locator('#w_0_0_0')).toHaveValue('40');
  await expect(page.locator('#w_0_0_2')).toHaveValue('50');
});

test('4. body check-in updates the dock state', async ({ page }) => {
  await codeLogin(page);
  await page.getByRole('button', { name: 'Body check-in' }).click();
  await page.locator('#qlbWeight').fill('72.4');
  await page.getByRole('button', { name: 'Save body check-in' }).click();
  await expect(page.locator('#qlDockBody')).toHaveClass(/is-done/);
});

test('5. offline submit shows pending state and online recovery drains it', async ({ page, context }) => {
  const state = await codeLogin(page);
  state.offline = true;
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Body check-in' }).click();
  await page.locator('#qlbWeight').fill('72.5');
  await page.getByRole('button', { name: 'Save body check-in' }).click();
  await expect(page.locator('#queuePendingBanner')).toBeVisible();
  await expect(page.locator('#queuePendingBanner')).toContainText('1 log waiting to send');

  state.offline = false;
  await context.setOffline(false);
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
