import { expect, test } from '@playwright/test';
function localISO(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Adelaide', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
const today = localISO();
const athlete = { ok: true, exists: true, active: true, code: 'KARL', name: 'Karl Sexon', auth_mode: 'both', email: 'k@e.com', access_token: 'signed-session' };
const rows = [{ id: 'run-today', notion_page_id: 'run-today', title: 'Optional Easy 9km', planned_date: today, session_type: 'run', status: 'Completed', week_label: 'Week 8', intensity: 'Z1-2 / RPE 2-3' }];

test("today's session shows the full prescription, not an ellipsis", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.addInitScript(() => { window.supabase = { createClient: () => ({ auth: { onAuthStateChange(){return {data:{subscription:{unsubscribe(){}}}};}, async getSession(){return {data:{session:null}};}, async signOut(){return {error:null};} } }) }; });
  await page.route('**/_vercel/**', r => r.abort());
  await page.route('https://**', r => r.abort());
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body = {}; try { body = route.request().postDataJSON() || {}; } catch (e) {}
    const planned = { rows, next: null, prescriptions: { exercises: {}, runSteps: {} } };
    let json = { ok: true };
    if (url.pathname === '/api/auth-athlete') json = url.searchParams.get('action') === 'eligibility' ? { ok:true, enabled:true, eligible:true, active:true } : athlete;
    else if (url.pathname.startsWith('/api/strava')) json = { connected:false, activities:[] };
    else if (url.pathname === '/api/reminders') json = { ok:true, notifications:[], unread:0 };
    else if (url.pathname === '/api/portal-data') {
      if (body.action === 'bootstrap') json = { ok:true, state:{rows:[],checkins:[]}, bodyLogs:{rows:[]}, nutritionLogs:{rows:[]}, sessionLogs:{rows:[{session_key:'session_KARL_run-today',logged_at:today}]}, dailyLogged:{body:[],nutrition:[]}, planned, splits:{rows:[]}, changes:{rows:[]}, library:{rows:[],revision:'e2e'} };
      else json = { ok:true, rows:[], checkins:[], body:[], nutrition:[], planned, splits:{rows:[]}, changes:{rows:[]}, library:{rows:[],revision:'e2e'} };
    }
    await route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(json) });
  });
  await page.goto('/index.html');
  await page.getByRole('button', { name: 'Use athlete access code' }).click();
  await page.getByLabel('Athlete access code').fill('KARL');
  await page.getByRole('button', { name: 'Enter Portal' }).click();
  await expect(page.locator('#portalScreen')).toBeVisible();
  await page.waitForTimeout(1800);
  // The prescription must be readable, not ellipsised away behind the action
  // button, and the completion state must not be repeated in it: the button
  // already says "Completed" and the card is green.
  const meta = await page.evaluate(() => {
    const m = document.querySelector('#todayEl .todaymeta');
    return {
      text: m.textContent.trim(),
      clippedH: m.scrollHeight > m.clientHeight + 1,
      clippedW: m.scrollWidth > m.clientWidth + 1,
    };
  });
  expect(meta.text, 'the prescription must survive').toContain('Z1-2 / RPE 2-3');
  expect(meta.text, 'the week must survive').toContain('Week 8');
  expect(meta.text, 'completion is already on the button and the card colour').not.toContain('Completed');
  expect(meta.clippedW, 'prescription clipped horizontally').toBe(false);
  expect(meta.clippedH, 'prescription clipped vertically').toBe(false);

  // The session name matters more than the meta; it must not be ellipsised
  // into "Optional E..." either.
  const name = await page.evaluate(() => {
    const n = document.querySelector('#todayEl .todayname');
    return { text: n.textContent.trim(), clippedW: n.scrollWidth > n.clientWidth + 1, clippedH: n.scrollHeight > n.clientHeight + 1 };
  });
  expect(name.text).toBe('Optional Easy 9km');
  expect(name.clippedW, 'session name clipped horizontally').toBe(false);
  expect(name.clippedH, 'session name clipped vertically').toBe(false);
  await expect(page.locator('#todayEl .today-action')).toContainText('Completed');
  await page.screenshot({ path: 'test-results/home-card.png' });
});
