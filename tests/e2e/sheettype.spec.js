import { expect, test } from '@playwright/test';

const athlete = { ok: true, exists: true, active: true, code: 'KARL', name: 'Karl Sexon', auth_mode: 'both', email: 'k@e.com', access_token: 'signed-session' };

test('check-in sheet fields are sized for the sheet, and the tab is untouched', async ({ page }) => {
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

  // On the tab the field keeps the shared control size.
  await page.evaluate(() => switchTab('checkin'));
  const onTab = await size();
  expect(onTab.inline, 'no inline font-size should shadow the stylesheet').toBe('');
  // The mobile accessibility floor pins form controls to 16px+ so iOS does not
  // zoom the page on focus. The sheet must not undercut it.
  expect(onTab.font).toBeGreaterThanOrEqual(16);

  // In the sheet it steps down to fit the narrower column.
  await page.evaluate(() => switchTab('calls'));
  await page.evaluate(() => openCheckinSheet());
  await expect(page.locator('#checkinModal')).toHaveClass(/open/);
  const inSheet = await size();
  // Smaller than the tab, but exactly on the threshold: below 16px iOS zooms
  // the page on every field tap, which on a five-step form is worse than the
  // extra pixel. This asserts both halves of that trade.
  expect(inSheet.font, 'the sheet must not drop below the iOS zoom floor').toBeGreaterThanOrEqual(16);
  expect(inSheet.font, 'and should be smaller than the tab').toBeLessThan(onTab.font);

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

  // Next must be on screen the moment the sheet opens, on every step, without
  // scrolling to hunt for it.
  const modalBox = await page.locator('#checkinModal .ql-modal-inner').boundingBox();
  for (const step of [1, 2, 3, 4, 5]) {
    await page.evaluate(s => ciGoStep(s), step);
    await page.waitForTimeout(150);
    const isLast = step === 5;
    const btn = page.locator(isLast ? '#ciSubmitBtn' : '#ciBtnNext');
    await expect(btn, `step ${step} action button hidden`).toBeVisible();
    const b = await btn.boundingBox();
    expect(b.y + b.height, `step ${step} action button sits below the sheet`).toBeLessThanOrEqual(modalBox.y + modalBox.height + 1);
    expect(b.y, `step ${step} action button sits above the sheet`).toBeGreaterThanOrEqual(modalBox.y);
  }
  await page.evaluate(() => ciGoStep(1));
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'test-results/sheet-type.png' });

  // And closing hands it back at the tab's size.
  await page.evaluate(() => closeCheckinSheet());
  const backOnTab = await size();
  expect(backOnTab.font).toBe(onTab.font);
});
