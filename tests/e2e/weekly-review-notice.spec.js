import { test, expect } from '@playwright/test';
import { bootPortal } from './harness.mjs';

// The Sunday "week in review" notice is the one automatic notification an
// athlete should always open, so it must stand apart from routine reminders:
// labelled, accented in the brand blue, and pinned just below any unread coach
// message — in both themes, at phone width, with no overflow.

const notifications = [
  { id: '44444444-4444-4444-8444-444444444444', type: 'logging', title: 'Easy Long 11km still open', body: "Two minutes to log it and it's in your week's numbers.", url: '/', created_at: '2026-09-27T10:00:00Z', read_at: null, pushed_at: null },
  { id: '55555555-5555-4555-8555-555555555555', type: 'weekly_review', title: 'Your week in review', body: 'Sessions, distance, strength and recovery for the week, in one place.', url: '/?tab=progress', created_at: '2026-09-27T09:30:00Z', read_at: null, pushed_at: '2026-09-27T09:30:01Z' },
  { id: '66666666-6666-4666-8666-666666666666', type: 'coach', title: 'Your week ahead changed', body: '4 programme changes — tap to review.', url: '/', created_at: '2026-09-27T09:07:00Z', read_at: null, pushed_at: '2026-09-27T09:07:01Z' },
  { id: '77777777-7777-4777-8777-777777777777', type: 'custom', title: 'Great week', body: 'Best week of the block. Proud of this one.', url: '/', created_at: '2026-09-27T08:00:00Z', read_at: null, pushed_at: null },
];

async function openInbox(page, items = notifications) {
  await page.route('**/api/reminders**', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, notifications: items, unread: items.length }),
  }));
  await page.evaluate(() => openNotificationInbox());
  await expect(page.locator('#notificationInboxList .notification-item')).toHaveCount(items.length);
}

for (const outdoor of [false, true]) {
  const theme = outdoor ? 'daylight' : 'night';
  test(`${theme}: the weekly review notice is labelled, accented and pinned`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await bootPortal(page, { outdoor });
    await openInbox(page);
    const items = page.locator('#notificationInboxList .notification-item');

    // Coach message first, then the review, then the rest in server order.
    await expect(items.nth(0)).toHaveClass(/is-coach/);
    const review = items.nth(1);
    await expect(review).toHaveClass(/is-review/);
    await expect(review).toContainText('Weekly review');
    await expect(review).toContainText('Your week in review');
    await expect(items.nth(2)).toContainText('Easy Long 11km still open');
    await expect(items.nth(2)).not.toHaveClass(/is-review/);

    const look = await page.evaluate(() => {
      const [review, plain] = [...document.querySelectorAll('#notificationInboxList .notification-item')]
        .filter((el) => !el.classList.contains('is-coach'));
      const tag = review.querySelector('.notification-review-tag');
      return {
        reviewShadow: getComputedStyle(review).boxShadow,
        reviewBorder: getComputedStyle(review).borderTopColor,
        plainBorder: getComputedStyle(plain).borderTopColor,
        tagColour: getComputedStyle(tag).color,
        textColour: getComputedStyle(plain.querySelector('strong')).color,
      };
    });
    expect(look.reviewShadow).toContain('inset');
    expect(look.reviewBorder).not.toBe(look.plainBorder);
    expect(look.tagColour).not.toBe(look.textColour);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    expect(overflow).toBe(false);
    await page.waitForTimeout(3500);
    await page.screenshot({ path: test.info().outputPath(`weekly-review-notice-${theme}.png`) });
    expect(errors).toEqual([]);
  });
}

test('a read weekly review notice keeps its label but is no longer pinned', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await bootPortal(page);
  const read = notifications.map((n) => (n.type === 'weekly_review' ? { ...n, read_at: '2026-09-27T10:05:00Z' } : n));
  await openInbox(page, read);
  const items = page.locator('#notificationInboxList .notification-item');
  await expect(items.nth(1)).toContainText('Easy Long 11km still open');
  const review = page.locator('#notificationInboxList .notification-item.is-review');
  await expect(review).toContainText('Weekly review');
});
