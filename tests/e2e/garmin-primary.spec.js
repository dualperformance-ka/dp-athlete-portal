import { test, expect } from '@playwright/test';
import { bootPortal, localISO } from './harness.mjs';

// Garmin is the primary source, Strava the fallback (Karl, Nov 2026).
// A Garmin recording completes a session and its numbers are what the
// training log stores; a recording only Strava holds still completes one.

test.setTimeout(120_000);
const today = localISO();
const PHONE = { width: 390, height: 844 };
const startRun = `${today}T06:30:00Z`, startRide = `${today}T15:00:00Z`;

const runRow = { id: 'run-1', notion_page_id: 'run-1', title: 'Easy Run 5km', planned_date: today, session_type: 'run', status: 'Planned', week_label: 'Week 12', distance_km: 5 };
const rideRow = { id: 'ride-1', notion_page_id: 'ride-1', title: 'Zwift Ride 50km', planned_date: today, session_type: 'ride', status: 'Planned', week_label: 'Week 12' };

const stravaRun = { id: 111, name: 'Morning Run', type: 'Run', sport_type: 'Run', distance: 5010, moving_time: 1860, elapsed_time: 1880, start_date_local: startRun, start_date: startRun };
const stravaRide = { id: 333, name: 'Zwift', type: 'Ride', sport_type: 'VirtualRide', distance: 50080, moving_time: 6120, elapsed_time: 6150, start_date_local: startRide, start_date: startRide };
const garminRun = { id: 'g1', activityId: 21047282990, name: 'Adelaide Running', type: 'RUNNING', startTime: startRun, localDate: today, distanceM: 5012, durationS: 1870, avgHr: 151, device: 'Garmin fenix 7' };

const garminFeed = (activities) => () => ({ available: true, connected: true, permissions: ['ACTIVITY_EXPORT'], lastSyncAt: new Date().toISOString(), activities });
const stravaFeed = (activities) => ({ connected: true, activitiesAvailable: true, activities });

function captureIngest(page) {
  const sent = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/ingest' && request.method() === 'POST') {
      try { const body = request.postDataJSON(); sent.push(body && body.payload ? body.payload : body); } catch (e) { /* ignore */ }
    }
  });
  return sent;
}
const runLogs = (sent) => sent.filter((p) => p && p.type === 'Run');

test('a run only Garmin recorded completes the session from Garmin', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const sent = captureIngest(page);
  await page.setViewportSize(PHONE);
  await bootPortal(page, { rows: [runRow], strava: stravaFeed([]), garmin: garminFeed([garminRun]) });
  await expect.poll(() => runLogs(sent).length).toBe(1);
  const log = runLogs(sent)[0];
  expect(log.clientWriteId).toBe('garmin_g1');
  expect(log.activitySource).toBe('garmin');
  expect(log.garminActivityId).toBe('21047282990');
  expect(log.exerciseLog).toMatch(/^Matched from Garmin run \| Distance: 5km/);
  expect(log).not.toHaveProperty('stravaActivityId');
  const stored = await page.evaluate(() => logs['run-1'].__stravaMatch);
  expect(stored.provider).toBe('Garmin');
  expect(stored.activity.provider).toBe('Garmin');
  expect(errors).toEqual([]);
});

test('when both services hold the run, Garmin completes it and Strava is not used', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const sent = captureIngest(page);
  await page.setViewportSize(PHONE);
  await bootPortal(page, { rows: [runRow], strava: stravaFeed([stravaRun]), garmin: garminFeed([garminRun]) });
  await expect.poll(() => runLogs(sent).length).toBe(1);
  expect(runLogs(sent)[0].clientWriteId).toBe('garmin_g1');
  await page.evaluate(() => startFocusedSession(sessions.findIndex((s) => s.id === 'run-1')));
  await expect(page.locator('#focusOverlay .run-hero')).toHaveClass(/run-hero--garmin/);
  // Splits still come from Strava's copy of the same recording, labelled.
  await page.evaluate(() => runPagerGo(focusedSessionIndex, 1));
  await expect(page.locator('#focusOverlay .run-split-source')).toHaveText('from Strava');
  expect(errors).toEqual([]);
});

test('a ride only Strava recorded still completes from Strava', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize(PHONE);
  await bootPortal(page, { rows: [rideRow], strava: stravaFeed([stravaRide]), garmin: garminFeed([]) });
  await expect.poll(() => page.evaluate(() => logs['ride-1'] && logs['ride-1'].__stravaMatch && logs['ride-1'].__stravaMatch.clientWriteId)).toBe('strava_333');
  expect(await page.evaluate(() => logs['ride-1'].__stravaMatch.provider)).toBe('Strava');
  expect(errors).toEqual([]);
});

test('a session Strava completed first moves to Garmin\'s copy in place', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const sent = captureIngest(page);
  await page.setViewportSize(PHONE);
  await bootPortal(page, { rows: [runRow], strava: stravaFeed([stravaRun]), garmin: garminFeed([]) });
  // Garmin connected but its copy had not arrived: Strava completed the run.
  await expect.poll(() => runLogs(sent).map((p) => p.clientWriteId)).toEqual(['strava_111']);
  // Garmin's copy lands.
  await page.evaluate((row) => {
    window._garminLoadPromise = Promise.resolve({ available: true, connected: true, activities: [row] });
    return refreshStravaSessionMatches();
  }, garminRun);
  await expect.poll(() => runLogs(sent).length).toBe(2);
  const resend = runLogs(sent)[1];
  expect(resend.clientWriteId).toBe('strava_111');
  expect(resend.activitySource).toBe('garmin');
  expect(resend.garminActivityId).toBe('21047282990');
  expect(resend.durationMin).toBe(31.2);
  const stored = await page.evaluate(() => logs['run-1'].__stravaMatch);
  expect(stored).toMatchObject({ provider: 'Garmin', clientWriteId: 'strava_111', movedFromStravaKey: '111' });
  // A second refresh does nothing more.
  await page.evaluate(() => refreshStravaSessionMatches());
  await page.waitForTimeout(500);
  expect(runLogs(sent).length).toBe(2);
  expect(errors).toEqual([]);
});

test('turning down Strava\'s copy also rules out Garmin\'s copy of the same run', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const sent = captureIngest(page);
  await page.setViewportSize(PHONE);
  await page.addInitScript(() => {
    try { localStorage.setItem('dp_strava_match_rejections_KARL', JSON.stringify({ 'run-1': ['111'] })); } catch (e) { /* ignore */ }
  });
  await bootPortal(page, {
    rows: [runRow], strava: stravaFeed([stravaRun]), garmin: garminFeed([garminRun]),
    onPortalAction(action) { if (action === 'bootstrap') return null; return null; },
  });
  await page.evaluate(() => { stravaMatchRejections = { 'run-1': ['111'] }; return refreshStravaSessionMatches(); });
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => !!getStravaSessionMatch(sessions.find((s) => s.id === 'run-1')))).toBe(false);
  expect(runLogs(sent).filter((p) => p.clientWriteId === 'garmin_g1')).toEqual([]);
  expect(errors).toEqual([]);
});

test('without Garmin connected, Strava completes sessions exactly as before', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const sent = captureIngest(page);
  await page.setViewportSize(PHONE);
  await bootPortal(page, { rows: [runRow], strava: stravaFeed([stravaRun]) });
  await expect.poll(() => runLogs(sent).length).toBe(1);
  const log = runLogs(sent)[0];
  expect(log.clientWriteId).toBe('strava_111');
  expect(log.stravaActivityId).toBe('111');
  expect(log.exerciseLog).toMatch(/^Matched from Strava run/);
  expect(log.activitySource).toBe('strava');
  expect(errors).toEqual([]);
});
