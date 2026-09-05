import { expect, test } from '@playwright/test';

function localISO(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Adelaide', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function isoWeekSuffix(date = new Date()) {
  const local = new Date(localISO(date));
  local.setDate(local.getDate() + 3 - ((local.getDay() + 6) % 7));
  const weekOne = new Date(local.getFullYear(), 0, 4);
  const week = 1 + Math.round(((local - weekOne) / 86400000 - 3 + ((weekOne.getDay() + 6) % 7)) / 7);
  return `${local.getFullYear()}_${String(week).padStart(2, '0')}`;
}

const today = localISO();
const athlete = { ok: true, exists: true, active: true, code: 'KARL', name: 'Karl', auth_mode: 'both', email: 'karl@example.com', access_token: 'signed-session' };
const exercise = { exercise: 'Leg Extension', sets: '3', reps: '8', repRange: '8-12', warmupSets: '0', workingSets: '3', rest: '0s', notes: '' };

function trainingBundle(note = '', exercises = [exercise], changes = []) {
  return {
    planned: {
      rows: [{ id: 'session-1', notion_page_id: 'session-1', title: 'Lower A', planned_date: today, session_type: 'strength', status: 'Planned', week_label: 'Week 3', notes: note }],
      next: null,
      prescriptions: { exercises: {}, runSteps: {} },
    },
    splits: { rows: [{ name: 'Lower A', athlete_code: null, exercises }] },
    changes: { rows: changes },
    library: { rows: [], revision: 'e2e', notModified: false },
    errors: [],
  };
}

async function installSupabaseStub(page) {
  await page.addInitScript(() => {
    const listeners = [];
    const session = { access_token: 'email-session' };
    window.supabase = {
      createClient() {
        return { auth: {
          onAuthStateChange(callback) { listeners.push(callback); return { data: { subscription: { unsubscribe() {} } } }; },
          async signInWithOtp() { return { data: {}, error: null }; },
          async verifyOtp() { listeners.forEach(callback => callback('SIGNED_IN', session)); return { data: { session }, error: null }; },
          async getSession() { return { data: { session: null } }; },
          async signOut() { listeners.forEach(callback => callback('SIGNED_OUT', null)); return { error: null }; },
        } };
      },
    };
  });
}

async function mockPortal(page, options = {}) {
  const state = { offline: false, note: options.note || '', exercises: options.exercises || [exercise], changes: options.changes || [], bookingRows: options.bookingRows || [], notifications: options.notifications || [] };
  await installSupabaseStub(page);
  await page.route('**/_vercel/**', route => route.abort());
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('https://fonts.gstatic.com/**', route => route.abort());
  await page.route('https://browser.sentry-cdn.com/**', route => route.abort());
  await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    let body = {};
    try { body = request.postDataJSON() || {}; } catch (error) {}
    if (url.pathname === '/api/ingest' && state.offline) { await route.abort('internetdisconnected'); return; }
    if (url.pathname === '/api/portal-data' && body.action === 'state-write' && state.offline) { await route.abort('internetdisconnected'); return; }
    let json = { ok: true };
    if (url.pathname === '/api/auth-athlete') {
      json = url.searchParams.get('action') === 'eligibility' ? { ok: true, enabled: true, eligible: true, active: true } : athlete;
    } else if (url.pathname === '/api/portal-data') {
      const action = body.action;
      if (action === 'bootstrap') json = { ok: true, state: { rows: [], checkins: [] }, bodyLogs: { rows: [] }, nutritionLogs: { rows: [] }, sessionLogs: { rows: [] }, dailyLogged: { body: [], nutrition: [] } };
      else if (action === 'training-read') json = trainingBundle(state.note, state.exercises, state.changes);
      else if (action === 'state-read') json = { ok: true, rows: [], checkins: [] };
      else if (action === 'body-logs' || action === 'nutrition-logs' || action === 'session-logs-read') json = { ok: true, rows: [] };
      else if (action === 'daily-log-dates') json = { ok: true, body: [], nutrition: [] };
      else if (action === 'nutrition-week') json = { ok: true, rows: [] };
      else if (action === 'weekly-sport-targets') json = { ok: true, rows: [] };
      else if (action === 'programme-data') json = { ok: true, rows: [] };
      else if (action === 'booking-sync' || action === 'booking-read') json = { ok: true, rows: state.bookingRows };
    } else if (url.pathname.startsWith('/api/strava')) {
      json = { connected: false, activities: [] };
    } else if (url.pathname === '/api/reminders') {
      if (request.method() === 'GET') {
        json = { ok: true, notifications: state.notifications, unread: state.notifications.filter(item => !item.read_at).length };
      } else if (body.action === 'read-notification') {
        state.notifications = state.notifications.map(item => item.id === body.id ? { ...item, read_at: new Date().toISOString() } : item);
        json = { ok: true, notifications: state.notifications, unread: state.notifications.filter(item => !item.read_at).length };
      } else if (body.action === 'dismiss-notification') {
        state.notifications = state.notifications.filter(item => item.id !== body.id);
        json = { ok: true, notifications: state.notifications, unread: state.notifications.filter(item => !item.read_at).length };
      } else if (body.action === 'clear-notifications') {
        state.notifications = [];
        json = { ok: true, notifications: [], unread: 0 };
      }
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) });
  });
  return state;
}

async function codeLogin(page, options = {}) {
  const state = await mockPortal(page, options);
  await page.goto('/index.html');
  await page.getByRole('button', { name: 'Use athlete access code' }).click();
  await page.getByLabel('Athlete access code').fill('KARL');
  await page.getByRole('button', { name: 'Enter Portal' }).click();
  await expect(page.locator('#portalScreen')).toBeVisible();
  await expect(page.getByText('Lower A', { exact: true }).first()).toBeVisible();
  return state;
}

test('1. code login renders the portal and today’s session', async ({ page }) => {
  await codeLogin(page);
  await expect(page.getByText('Sign in with your email next time')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss email sign-in suggestion' }).click();
  await expect(page.locator('#emailUpgradePrompt')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open Lower A' })).toBeVisible();
  expect(await page.evaluate(async () => !!(await navigator.serviceWorker.ready).active)).toBe(true);
});

test('2. email OTP login lands on the same portal state', async ({ page }) => {
  await mockPortal(page);
  await page.goto('/index.html');
  await page.getByLabel('Email address').fill('karl@example.com');
  await page.getByRole('button', { name: 'Send Code' }).click();
  await page.getByLabel('One-time email code').fill('123456');
  await expect(page.locator('#portalScreen')).toBeVisible();
  await expect(page.getByText('Lower A', { exact: true }).first()).toBeVisible();
});

test('3. three strength sets submit and persist across reload', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
  await codeLogin(page);
  await page.getByRole('button', { name: 'Open Lower A' }).click();
  for (let set = 0; set < 3; set++) {
    await page.locator(`#w_0_0_${set}`).fill(String(40 + set * 5));
    await page.locator(`#r_0_0_${set}`).fill(String(10 - set));
  }
  await page.getByRole('button', { name: /Right load/ }).click();
  await page.locator('#focusFooterAction').click();
  await expect(page.locator('#strengthReviewTitle')).toHaveText('Review session');
  await page.getByRole('button', { name: 'Submit to coaches' }).click();
  await expect(page.getByText('Your coaches can now review the full session.')).toBeVisible();
  await expect(page.locator('#gym_saved_0')).toContainText('Session submitted');

  await page.reload();
  await expect(page.locator('#portalScreen')).toBeVisible();
  await page.getByRole('button', { name: /Open (completed )?Lower A/ }).click();
  await expect(page.locator('#w_0_0_0')).toHaveValue('40');
  await expect(page.locator('#w_0_0_2')).toHaveValue('50');
});

test('unlocking the next load gives brief encouragement without interrupting the session', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
  await codeLogin(page);
  await page.getByRole('button', { name: 'Open Lower A' }).click();
  await page.locator('#w_0_0_0').fill('40');
  await page.locator('#r_0_0_0').fill('12');
  await page.getByRole('button', { name: /Right load/ }).click();
  for (let set = 1; set < 3; set++) {
    await page.locator(`#w_0_0_${set}`).fill('40');
    await page.locator(`#r_0_0_${set}`).fill('12');
  }

  await expect(page.locator('#toast')).toContainText(/Nice work.*unlocked for next session/);
  await expect(page.locator('.exc').first()).toHaveClass(/ns-unlock-celebrate/);
  await expect(page.getByText(/Next session: Increase to/)).toBeVisible();
  await expect(page.locator('#focusOverlay')).toHaveClass(/open/);
});

test('a locally saved workout awaits submission and does not count as complete', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
  await codeLogin(page);
  await page.getByRole('button', { name: 'Open Lower A' }).click();
  await page.locator('#w_0_0_0').fill('40');
  await page.locator('#r_0_0_0').fill('10');
  await page.getByRole('button', { name: /Right load/ }).click();
  await page.getByRole('button', { name: 'Close session' }).click();
  await page.evaluate(() => renderTodaySection());

  await expect(page.locator('.todaymeta')).toContainText('Awaiting submission');
  await expect(page.getByRole('button', { name: 'Open awaiting submission Lower A' })).toHaveText(/Review & submit/);
  await expect(page.locator('#heroStatCompliance')).toHaveText('0/1');
  await expect(page.locator('#gymDoneVal')).toHaveText('0');
});

test('focused strength flow shows coach context, live progress, calm stats and the next exercise', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('dp_strength_rpe_enabled', 'false'));
  const secondExercise = { ...exercise, exercise: 'Leg Curl', sets: '2', workingSets: '2', rest: '90s' };
  await codeLogin(page, {
    exercises: [exercise, secondExercise],
    changes: [{ source: 'programme', changed_at: `${today}T01:00:00Z`, detail: { date: today, item: 'Leg Extension', action: 'load target updated' } }],
  });
  await page.getByRole('button', { name: 'Open Lower A' }).click();

  await expect(page.getByText('Your coach adjusted this session')).toBeVisible();
  await expect(page.locator('#focusOverlayMeta')).toHaveText('0 of 2 exercises');
  await expect(page.locator('#focusOverlayTime')).toContainText('min remaining');
  await expect(page.getByRole('button', { name: 'Stats' }).first()).toBeVisible();

  for (let set = 0; set < 3; set++) {
    await page.locator(`#w_0_0_${set}`).fill('40');
    await page.locator(`#r_0_0_${set}`).fill('10');
  }
  await page.getByRole('button', { name: /Right load/ }).click();

  await expect(page.getByRole('button', { name: /Up next.*Leg Curl/ })).toBeVisible();
  await expect(page.locator('#focusOverlayMeta')).toHaveText('1 of 2 exercises');
  await expect(page.getByRole('button', { name: 'Review & submit' }).last()).toBeVisible();
});

test('4. body check-in updates the dock state', async ({ page }) => {
  await codeLogin(page);
  await page.getByRole('button', { name: 'Body check-in' }).click();
  await page.locator('#qlbWeight').fill('72.4');
  await page.getByRole('button', { name: 'Save body check-in' }).click();
  await expect(page.locator('#qlDockBody')).toHaveClass(/is-done/);
});

test('5. offline submit shows pending state and online recovery drains it', async ({ page, context }) => {
  const state = await codeLogin(page);
  state.offline = true;
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Body check-in' }).click();
  await page.locator('#qlbWeight').fill('72.5');
  await page.getByRole('button', { name: 'Save body check-in' }).click();
  await expect(page.locator('#queuePendingBanner')).toBeVisible();
  const initialPending = await page.evaluate(() => pendingCoachWriteCount());
  expect(initialPending).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#queuePendingBanner')).toContainText(`${initialPending} updates waiting to send`);

  // Keep writes unavailable while allowing the cached app to perform its
  // normal authenticated reload. The state outbox must survive that reload.
  await context.setOffline(false);
  await page.evaluate(() => localStorage.setItem('dp_reschedules_KARL', JSON.stringify({ 'session-1': '2026-08-28' })));
  await expect.poll(() => page.evaluate(() => pendingCoachWriteCount())).toBe(initialPending + 1);
  await expect(page.locator('#queuePendingBanner')).toContainText(`${initialPending + 1} updates waiting to send`);
  await page.reload();
  await expect(page.locator('#portalScreen')).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('dp_reschedules_KARL') || '{}')['session-1'])).toBe('2026-08-28');
  await expect.poll(() => page.evaluate(() => pendingCoachWriteCount())).toBe(initialPending + 1);
  await expect(page.locator('#queuePendingBanner')).toContainText(`${initialPending + 1} updates waiting to send`);

  state.offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#queuePendingBanner')).toBeHidden({ timeout: 10_000 });
});

test('6. coach cue avatars appear only for a real override note', async ({ page }) => {
  const state = await codeLogin(page, { note: 'Keep the first set controlled and own the final two.' });
  await expect(page.getByText('Coach cue for today')).toBeVisible();
  await expect(page.locator('.coach-avatars')).toBeVisible();

  state.note = '';
  await page.evaluate(() => refreshWeekInBackground());
  await expect(page.getByText('Today’s focus')).toBeVisible();
  await expect(page.locator('.coach-avatars')).toHaveCount(0);
});

test('7. booking leads the collapsed stack and a cancellation clears the stale confirmation', async ({ page }) => {
  const suffix = isoWeekSuffix();
  const localKey = `dp_call_booked_KARL_${suffix}`;
  const state = await codeLogin(page, {
    bookingRows: [{
      key: `call_booked_${suffix}`,
      value: { time: 'Sat 29 Aug · 9:30 am', startsAt: '2026-08-29T00:00:00.000Z', eventId: 'event-123' },
    }],
  });

  await expect(page.locator('#callConfirmedNudge')).toBeVisible();
  await expect.poll(() => page.locator('.top-shell-priority > .nudge-strip:visible').first().getAttribute('id')).toBe('callConfirmedNudge');
  await expect.poll(() => page.evaluate(key => !!localStorage.getItem(key), localKey)).toBe(true);

  state.bookingRows = [];
  await page.evaluate(() => refreshCallBookingsFromCloud(0, true));

  await expect(page.locator('#callConfirmedNudge')).toBeHidden();
  await expect(page.locator('#callNudge')).toBeVisible();
  await expect.poll(() => page.locator('.top-shell-priority > .nudge-strip:visible').first().getAttribute('id')).toBe('callNudge');
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), localKey)).toBe(null);
});

test('8. athlete can clear one notification or clear the whole inbox', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await codeLogin(page, {
    notifications: [
      { id: '11111111-1111-4111-8111-111111111111', title: 'Programme published', body: 'Your next training block is live.', url: '/', created_at: '2026-08-27T07:15:00Z', read_at: null, pushed_at: null },
      { id: '22222222-2222-4222-8222-222222222222', title: "Today's training", body: 'VO2 5×1km + 4×200m', url: '/?tab=training', created_at: '2026-08-27T06:00:00Z', read_at: null, pushed_at: '2026-08-27T06:00:05Z' },
    ],
  });

  await expect(page.getByRole('button', { name: 'Open notifications, 2 unread' })).toBeVisible();
  await page.getByRole('button', { name: 'Open notifications, 2 unread' }).click();
  await expect(page.getByRole('button', { name: 'Clear Programme published notification' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear Programme published notification' }).click();
  await expect(page.getByText('Programme published', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open notifications, 1 unread' })).toBeVisible();

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Clear all' }).click();
  await expect(page.getByText('You’re all caught up')).toBeVisible();
  await expect(page.locator('#notificationCount')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Clear all' })).toBeHidden();
});

test('9. coaching-call prep answers sync to the coach and survive a new device', async ({ page }) => {
  // Prep rides the existing athlete_data state store (key calls_prep_<ISO week>),
  // the same channel as call_booked_*, so it inherits the debounce, the
  // force-flush on background and the offline queue.
  const stateRows = [];
  await installSupabaseStub(page);
  await page.route('**/_vercel/**', route => route.abort());
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch (error) {}
    let json = { ok: true };
    if (url.pathname === '/api/auth-athlete') {
      json = url.searchParams.get('action') === 'eligibility' ? { ok: true, enabled: true, eligible: true, active: true } : athlete;
    } else if (url.pathname === '/api/portal-data') {
      if (body.action === 'state-write') { stateRows.push({ key: body.key, value: body.value }); json = { key: body.key, synced_at: 'now' }; }
      else if (body.action === 'state-read') json = { ok: true, rows: stateRows, checkins: [] };
      else if (body.action === 'bootstrap') json = { ok: true, state: { rows: stateRows, checkins: [] }, bodyLogs: { rows: [] }, nutritionLogs: { rows: [] }, sessionLogs: { rows: [] }, dailyLogged: { body: [], nutrition: [] } };
      else json = { ok: true, rows: [], checkins: [], body: [], nutrition: [] };
    } else if (url.pathname.startsWith('/api/strava')) json = { connected: false, activities: [] };
    else if (url.pathname === '/api/reminders') json = { ok: true, notifications: [], unread: 0 };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) });
  });

  await page.goto('/index.html');
  await page.getByRole('button', { name: 'Use athlete access code' }).click();
  await page.getByLabel('Athlete access code').fill('KARL');
  await page.getByRole('button', { name: 'Enter Portal' }).click();
  await expect(page.locator('#portalScreen')).toBeVisible();

  await page.evaluate(() => switchTab('calls'));
  await page.locator('#callsPrep0').fill('Threshold felt controlled.');
  await expect.poll(() => stateRows.filter(row => /^calls_prep_\d{4}_\d{2}$/.test(row.key)).length, { timeout: 8000 }).toBeGreaterThan(0);

  // A fresh device holds the session but no cached answers: they must come back
  // from the server, not from localStorage.
  await page.evaluate(() => {
    const token = localStorage.getItem('dp_auth_token');
    const code = localStorage.getItem('dp_auth_code');
    const method = localStorage.getItem('dp_auth_method');
    localStorage.clear();
    localStorage.setItem('dp_auth_token', token);
    localStorage.setItem('dp_auth_code', code);
    if (method) localStorage.setItem('dp_auth_method', method);
  });
  await page.reload();
  await expect(page.locator('#portalScreen')).toBeVisible();
  await page.waitForTimeout(1200);
  await page.evaluate(() => switchTab('calls'));
  await expect(page.locator('#callsPrep0')).toHaveValue(/Threshold felt controlled/, { timeout: 8000 });
});
