import { expect, test } from '@playwright/test';
import { bootPortal } from './harness.mjs';

test.setTimeout(120_000);

const CONNECT_URL = 'https://connect.garmin.com/oauth2Confirm?response_type=code&client_id=x&state=signed';

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error && error.message || error)));
  return errors;
}

test('Garmin stays invisible when the server says it is not available', async ({ page }) => {
  const errors = watchErrors(page);
  await bootPortal(page);
  await expect(page.locator('#dp-garmin-btn')).toBeHidden();
  await page.evaluate(() => openPreferences());
  await expect(page.locator('#garminPreference')).toBeHidden();
  expect(errors).toEqual([]);
});

test('a not-yet-connected athlete gets a server-minted connect link', async ({ page }) => {
  const errors = watchErrors(page);
  await bootPortal(page, {
    garmin: () => ({ available: true, connected: false, connectUrl: CONNECT_URL }),
  });
  const pill = page.locator('#dp-garmin-btn');
  await expect(pill).toBeVisible();
  await expect(pill).toHaveText('Connect Garmin');
  await expect(pill).toHaveAttribute('href', CONNECT_URL);
  await page.evaluate(() => openPreferences());
  await expect(page.locator('#garminPreference')).toBeVisible();
  await expect(page.locator('#garminPrefAction')).toHaveText('Connect Garmin');
  expect(errors).toEqual([]);
});

test('disconnect takes two taps and then shows the connect state again', async ({ page }) => {
  const errors = watchErrors(page);
  let connected = true;
  const disconnects = [];
  await bootPortal(page, {
    garmin: (pathname, method) => {
      if (pathname === '/api/garmin-disconnect') {
        disconnects.push(method);
        connected = false;
        return { available: true, connected: false, disconnected: true, connectUrl: CONNECT_URL };
      }
      return connected
        ? { available: true, connected: true, lastSyncAt: new Date(Date.now() - 20 * 60000).toISOString(), permissions: ['ACTIVITY_EXPORT', 'HEALTH_EXPORT'], activities: [] }
        : { available: true, connected: false, connectUrl: CONNECT_URL };
    },
  });

  const pill = page.locator('#dp-garmin-btn');
  await expect(pill).toContainText('Garmin connected');
  await expect(pill).not.toHaveAttribute('href', /.+/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => openPreferences());
  const action = page.locator('#garminPrefAction');
  await expect(page.locator('#garminPrefStatus')).toContainText('Connected. Last sync 20 min ago');
  await page.locator('#garminPreference').scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('garmin-preferences-connected.png') });

  await action.click();
  await expect(action).toHaveText(/Tap again/);
  expect(disconnects).toEqual([]);

  await action.click();
  await expect(action).toHaveText('Connect Garmin');
  expect(disconnects).toEqual(['POST']);
  await expect(pill).toHaveText('Connect Garmin');
  expect(errors).toEqual([]);
});

test('returning from Garmin cleans the URL and confirms the connection', async ({ page }) => {
  const errors = watchErrors(page);
  await page.addInitScript(() => {
    if (location.protocol.startsWith('http') && !location.search.includes('garmin=')) history.replaceState(null, '', location.pathname + '?garmin=connected');
  });
  await bootPortal(page, {
    garmin: () => ({ available: true, connected: true, lastSyncAt: null, activities: [] }),
  });
  await expect.poll(() => page.evaluate(() => location.search)).not.toContain('garmin=');
  await page.evaluate(() => openPreferences());
  await expect(page.locator('#garminPrefStatus')).toContainText('within a few minutes');
  expect(errors).toEqual([]);
});
