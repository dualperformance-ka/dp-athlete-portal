import { expect, test } from '@playwright/test';

// Regression for the production Sentry event
//   SecurityError: Storage disabled  (onunhandledrejection)
// Browser storage can exist while every method throws (privacy modes, blocked
// site data, automated browsers), or be null, or throw on property access.
// None of those may reject bootPortal(), raise a page error, or leave the
// logged-out athlete looking at a blank screen.

const athlete = { ok: true, exists: true, active: true, code: 'KARL', name: 'Karl', auth_mode: 'code', access_token: 'signed-session' };

// Storage failure modes, installed before any portal script runs. Written as
// function expressions: addInitScript serialises the function source, and
// method shorthand (`name() {}`) does not survive that as an expression.
const MODES = {
  getItemThrows: function () {
    const error = new DOMException('Storage disabled', 'SecurityError');
    Storage.prototype.getItem = function () { throw error; };
  },
  removeItemThrows: function () {
    const error = new DOMException('Storage disabled', 'SecurityError');
    Storage.prototype.removeItem = function () { throw error; };
  },
  allMethodsThrow: function () {
    const error = new DOMException('Storage disabled', 'SecurityError');
    for (const name of ['getItem', 'setItem', 'removeItem', 'key', 'clear']) {
      Storage.prototype[name] = function () { throw error; };
    }
  },
  storageNull: function () {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: null });
  },
  storageAccessThrows: function () {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('Storage disabled', 'SecurityError'); },
    });
  },
};

/**
 * Stub the network edge and record everything the acceptance criteria care
 * about: page errors, unhandled rejections, and the analytics request.
 *  - seed: localStorage entries written before the portal boots (only used
 *    when storage itself works for writes)
 *  - mode: a key of MODES, installed after seeding
 *  - authAthlete(request): override the /api/auth-athlete response
 *  - session: an access token for the Supabase getSession stub (email auth)
 */
async function preparePortal(page, { seed = null, mode = null, authAthlete = null, session = null } = {}) {
  const problems = [];
  const analytics = [];
  page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error' && /unhandledrejection/i.test(message.text())) problems.push(`console: ${message.text()}`);
  });

  await page.addInitScript(token => {
    window.__dpUnhandled = [];
    window.addEventListener('unhandledrejection', event => {
      const reason = event.reason;
      window.__dpUnhandled.push(String((reason && (reason.name + ': ' + reason.message)) || reason));
    });
    window.supabase = { createClient: () => ({ auth: {
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async getSession() { return { data: { session: token ? { access_token: token } : null } }; },
      async signOut() { return { error: null }; },
    } }) };
  }, session);
  if (seed) {
    await page.addInitScript(entries => {
      // Seed once per test, not on every navigation, so a logout can be
      // followed by a reload that observes the cleared state.
      if (sessionStorage.getItem('__dpSeeded')) return;
      sessionStorage.setItem('__dpSeeded', '1');
      for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
    }, seed);
  }
  if (mode) await page.addInitScript(MODES[mode]);

  await page.route('**/_vercel/**', route => { analytics.push(route.request().url()); return route.abort(); });
  await page.route('https://**', route => route.abort());
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body = {}; try { body = route.request().postDataJSON() || {}; } catch (e) {}
    let status = 200;
    let json = { ok: true };
    if (url.pathname === '/api/auth-athlete') {
      if (url.searchParams.get('action') === 'eligibility') json = { ok: true, enabled: true, eligible: true, active: true };
      else if (authAthlete) ({ status = 200, json } = authAthlete(route.request()));
      else json = athlete;
    } else if (url.pathname.startsWith('/api/strava')) json = { connected: false, activities: [] };
    else if (url.pathname === '/api/reminders') json = { ok: true, notifications: [], unread: 0 };
    else if (url.pathname === '/api/portal-data') {
      const common = { planned: { rows: [], next: null, prescriptions: { exercises: {}, runSteps: {} } }, splits: { rows: [] }, changes: { rows: [] }, library: { rows: [], revision: 'e2e' } };
      json = body.action === 'bootstrap'
        ? { ok: true, state: { rows: [], checkins: [] }, bodyLogs: { rows: [] }, nutritionLogs: { rows: [] }, sessionLogs: { rows: [] }, dailyLogged: { body: [], nutrition: [] }, ...common }
        : { ok: true, rows: [], checkins: [], body: [], nutrition: [], ...common };
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
  });
  return { problems, analytics };
}

async function expectCleanLoggedOutBoot(page, recorded) {
  await expect(page.locator('#loginScreen')).toBeVisible();
  await expect(page.locator('#portalScreen')).toBeHidden();
  // Analytics still starts once boot settles, whichever way it settled.
  await expect.poll(() => page.evaluate(() => window.__dpAnalyticsStarted === true)).toBe(true);
  await expect.poll(() => recorded.analytics.some(url => url.includes('/_vercel/insights/script.js'))).toBe(true);
  // Give any stray rejection a chance to surface before asserting silence.
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__dpUnhandled)).toEqual([]);
  expect(recorded.problems).toEqual([]);
}

test('getItem throwing SecurityError still shows the login screen with no unhandled rejection', async ({ page }) => {
  const recorded = await preparePortal(page, { mode: 'getItemThrows' });
  await page.goto('/index.html');
  await expectCleanLoggedOutBoot(page, recorded);
});

test('removeItem throwing while discarding a rejected legacy session still shows the login screen', async ({ page }) => {
  const recorded = await preparePortal(page, {
    seed: { dp_legacy_session: 'expired-token' },
    mode: 'removeItemThrows',
    authAthlete: () => ({ status: 401, json: { ok: false, error: 'invalid_session' } }),
  });
  await page.goto('/index.html');
  await expectCleanLoggedOutBoot(page, recorded);
});

test('removeItem throwing on a ?code= link still signs the athlete in', async ({ page }) => {
  const recorded = await preparePortal(page, { mode: 'removeItemThrows' });
  await page.goto('/index.html?code=KARL');
  await expect(page.locator('#portalScreen')).toBeVisible();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__dpUnhandled)).toEqual([]);
  expect(recorded.problems).toEqual([]);
});

test('every storage method throwing still shows the login screen', async ({ page }) => {
  const recorded = await preparePortal(page, { mode: 'allMethodsThrow' });
  await page.goto('/index.html');
  await expectCleanLoggedOutBoot(page, recorded);
});

test('localStorage being null still shows the login screen', async ({ page }) => {
  const recorded = await preparePortal(page, { mode: 'storageNull' });
  await page.goto('/index.html');
  await expectCleanLoggedOutBoot(page, recorded);
});

test('reading window.localStorage throwing still shows the login screen', async ({ page }) => {
  const recorded = await preparePortal(page, { mode: 'storageAccessThrows' });
  await page.goto('/index.html');
  await expectCleanLoggedOutBoot(page, recorded);
});

test('an unexpected bootPortal rejection is caught, logged once and falls back to login', async ({ page }) => {
  const warnings = [];
  page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
  // Force a failure the storage layer cannot absorb: when 00-safe-storage.js
  // installs safeStorageGet, wrap it so the legacy-session lookup throws
  // synchronously inside bootPortal.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'safeStorageGet', {
      configurable: true,
      set(fn) {
        Object.defineProperty(window, 'safeStorageGet', {
          configurable: true, writable: true,
          value(key) { if (key === 'dp_legacy_session') throw new Error('boom'); return fn(key); },
        });
      },
    });
  });
  const recorded = await preparePortal(page);
  await page.goto('/index.html');
  await expectCleanLoggedOutBoot(page, recorded);
  expect(warnings.filter(text => text.includes('Portal boot failed'))).toHaveLength(1);
});

// ── Working storage keeps every existing restore path ─────────────────────────

test('a stored legacy access session restores straight into the portal', async ({ page }) => {
  let authorization = '';
  const recorded = await preparePortal(page, {
    seed: { dp_legacy_session: 'stored-token' },
    authAthlete: request => { authorization = request.headers().authorization || ''; return { json: athlete }; },
  });
  await page.goto('/index.html');
  await expect(page.locator('#portalScreen')).toBeVisible();
  expect(authorization).toBe('Bearer stored-token');
  await expect.poll(() => page.evaluate(() => window.__dpAnalyticsStarted === true)).toBe(true);
  expect(recorded.problems).toEqual([]);
});

test('a remembered access code signs in automatically', async ({ page }) => {
  let legacyLogin = null;
  const recorded = await preparePortal(page, {
    seed: { dp_auth_code: 'KARL', dp_auth_method: 'code' },
    authAthlete: request => {
      try { legacyLogin = request.postDataJSON(); } catch (e) {}
      return { json: athlete };
    },
  });
  await page.goto('/index.html');
  await expect(page.locator('#portalScreen')).toBeVisible();
  expect(legacyLogin).toEqual({ action: 'legacy-login', code: 'KARL' });
  expect(await page.evaluate(() => localStorage.getItem('dp_legacy_session'))).toBe('signed-session');
  expect(recorded.problems).toEqual([]);
});

test('a stored email session restores straight into the portal', async ({ page }) => {
  let authorization = '';
  const recorded = await preparePortal(page, {
    seed: { 'dp-portal-auth': '{"stored":true}', dp_auth_method: 'email' },
    session: 'email-session',
    authAthlete: request => { authorization = request.headers().authorization || ''; return { json: { ...athlete, access_token: undefined } }; },
  });
  await page.goto('/index.html');
  await expect(page.locator('#portalScreen')).toBeVisible();
  expect(authorization).toBe('Bearer email-session');
  expect(recorded.problems).toEqual([]);
});

test('explicit logout clears remembered credentials so the next boot stays logged out', async ({ page }) => {
  const recorded = await preparePortal(page, { seed: { dp_auth_code: 'KARL', dp_auth_method: 'code' } });
  await page.goto('/index.html');
  await expect(page.locator('#portalScreen')).toBeVisible();
  await page.evaluate(() => logout());
  await expect(page.locator('#loginScreen')).toBeVisible();
  expect(await page.evaluate(() => ['dp_auth_code', 'dp_auth_method', 'dp_legacy_session'].map(key => localStorage.getItem(key)))).toEqual([null, null, null]);
  await page.reload();
  await expect(page.locator('#loginScreen')).toBeVisible();
  await expect(page.locator('#portalScreen')).toBeHidden();
  expect(recorded.problems).toEqual([]);
});
