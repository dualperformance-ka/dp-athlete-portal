import { test, expect } from '@playwright/test';
import { bootPortal } from './harness.mjs';

// A coach-written message must read as personal in the real inbox: labelled,
// pinned first while unread, and visually distinct from automatic reminders,
// at phone width and without layout overflow.

const notifications = [
  { id: '11111111-1111-4111-8111-111111111111', type: 'coach', title: 'Your programme changed', body: 'Upper A (2 days / wk) (Mon, 21 Sept) added', url: '/', created_at: '2026-09-24T20:00:00Z', read_at: null, pushed_at: '2026-09-24T20:00:01Z' },
  { id: '22222222-2222-4222-8222-222222222222', type: 'sessions', title: "Today's training", body: 'Optional Shakeout 4km', url: '/', created_at: '2026-09-23T20:00:00Z', read_at: null, pushed_at: '2026-09-23T20:00:01Z' },
  { id: '33333333-3333-4333-8333-333333333333', type: 'custom', title: 'Great work', body: 'Nailed Upper A (2 days / wk). That is the standard. Keep stacking sessions like this', url: '/', created_at: '2026-09-23T19:23:00Z', read_at: null, pushed_at: null },
];

test('a coach message is pinned, labelled and distinct in the inbox', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await bootPortal(page);
  await page.route('**/api/reminders**', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, notifications, unread: 3 }),
  }));
  await page.evaluate(() => openNotificationInbox());
  const items = page.locator('#notificationInboxList .notification-item');
  await expect(items).toHaveCount(3);

  const first = items.first();
  await expect(first).toHaveClass(/is-coach/);
  await expect(first).toContainText('From your coach');
  await expect(first).toContainText('Great work');
  await expect(first).not.toContainText('· Inbox');
  await expect(items.nth(1)).not.toHaveClass(/is-coach/);
  await expect(items.nth(1)).toContainText('Sent to your device');

  const accent = await first.evaluate(el => getComputedStyle(el).boxShadow);
  expect(accent).toContain('inset');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  expect(overflow).toBe(false);
  await page.waitForTimeout(3500); // let the one-off glow finish so the resting state is captured
  await page.screenshot({ path: test.info().outputPath('coach-message-inbox.png') });
  expect(errors).toEqual([]);
});
