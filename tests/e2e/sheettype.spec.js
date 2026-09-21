import { expect, test } from '@playwright/test';

const athlete = { ok: true, exists: true, active: true, code: 'KARL', name: 'Karl Sexon', auth_mode: 'both', email: 'k@e.com', access_token: 'signed-session' };

test('check-in fields stay iOS-safe in the Coaching sheet and return to their host', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.addInitScript(() => {
    window.supabase = { createClient: () => ({ auth: {
      onAuthStateChange(){return {data:{subscription:{unsubscribe(){}}}};},
      async getSession(){return {data:{session:null}};}, async signOut(){return {error:null};} } }) };
  });
  await page.route('**/_vercel/**', r => r.abort());
  await page.route('https://**', r => r.abort());
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body = {}; try { body = route.request().postDataJSON() || {}; } catch (e) {}
    let json = { ok: true };
    if (url.pathname === '/api/auth-athlete') json = url.searchParams.get('action') === 'eligibility' ? { ok:true, enabled:true, eligible:true, active:true } : athlete;
    else if (url.pathname.startsWith('/api/strava')) json = { connected:false, activities:[] };
    else if (url.pathname === '/api/reminders') json = { ok:true, notifications:[], unread:0 };
    else if (url.pathname === '/api/portal-data') {
      if (body.action === 'bootstrap') json = { ok:true, state:{rows:[],checkins:[]}, bodyLogs:{rows:[]}, nutritionLogs:{rows:[]}, sessionLogs:{rows:[]}, dailyLogged:{body:[],nutrition:[]} };
      else json = { ok:true, rows:[], checkins:[], body:[], nutrition:[] };
    }
    await route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(json) });
  });

  await page.goto('/index.html');
  await page.getByRole('button', { name: 'Use athlete access code' }).click();
  await page.getByLabel('Athlete access code').fill('KARL');
  await page.getByRole('button', { name: 'Enter Portal' }).click();
  await expect(page.locator('#portalScreen')).toBeVisible();

  const size = async () => page.locator('#ciRunWins').evaluate(el => ({
    font: parseFloat(getComputedStyle(el).fontSize),
    inline: el.style.fontSize || '',
  }));

  const host = await page.locator('#ciFormContent').evaluate(el => el.parentElement.id);
  await page.evaluate(() => switchTab('coaching'));
  await page.evaluate(() => openCheckinSheet());
  await expect(page.locator('#checkinModal')).toHaveClass(/open/);
  const inSheet = await size();
  expect(inSheet.inline, 'no inline font-size should shadow the stylesheet').toBe('');
  // Below 16px iOS zooms the page on every field tap.
  expect(inSheet.font, 'the sheet must not drop below the iOS zoom floor').toBeGreaterThanOrEqual(16);

  // The placeholder must actually fit rather than being clipped by min-height.
  const clipped = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('#checkinModal textarea.li').forEach(el => {
      if (!el.offsetParent) return;            // only what the athlete can see
      if (el.scrollHeight > el.clientHeight + 1) out.push(el.id);
    });
    return out;
  });
  expect(clipped, 'placeholder copy clipped inside these textareas').toEqual([]);

  await page.screenshot({ path: 'test-results/sheet-type.png' });

  // Closing returns the one shared form to its inert host.
  await page.evaluate(() => closeCheckinSheet());
  const returnedHost = await page.locator('#ciFormContent').evaluate(el => el.parentElement.id);
  expect(returnedHost).toBe(host);
});
