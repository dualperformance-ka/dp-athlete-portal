import { expect, test } from '@playwright/test';
test.setTimeout(120_000);

function localISO(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone:'Australia/Adelaide', year:'numeric', month:'2-digit', day:'2-digit' }).format(d);
}
const today = localISO();
const yesterday = (() => { const d = new Date(today + 'T00:00:00'); d.setDate(d.getDate() - 1); return localISO(d); })();
const athlete = { ok:true, exists:true, active:true, code:'KARL', name:'Karl', auth_mode:'both', email:'karl@example.com', access_token:'signed-session' };
const exercise = { exercise:'Leg Extension', sets:'3', reps:'8', repRange:'8-12', warmupSets:'0', workingSets:'3', rest:'0s', notes:'' };

function bundle() {
  return { planned:{ rows:[{ id:'session-1', notion_page_id:'session-1', title:'Lower A', planned_date:today, session_type:'strength', status:'Planned', week_label:'Week 3', notes:'' }], next:null, prescriptions:{ exercises:{}, runSteps:{} } },
    splits:{ rows:[{ name:'Lower A', athlete_code:null, exercises:[exercise] }] }, changes:{ rows:[] }, library:{ rows:[], revision:'accept' }, errors:[] };
}

async function login(page, opts = {}) {
  const state = { offline:false, writes:[] };
  await page.addInitScript(() => {
    window.supabase = { createClient: () => ({ auth:{ onAuthStateChange(){ return { data:{ subscription:{ unsubscribe(){} } } }; }, async getSession(){ return { data:{ session:null } }; }, async signOut(){ return { error:null }; } } }) };
  });
  if (opts.seedYesterdayFuel) {
    await page.addInitScript(([code, y]) => {
      localStorage.setItem('dp_daily_nut_' + code + '_' + y, JSON.stringify({ calories:'2450', protein:'172', carbs:'268', fat:'71', fibre:'34', notes:'big day' }));
    }, ['KARL', yesterday]);
  }
  await page.route('**/_vercel/**', r => r.abort());
  await page.route('https://**', r => r.abort());
  await page.route('**/api/**', async route => {
    const req = route.request(); const url = new URL(req.url());
    let body = {}; try { body = req.postDataJSON() || {}; } catch (e) {}
    if (state.offline && (url.pathname === '/api/ingest' || (url.pathname === '/api/portal-data' && body.action === 'state-write'))) { await route.abort('internetdisconnected'); return; }
    if (url.pathname === '/api/ingest') state.writes.push(body);
    let json = { ok:true };
    if (url.pathname === '/api/auth-athlete') json = url.searchParams.get('action') === 'eligibility' ? { ok:true, enabled:true, eligible:true, active:true } : athlete;
    else if (url.pathname === '/api/portal-data') {
      const a = body.action;
      if (a === 'bootstrap') json = { ok:true, state:{ rows:[], checkins:[] }, bodyLogs:{ rows:[] }, nutritionLogs:{ rows:[] }, sessionLogs:{ rows:[] }, dailyLogged:{ body:[], nutrition:[] } };
      else if (a === 'training-read') json = bundle();
      else if (a === 'state-read') json = { ok:true, rows:[], checkins:[] };
      else if (a === 'daily-log-dates') json = { ok:true, body:[], nutrition:[] };
      else json = { ok:true, rows:[] };
    } else if (url.pathname.startsWith('/api/strava')) json = { connected:false, activities:[] };
    else if (url.pathname === '/api/reminders') json = { ok:true, notifications:[], unread:0 };
    await route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify(json) });
  });
  await page.goto('/index.html');
  await page.getByRole('button', { name:'Use athlete access code' }).click();
  await page.getByLabel('Athlete access code').fill('KARL');
  await page.getByRole('button', { name:'Enter Portal' }).click();
  await expect(page.locator('#portalScreen')).toBeVisible();
  await expect(page.getByText('Lower A', { exact:true }).first()).toBeVisible();
  return state;
}

// ── 1 · reachable and submittable from every destination ─────────────────────
for (const dest of ['today', 'week', 'progress', 'coaching', 'goals']) {
  test(`the Log sheet opens and submits a body check-in from ${dest}`, async ({ page }) => {
    await login(page);
    await page.evaluate(d => switchTab(d), dest);
    await page.waitForTimeout(400);
    await page.evaluate(() => openLogSheet());
    await expect(page.locator('#logSheet')).toHaveClass(/open/);
    await page.evaluate(() => showLogTab('body'));
    await expect(page.locator('#logPanelBody')).toBeVisible();
    await page.locator('#qlbWeight').fill('72.4');
    await page.getByRole('button', { name:'Save body check-in' }).click();
    await expect(page.locator('#qlDockBody')).toHaveClass(/is-done/);
    await expect(page.locator('#logSheet')).not.toHaveClass(/open/);
  });
}

// ── 2 · offline queues, online drains ────────────────────────────────────────
test('logging offline shows the queued state, and coming back online sends it', async ({ page, context }) => {
  const state = await login(page);
  state.offline = true;
  await context.setOffline(true);
  await page.evaluate(() => openLogSheet('body'));
  await page.locator('#qlbWeight').fill('72.9');
  await page.getByRole('button', { name:'Save body check-in' }).click();
  // Saved on this device, NOT with the coaches.
  await expect(page.locator('#queuePendingBanner')).toBeVisible();
  await expect(page.locator('#qlDockBody')).not.toHaveClass(/is-done/);
  const pending = await page.evaluate(() => pendingCoachWriteCount());
  expect(pending).toBeGreaterThan(0);

  state.offline = false;
  await context.setOffline(false);
  await page.evaluate(() => retryPendingCoachWrites && retryPendingCoachWrites());
  await expect.poll(() => page.evaluate(() => pendingCoachWriteCount()), { timeout:20_000 }).toBe(0);
});

// ── 3 · a second save is a correction, not a duplicate ───────────────────────
test('saving twice on the same day reads as a correction', async ({ page }) => {
  await login(page);
  await page.evaluate(() => openLogSheet('body'));
  await page.locator('#qlbWeight').fill('72.4');
  await page.getByRole('button', { name:'Save body check-in' }).click();
  await expect(page.locator('#qlDockBody')).toHaveClass(/is-done/);

  await page.evaluate(() => openLogSheet('body'));
  // The day comes back with its values, the note says the coaches have it, and
  // the button offers an update rather than a fresh save.
  await expect(page.locator('#qlbWeight')).toHaveValue('72.4');
  await expect(page.locator('#qlbSubmittedNote')).toBeVisible();
  await expect(page.locator('#qlbSubmittedNote')).toContainText(/coaches have this/i);
  await expect(page.locator('#qlbSubmitBtn')).toHaveText('Update body check-in');
  // Same date, so one record for the day — not a second one.
  await expect(page.locator('#qlbDate')).toHaveValue(today);
});

// ── 4 · default tab picks what is most likely ─────────────────────────────────
test('the sheet opens on Session while today is unlogged, then Body, then Fuel', async ({ page }) => {
  await login(page);
  expect(await page.evaluate(() => defaultLogTab())).toBe('session');
  await page.evaluate(() => { markSessionLogged('session-1'); });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => defaultLogTab())).toBe('body');
  await page.evaluate(d => markLogConfirmed('body', d), today);
  expect(await page.evaluate(() => defaultLogTab())).toBe('fuel');
});

// ── 5 · three tabs, one set of fields ────────────────────────────────────────
test('the sheet carries three tabs and exactly one copy of each field', async ({ page }) => {
  await login(page);
  await page.evaluate(() => openLogSheet());
  await expect(page.locator('#logSheetTabs .quicklog-btn')).toHaveCount(3);
  for (const id of ['qlbDate', 'qlbWeight', 'qlbSubmitBtn', 'qlnDate', 'qlnCal', 'qlnSubmitBtn']) {
    await expect(page.locator('#' + id)).toHaveCount(1);
  }
  // Session tab reuses the run/strength path: the row hands off, it does not
  // reimplement a form.
  await page.evaluate(() => showLogTab('session'));
  await expect(page.locator('#logPanelSession .log-session-row')).toHaveCount(1);
  await expect(page.locator('#logPanelSession')).toContainText('Lower A');
});

// ── 6 · fuel seeds from yesterday, marked and editable ───────────────────────
test('the Fuel tab starts from yesterday, clearly marked, and the mark clears on edit', async ({ page }) => {
  await login(page, { seedYesterdayFuel:true });
  await page.evaluate(() => openLogSheet('fuel'));
  await expect(page.locator('#logPanelFuel')).toBeVisible();
  await expect(page.locator('#qlnCal')).toHaveValue('2450');
  await expect(page.locator('#qlnPro')).toHaveValue('172');
  await expect(page.locator('#qlnSeedNote')).toBeVisible();
  await expect(page.locator('#qlnSeedNote')).toContainText(/yesterday/i);
  // Editable, and editing makes it the athlete's own number.
  await expect(page.locator('#qlnCal')).toHaveClass(/is-seeded/);
  await page.locator('#qlnCal').fill('2200');
  await expect(page.locator('#qlnCal')).not.toHaveClass(/is-seeded/);
  // A seeded day must not claim to be a record the coaches hold.
  await expect(page.locator('#qlnSubmitBtn')).toHaveText('Save nutrition log');
});

// ── 7 · drafts survive and say they are unsent ────────────────────────────────
test('a field draft-saves and is restored marked as not yet submitted', async ({ page }) => {
  await login(page);
  await page.evaluate(() => openLogSheet('body'));
  await page.locator('#qlbNotes').fill('left calf tight on the warm up');
  await page.locator('#qlbWeight').fill('73.1');
  await page.waitForTimeout(700);           // past the 400ms debounce
  await page.evaluate(() => closeLogSheet());
  const stored = await page.evaluate(d => localStorage.getItem('dp_log_draft_body_KARL_' + d), today);
  expect(stored).toBeTruthy();
  expect(JSON.parse(stored).qlbNotes).toBe('left calf tight on the warm up');

  await page.evaluate(() => openLogSheet('body'));
  await expect(page.locator('#qlbNotes')).toHaveValue('left calf tight on the warm up');
  await expect(page.locator('#qlbDraftNote')).toBeVisible();
  await expect(page.locator('#qlbDraftNote')).toContainText(/not been sent/i);
});

// ── 8 · the refresh control is back, top right ────────────────────────────────
test('the header carries a refresh control again', async ({ page }) => {
  await login(page);
  const btn = page.locator('#portalRefreshBtn');
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('aria-label', /refresh/i);
  // It sits in the header actions, at the end of the row with the bell and avatar.
  await expect(page.locator('.header-actions #portalRefreshBtn')).toHaveCount(1);
  const [refreshBox, bellBox] = await Promise.all([btn.boundingBox(), page.locator('#notificationBell').boundingBox()]);
  expect(refreshBox.x).toBeLessThan(bellBox.x);
});
