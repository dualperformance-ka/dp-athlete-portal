import { expect, test } from '@playwright/test';

// Signing out (or an expired session logging the athlete out) while the
// portal is still loading used to throw from the login pipeline's late work:
//   Cannot read properties of null (reading 'code')       doLogin
//   Cannot read properties of null (reading 'startDate')  loadWeek
// logoutToLogin sets athlete=null, and the in-flight responses then painted a
// portal that was no longer on screen. Surfaced in CI by the slower runner
// under storage-disabled.spec.js's logout test.

const athlete = { ok: true, exists: true, active: true, code: 'KARL', name: 'Karl', auth_mode: 'code', access_token: 'signed-session' };

async function slowPortal(page, delay) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('__dpSeeded')) {
      sessionStorage.setItem('__dpSeeded', '1');
      localStorage.setItem('dp_auth_code', 'KARL');
      localStorage.setItem('dp_auth_method', 'code');
    }
    window.supabase = { createClient: () => ({ auth: {
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async getSession() { return { data: { session: null } }; },
      async signOut() { return { error: null }; },
    } }) };
  });
  await page.route('https://**', route => route.abort());
  await page.route('**/_vercel/**', route => route.abort());
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body = {}; try { body = route.request().postDataJSON() || {}; } catch (e) {}
    let json = { ok: true };
    if (url.pathname === '/api/auth-athlete') {
      json = url.searchParams.get('action') === 'eligibility' ? { ok: true, enabled: true, eligible: true, active: true } : athlete;
    } else if (url.pathname === '/api/portal-data') {
      // Hold every data response so the sign-out lands mid-load.
      await new Promise(resolve => setTimeout(resolve, delay));
      const common = { planned: { rows: [], next: null, prescriptions: { exercises: {}, runSteps: {} } }, splits: { rows: [] }, changes: { rows: [] }, library: { rows: [], revision: 'e2e' } };
      json = body.action === 'bootstrap'
        ? { ok: true, state: { rows: [], checkins: [] }, bodyLogs: { rows: [] }, nutritionLogs: { rows: [] }, sessionLogs: { rows: [] }, dailyLogged: { body: [], nutrition: [] }, ...common }
        : { ok: true, rows: [], checkins: [], body: [], nutrition: [], ...common };
    } else if (url.pathname.startsWith('/api/strava')) json = { connected: false, activities: [] };
    else if (url.pathname === '/api/reminders') json = { ok: true, notifications: [], unread: 0 };
    try { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) }); } catch (e) {}
  });
  return errors;
}

for (const delay of [800, 1500]) {
  test(`signing out while the portal is still loading (${delay}ms data) leaves a clean login screen`, async ({ page }) => {
    const errors = await slowPortal(page, delay);
    await page.goto('/index.html');
    await expect(page.locator('#portalScreen')).toBeVisible();
    await page.evaluate(() => logout());
    // Let every held response land after the sign-out.
    await page.waitForTimeout(delay + 2000);
    await expect(page.locator('#loginScreen')).toBeVisible();
    await expect(page.locator('#portalScreen')).toBeHidden();
    expect(await page.evaluate(() => athlete)).toBeNull();
    expect(errors).toEqual([]);
  });
}
