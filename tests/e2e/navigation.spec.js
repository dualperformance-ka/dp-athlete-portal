import { expect, test } from '@playwright/test';

test.setTimeout(60_000);

const athlete = { ok: true, exists: true, active: true, code: 'KARL', name: 'Karl', auth_mode: 'both', email: 'k@e.com', access_token: 'signed-session' };

async function openPortal(page, { width, height, outdoor = false, deepTab = '' }) {
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => {
    window.supabase = { createClient: () => ({ auth: {
      onAuthStateChange(){ return { data: { subscription: { unsubscribe(){} } } }; },
      async getSession(){ return { data: { session: null } }; },
      async signOut(){ return { error: null }; },
    } }) };
  });
  await page.route('**/_vercel/**', route => route.abort());
  await page.route('https://**', route => route.abort());
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body = {}; try { body = route.request().postDataJSON() || {}; } catch (error) {}
    let json = { ok: true };
    if (url.pathname === '/api/auth-athlete') json = url.searchParams.get('action') === 'eligibility' ? { ok:true, enabled:true, eligible:true, active:true } : athlete;
    else if (url.pathname.startsWith('/api/strava')) json = { connected:false, activities:[] };
    else if (url.pathname === '/api/reminders') json = { ok:true, notifications:[], unread:0 };
    else if (url.pathname === '/api/portal-data') {
      if (body.action === 'bootstrap') json = { ok:true, state:{rows:[],checkins:[]}, bodyLogs:{rows:[]}, nutritionLogs:{rows:[]}, sessionLogs:{rows:[]}, dailyLogged:{body:[],nutrition:[]} };
      else json = { ok:true, rows:[], checkins:[], body:[], nutrition:[], planned:{ rows:[], next:null, prescriptions:{ exercises:{}, runSteps:{} } }, splits:{rows:[]}, changes:{rows:[]}, library:{rows:[],revision:'nav-e2e'} };
    }
    await route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify(json) });
  });

  await page.goto(`/index.html${deepTab ? `?tab=${deepTab}` : ''}`);
  await page.getByRole('button', { name:'Use athlete access code' }).click();
  await page.getByLabel('Athlete access code').fill('KARL');
  await page.getByRole('button', { name:'Enter Portal' }).click();
  await expect(page.locator('#portalScreen')).toBeVisible();
  await page.evaluate(value => document.documentElement.classList.toggle('outdoor-mode', value), outdoor);
  await page.evaluate(() => { const prompt = document.getElementById('emailUpgradePrompt'); if (prompt) { prompt.hidden = true; prompt.style.display = 'none'; } });
}

async function choose(page, destination, mobile) {
  const selector = mobile ? `[data-mobile-tab="${destination}"]` : `.tabs [data-tab="${destination}"]`;
  await page.locator(selector).click();
  await expect(page.locator('body')).toHaveAttribute('data-active-tab', destination);
}

for (const mode of [
  { name:'phone dark', width:393, height:852, outdoor:false },
  { name:'phone daylight', width:393, height:852, outdoor:true },
  { name:'desktop dark', width:1440, height:1000, outdoor:false },
  { name:'desktop daylight', width:1440, height:1000, outdoor:true },
]) {
  test(`five-destination navigation works in ${mode.name}`, async ({ page }) => {
    const mobile = mode.width < 900;
    await openPortal(page, mode);
    await expect(page.locator('body')).toHaveAttribute('data-active-tab', 'today');
    await expect(page.locator('.quicklog-strip')).toBeVisible();

    await choose(page, 'week', mobile);
    await expect(page.locator('#tab-weekly')).toBeVisible();
    await expect(page.locator('.quicklog-strip')).toBeVisible();

    await choose(page, 'progress', mobile);
    await expect(page.locator('#tab-progress')).toBeVisible();

    await choose(page, 'coaching', mobile);
    await expect(page.locator('#tab-calls')).toBeVisible();
    await page.getByRole('button', { name:'Complete your check-in' }).click();
    await expect(page.locator('#checkinModal')).toHaveClass(/open/);
    await page.getByRole('button', { name:'Close check-in' }).click();

    const log = mobile ? page.locator('[data-mobile-tab="log"]') : page.locator('.tabs [data-tab="log"]');
    await log.click();
    await expect(page.locator('#qlBodyModal')).toHaveClass(/open/);
    await page.getByRole('button', { name:'Close body log' }).click();

    await page.locator('#profileAvatar').click();
    await expect(page.locator('#profileMenu')).toHaveClass(/open/);
    await expect(page.locator('#profileMenu .profile-menu-sheet')).toBeVisible();
    await page.locator('#profileMenu .profile-menu-list button').first().click();
    await expect(page.locator('body')).toHaveAttribute('data-active-tab', 'goals');

    await choose(page, 'today', mobile);
    await choose(page, 'week', mobile);
    await page.goBack();
    await expect(page.locator('body')).toHaveAttribute('data-active-tab', 'today');
    await page.goForward();
    await expect(page.locator('body')).toHaveAttribute('data-active-tab', 'week');

    await page.screenshot({ path:`test-results/navigation-${mode.name.replaceAll(' ', '-')}.png`, fullPage:true });
  });
}

test('coaching deep link survives login', async ({ page }) => {
  await openPortal(page, { width:393, height:852, deepTab:'coaching' });
  await expect(page.locator('body')).toHaveAttribute('data-active-tab', 'coaching');
  await expect(page.locator('#tab-calls')).toBeVisible();
});
