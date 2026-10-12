import { expect, test } from '@playwright/test';
import { bootPortal } from './harness.mjs';

// The two athlete-facing promises from tests/submit-feedback.test.js, checked
// in a real booted portal at phone size:
//  1. a session with typed-but-unsent work reads "Not sent" on the week
//  2. a submit button visibly says Sending, then turns green once it lands
const PHONE = { width: 393, height: 852 };

for (const outdoor of [false, true]) {
  const theme = outdoor ? 'daylight' : 'night';
  test(`${theme}: an unsent draft is flagged on the week and clears once sent`, async ({ page }) => {
    await page.setViewportSize(PHONE);
    await bootPortal(page, { outdoor });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));

    // Tuesday's run has numbers typed in but never sent.
    await page.evaluate(() => {
      const run = sessions.find(s => s.name && /Progression/.test(s.name));
      logs[run.id] = { distance: '8.2', duration: '41', pace: '', rpe: '', feel: '', notes: '' };
      goTrainingPlan();
      renderCal(getWS());
    });
    await page.waitForTimeout(700);

    const row = page.locator('#weeklyCalEl .mobile-week-session', { hasText: 'Progression' });
    await expect(row).toHaveClass(/has-draft/);
    await expect(row.locator('.mobile-week-draft')).toBeVisible();
    await expect(row.locator('.mobile-week-draft')).toHaveText('Not sent');
    await expect(row).toHaveAttribute('aria-label', /not sent to your coaches yet/);
    // Untouched sessions are not flagged.
    await expect(page.locator('#weeklyCalEl .mobile-week-session.has-draft')).toHaveCount(1);

    const bg = await row.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(bg, 'the draft row is tinted, not the default surface').not.toBe('rgba(0, 0, 0, 0)');
    await page.locator('#weeklyCalEl').screenshot({ path: `test-results/week-unsent-${theme}.png` });

    // Once it is submitted the flag goes and the row reads complete.
    await page.evaluate(() => {
      const run = sessions.find(s => s.name && /Progression/.test(s.name));
      sessionLoggedCache['session_' + athlete.code + '_' + run.id] = true;
      renderCal(getWS());
    });
    await page.waitForTimeout(400);
    await expect(row).not.toHaveClass(/has-draft/);
    await expect(row.locator('.mobile-week-draft')).toBeHidden();
    expect(errors).toEqual([]);
  });
}

test('the body check-in button says Sending, then turns green, while the write is in flight', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await bootPortal(page);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  let release;
  const gate = new Promise(r => { release = r; });
  await page.route('**/api/ingest', async route => {
    await gate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.evaluate(() => openQuickLog('body'));
  const btn = page.locator('#qlbSubmitBtn');
  await expect(btn).toBeVisible();
  await btn.click();

  await expect(btn).toHaveText('Sending…');
  await expect(btn).toHaveAttribute('aria-busy', 'true');
  const sending = await btn.evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, opacity: getComputedStyle(el).opacity, spinner: getComputedStyle(el, '::after').content }));
  expect(sending.opacity, 'sending must not dim the button').toBe('1');
  expect(sending.spinner, 'a spinner shows while sending').not.toBe('none');
  await page.locator('.ql-modal.open .sheet-actions, #qlbSubmitBtn').first().screenshot({ path: 'test-results/button-sending.png' });

  // Transitions off so the colour is final the moment the class lands, and
  // the check runs in-page: the green only holds for ~0.75s before the sheet
  // closes, which a round-trip poll can miss on a loaded machine.
  await page.addStyleTag({ content: '#qlbSubmitBtn{transition:none!important;animation:none!important}' });
  const greenSeen = page.waitForFunction(() => {
    const el = document.getElementById('qlbSubmitBtn');
    return el && el.textContent === 'Sent to coaches ✓' && el.getAttribute('aria-busy') !== 'true'
      && getComputedStyle(el).backgroundColor === 'rgb(34, 197, 94)';
  }, null, { polling: 'raf' });
  release();
  await greenSeen;
  expect(errors).toEqual([]);
});

test('the session footer and strength review button carry sending and sent states', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await bootPortal(page);
  const shots = await page.evaluate(() => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:auto 16px 16px 16px;z-index:99999;display:grid;gap:10px;padding:12px;background:var(--g-0)';
    host.innerHTML = '<button class="savebtn" id="demoA">Review &amp; submit</button><button class="focus-done-btn" id="demoB">Send to coaches</button><button class="strength-review-primary" id="demoC" style="min-height:46px;border-radius:12px">Submit to coaches</button>';
    host.id = 'demoHost';
    document.body.appendChild(host);
    ['demoA', 'demoB', 'demoC'].forEach(id => setButtonBusy(document.getElementById(id), true));
    return ['demoA', 'demoB', 'demoC'].map(id => getComputedStyle(document.getElementById(id)).opacity);
  });
  expect(shots).toEqual(['1', '1', '1']);
  await page.locator('#demoHost').screenshot({ path: 'test-results/buttons-sending.png' });
  await page.evaluate(() => { markButtonSent(document.getElementById('demoA')); markButtonSent(document.getElementById('demoB')); markButtonSent(document.getElementById('demoC'), null, true); });
  await page.waitForTimeout(400);
  await page.locator('#demoHost').screenshot({ path: 'test-results/buttons-sent.png' });
  await expect(page.locator('#demoA')).toHaveText('Sent to coaches ✓');
});
