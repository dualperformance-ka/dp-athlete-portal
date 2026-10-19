// Loading under a slow or failing backend.
//
// Production saw Supabase hold REST calls for 110-190s and fail with
// statement timeouts. These journeys pin down what the athlete gets then:
// the current week first, secondary work only after it, a bounded and stale
// (not spinning) state when the server cannot answer, and never a fan-out of
// compatibility reads on a timeout or 5xx.
import { expect, test } from '@playwright/test';
import { bootPortal } from './harness.mjs';

const COMPAT_ACTIONS = ['state-read', 'body-logs', 'nutrition-logs', 'session-logs-read', 'daily-log-dates', 'planned-sessions', 'workout-splits', 'session-library'];
const SECONDARY = ['booking-sync', 'booking-read', 'programme-sessions', 'nutrition-week', 'session-library'];

function recordRequests(page) {
  const log = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return;
    let action = '';
    try { action = String((request.postDataJSON() || {}).action || ''); } catch (e) {}
    log.push({ path: url.pathname, action, at: Date.now() });
  });
  return log;
}

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test('secondary sync starts only after the current week has loaded', async ({ page }) => {
  const errors = watchErrors(page);
  const log = recordRequests(page);
  let trainingDoneAt = 0;
  await bootPortal(page, {
    onPortalAction: async (action) => {
      if (action === 'training-read') {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        trainingDoneAt = Date.now();
      }
      return undefined;
    },
  });
  await page.waitForTimeout(4500);
  expect(trainingDoneAt).toBeGreaterThan(0);
  const secondary = log.filter((entry) => SECONDARY.includes(entry.action)
    || entry.path === '/api/reminders' || entry.path.startsWith('/api/strava'));
  expect(secondary.length).toBeGreaterThan(0);
  for (const entry of secondary) {
    expect(entry.at, `${entry.action || entry.path} started before the week loaded`).toBeGreaterThanOrEqual(trainingDoneAt);
  }
  // No full GoHighLevel sync storm: at most one booking request on entry.
  expect(log.filter((entry) => entry.action.startsWith('booking-')).length).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('a 5xx from the combined reads shows a stale state and never fans out into legacy reads', async ({ page }) => {
  const errors = watchErrors(page);
  const log = recordRequests(page);
  await bootPortal(page, {
    onPortalAction: async (action) => {
      if (action === 'bootstrap' || action === 'training-read') {
        return { status: 503, json: { ok: false, error: 'Request failed', code: 'upstream_unavailable' } };
      }
      return undefined;
    },
  });
  await expect(page.locator('#saveStatePill')).toContainText('showing saved plan');
  await expect(page.locator('#loadErrEl, #weeklyLoadErrEl').first()).toBeAttached();
  await page.waitForTimeout(2500);
  const compat = log.filter((entry) => COMPAT_ACTIONS.includes(entry.action));
  expect(compat.map((entry) => entry.action)).toEqual([]);
  // Retries are spaced by the backoff (at least 2s apart) and capped at three,
  // never a tight loop.
  for (const action of ['bootstrap', 'training-read']) {
    const times = log.filter((entry) => entry.action === action).map((entry) => entry.at);
    expect(times.length, `${action} attempts`).toBeLessThanOrEqual(4);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1], `${action} retry ${i} spacing`).toBeGreaterThanOrEqual(1900);
    }
  }
  expect(errors).toEqual([]);
});

test('a training read that never answers ends in a bounded, retryable state', async ({ page }) => {
  test.setTimeout(45000);
  const errors = watchErrors(page);
  const log = recordRequests(page);
  await bootPortal(page, {
    onPortalAction: async (action) => {
      if (action === 'training-read') {
        // Hang well past the portal's 9s deadline.
        await new Promise((resolve) => setTimeout(resolve, 20000));
        return { json: { ok: false } };
      }
      return undefined;
    },
  });
  const started = Date.now();
  const failure = page.locator('#loadErrEl:visible, #weeklyLoadErrEl:visible').first();
  await expect(failure).toBeVisible({ timeout: 12000 });
  expect(Date.now() - started).toBeLessThan(12000);
  await expect(page.locator('#loadingEl')).toBeHidden();
  expect(log.filter((entry) => COMPAT_ACTIONS.includes(entry.action)).map((entry) => entry.action)).toEqual([]);
  expect(errors).toEqual([]);
});

test('an older server without the combined bootstrap still gets the compatibility reads', async ({ page }) => {
  const errors = watchErrors(page);
  const log = recordRequests(page);
  await bootPortal(page, {
    onPortalAction: async (action) => {
      if (action === 'bootstrap') return { status: 400, json: { ok: false, error: 'Unknown portal action' } };
      return undefined;
    },
  });
  await page.waitForTimeout(500);
  const actions = log.map((entry) => entry.action);
  for (const action of ['state-read', 'body-logs', 'session-logs-read']) expect(actions).toContain(action);
  expect(errors).toEqual([]);
});

test('an expired saved week is shown when the server fails, instead of an error', async ({ page }) => {
  const errors = watchErrors(page);
  let failTraining = false;
  await bootPortal(page, {
    onPortalAction: async (action) => {
      if (failTraining && action === 'training-read') return { status: 504, json: { ok: false, error: 'Request failed', code: 'upstream_timeout' } };
      return undefined;
    },
  });
  await expect(page.locator('#portalScreen')).toBeVisible();
  // Age every saved week past its 24h freshness, then fail the next read.
  await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || key.indexOf('dp_training_week_v1_') !== 0) continue;
      const value = JSON.parse(localStorage.getItem(key));
      value.ts = Date.now() - 3 * 86400000;
      localStorage.setItem(key, JSON.stringify(value));
    }
  });
  failTraining = true;
  await page.reload();
  await page.locator('#portalScreen').waitFor({ state: 'visible' });
  await expect(page.locator('#saveStatePill')).toContainText('showing saved plan');
  await expect(page.locator('#loadErrEl')).toBeHidden();
  await expect(page.getByText('Long Run 18km').first()).toBeAttached();
  expect(errors).toEqual([]);
});
