import { test, expect } from '@playwright/test';
import { bootPortal, localISO } from './harness.mjs';

// Garmin first, Strava fills gaps. A session Strava completed is shown from
// Garmin's copy of the same recording; a recording only Strava holds still
// shows from Strava. Nothing Garmin supplies is written.

test.setTimeout(120_000);
const today = localISO();
const PHONE = { width: 390, height: 844 };
const startRun = `${today}T06:30:00Z`, startSwim = `${today}T12:00:00Z`, startRide = `${today}T15:00:00Z`;

const rows = [
  { id: 'run-1', notion_page_id: 'run-1', title: 'Easy Run 5km', planned_date: today, session_type: 'run', status: 'Planned', week_label: 'Week 12', distance_km: 5 },
  { id: 'swim-1', notion_page_id: 'swim-1', title: 'Swim 1500m', planned_date: today, session_type: 'swim', status: 'Planned', week_label: 'Week 12' },
  { id: 'ride-1', notion_page_id: 'ride-1', title: 'Zwift Ride 50km', planned_date: today, session_type: 'ride', status: 'Planned', week_label: 'Week 12' },
];
const strava = { connected: true, activitiesAvailable: true, activities: [
  { id: 111, name: 'Morning Run', type: 'Run', sport_type: 'Run', distance: 5010, moving_time: 1860, elapsed_time: 1880, start_date_local: startRun, start_date: startRun, average_heartrate: 150 },
  { id: 222, name: 'Swim', type: 'Swim', sport_type: 'Swim', distance: 1550, moving_time: 2040, elapsed_time: 2100, start_date_local: startSwim, start_date: startSwim },
  // Only Strava has this one, like a Zwift ride that never reaches Garmin.
  { id: 333, name: 'Zwift', type: 'Ride', sport_type: 'VirtualRide', distance: 50080, moving_time: 6120, elapsed_time: 6150, start_date_local: startRide, start_date: startRide },
]};
const garmin = () => ({ available: true, connected: true, permissions: ['ACTIVITY_EXPORT', 'HEALTH_EXPORT'], lastSyncAt: new Date().toISOString(), activities: [
  { id: 'g1', activityId: 21047282990, name: 'Adelaide Running', type: 'RUNNING', startTime: startRun, localDate: today, distanceM: 5012, durationS: 1870, avgHr: 151, device: 'Garmin fenix 7' },
  { id: 'g2', name: 'Pool Swim', type: 'LAP_SWIMMING', startTime: startSwim, localDate: today, distanceM: 1550, durationS: 2100, device: 'unknown' },
]});

async function boot(page, writes) {
  await page.setViewportSize(PHONE);
  await bootPortal(page, { rows, strava, garmin, onPortalAction(action, body) { writes.push({ action, body }); } });
  await expect.poll(() => page.evaluate(() => !!(window._connectedActivityFeed && window._connectedActivityFeed.activities.length))).toBe(true);
}
async function open(page, id) {
  await page.evaluate((sid) => startFocusedSession(sessions.findIndex((s) => s.id === sid)), id);
  await expect(page.locator('#focusOverlay')).toHaveClass(/\bopen\b/);
}

test('a run Strava completed is shown from Garmin, with pace and a Garmin Connect link', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const writes = [];
  await boot(page, writes);
  await open(page, 'run-1');
  const hero = page.locator('#focusOverlay .run-hero');
  await expect(hero).toHaveClass(/run-hero--garmin/);
  await expect(hero).toContainText('Garmin fenix 7');
  await expect(hero).toContainText('6:13 /km');
  await expect(hero).toContainText('151 bpm');
  await expect(hero.locator('.run-hero-link')).toHaveAttribute('href', 'https://connect.garmin.com/modern/activity/21047282990');
  await expect(hero).not.toContainText('Strava');
  await expect(hero.getByRole('button', { name: 'Not this run' })).toBeVisible();
  await expect(page.locator('#focusFooterTitle')).toHaveText('Run received from Garmin');
  await page.screenshot({ path: test.info().outputPath('garmin-first-run-390.png') });
  // Rewritten when Garmin became the primary source: this asserted the stored
  // match stayed Strava's. Garmin's copy is now what completes the session.
  const stored = await page.evaluate(() => logs['run-1'] && logs['run-1'].__stravaMatch);
  expect(stored && String(stored.activity.id)).toBe('garmin:g1');
  expect(stored && stored.provider).toBe('Garmin');
  expect(errors).toEqual([]);
});

test('a swim is reviewed from Garmin in whole metres, with no Strava naming', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await boot(page, []);
  await open(page, 'swim-1');
  const overlay = page.locator('#focusOverlay');
  await expect(overlay.locator('.endurance-result')).toContainText('Garmin');
  await expect(overlay.locator('.endurance-result')).toContainText('1550 m');
  await expect(overlay.locator('.endurance-review-head')).toContainText('From Garmin');
  await expect(overlay.locator('.endurance-review-stats')).toContainText('2:15 /100m');
  await expect(page.locator('#focusFooterTitle')).toHaveText('Swim received from Garmin');
  await page.screenshot({ path: test.info().outputPath('garmin-first-swim-390.png') });
  expect(errors).toEqual([]);
});

test('a ride Garmin never received still shows from Strava', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await boot(page, []);
  await open(page, 'ride-1');
  const overlay = page.locator('#focusOverlay');
  await expect(overlay.locator('.endurance-result')).toContainText('Synced from Strava');
  await expect(overlay.locator('.endurance-review-head')).toContainText('From Strava');
  await expect(page.locator('#focusFooterTitle')).toHaveText('Ride received from Strava');
  expect(errors).toEqual([]);
});

test('without Garmin connected nothing changes', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize(PHONE);
  await bootPortal(page, { rows, strava });
  await expect.poll(() => page.evaluate(() => Object.keys(stravaSessionMatches || {}).length)).toBeGreaterThan(0);
  await open(page, 'run-1');
  await expect(page.locator('#focusOverlay .run-hero')).toContainText('Synced from Strava');
  await expect(page.locator('#focusFooterTitle')).toHaveText('Run received from Strava');
  expect(errors).toEqual([]);
});
