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
