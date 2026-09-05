import { expect, test } from '@playwright/test';

function localISO(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Adelaide', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function monday(base = new Date()) {
  const d = new Date(localISO(base)); const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day); return d;
}
const athlete = { ok: true, exists: true, active: true, code: 'KARL', name: 'Karl', auth_mode: 'both', email: 'k@e.com', access_token: 'signed-session' };

// Karl's actual week: 10 sessions over 7 days, three days doubled up.
function weekRows() {
  const mon = monday();
  const iso = i => { const d = new Date(mon); d.setDate(mon.getDate() + i); return localISO(d); };
  const plan = [
    [0, [['Upper A', 'strength']]],
    [1, [['Progression 8km (controlled)', 'run']]],
    [2, [['Recovery 12km', 'run']]],
    [3, [['Sub-49 Specific 3x2km + 4x200m', 'run'], ['Lower A', 'strength']]],
    [4, [['Recovery 9km', 'run'], ['Upper B', 'strength']]],
    [5, [['Optional Easy 9km', 'run']]],
    [6, [['Long Run 18km', 'run'], ['Mobility', 'strength']]],
  ];
  const rows = [];
  plan.forEach(([offset, list]) => list.forEach(([title, type], n) => {
    rows.push({ id: `s-${offset}-${n}`, notion_page_id: `s-${offset}-${n}`, title, planned_date: iso(offset), session_type: type, status: 'Planned', week_label: 'Week 8' });
  }));
  return rows;
}

const SIZES = [
  { name: 'iPhone SE', width: 375, height: 667 },
  { name: 'iPhone 13 mini', width: 375, height: 812 },
  { name: 'iPhone 15 Pro', width: 393, height: 852 },
  { name: 'iPhone 15 Pro Max', width: 430, height: 932 },
];

for (const size of SIZES) {
test(`every day of a 10-session week is visible without scrolling on ${size.name}`, async ({ page }) => {
  await page.setViewportSize({ width: size.width, height: size.height });
  const rows = weekRows();
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
    const planned = { rows, next: null, prescriptions: { exercises: {}, runSteps: {} } };
    let json = { ok: true };
    if (url.pathname === '/api/auth-athlete') json = url.searchParams.get('action') === 'eligibility' ? { ok:true, enabled:true, eligible:true, active:true } : athlete;
    else if (url.pathname.startsWith('/api/strava')) json = { connected: false, activities: [] };
    else if (url.pathname === '/api/reminders') json = { ok:true, notifications:[], unread:0 };
    else if (url.pathname === '/api/portal-data') {
      if (body.action === 'bootstrap') json = { ok:true, state:{rows:[],checkins:[]}, bodyLogs:{rows:[]}, nutritionLogs:{rows:[]}, sessionLogs:{rows:[]}, dailyLogged:{body:[],nutrition:[]}, planned, splits:{rows:[]}, changes:{rows:[]}, library:{rows:[],revision:'e2e'} };
      else json = { ok:true, rows:[], checkins:[], body:[], nutrition:[], planned, splits:{rows:[]}, changes:{rows:[]}, library:{rows:[],revision:'e2e'} };
    }
    await route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(json) });
  });

  await page.goto('/index.html');
  await page.getByRole('button', { name: 'Use athlete access code' }).click();
  await page.getByLabel('Athlete access code').fill('KARL');
  await page.getByRole('button', { name: 'Enter Portal' }).click();
  await expect(page.locator('#portalScreen')).toBeVisible();
  await page.waitForTimeout(1500);
  // The week agenda is the mobile training "plan" view; land on it explicitly.
  await page.evaluate(() => goTrainingPlan());
  await page.waitForTimeout(900);

  // renderCal paints both the Training tab (#calEl) and the desktop Weekly tab,
  // so scope to the one the mobile plan view actually shows.
  const agenda = page.locator('#calEl .mobile-week-agenda');
  await expect(agenda).toBeVisible();
  const days = page.locator('#calEl .mobile-week-day');
  await expect(days).toHaveCount(7);

  // The quicklog dock is fixed-position and used to float over the bottom of
  // the agenda, hiding Saturday and Sunday behind it.
  const dock = await page.evaluate(() => {
    const el = document.querySelector('.quicklog-strip');
    return el ? getComputedStyle(el).display : 'none-el';
  });
  expect(dock, 'the quicklog dock must not cover the week agenda').toBe('none');
  // The email-upgrade prompt is a one-off nag, not part of this layout; it
  // steals ~150px and would make the measurements lie about a normal week.
  await page.evaluate(() => { const p = document.getElementById('emailUpgradePrompt'); if (p) { p.hidden = true; p.style.display = 'none'; } });
  await page.waitForTimeout(300);
  if (size.name === 'iPhone 15 Pro') await page.screenshot({ path: 'test-results/week-fits.png' });

  // The agenda must sit above the tab bar, not run underneath it.
  const nav = await page.locator('.mobile-nav').boundingBox();
  const agendaBox = await agenda.boundingBox();
  if (nav) expect(agendaBox.y + agendaBox.height, 'agenda runs under the tab bar').toBeLessThanOrEqual(nav.y + 1);
  const box = await agenda.boundingBox();
  // Sunday's row must sit inside the agenda, not clipped below it.
  const last = await days.nth(6).boundingBox();
  expect(last.y + last.height).toBeLessThanOrEqual(box.y + box.height + 1);

  // And the agenda itself must not need scrolling.
  const overflow = await agenda.evaluate(el => el.scrollHeight - el.clientHeight);
  expect(overflow).toBeLessThanOrEqual(1);

  // The weekly volume strip stays on screen alongside it.
  const vstrip = page.locator('.vstrip').first();
  if (await vstrip.count()) await expect(vstrip).toBeInViewport();

  // Nothing may be clipped mid-content. This is what the first attempt got
  // wrong: rows were forced to a computed share and the overflow was hidden,
  // so Saturday's "9km" was sliced in half.
  const clipped = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('#calEl .mobile-week-day').forEach(day => {
      if (day.scrollHeight > day.clientHeight + 1) out.push(day.dataset.date + ':day');
      day.querySelectorAll('.mobile-week-session').forEach(b => {
        if (b.scrollHeight > b.clientHeight + 1) out.push(day.dataset.date + ':' + b.textContent.trim().slice(0, 18));
      });
    });
    return out;
  });
  expect(clipped, 'content clipped inside these rows').toEqual([]);

  // No dead block under Sunday: the rows fill the agenda they were given.
  const slack = await agenda.evaluate(el => {
    const last = el.lastElementChild.getBoundingClientRect();
    return el.getBoundingClientRect().bottom - last.bottom;
  });
  expect(slack, 'empty space left inside the agenda under the last day').toBeLessThanOrEqual(8);

  // Every session row stays big enough to hit.
  const buttons = page.locator('#calEl .mobile-week-session');
  const n = await buttons.count();
  for (let i = 0; i < n; i += 1) {
    const b = await buttons.nth(i).boundingBox();
    expect(b.height, `session ${i} too small to tap`).toBeGreaterThanOrEqual(28);
  }
});
}
