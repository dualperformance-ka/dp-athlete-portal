import { test, expect } from '@playwright/test';
import { bootPortal, localISO } from './harness.mjs';

const PHONE = { width: 390, height: 844 };
const today = localISO();

const rows = [
  {
    id: 'swim-1', notion_page_id: 'swim-1', title: 'Swim: Technique', planned_date: today,
    session_type: 'Swim', status: 'Planned', intensity: 'Easy', estimated_minutes: 45,
    run_details: '300 easy. 6 x 50 catch-up drill. 6 x 50 single arm. 4 x 100 build. 200 easy. About 1500m',
  },
  {
    id: 'ride-1', notion_page_id: 'ride-1', title: 'Ride: FTP Test', planned_date: today,
    session_type: 'Cycling', status: 'Planned', intensity: 'Moderate', estimated_minutes: 90,
    run_details: '20min easy spin. 5min building. 5min easy. 20min absolute max sustainable. FTP = 95 percent of the 20min average. 15min spin down',
    notes: 'This number sets every bike session that follows. Give it everything',
  },
];

async function openSession(page, id) {
  await page.evaluate((sessionId) => startFocusedSession(sessions.findIndex((session) => session.id === sessionId)), id);
  await expect(page.locator('#focusOverlay')).toHaveClass(/\bopen\b/);
  await page.waitForTimeout(300);
}

test('swim and cycling sessions show their prescribed workout in the focused view', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await bootPortal(page, { rows });

  await openSession(page, 'swim-1');
  const overlay = page.locator('#focusOverlay');
  await expect(overlay).toContainText('Swim workout');
  await expect(overlay).toContainText('6 x 50 catch-up drill');
  await expect(overlay).toContainText('About 1500m');
  await expect(overlay).not.toContainText('Rest up. Recovery is training too.');
  await page.screenshot({ path: 'test-results/endurance-swim-390.png' });

  await page.getByRole('button', { name: 'Close session' }).click();
  await openSession(page, 'ride-1');
  await expect(overlay).toContainText('Ride workout');
  await expect(overlay).toContainText('20min absolute max sustainable');
  await expect(overlay).toContainText('FTP = 95 percent of the 20min average');
  await expect(overlay).toContainText('This number sets every bike session that follows');
  await expect(overlay).not.toContainText('Rest up. Recovery is training too.');
  await page.screenshot({ path: 'test-results/endurance-ride-390.png' });
});

test('matched swim and ride sessions expose Strava laps and a real review submission', async ({ page }) => {
  await page.setViewportSize(PHONE);
  const writes = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/ingest/.test(request.url())) {
      try { writes.push(request.postDataJSON()?.payload); } catch (error) {}
    }
  });
  const swim = {
    id: 20369277952, name: 'Morning Swim', type: 'Swim', sport_type: 'Swim',
    distance: 1500, moving_time: 2089, elapsed_time: 3020,
    start_date_local: `${today}T06:03:43+09:30`, start_date: `${today}T06:03:43+09:30`,
    average_heartrate: 123.9, max_heartrate: 150, average_cadence: 25.9,
    laps: [
      { lap_index: 0, distance: 50, moving_time: 61, average_heartrate: 96 },
      { lap_index: 1, distance: 0, moving_time: 22, average_heartrate: 95 },
      { lap_index: 2, distance: 100, moving_time: 136, average_heartrate: 133 },
    ],
  };
  const ride = {
    id: 20383917710, name: 'FTP Test', type: 'Ride', sport_type: 'Ride',
    distance: 26734.8, moving_time: 3367, elapsed_time: 3428,
    start_date_local: `${today}T09:56:03+09:30`, start_date: `${today}T09:56:03+09:30`,
    average_heartrate: 141.4, max_heartrate: 175, average_watts: 140.9,
    weighted_average_watts: 167, max_watts: 662, total_elevation_gain: 136,
    laps: [
      { lap_index: 0, distance: 5000, moving_time: 651, average_watts: 126.3, average_heartrate: 131.3 },
      { lap_index: 1, distance: 4076.55, moving_time: 549, average_watts: 124.1, average_heartrate: 134 },
      { lap_index: 4, distance: 5000, moving_time: 527, average_watts: 206.9, average_heartrate: 160.4 },
    ],
  };
  await bootPortal(page, {
    rows,
    strava: { connected: true, activities: [swim, ride], activitiesAvailable: true },
  });

  await openSession(page, 'swim-1');
  const overlay = page.locator('#focusOverlay');
  await expect(overlay.locator('.endurance-lap')).toHaveCount(2);
  await expect(overlay).toContainText('2:02 /100m');
  await expect(overlay.locator('.run-checkin')).toBeVisible();
  await expect(page.locator('#focusFooterTitle')).toHaveText('Swim received from Strava');
  await expect(page.locator('#focusFooterDetail')).toHaveText('2 answers left');
  await expect(page.locator('#focusFooterAction')).toHaveText('Send to coaches');
  await page.screenshot({ path: 'test-results/endurance-swim-review-390.png' });
  await overlay.locator('.run-chip', { hasText: /^6$/ }).click();
  await overlay.getByRole('button', { name: 'No pain' }).click();
  await page.locator('#focusFooterAction').click();
  await expect.poll(() => writes.filter((payload) => payload?.type === 'Swim').length).toBe(1);
  await expect(overlay).not.toHaveClass(/\bopen\b/);

  await openSession(page, 'ride-1');
  await expect(overlay.locator('.endurance-lap')).toHaveCount(3);
  await expect(overlay).toContainText('167 W weighted');
  await expect(overlay).toContainText('207 W');
  await expect(overlay.locator('.run-checkin')).toBeVisible();
  await expect(page.locator('#focusFooterTitle')).toHaveText('Ride received from Strava');
  await page.screenshot({ path: 'test-results/endurance-ride-review-390.png' });
});
