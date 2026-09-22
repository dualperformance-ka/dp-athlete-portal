// Shared portal boot harness for e2e specs.
//
// The portal is stubbed at the network edge exactly as weekfit.spec.js does it:
// a signed athlete, a planned week, and empty logs. Specs that need to look at
// rendered chrome (layout, colour) get a real, fully booted portal without a
// backend.
export function localISO(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Adelaide', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function monday(base = new Date()) {
  const d = new Date(localISO(base));
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d;
}

const athlete = { ok: true, exists: true, active: true, code: 'KARL', name: 'Karl', auth_mode: 'both', email: 'k@e.com', access_token: 'signed-session' };

// A week with a completed strength session (Monday) and a mix of run days, so
// the done/pending/key variants of a calendar row are all on screen.
export function weekRows() {
  const mon = monday();
  const iso = i => { const d = new Date(mon); d.setDate(mon.getDate() + i); return localISO(d); };
  const plan = [
    [0, [['Upper A (2 days / wk)', 'strength']]],
    [1, [['Progression 8km (controlled)', 'run']]],
    [3, [['Sub-49 Specific 3x2km + 4x200m', 'run'], ['Lower A', 'strength']]],
    [6, [['Long Run 18km', 'run']]],
  ];
  const rows = [];
  plan.forEach(([offset, list]) => list.forEach(([title, type], n) => {
    rows.push({ id: `s-${offset}-${n}`, notion_page_id: `s-${offset}-${n}`, title, planned_date: iso(offset), session_type: type, status: offset === 0 ? 'Completed' : 'Planned', week_label: 'Week 12' });
  }));
  return rows;
}

/**
 * @param {object} options
 *  - onPortalAction(action, body) — return `{ status?, json }` to answer a
 *    /api/portal-data action yourself, or undefined to fall through to the
 *    default stub. Lets a spec fail, delay or shape one action without
 *    reimplementing the whole backend.
 */
export async function bootPortal(page, { rows = weekRows(), outdoor = false, onPortalAction = null } = {}) {
  await page.addInitScript(() => {
    window.supabase = { createClient: () => ({ auth: {
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async getSession() { return { data: { session: null } }; },
      async signOut() { return { error: null }; } } }) };
  });
  await page.addInitScript(mode => {
    try { localStorage.setItem('dp_outdoor_mode', mode ? '1' : '0'); } catch (e) {}
  }, outdoor);
  await page.route('**/_vercel/**', r => r.abort());
  await page.route('https://**', r => r.abort());
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body = {}; try { body = route.request().postDataJSON() || {}; } catch (e) {}
    const planned = { rows, next: null, prescriptions: { exercises: {}, runSteps: {} } };
    let json = { ok: true };
    if (url.pathname === '/api/auth-athlete') json = url.searchParams.get('action') === 'eligibility' ? { ok: true, enabled: true, eligible: true, active: true } : athlete;
    else if (url.pathname.startsWith('/api/strava')) json = { connected: false, activities: [] };
    else if (url.pathname === '/api/reminders') json = { ok: true, notifications: [], unread: 0 };
    else if (url.pathname === '/api/portal-data') {
      if (onPortalAction) {
        const handled = await onPortalAction(String(body.action || ''), body);
        if (handled) {
          await route.fulfill({
            status: handled.status || 200,
            contentType: 'application/json',
            body: JSON.stringify(handled.json === undefined ? { ok: true } : handled.json),
          });
          return;
        }
      }
      const common = { planned, splits: { rows: [] }, changes: { rows: [] }, library: { rows: [], revision: 'e2e' } };
      if (body.action === 'bootstrap') json = { ok: true, state: { rows: [], checkins: [] }, bodyLogs: { rows: [] }, nutritionLogs: { rows: [] }, sessionLogs: { rows: [] }, dailyLogged: { body: [], nutrition: [] }, ...common };
      else json = { ok: true, rows: [], checkins: [], body: [], nutrition: [], ...common };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) });
  });

  await page.goto('/index.html');
  await page.getByRole('button', { name: 'Use athlete access code' }).click();
  await page.getByLabel('Athlete access code').fill('KARL');
  await page.getByRole('button', { name: 'Enter Portal' }).click();
  await page.locator('#portalScreen').waitFor({ state: 'visible' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { const p = document.getElementById('emailUpgradePrompt'); if (p) { p.hidden = true; p.style.display = 'none'; } });
}
