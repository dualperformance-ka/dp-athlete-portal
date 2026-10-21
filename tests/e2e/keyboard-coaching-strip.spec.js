import { expect, test } from '@playwright/test';

// Logging a set with the phone keyboard open.
//
// On iPhone the keyboard does not shrink the page: the session overlay is
// position:fixed at the full screen height and the keyboard simply covers its
// bottom half. Safari then scrolls (and often pans the whole page) so the
// focused box sits just above the keyboard, which pushes Today's plan, with
// the rep range, the effort target and the progression rule, off the top of
// the screen. The athlete had to dismiss the keyboard to read it.
//
// Chromium has no on-screen keyboard, so the keyboard is stood in for the way
// Safari reports it: window.visualViewport shrinks (and may be offset by a
// pan) and fires resize/scroll, while innerHeight stays put. After focusing a
// box the test lets "Safari" put it just above the keyboard, exactly as iOS
// does, and then checks what the athlete can actually see.

function localISO(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Adelaide', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
const today = localISO();
const athlete = { ok: true, exists: true, active: true, code: 'KARL', name: 'Karl', auth_mode: 'both', email: 'karl@example.com', access_token: 'signed-session' };

const incline = { exercise: 'Incline Dumbbell Press', sets: '3', reps: '8', repRange: '8-12', warmupSets: '1', workingSets: '2', rest: '90s', rir: '2', notes: '' };
const legPress = { exercise: 'Leg Press', sets: '3', reps: '10', repRange: '10', warmupSets: '0', workingSets: '3', rest: '90s', notes: '' };
const assisted = { exercise: 'Assisted Pull-up', sets: '2', reps: '8', repRange: '8-12', warmupSets: '0', workingSets: '2', rest: '90s', notes: '' };
const split = { exercise: 'Bulgarian Split Squat', sets: '2', reps: '8', repRange: '8-12', warmupSets: '0', workingSets: '2', rest: '90s', notes: '' };
const exercises = [incline, legPress, assisted, split];
const history = [{ id: 'past', date: '2026-10-12', log: {
  'Incline Dumbbell Press': [{ weight: '14', reps: '12', done: true }, { weight: '26', reps: '10', done: true, effort: 'on_target' }, { weight: '26', reps: '9', done: true }],
  'Leg Press': [{ weight: '120', reps: '10', done: true, effort: 'on_target' }, { weight: '120', reps: '10', done: true }, { weight: '120', reps: '10', done: true }],
  'Assisted Pull-up': [{ weight: '30', reps: '9', done: true, effort: 'on_target' }, { weight: '30', reps: '8', done: true }],
} }];

// Typical iPhone screens with the numeric keyboard (plus its toolbar) up.
const PHONES = [
  { name: 'iPhone SE', width: 375, height: 667, keyboard: 260 },
  { name: 'iPhone 15', width: 390, height: 844, keyboard: 336 },
  { name: 'iPhone 15 Pro Max', width: 430, height: 932, keyboard: 346 },
  // In a Safari tab rather than the installed app: browser chrome takes more
  // of the screen, leaving the least room of all.
  { name: 'iPhone 15 in Safari', width: 390, height: 664, keyboard: 300 },
];

async function fakeKeyboard(page) {
  await page.addInitScript(() => {
    const vv = new EventTarget();
    let kb = 0, pan = 0;
    Object.defineProperties(vv, {
      width: { get: () => window.innerWidth },
      height: { get: () => window.innerHeight - kb },
      offsetTop: { get: () => pan },
      offsetLeft: { get: () => 0 },
      pageTop: { get: () => window.scrollY + pan },
      pageLeft: { get: () => 0 },
      scale: { get: () => 1 },
    });
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
    const fire = () => { vv.dispatchEvent(new Event('resize')); vv.dispatchEvent(new Event('scroll')); };
    window.__kb = {
      open(height, offset = 0) { kb = height; pan = offset; fire(); },
      close() { kb = 0; pan = 0; fire(); },
      area() { return { top: pan, bottom: pan + window.innerHeight - kb }; },
    };
  });
}

async function mockPortal(page, exercises) {
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
    const request = route.request();
    const url = new URL(request.url());
    let body = {};
    try { body = request.postDataJSON() || {}; } catch (error) {}
    let json = { ok: true };
    if (url.pathname === '/api/auth-athlete') {
      json = url.searchParams.get('action') === 'eligibility' ? { ok: true, enabled: true, eligible: true, active: true } : athlete;
    } else if (url.pathname === '/api/portal-data') {
      const action = body.action;
      if (action === 'bootstrap') json = { ok: true, state: { rows: [], checkins: [] }, bodyLogs: { rows: [] }, nutritionLogs: { rows: [] }, sessionLogs: { rows: [] }, dailyLogged: { body: [], nutrition: [] } };
      else if (action === 'training-read') json = {
        planned: { rows: [{ id: 'session-1', notion_page_id: 'session-1', title: 'Upper A', planned_date: today, session_type: 'strength', status: 'Planned', week_label: 'Week 3', notes: '' }], next: null, prescriptions: { exercises: {}, runSteps: {} } },
        splits: { rows: [{ name: 'Upper A', athlete_code: null, exercises }] },
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

async function openSession(page, phone, { rpe = true, list = exercises } = {}) {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setViewportSize({ width: phone.width, height: phone.height });
  await page.addInitScript(on => localStorage.setItem('dp_strength_rpe_enabled', on ? 'true' : 'false'), rpe);
  await fakeKeyboard(page);
  await mockPortal(page, list);
  await page.goto('/index.html');
  await page.getByRole('button', { name: 'Use athlete access code' }).click();
  await page.getByLabel('Athlete access code').fill('KARL');
  await page.getByRole('button', { name: 'Enter Portal' }).click();
  await expect(page.locator('#portalScreen')).toBeVisible();
  await expect(page.getByText('Upper A', { exact: true }).first()).toBeVisible();
  await page.evaluate((entries) => {
    entries.forEach(entry => { allSessions.push({ id: entry.id, date: entry.date }); logs[entry.id] = { ...entry.log, __sessionDate: entry.date }; });
  }, history);
  await page.getByRole('button', { name: 'Open Upper A' }).click();
  await expect(page.locator('#focusOverlay')).toHaveClass(/open/);
  await expect(page.locator('.exc.exl.open')).toHaveCount(1);
  await page.waitForTimeout(300);
  return errors;
}

// Focus a box, raise the keyboard, then do what Safari does: scroll the box's
// scroller so the box sits just above the keyboard if it is not already
// visible. With the fix in place the portal has already done this itself.
async function typeInto(page, selector, keyboard, pan = 0) {
  await page.locator(selector).focus();
  await page.evaluate(([h, p]) => window.__kb.open(h, p), [keyboard, pan]);
  await page.waitForTimeout(120);
  await page.evaluate((sel) => {
    const el = document.querySelector(sel), area = window.__kb.area();
    const scroller = el.closest('.focus-overlay-scroll');
    const r = el.getBoundingClientRect();
    if (r.bottom > area.bottom - 4) scroller.scrollTop += r.bottom - (area.bottom - 4);
  }, selector);
  await page.waitForTimeout(80);
}

// Fully on screen: inside the area above the keyboard, inside every clipping
// scroller, and actually the thing a finger would hit (nothing on top of it).
async function onScreen(page, selector) {
  return page.evaluate((sel) => {
    const el = typeof sel === 'string' ? document.querySelector(sel) : null;
    if (!el) return { ok: false, why: 'missing' };
    const r = el.getBoundingClientRect(), area = window.__kb.area();
    if (!r.width || !r.height) return { ok: false, why: 'not rendered' };
    if (r.top < area.top - 0.5 || r.bottom > area.bottom + 0.5) return { ok: false, why: `outside visible area ${Math.round(r.top)}-${Math.round(r.bottom)} vs ${area.top}-${area.bottom}` };
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll|hidden)/.test(cs.overflowY)) {
        const pr = p.getBoundingClientRect();
        if (r.top < pr.top - 0.5 || r.bottom > pr.bottom + 0.5) return { ok: false, why: 'clipped by ' + p.className };
      }
    }
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || !(hit === el || el.contains(hit))) return { ok: false, why: 'covered by ' + (hit && hit.className) };
    // Also anything drawn over it that ignores taps (a toast, a note): it
    // still hides the box from the athlete.
    for (const other of document.querySelectorAll('#focusOverlay *')) {
      if (other === el || other.contains(el) || el.contains(other)) continue;
      const cs = getComputedStyle(other);
      if (!/(absolute|fixed|sticky)/.test(cs.position) || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) continue;
      const o = other.getBoundingClientRect();
      if (!o.width || !o.height) continue;
      if (o.left < r.right - 1 && o.right > r.left + 1 && o.top < r.bottom - 1 && o.bottom > r.top + 1) return { ok: false, why: 'drawn over by ' + other.className };
    }
    return { ok: true };
  }, selector);
}

// Whatever on screen tells the athlete the rep range, the target RIR and the
// progression rule. Returns the first element that carries all of it and is
// fully visible above the keyboard.
async function visiblePrescription(page, { range, rir, rule }) {
  return page.evaluate(({ range, rir, rule }) => {
    const area = window.__kb.area();
    const norm = s => String(s || '').replace(/\s+/g, ' ');
    const candidates = Array.from(document.querySelectorAll('#focusOverlay *')).filter(el => {
      const t = norm(el.textContent);
      return t.includes(range) && (!rir || t.includes(rir)) && t.includes(rule);
    });
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.top < area.top - 0.5 || r.bottom > area.bottom + 0.5) continue;
      let clipped = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (/(auto|scroll|hidden)/.test(getComputedStyle(p).overflowY)) {
          const pr = p.getBoundingClientRect();
          if (r.top < pr.top - 0.5 || r.bottom > pr.bottom + 0.5) { clipped = true; break; }
        }
      }
      if (!clipped) return { ok: true, className: el.className };
    }
    return { ok: false, candidates: candidates.length };
  }, { range, rir, rule });
}

const cardRule = (page, ei) => page.locator(`.exc[data-exercise-index="${ei}"] .exl-target .exl-rule`).innerText();

for (const phone of PHONES) {
  test(`${phone.name}: prescription, RIR target and progression rule stay visible above the keyboard`, async ({ page }) => {
    const errors = await openSession(page, phone, { rpe: false });
    const rule = (await cardRule(page, 0)).replace(/\s+/g, ' ').trim();
    expect(rule.length).toBeGreaterThan(10);

    // 1. Focus kg on the first working set.
    await typeInto(page, '#w_0_0_1', phone.keyboard);
    expect(await onScreen(page, '#w_0_0_1')).toEqual({ ok: true });
    expect(await onScreen(page, '#r_0_0_1')).toEqual({ ok: true });
    expect(await onScreen(page, '#st_0_0_1')).toEqual({ ok: true });
    expect(await visiblePrescription(page, { range: '8–12', rir: 'RIR 2', rule })).toMatchObject({ ok: true });
    await page.keyboard.type('26');

    // 2. Straight from kg to reps: the strip stays and nothing jumps.
    const scrollBefore = await page.evaluate(() => document.getElementById('focusOverlayScroll').scrollTop);
    await page.locator('#r_0_0_1').focus();
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => document.getElementById('focusOverlayScroll').scrollTop)).toBeCloseTo(scrollBefore, 0);
    expect(await onScreen(page, '#r_0_0_1')).toEqual({ ok: true });
    expect(await visiblePrescription(page, { range: '8–12', rir: 'RIR 2', rule })).toMatchObject({ ok: true });
    await page.keyboard.type('10');

    // 3. Complete the first working set (effort answered, set ticked).
    await page.evaluate(() => window.__kb.close());
    await page.locator('#r_0_0_1').blur();
    await page.waitForTimeout(400);
    const effort = page.locator('#effort_0_0_1 button[data-effort-code="on_target"]');
    if (await effort.isVisible()) await effort.click();
    if (!(await page.locator('#st_0_0_1').getAttribute('class')).includes('on')) await page.locator('#st_0_0_1').click();
    await expect(page.locator('#st_0_0_1')).toHaveClass(/\bon\b/);

    // 4. Second working set: the strip names the row and keeps the rule.
    const rule2 = (await cardRule(page, 0)).replace(/\s+/g, ' ').trim();
    await typeInto(page, '#r_0_0_2', phone.keyboard);
    expect(await onScreen(page, '#w_0_0_2')).toEqual({ ok: true });
    expect(await onScreen(page, '#r_0_0_2')).toEqual({ ok: true });
    expect(await onScreen(page, '#st_0_0_2')).toEqual({ ok: true });
    expect(await visiblePrescription(page, { range: '8–12', rir: 'RIR 2', rule: rule2 })).toMatchObject({ ok: true });

    // 5. Dismiss (iOS "Done"): normal layout, strip gone, row stays put.
    const rowTop = await page.evaluate(() => document.getElementById('sr_0_0_2').getBoundingClientRect().top);
    await page.locator('#r_0_0_2').blur();
    await page.evaluate(() => window.__kb.close());
    await page.waitForTimeout(150);
    await expect(page.locator('#focusOverlay .exl-cue')).toBeHidden();
    expect(await page.evaluate(() => document.getElementById('focusOverlay').getAttribute('style') || '')).not.toMatch(/--kb-/);
    const rowTopAfter = await page.evaluate(() => document.getElementById('sr_0_0_2').getBoundingClientRect().top);
    expect(Math.abs(rowTopAfter - rowTop)).toBeLessThanOrEqual(2);
    // ...and reopens cleanly.
    await typeInto(page, '#w_0_0_2', phone.keyboard);
    expect(await visiblePrescription(page, { range: '8–12', rir: 'RIR 2', rule: rule2 })).toMatchObject({ ok: true });

    // 8. Nothing typed or ticked was lost on the way.
    expect(await page.locator('#w_0_0_1').inputValue()).toBe('26');
    expect(await page.locator('#r_0_0_1').inputValue()).toBe('10');
    await expect(page.locator('#st_0_0_1')).toHaveClass(/\bon\b/);
    expect(errors).toEqual([]);
  });
}

test('a page pan by Safari still leaves the session header and the strip on screen', async ({ page }) => {
  const phone = PHONES[1];
  const errors = await openSession(page, phone);
  await typeInto(page, '#r_0_0_1', phone.keyboard, 140);
  const box = await page.evaluate(() => {
    const r = document.getElementById('focusOverlay').getBoundingClientRect(), area = window.__kb.area();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), areaTop: area.top, areaBottom: area.bottom };
  });
  expect(box.top).toBe(box.areaTop);
  expect(box.bottom).toBe(box.areaBottom);
  expect(await onScreen(page, '.focus-close')).toEqual({ ok: true });
  expect(await onScreen(page, '#focusOverlay .exl-cue')).toEqual({ ok: true });
  expect(await onScreen(page, '#r_0_0_1')).toEqual({ ok: true });
  // RPE logging is on here: the strip shows the RPE equivalent of the target
  // so it reads against the RPE the athlete types, labelled as the target.
  await expect(page.locator('#focusOverlay .exl-cue-k')).toHaveText('Target');
  await expect(page.locator('#focusOverlay .exl-cue-effort')).toHaveText('RIR 2 · RPE 8');
  expect(errors).toEqual([]);
});

test('no box in the logger is small enough for iOS to zoom the page on focus', async ({ page }) => {
  const errors = await openSession(page, PHONES[1]);
  const small = await page.evaluate(() => Array.from(document.querySelectorAll('#focusOverlay input, #focusOverlay select, #focusOverlay textarea'))
    .filter(el => el.getClientRects().length)
    .map(el => ({ id: el.id || el.className, size: parseFloat(getComputedStyle(el).fontSize) }))
    .filter(x => x.size < 16));
  expect(small).toEqual([]);
  expect(errors).toEqual([]);
});

test('the strip follows each exercise’s own progression model, word for word with its card', async ({ page }) => {
  const phone = PHONES[1];
  const errors = await openSession(page, phone, { rpe: false });
  // slot = which working set the box belongs to. history = the engine has
  // something to set a per-set rep target from.
  const cases = [
    { ei: 0, first: '#w_0_0_1', slot: 0, name: 'Incline Dumbbell Press', history: true },
    { ei: 0, first: '#r_0_0_2', slot: 1, name: 'Incline Dumbbell Press', history: true },
    { ei: 1, first: '#w_0_1_0', slot: 0, name: 'Leg Press', history: true },
    { ei: 2, first: '#w_0_2_0', slot: 0, name: 'Assisted Pull-up', history: true, load: 'assist' },
    { ei: 3, first: '#w_0_3_0', slot: 0, name: 'Bulgarian Split Squat', history: false },
  ];
  const norm = t => t.replace(/\s+/g, ' ').trim();
  for (const c of cases) {
    const card = page.locator(`.exc[data-exercise-index="${c.ei}"]`);
    if (!(await card.getAttribute('class')).includes('open')) await card.locator('.exc-summary').click();
    await expect(card).toHaveClass(/\bopen\b/);
    const rule = norm(await cardRule(page, c.ei));
    const chips = card.locator('.exl-target .exl-set .exl-set-v');
    const chipReps = (await chips.count()) ? norm(await chips.nth(c.slot).innerText()).match(/^\d+/)[0] : null;
    const cardLoad = (await card.locator('.exl-target .exl-big').count()) ? norm(await card.locator('.exl-target .exl-big').innerText()) : null;
    await typeInto(page, c.first, phone.keyboard);
    const cue = page.locator('#focusOverlay .exl-cue');
    await expect(cue).toBeVisible();
    await expect(cue.locator('.exl-cue-name')).toHaveText(c.name);
    await expect(cue.locator('.exl-cue-row')).toHaveText(`Work ${c.slot + 1}`);
    await expect(cue.locator('.exl-cue-k')).toHaveText('Target');
    const big = norm(await cue.locator('.exl-cue-big').innerText());
    if (c.history) {
      // The engine's per-set target leads; the range drops to the line below.
      expect(chipReps, 'card should have a per-set target').not.toBeNull();
      expect(big).toMatch(new RegExp(`(^|× ?)${chipReps} ?reps$`));
      await expect(cue.locator('.exl-cue-range')).toHaveText(/Range 8–12|Exactly 10 reps/);
    } else {
      expect(big).toMatch(/8–12 ?reps$/);
    }
    if (cardLoad) expect(big.startsWith(cardLoad)).toBe(true);
    if (c.load) expect(big).toContain(c.load);
    await expect(cue.locator('.exl-cue-effort')).toHaveText('RIR 2');
    // The rule is the card's own sentence, never a second wording.
    expect(norm(await cue.locator('.exl-cue-rule .exl-cue-text').innerText())).toBe(rule);
    expect(await onScreen(page, c.first)).toEqual({ ok: true });
    await page.locator(c.first).blur();
    await page.evaluate(() => window.__kb.close());
    await page.waitForTimeout(80);
  }
  // A warm-up row: no per-set target, the working plan is labelled as such.
  await page.locator('.exc[data-exercise-index="0"] .exc-summary').click();
  await expect(page.locator('.exc[data-exercise-index="0"]')).toHaveClass(/\bopen\b/);
  await typeInto(page, '#w_0_0_0', phone.keyboard);
  await expect(page.locator('#focusOverlay .exl-cue-row')).toHaveText('WU 1');
  await expect(page.locator('#focusOverlay .exl-cue-k')).toHaveText('Work sets');
  await page.locator('#w_0_0_0').blur();
  await page.evaluate(() => window.__kb.close());
  await page.waitForTimeout(80);
  // Scrolling the list with the keyboard up keeps the strip in place and off
  // the inputs.
  await typeInto(page, '#w_0_0_1', phone.keyboard);
  await page.evaluate(() => { document.getElementById('focusOverlayScroll').scrollTop -= 200; });
  await page.waitForTimeout(80);
  expect(await onScreen(page, '#focusOverlay .exl-cue')).toEqual({ ok: true });
  expect(errors).toEqual([]);
});

// With the keyboard up, the session reaches all the way down under the
// keyboard (a glass keyboard must not show the page behind it), and nothing
// from the list shows below the pinned rest timer.
test('keyboard up: no page behind the keyboard, no row peeking under the rest timer', async ({ page }) => {
  const phone = PHONES[1];
  const errors = await openSession(page, phone, { rpe: false });
  await typeInto(page, '#w_0_0_1', phone.keyboard);
  const m = await page.evaluate(() => {
    const area = window.__kb.area();
    const under = document.elementFromPoint(window.innerWidth / 2, area.bottom + 40);
    const sc = document.getElementById('focusOverlayScroll').getBoundingClientRect();
    const dock = document.querySelector('.exc.open .exl-dock').getBoundingClientRect();
    return { underIsOverlay: !!(under && under.closest('#focusOverlay')) || under === document.getElementById('focusOverlay'), gap: Math.round(sc.bottom - dock.bottom) };
  });
  expect(m.underIsOverlay).toBe(true);
  expect(m.gap).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

// Tapping a control straight from a set box hides the strip. Hiding it moves
// the list, and if that happened between press and release the release landed
// on a different element and the tap was lost (the effort answer, Swap,
// Review & submit). Filling rows down the card leaves the list scrolled to
// its end, where the browser clamps the scroll itself: the case that bit.
for (const phone of [PHONES[1], { name: 'desktop', width: 1280, height: 720, keyboard: 0 }]) test(`${phone.name}: a tap that takes focus off a set box still lands on what was tapped`, async ({ page }) => {
  // No rest timer (so no dock under the rows) and three working sets.
  const extension = { exercise: 'Leg Extension', sets: '3', reps: '8', repRange: '8-12', warmupSets: '0', workingSets: '3', rest: '0s', notes: '' };
  const curl = { ...extension, exercise: 'Leg Curl', sets: '2', workingSets: '2' };
  const errors = await openSession(page, phone, { rpe: false, list: [extension, curl] });
  for (const si of [0, 1, 2]) {
    await page.locator(`#w_0_0_${si}`).fill('40');
    await page.locator(`#r_0_0_${si}`).fill('10');
  }
  await expect(page.locator('#focusOverlay .exl-cue')).toBeVisible();
  const answer = page.locator('#effort_0_0_0 button[data-effort-code="on_target"]');
  await answer.click();
  await expect(answer).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#focusOverlay .exl-cue')).toBeHidden();
  expect(errors).toEqual([]);
});
