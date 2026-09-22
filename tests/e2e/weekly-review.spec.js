import { expect, test } from '@playwright/test';
import { bootPortal, localISO, monday } from './harness.mjs';

// The Weekly Review journey, end to end in a real browser: it loads on Progress,
// it changes week, it refuses to walk into a week that has not started, it shows
// a skeleton rather than the last week's numbers under a new label, it survives
// an API failure without taking the rest of Progress down, it retries, it says
// so when the data is partial, and it fits a 320px phone.

const CURRENT_ID = '0f30b419-62ad-4bef-80e2-35eb71eb8ccb';
const PREVIOUS_ID = '11111111-2222-4333-8444-555555555555';
const NEXT_ID = '22222222-3333-4444-8555-666666666666';

function weekStarts() {
  const thisMonday = monday();
  const iso = (offsetWeeks) => {
    const date = new Date(thisMonday);
    date.setDate(thisMonday.getDate() + offsetWeeks * 7);
    return localISO(date);
  };
  return { previous: iso(-1), current: iso(0), next: iso(1) };
}

function programmeWeeks() {
  const starts = weekStarts();
  return [
    { id: PREVIOUS_ID, programmeId: 'prog', weekNumber: 7, weekLabel: 'Week 7', startDate: starts.previous },
    { id: CURRENT_ID, programmeId: 'prog', weekNumber: 8, weekLabel: 'Week 8', startDate: starts.current },
    // Deliberately in the future: the next control must refuse to reach it.
    { id: NEXT_ID, programmeId: 'prog', weekNumber: 9, weekLabel: 'Week 9', startDate: starts.next },
  ];
}

function summaryFor(id, over = {}) {
  const starts = weekStarts();
  const byId = {
    [CURRENT_ID]: { weekNumber: 8, label: 'Week 8', startDate: starts.current, state: 'current' },
    [PREVIOUS_ID]: { weekNumber: 7, label: 'Week 7', startDate: starts.previous, state: 'past' },
  };
  const week = byId[id] || byId[CURRENT_ID];
  const endDate = (() => {
    const date = new Date(week.startDate);
    date.setDate(date.getDate() + 6);
    return localISO(date);
  })();
  const zero = { planned: 0, completed: 0 };
  const noSport = {
    plannedDistanceKm: null, plannedDistanceSource: 'none', actualSessions: 0,
    actualDistanceKm: null, actualDurationMinutes: null, actualSource: 'unavailable',
  };
  return {
    version: 1,
    generatedAt: '2026-09-23T10:15:00.000Z',
    period: {
      type: 'week', programmeWeekId: id, weekNumber: week.weekNumber, label: week.label,
      startDate: week.startDate, endDate, state: week.state,
    },
    training: {
      plannedSessions: 6, completedSessions: 5, completionPercent: 83,
      byType: {
        running: { planned: 4, completed: 3 }, cycling: zero, swimming: zero,
        strength: { planned: 2, completed: 2 }, other: zero,
      },
      missedSessions: [{ id: 's1', title: 'Easy Run', date: week.startDate, type: 'running' }],
    },
    endurance: {
      running: {
        plannedDistanceKm: 42, plannedDistanceSource: 'typed', actualSessions: 3,
        actualDistanceKm: 39.6, actualDurationMinutes: 228, actualSource: 'strava',
      },
      cycling: { ...noSport },
      swimming: { ...noSport },
    },
    strength: {
      plannedSessions: 2, completedSessions: 2, exercisesLogged: 9, workingSets: 31,
      measurableVolumeKg: 5240,
      volumeCoverage: { eligibleSets: 31, measuredSets: 27, excludedSets: 4 },
      personalBestsStatus: 'calculated',
      personalBests: [{ exercise: 'Back Squat', type: 'load', value: 110, unit: 'kg', previous: 105, delta: 5, date: week.startDate }],
    },
    readiness: {
      daysLogged: 6, average: 72, previousWeekAverage: 78, changeFromPreviousWeek: -6,
      sleepAverage: 6.8, energyAverage: 6.4, sorenessAverage: 5.2, stressAverage: 7.1,
    },
    bodyweight: { entries: 4, firstKg: 86.4, lastKg: 85.9, changeKg: -0.5, firstDate: week.startDate, lastDate: endDate },
    checkIn: { submitted: true, submittedAt: '2026-09-23T09:42:18.000Z', weekEnding: endDate },
    attention: [{ code: 'high_stress', severity: 'medium', message: 'Average stress was 7.1 this week.', value: 7.1 }],
    dataQuality: { partial: false, missingSources: [], warnings: [] },
    ...over,
  };
}

const emptySummary = (id) => {
  const base = summaryFor(id);
  const zero = { planned: 0, completed: 0 };
  const noSport = {
    plannedDistanceKm: null, plannedDistanceSource: 'none', actualSessions: 0,
    actualDistanceKm: null, actualDurationMinutes: null, actualSource: 'unavailable',
  };
  return {
    ...base,
    training: {
      plannedSessions: 0, completedSessions: 0, completionPercent: null,
      byType: { running: zero, cycling: zero, swimming: zero, strength: zero, other: zero },
      missedSessions: [],
    },
    endurance: { running: { ...noSport }, cycling: { ...noSport }, swimming: { ...noSport } },
    strength: {
      plannedSessions: 0, completedSessions: 0, exercisesLogged: 0, workingSets: 0,
      measurableVolumeKg: null, volumeCoverage: { eligibleSets: 0, measuredSets: 0, excludedSets: 0 },
      personalBestsStatus: 'calculated', personalBests: [],
    },
    readiness: {
      daysLogged: 0, average: null, previousWeekAverage: null, changeFromPreviousWeek: null,
      sleepAverage: null, energyAverage: null, sorenessAverage: null, stressAverage: null,
    },
    bodyweight: { entries: 0, firstKg: null, lastKg: null, changeKg: null, firstDate: null, lastDate: null },
    checkIn: { submitted: false, submittedAt: null, weekEnding: base.period.endDate },
    attention: [],
  };
};

/**
 * @param {object} options
 *  - summary(id) => summary object, or 'fail' to answer 500
 *  - delayMs — hold the performance-summary response open
 *  - onRequest(id) — called for every summary request
 */
function reviewStubs({ summary = summaryFor, delayMs = 0, onRequest = null, weeks = programmeWeeks() } = {}) {
  return async (action, body) => {
    if (action === 'programme-data') {
      if (weeks === 'fail') return { status: 500, json: { ok: false, error: 'Programme unavailable' } };
      return { json: { ok: true, planned: [], nutrition: [], programmeWeeks: weeks } };
    }
    if (action === 'performance-summary') {
      const id = String(body.programmeWeekId || '');
      if (onRequest) onRequest(id);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const result = summary(id);
      if (result === 'fail') return { status: 500, json: { ok: false, error: 'Weekly review is temporarily unavailable' } };
      return { json: { ok: true, summary: result } };
    }
    return undefined;
  };
}

async function openProgress(page) {
  await page.evaluate(() => switchTab('progress'));
  await page.locator('#weeklyReviewCard').waitFor({ state: 'visible' });
}

const card = (page) => page.locator('#weeklyReviewCard');
const body = (page) => page.locator('#wrBody');

// ── Loads on Progress ────────────────────────────────────────────────────────

test('opening Progress loads the current weekly review', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  const requested = [];
  await bootPortal(page, { onPortalAction: reviewStubs({ onRequest: (id) => requested.push(id) }) });
  await openProgress(page);

  await expect(page.locator('#wrWeekLabel')).toHaveText('Week 8');
  await expect(page.locator('#wrWeekCurrent')).toBeVisible();
  await expect(body(page)).toContainText('of 6 completed');
  await expect(body(page)).toContainText('5 240 kg', { useInnerText: true }).catch(async () => {
    // en-AU groups with a space in some builds and a comma in others.
    await expect(body(page)).toContainText(/5[\s,]240 kg/);
  });
  await expect(body(page)).toContainText('39.6 km');
  await expect(body(page)).toContainText('72/100');
  await expect(body(page)).toContainText('Back Squat');
  await expect(body(page)).toContainText('Average stress was 7.1 this week.');
  await expect(body(page)).toContainText('Weekly check-in: Submitted.');
  expect(requested).toEqual([CURRENT_ID]);

  // It sits above the photo card, which is the whole point of the hierarchy change.
  const reviewTop = (await card(page).boundingBox()).y;
  const photoTop = (await page.locator('.progress-photo-priority').boundingBox()).y;
  expect(reviewTop).toBeLessThan(photoTop);
});

test('the review does not hold up the rest of Progress', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await bootPortal(page, { onPortalAction: reviewStubs({ delayMs: 2500 }) });
  await page.evaluate(() => switchTab('progress'));
  // While the summary is still in flight the weight trend has already rendered.
  await expect(page.locator('#wrBody .wr-skeleton')).toBeVisible();
  await expect(page.locator('.progress-photo-priority')).toBeVisible();
  await expect(page.locator('#pgTarget')).not.toHaveText('');
});

// ── Week navigation ──────────────────────────────────────────────────────────

test('switching to a previous week replaces the content and requests that week', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  const requested = [];
  await bootPortal(page, { onPortalAction: reviewStubs({ onRequest: (id) => requested.push(id) }) });
  await openProgress(page);
  await expect(page.locator('#wrWeekLabel')).toHaveText('Week 8');

  await page.locator('#wrPrevBtn').click();
  await expect(page.locator('#wrWeekLabel')).toHaveText('Week 7');
  await expect(page.locator('#wrWeekCurrent')).toBeHidden();
  await expect(body(page)).toContainText('of 6 completed');
  expect(requested).toEqual([CURRENT_ID, PREVIOUS_ID]);

  // Back again is served from the in-memory cache — no second request.
  await page.locator('#wrNextBtn').click();
  await expect(page.locator('#wrWeekLabel')).toHaveText('Week 8');
  await page.waitForTimeout(400);
  expect(requested).toEqual([CURRENT_ID, PREVIOUS_ID]);
});

test('navigation into a week that has not started is disabled', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  const requested = [];
  await bootPortal(page, { onPortalAction: reviewStubs({ onRequest: (id) => requested.push(id) }) });
  await openProgress(page);

  const next = page.locator('#wrNextBtn');
  await expect(next).toBeDisabled();
  await expect(next).toHaveAttribute('aria-disabled', 'true');
  // Even driven directly, the controller refuses.
  await page.evaluate(() => weeklyReviewStep(1));
  await page.waitForTimeout(300);
  await expect(page.locator('#wrWeekLabel')).toHaveText('Week 8');
  expect(requested).toEqual([CURRENT_ID]);

  // And the first week has nothing before it.
  await page.locator('#wrPrevBtn').click();
  await expect(page.locator('#wrWeekLabel')).toHaveText('Week 7');
  await expect(page.locator('#wrPrevBtn')).toBeDisabled();
});

test('both week controls have descriptive accessible names and are keyboard reachable', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await bootPortal(page, { onPortalAction: reviewStubs() });
  await openProgress(page);
  await expect(page.getByRole('button', { name: 'Show the previous programme week' })).toBeVisible();
  // The next control is present but disabled on the current week.
  await expect(page.locator('#wrNextBtn')).toHaveAttribute('aria-label', 'Show the next programme week');
  await page.locator('#wrPrevBtn').focus();
  await expect(page.locator('#wrPrevBtn')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#wrWeekLabel')).toHaveText('Week 7');
});

// ── Loading ──────────────────────────────────────────────────────────────────

test('the loading state is a skeleton, never the previous week under a new label', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await bootPortal(page, { onPortalAction: reviewStubs({ delayMs: 1200 }) });
  await openProgress(page);
  await expect(body(page)).toContainText('39.6 km');

  await page.locator('#wrPrevBtn').click();
  // Label has already moved; the numbers must NOT still be week 8's.
  await expect(page.locator('#wrWeekLabel')).toHaveText('Week 7');
  await expect(page.locator('#wrBody .wr-skeleton')).toBeVisible();
  await expect(body(page)).not.toContainText('39.6 km');
  await expect(body(page)).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#wrBody .wr-status')).toHaveText(/Loading/);

  await expect(body(page)).toContainText('39.6 km', { timeout: 5000 });
  await expect(body(page)).toHaveAttribute('aria-busy', 'false');
});

// ── Empty ────────────────────────────────────────────────────────────────────

test('a week with nothing in it states the facts rather than hiding the card', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await bootPortal(page, { onPortalAction: reviewStubs({ summary: emptySummary }) });
  await openProgress(page);
  await expect(card(page)).toBeVisible();
  await expect(body(page)).toContainText('No sessions were scheduled for this week.');
  await expect(body(page)).toContainText('No readiness entries were recorded.');
  await expect(body(page)).toContainText('Weekly check-in: Not submitted for this week.');
  // Nothing reads as failure, and nothing unavailable reads as a zero.
  await expect(body(page)).not.toContainText('unavailable');
  await expect(body(page)).not.toContainText('0 km');
});

// ── Error and retry ──────────────────────────────────────────────────────────

test('an API failure leaves the rest of Progress usable', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await bootPortal(page, { onPortalAction: reviewStubs({ summary: () => 'fail' }) });
  await openProgress(page);

  await expect(body(page)).toContainText('Weekly review unavailable');
  await expect(page.locator('#wrBody .wr-retry')).toBeVisible();
  // The card failed; the tab did not.
  await expect(page.locator('.progress-photo-priority')).toBeVisible();
  await expect(page.locator('.progress-baseline')).toBeVisible();
  await expect(page.locator('#pgTarget')).toBeVisible();
  await expect(page.locator('#photoCurrentAction')).toBeEnabled();
});

test('retry goes back to the server and succeeds', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  let attempt = 0;
  await bootPortal(page, {
    onPortalAction: reviewStubs({
      summary: (id) => { attempt += 1; return attempt === 1 ? 'fail' : summaryFor(id); },
    }),
  });
  await openProgress(page);
  await expect(body(page)).toContainText('Weekly review unavailable');

  const retry = page.locator('#wrBody .wr-retry');
  // A real button, not a link or a div.
  await expect(retry).toHaveRole('button');
  await retry.click();
  await expect(body(page)).toContainText('of 6 completed');
  expect(attempt).toBe(2);
});

// ── Partial ──────────────────────────────────────────────────────────────────

test('a partial summary renders what it has and says what it could not load', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  const partial = (id) => {
    const base = summaryFor(id);
    return {
      ...base,
      endurance: {
        ...base.endurance,
        running: {
          plannedDistanceKm: 42, plannedDistanceSource: 'typed', actualSessions: 0,
          actualDistanceKm: null, actualDurationMinutes: null, actualSource: 'unavailable',
        },
      },
      readiness: {
        daysLogged: 0, average: null, previousWeekAverage: null, changeFromPreviousWeek: null,
        sleepAverage: null, energyAverage: null, sorenessAverage: null, stressAverage: null,
      },
      bodyweight: { entries: 0, firstKg: null, lastKg: null, changeKg: null, firstDate: null, lastDate: null },
      attention: [],
      dataQuality: { partial: true, missingSources: ['daily_body_logs', 'strava_activities'], warnings: [] },
    };
  };
  await bootPortal(page, { onPortalAction: reviewStubs({ summary: partial }) });
  await openProgress(page);

  await expect(body(page)).toContainText('Some weekly data could not be loaded');
  // The sections that do have data still render normally.
  await expect(body(page)).toContainText('of 6 completed');
  await expect(body(page)).toContainText('42 km planned');
  // And an unavailable metric is never drawn as a zero.
  await expect(body(page)).toContainText('Activity data unavailable');
  await expect(body(page)).toContainText('No readiness entries were recorded.');
  await expect(body(page)).not.toContainText('0 km');
  await expect(body(page)).not.toContainText('0/100');
});

test('a PB status of not_calculated says so instead of claiming none were set', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  const noPbs = (id) => {
    const base = summaryFor(id);
    return { ...base, strength: { ...base.strength, personalBestsStatus: 'not_calculated', personalBests: [] } };
  };
  await bootPortal(page, { onPortalAction: reviewStubs({ summary: noPbs }) });
  await openProgress(page);
  await expect(body(page)).toContainText('Personal bests could not be checked for this week.');
  await expect(body(page)).not.toContainText('Back Squat');
});

// ── Programme with no published weeks ────────────────────────────────────────

test('an athlete with no published programme weeks gets an explanation, not an error', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await bootPortal(page, { onPortalAction: reviewStubs({ weeks: [] }) });
  await openProgress(page);
  await expect(body(page)).toContainText('Your programme weeks will appear here');
  await expect(page.locator('#wrPrevBtn')).toBeDisabled();
  await expect(page.locator('#wrNextBtn')).toBeDisabled();
});

// ── Fit, themes and console ──────────────────────────────────────────────────

const WIDTHS = [320, 390, 768, 1280];

for (const width of WIDTHS) {
  for (const outdoor of [false, true]) {
    const theme = outdoor ? 'daylight' : 'night';
    test(`${theme}: the review fits and stays readable at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width >= 768 ? 900 : 852 });
      await bootPortal(page, { outdoor, onPortalAction: reviewStubs() });
      await openProgress(page);
      await expect(body(page)).toContainText('of 6 completed');

      const report = await page.evaluate(() => {
        const host = document.getElementById('weeklyReviewCard');
        const offenders = [];
        host.querySelectorAll('*').forEach((node) => {
          const style = getComputedStyle(node);
          if (style.overflowX !== 'visible') return;
          if (node.scrollWidth > node.clientWidth + 1) {
            offenders.push({ sel: node.className || node.tagName, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth });
          }
        });
        const tap = [];
        host.querySelectorAll('button').forEach((node) => {
          const box = node.getBoundingClientRect();
          if (box.width > 0 && (box.height < 44 || box.width < 44)) {
            tap.push({ sel: node.id || node.className, w: Math.round(box.width), h: Math.round(box.height) });
          }
        });
        return {
          offenders,
          tap,
          documentScroll: document.documentElement.scrollWidth,
          viewport: window.innerWidth,
          cardWidth: host.getBoundingClientRect().width,
        };
      });

      expect(report.offenders, `overflowing inside the review at ${width}px`).toEqual([]);
      expect(report.documentScroll, 'no horizontal page scroll').toBeLessThanOrEqual(report.viewport + 1);
      expect(report.tap, 'every control keeps a 44px touch target').toEqual([]);
      expect(report.cardWidth).toBeLessThanOrEqual(report.viewport);

      if (width === 390) {
        await card(page).screenshot({ path: `test-results/weekly-review-${theme}-390.png` });
      }
    });
  }
}

test('the fit probe bites when the review is pushed past its column', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 852 });
  await bootPortal(page, { onPortalAction: reviewStubs() });
  await openProgress(page);
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = '#weeklyReviewCard .wr-metric-value{font-size:70px;white-space:nowrap}';
    document.head.appendChild(style);
  });
  const offenders = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('#weeklyReviewCard *').forEach((node) => {
      if (getComputedStyle(node).overflowX !== 'visible') return;
      if (node.scrollWidth > node.clientWidth + 1) out.push(node.className || node.tagName);
    });
    return out;
  });
  expect(offenders.length, 'the probe should see the overflow it is there to catch').toBeGreaterThan(0);
});

test('attention severity is carried by words, not colour alone', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  const flagged = (id) => {
    const base = summaryFor(id);
    return {
      ...base,
      attention: [
        { code: 'pain_reported', severity: 'high', message: 'Knee pain was recorded on 2 days.', value: 2 },
        { code: 'high_stress', severity: 'medium', message: 'Average stress was 8.1 this week.', value: 8.1 },
        { code: 'checkin_missing', severity: 'low', message: 'The weekly check-in for this week was not submitted.', value: null },
      ],
    };
  };
  await bootPortal(page, { onPortalAction: reviewStubs({ summary: flagged }) });
  await openProgress(page);
  const words = await page.locator('#wrBody .wr-severity').allTextContents();
  expect(words).toEqual(['Flagged', 'Worth noting', 'For the record']);
  await expect(body(page)).toContainText('Knee pain was recorded on 2 days.');
  // Factual only — no advice, no diagnosis, no congratulation.
  const text = await body(page).innerText();
  expect(/well done|great work|keep it up|you should|push through|injury|injured/i.test(text)).toBe(false);
});

test('the whole journey runs with no console errors', async ({ page }) => {
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error}`));
  page.on('console', (message) => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });

  await page.setViewportSize({ width: 393, height: 852 });
  let attempt = 0;
  await bootPortal(page, {
    onPortalAction: reviewStubs({
      summary: (id) => { attempt += 1; return attempt === 2 ? 'fail' : summaryFor(id); },
    }),
  });
  await openProgress(page);
  await expect(body(page)).toContainText('of 6 completed');
  await page.locator('#wrPrevBtn').click();                 // fails
  await expect(body(page)).toContainText('Weekly review unavailable');
  await page.locator('#wrBody .wr-retry').click();          // succeeds
  await expect(body(page)).toContainText('of 6 completed');
  await page.locator('#wrNextBtn').click();
  await expect(page.locator('#wrWeekLabel')).toHaveText('Week 8');
  await page.evaluate(() => switchTab('today'));
  await page.evaluate(() => switchTab('progress'));
  await expect(body(page)).toContainText('of 6 completed');

  // A stubbed 500 is an expected part of this journey and the fetch itself logs
  // it; what must not appear is an uncaught error or a broken render.
  expect(problems.filter((item) => !/Failed to load resource|500|net::ERR|_vercel/.test(item))).toEqual([]);
});

test('the summary is never written to device storage', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await bootPortal(page, { onPortalAction: reviewStubs() });
  await openProgress(page);
  await expect(body(page)).toContainText('of 6 completed');
  const leaked = await page.evaluate(() => {
    const hits = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      const value = String(localStorage.getItem(key) || '');
      if (/performance-summary|measurableVolumeKg|personalBestsStatus|dataQuality/.test(value) || /weekly_?review|wrCache/i.test(key)) {
        hits.push(key);
      }
    }
    return hits;
  });
  expect(leaked, 'the weekly summary must stay in memory for the page session').toEqual([]);
});
