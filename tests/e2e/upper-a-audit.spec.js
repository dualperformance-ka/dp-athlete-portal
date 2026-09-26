import { expect, test } from '@playwright/test';
import { upperA, upperAHistory } from './fixtures-upper-a.mjs';

// Audit against the real session that prompted the redesign: Upper A (2 days
// / wk), 12 exercises, with the athlete's actual recent history. Every
// exercise must fit one phone screen mid-set, and the whole session must log
// through the dock and land in the saved draft exactly as typed.

function localISO(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Adelaide', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
const today = localISO();
const TITLE = 'Upper A (2 days / wk)';
const athlete = { ok: true, exists: true, active: true, code: 'KARL', name: 'Karl', auth_mode: 'both', email: 'karl@example.com', access_token: 'signed-session' };

async function mockPortal(page) {
  await page.addInitScript(() => {
    window.supabase = { createClient() { return { auth: {
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async getSession() { return { data: { session: null } }; },
      async signOut() { return { error: null }; },
    } }; } };
  });
  for (const host of ['**/_vercel/**', 'https://fonts.googleapis.com/**', 'https://fonts.gstatic.com/**', 'https://browser.sentry-cdn.com/**', 'https://cdn.jsdelivr.net/**']) {
    await page.route(host, route => route.abort());
  }
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch (error) {}
    let json = { ok: true };
    if (url.pathname === '/api/auth-athlete') {
      json = url.searchParams.get('action') === 'eligibility' ? { ok: true, enabled: true, eligible: true, active: true } : athlete;
    } else if (url.pathname === '/api/portal-data') {
      const action = body.action;
      if (action === 'bootstrap') json = { ok: true, state: { rows: [], checkins: [] }, bodyLogs: { rows: [] }, nutritionLogs: { rows: [] }, sessionLogs: { rows: [] }, dailyLogged: { body: [], nutrition: [] } };
      else if (action === 'training-read') json = {
        planned: { rows: [{ id: 'session-1', notion_page_id: 'session-1', title: TITLE, planned_date: today, session_type: 'strength', status: 'Planned', week_label: 'Week 3', notes: '' }], next: null, prescriptions: { exercises: {}, runSteps: {} } },
        splits: { rows: [{ name: TITLE, athlete_code: null, exercises: upperA }] },
        changes: { rows: [] }, library: { rows: [], revision: 'e2e', notModified: false }, errors: [],
      };
      else if (action === 'state-read') json = { ok: true, rows: [], checkins: [] };
      else if (['body-logs', 'nutrition-logs', 'session-logs-read', 'nutrition-week', 'weekly-sport-targets', 'programme-data', 'booking-sync', 'booking-read'].includes(action)) json = { ok: true, rows: [] };
      else if (action === 'daily-log-dates') json = { ok: true, body: [], nutrition: [] };
    } else if (url.pathname.startsWith('/api/strava')) {
      json = { ok: true, connected: false, activities: [] };
    }
    await route.fulfill({ json });
  });
}

async function openSession(page, rpe) {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript((on) => localStorage.setItem('dp_strength_rpe_enabled', on ? 'true' : 'false'), rpe);
  // History is on the device before the portal loads, so the session card is
  // always built with it (injecting after login raced the card build).
  await page.addInitScript((entries) => {
    if (localStorage.getItem('dp_logs_KARL')) return;
    const seeded = {};
    entries.forEach(entry => { seeded[entry.id] = { ...entry.log, __sessionDate: entry.date }; });
    localStorage.setItem('dp_logs_KARL', JSON.stringify(seeded));
  }, upperAHistory);
  await mockPortal(page);
  await page.goto('/index.html');
  await page.getByRole('button', { name: 'Use athlete access code' }).click();
  await page.getByLabel('Athlete access code').fill('KARL');
  await page.getByRole('button', { name: 'Enter Portal' }).click();
  await expect(page.locator('#portalScreen')).toBeVisible();
  await page.getByRole('button', { name: `Open ${TITLE}` }).click();
  await expect(page.locator('#focusOverlay')).toHaveClass(/open/);
  // Sanity: the real history is driving the targets.
  await expect(page.locator('.exc[data-exercise-index="0"] .exl-target .exl-big').first()).toHaveText('38.6');
  return errors;
}

// Measures the open exercise: is everything needed mid-set above the dock,
// with nothing clipped and no sideways scroll?
function measure(page) {
  return page.locator('.exc.exl.open').evaluate((node) => {
    const box = (sel) => { const el = node.querySelector(sel); return el ? el.getBoundingClientRect() : null; };
    const rows = [...node.querySelectorAll('.setrow,.setrow-single')];
    const dockTop = box('.exl-dock').top;
    return {
      name: node.querySelector('.exn').textContent,
      rows: rows.length,
      // The exercise's own row must be visible below the session header.
      headTop: Math.round(node.querySelector('.exc-summary').getBoundingClientRect().top - document.getElementById('focusOverlayScroll').getBoundingClientRect().top),
      lastRowBottom: Math.round(rows[rows.length - 1].getBoundingClientRect().bottom),
      tilesBottom: Math.round(box('.exl-tiles').bottom),
      dockTop: Math.round(dockTop),
      dockBottom: Math.round(box('.exl-dock').bottom),
      spare: Math.round(dockTop - box('.exl-tiles').bottom),
      wide: Math.max(document.documentElement.scrollWidth - window.innerWidth, (() => { const sc = document.getElementById('focusOverlayScroll'); return sc.scrollWidth - sc.clientWidth; })()),
      clipped: [...node.querySelectorAll('.slast, .sin, .rpe-in, .exl-line, .exl-name, .snum')]
        .filter(el => el.offsetParent && el.scrollWidth > el.clientWidth + 1).map(el => `${el.id || el.className} ${el.scrollWidth}>${el.clientWidth} ${el.textContent}`),
      small: [...node.querySelectorAll('.exl-view input, .exl-view button, .exl-dock button')]
        .filter(el => el.offsetParent && !el.closest('.set-effort') && !el.classList.contains('del-set') && !el.classList.contains('exl-pref') /* 26px pill, 44px touch area via ::after */)
        .filter(el => el.getBoundingClientRect().height < 44).map(el => el.id || el.className),
    };
  });
}

const sizes = [
  { name: 'iPhone 15 / 14', width: 393, height: 852, rpe: true },
  { name: 'iPhone 13 / 14', width: 390, height: 844, rpe: true },
  { name: 'iPhone 13 / 14 (RPE off)', width: 390, height: 844, rpe: false },
  { name: 'iPhone 13 mini', width: 375, height: 812, rpe: true },
  { name: 'Android 360', width: 360, height: 780, rpe: true },
];

for (const size of sizes) {
  test(`every Upper A exercise fits one screen · ${size.name} ${size.width}×${size.height}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    const errors = await openSession(page, size.rpe);
    const report = [];
    for (let ei = 0; ei < upperA.length; ei++) {
      const card = page.locator(`.exc[data-exercise-index="${ei}"]`);
      if (!(await card.evaluate(el => el.classList.contains('open')))) await card.locator('.exc-summary').click();
      await expect(card).toHaveClass(/\bopen\b/);
      await page.waitForTimeout(300); // let open/tick transitions settle; measure what the athlete sees
      const m = await measure(page);
      report.push(m);
      expect.soft(m.headTop, `${m.name}: exercise row under the header`).toBeGreaterThanOrEqual(0);
      expect.soft(m.lastRowBottom, `${m.name}: last set row behind the dock`).toBeLessThanOrEqual(m.dockTop);
      expect.soft(m.tilesBottom, `${m.name}: tiles behind the dock`).toBeLessThanOrEqual(m.dockTop);
      expect.soft(m.dockBottom, `${m.name}: dock off screen`).toBeLessThanOrEqual(size.height + 1);
      expect.soft(m.wide, `${m.name}: sideways scroll`).toBeLessThanOrEqual(0);
      expect.soft(m.clipped, `${m.name}: clipped text`).toEqual([]);
      expect.soft(m.small, `${m.name}: tap targets under 44px`).toEqual([]);
    }
    console.log(`AUDIT ${size.name} ${size.width}x${size.height} rpe=${size.rpe}\n` + report.map(r => `  ${r.name.padEnd(24)} rows=${r.rows} spare=${r.spare}px lastRow=${r.lastRowBottom} tiles=${r.tilesBottom} dockTop=${r.dockTop}`).join('\n'));
    await page.screenshot({ path: `test-results/upper-a-list-${size.width}x${size.height}.png` });
    expect(errors).toEqual([]);
  });
}

test('the whole Upper A session logs by typing alone and saves exactly what was typed', async ({ page }) => {
  test.setTimeout(120000); // twelve exercises, every set, one tap at a time
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await openSession(page, true);
  const typed = {};
  const pickerFit = [];
  for (let ei = 0; ei < upperA.length; ei++) {
    // Always start from the Up next card, the way an athlete moves through.
    // The first is already open; after that it is one tap.
    const up = page.locator('.exc.is-up-next');
    await expect(up).toHaveAttribute('data-exercise-index', String(ei));
    if (!(await up.evaluate(el => el.classList.contains('open')))) await up.locator('.exc-summary').click();
    const card = page.locator(`.exc[data-exercise-index="${ei}"]`);
    await expect(card).toHaveClass(/\bopen\b/);
    const dock = card.locator('.exl-log');
    const rows = card.locator('.setrow,.setrow-single');
    const count = await rows.count();
    typed[ei] = [];
    for (let si = 0; si < count; si++) {
      await expect(page.locator(`#sr_0_${ei}_${si}`)).toHaveClass(/is-current/);
      const single = await page.locator(`#rL_0_${ei}_${si}`).count();
      const kgHint = await page.locator(`#w_0_${ei}_${si}`).getAttribute('placeholder');
      const reps = 10 + (si % 2);
      if (single) {
        await page.locator(`#rL_0_${ei}_${si}`).fill(String(reps));
        await page.locator(`#rR_0_${ei}_${si}`).fill(String(reps));
      } else {
        await page.locator(`#r_0_${ei}_${si}`).fill(String(reps));
        await page.locator(`#rpe_0_${ei}_${si}`).fill('8');
      }
      // No kg typed when the box shows a numeric target: logging uses it.
      if (!/^\d+(\.\d+)?$/.test(String(kgHint))) await page.locator(`#w_0_${ei}_${si}`).fill('20');
      // Nothing is pressed: the row ticks itself once reps are in and typing
      // pauses. The first work set asks its effort question first.
      const picker = page.locator(`#effort_0_${ei}_${si}`);
      const tick = page.locator(`#st_0_${ei}_${si}`);
      await expect.poll(async () => (await tick.evaluate(el => el.classList.contains('on'))) || ((await picker.count()) > 0 && await picker.isVisible()), { timeout: 4000 }).toBe(true);
      if (await picker.count() && await picker.isVisible()) {
        const withPicker = await measure(page);
        pickerFit.push(`${withPicker.name} spare=${withPicker.dockTop - withPicker.lastRowBottom}`);
        expect.soft(withPicker.lastRowBottom, `${withPicker.name}: last set hidden while the effort question is open`).toBeLessThanOrEqual(withPicker.dockTop);
        expect.soft(withPicker.wide, `${withPicker.name}: sideways scroll with the effort question open`).toBeLessThanOrEqual(0);
        expect.soft(withPicker.clipped, `${withPicker.name}: clipped with the effort question open`).toEqual([]);
        await picker.getByRole('button', { name: /On target/ }).click();
      }
      await expect(tick).toHaveClass(/\bon\b/);
      // The exercise being logged never moves: it stays open in the Up next slot.
      if (si < count - 1) await expect(card).toHaveClass(/is-up-next/);
      typed[ei].push({ weight: await page.locator(`#w_0_${ei}_${si}`).inputValue(), reps: String(reps) });
    }
    // No finish or submit step: the done exercise closes itself.
    await expect(card).not.toHaveClass(/\bopen\b/);
    await expect(card).toHaveClass(/exercise-complete/);
    await expect(page.locator(`.exc[data-exercise-index="${ei}"] .exl-badge`)).not.toHaveAttribute('data-dir', 'none');
  }
  console.log('PICKER (last row vs dock, px, 390x844)\n  ' + pickerFit.join('\n  '));
  await expect(page.locator('.exlist-label[data-exl-label="done"]')).toContainText('Done · 12');
  // The list stays scannable: the header shows the whole session name and
  // done rows are one line each.
  const list = await page.evaluate(() => ({
    name: (() => { const el = document.getElementById('focusOverlayName'); return el.scrollWidth <= el.clientWidth + 1; })(),
    doneRows: [...document.querySelectorAll('.exlist .exc.exercise-complete')].map(el => Math.round(el.getBoundingClientRect().height)),
  }));
  expect(list.name, 'session name truncated').toBe(true);
  expect(Math.max(...list.doneRows), 'a done row wraps').toBeLessThanOrEqual(72);
  await expect(page.locator('#focusFooterTitle')).toHaveText('Draft saved on this device');
  await page.screenshot({ path: 'test-results/upper-a-all-done.png' });

  // The saved draft holds exactly what was logged, set for set.
  await page.waitForTimeout(400);
  const saved = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('dp_logs_KARL') || '{}')['session-1'] || {};
    const out = {};
    Object.keys(stored).filter(k => k.indexOf('__') !== 0).forEach(k => {
      out[k] = stored[k].map(set => ({ weight: set.weight, reps: set.reps || set.repsLeft, done: set.done }));
    });
    return out;
  });
  for (let ei = 0; ei < upperA.length; ei++) {
    const sets = saved[upperA[ei].exercise];
    expect(sets, upperA[ei].exercise).toBeTruthy();
    expect(sets.map(x => x.weight), upperA[ei].exercise).toEqual(typed[ei].map(x => x.weight));
    expect(sets.map(x => x.reps), upperA[ei].exercise).toEqual(typed[ei].map(x => x.reps));
    expect(sets.every(x => x.done), upperA[ei].exercise).toBe(true);
  }

  await page.locator('#focusFooterAction').click();
  await expect(page.locator('#strengthReviewTitle')).toHaveText('Review session');
  expect(errors).toEqual([]);
});
