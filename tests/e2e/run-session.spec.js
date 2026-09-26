import { test, expect } from '@playwright/test';
import { bootPortal, localISO } from './harness.mjs';

// The run session screen: swipeable pages, the Strava result and a two-tap
// check-in on the first page after a run, the plan first before one.

const today = localISO();
const PHONE = { width: 390, height: 844 };

function runRow(extra = {}) {
  return {
    id: 'run-1', notion_page_id: 'run-1', title: 'Easy Run 7km', planned_date: today,
    session_type: 'run', status: 'Planned', week_label: 'Week 12', distance_km: 7,
    warm_up: '2 km easy', intervals: '7 km continuous easy', working_pace: '6:15-6:45',
    cool_down: 'Walk 5 min', notes: 'Keep it conversational.', ...extra,
  };
}

const splits = [331, 326, 322, 319, 318, 315, 271].map((t, ix) => ({ split: ix + 1, distance: ix === 6 ? 860 : 1000, moving_time: t }));
const activity = {
  id: 987654, name: 'Morning Run', type: 'Run', sport_type: 'Run',
  distance: 6860, moving_time: 2202, elapsed_time: 2230,
  start_date_local: `${today}T06:30:00Z`, start_date: `${today}T06:30:00Z`,
  average_heartrate: 146.2, max_heartrate: 161, average_cadence: 84.5, total_elevation_gain: 22,
  splits_metric: splits, map: { summary_polyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' },
};

async function openRun(page) {
  await page.evaluate(() => startFocusedSession(sessions.findIndex((s) => s.id === 'run-1')));
  await expect(page.locator('#focusOverlay')).toHaveClass(/\bopen\b/);
  await expect(page.locator('#focusOverlay')).toHaveClass(/\bis-run\b/);
}

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

test('after a Strava run: result and check-in on page one, sent from the footer', async ({ page }) => {
  await page.setViewportSize(PHONE);
  const errors = collectErrors(page);
  const writes = [];
  page.on('request', (req) => {
    // Coach writes go through /api/ingest as { targetUrl, payload }.
    if (req.method() === 'POST' && /\/api\/ingest/.test(req.url())) { try { const b = req.postDataJSON(); writes.push(b && b.payload); } catch (e) {} }
  });
  await bootPortal(page, { rows: [runRow()], strava: { connected: true, activities: [activity], activitiesAvailable: true } });
  await openRun(page);

  const overlay = page.locator('#focusOverlay');
  await expect(overlay.locator('.run-tab')).toHaveText([/Result/, /Splits \+ plan/]);
  const hero = overlay.locator('.run-hero');
  await expect(hero).toContainText('Synced from Strava');
  await expect(hero.locator('.run-hero-number')).toHaveText('36:42');
  await expect(hero).toContainText('6.9 km');
  await expect(hero).toContainText('146 bpm');
  await expect(hero.locator('.run-hero-link')).toHaveAttribute('href', 'https://www.strava.com/activities/987654');
  // The hero replaces the old strip, so the run is not announced twice.
  await expect(overlay.locator('.strava-match-attribution')).toHaveCount(0);

  await page.screenshot({ path: 'test-results/run-session-after-390.png' });
  // Page one fits the phone: no scrolling needed to answer and send.
  const page1 = overlay.locator('.run-page').first();
  const fit = await page1.evaluate((el) => ({ scroll: el.scrollHeight - el.clientHeight, wide: document.documentElement.scrollWidth - window.innerWidth }));
  expect(fit.scroll, 'page one scrolls vertically').toBeLessThanOrEqual(1);
  expect(fit.wide).toBeLessThanOrEqual(0);
  await expect(overlay.locator('.run-chip')).toHaveCount(10);
  await expect(overlay.locator('.run-chip').last()).toBeInViewport();
  await expect(overlay.locator('.run-pain').last()).toBeInViewport();
  // Nothing on the page is a tap target under 44px.
  const small = await page1.evaluate((el) => [...el.querySelectorAll('button, summary, a')]
    .filter((b) => b.offsetParent).map((b) => ({ t: b.textContent.trim(), h: Math.round(b.getBoundingClientRect().height) })).filter((b) => b.h < 44));
  expect(small).toEqual([]);

  // The footer says what is actually left.
  const footer = page.locator('#focusFooterAction');
  await expect(page.locator('#focusFooterTitle')).toHaveText('Run received from Strava');
  await expect(page.locator('#focusFooterDetail')).toHaveText('2 answers left');
  await expect(footer).toHaveText('Send to coaches');
  await expect(overlay.locator('.exl-key')).toBeHidden();

  // Sending early flags what is missing and sends nothing.
  await footer.click();
  await expect(page.locator('#srpeg_0, [id^="srpeg_"]').first()).toHaveAttribute('aria-invalid', 'true');
  expect(writes.filter((w) => w && w.rpe)).toEqual([]);

  await overlay.locator('.run-chip', { hasText: /^8$/ }).click();
  await expect(page.locator('#focusFooterDetail')).toHaveText('1 answer left');
  await overlay.getByRole('button', { name: 'No pain' }).click();
  await expect(page.locator('#focusFooterDetail')).toHaveText('Ready to send');
  await expect(overlay.locator('.run-checkin-head span')).toHaveText('RPE 8 · Hard · No pain');
  await page.screenshot({ path: 'test-results/run-session-after-ready-390.png' });

  // Page two: splits and the plan, reached by the tab (swiping moves the same track).
  await overlay.locator('.run-tab').nth(1).click();
  await expect(overlay.locator('.run-tab').nth(1)).toHaveAttribute('aria-current', 'true');
  // Wait for the slide to settle: page two sits exactly in view.
  await expect.poll(() => overlay.locator('.run-page').nth(1).evaluate((el) => Math.round(el.getBoundingClientRect().left))).toBe(0);
  await expect(overlay.locator('.run-split')).toHaveCount(7);
  await expect(overlay.locator('.run-split').first()).toContainText('5:31');
  await expect(overlay.locator('.run-split').last()).toContainText('0.86 km');
  await expect(overlay.locator('.run-route path')).toHaveCount(1);
  await expect(overlay.locator('.run-prescription-card')).toBeVisible();
  await page.screenshot({ path: 'test-results/run-session-after-page2-390.png' });

  // A swipe back (scrolling the track) moves the current tab with it.
  await overlay.locator('.run-pages').evaluate((el) => { el.scrollTo({ left: 0, behavior: 'instant' }); el.dispatchEvent(new Event('scroll')); });
  await expect(overlay.locator('.run-tab').first()).toHaveAttribute('aria-current', 'true');

  await footer.click();
  await expect.poll(() => writes.filter((w) => w && String(w.rpe) === '8').length).toBeGreaterThan(0);
  const sent = writes.find((w) => w && String(w.rpe) === '8');
  expect(sent.painFlag).toBe(false);
  expect(sent.distanceKm).toBe(6.9);
  await expect(overlay).not.toHaveClass(/\bopen\b/);
  expect(errors).toEqual([]);
});

test('before a run: the plan leads, logging waits for Strava with a manual fallback', async ({ page }) => {
  await page.setViewportSize(PHONE);
  const errors = collectErrors(page);
  await bootPortal(page, {
    rows: [runRow({ title: 'Threshold Cruise 5 x 4 min', distance_km: 9.5, intervals: '5 x 4 min @ 5:00-5:15/km', working_pace: '5:00-5:15/km', rest: '90 sec easy jog' })],
    strava: { connected: true, activities: [], activitiesAvailable: true },
  });
  await openRun(page);
  const overlay = page.locator('#focusOverlay');
  await expect(overlay.locator('.run-tab')).toHaveText([/The session/, /Log it/]);
  // The pace is written once, not "@ 5:00-5:15/km @ 5:00-5:15/km/km".
  await expect(overlay.locator('.run-prescription-row', { hasText: 'Main set' })).toContainText('5 x 4 min @ 5:00-5:15/km');
  await expect(overlay.locator('.run-prescription-row', { hasText: 'Main set' })).not.toContainText('/km/km');
  await expect(page.locator('#focusFooterTitle')).toHaveText('Not run yet');
  await expect(page.locator('#focusFooterAction')).toHaveText('Back to plan');
  await page.screenshot({ path: 'test-results/run-session-before-390.png' });

  await overlay.locator('.run-tab').nth(1).click();
  await expect(overlay.locator('.run-waiting')).toContainText('Waiting for Strava');
  // The manual form is the fallback, folded away until asked for.
  const manual = overlay.locator('details.run-manual');
  await expect(manual).not.toHaveAttribute('open', '');
  await expect(overlay.locator('[id^="rd_"]')).toBeHidden();
  await manual.locator('summary').click();
  await expect(overlay.locator('[id^="rd_"]')).toBeVisible();
  await page.screenshot({ path: 'test-results/run-session-before-log-390.png' });
  expect(errors).toEqual([]);
});

test('without Strava the log form is on the second page straight away', async ({ page }) => {
  await page.setViewportSize(PHONE);
  const errors = collectErrors(page);
  await bootPortal(page, { rows: [runRow()] });
  await openRun(page);
  const overlay = page.locator('#focusOverlay');
  await overlay.locator('.run-tab').nth(1).click();
  await expect(overlay.locator('.run-waiting')).toHaveCount(0);
  await expect(overlay.locator('[id^="rd_"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a race attempt reads as a race', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await bootPortal(page, { rows: [runRow({ title: 'City-Bay 12K — Sub-49 attempt', distance_km: 12 })] });
  await openRun(page);
  const badges = page.locator('#focusOverlay .run-prescription-badges');
  await expect(badges).toContainText('9/10 RPE');
  await expect(badges).toContainText('Race Pace');
});
