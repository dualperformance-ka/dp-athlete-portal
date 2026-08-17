import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const nav = readFileSync(join(root, 'public', 'js', '03-nav-nudges.js'), 'utf8');
const login = readFileSync(join(root, 'public', 'js', '02-login-goals.js'), 'utf8');
const index = readFileSync(join(root, 'public', 'index.html'), 'utf8');
const sw = readFileSync(join(root, 'public', 'sw.js'), 'utf8');

test('installed PWA receives a one-time notification onboarding prompt', () => {
  assert.match(nav, /matchMedia\('\(display-mode: standalone\)'\)\.matches/);
  assert.match(nav, /window\.navigator\.standalone===true/);
  assert.match(nav, /Notification\.permission==='denied'\|\|localStorage\.getItem\(notificationOnboardingKey\(\)\)/);
  assert.match(nav, /openPreferences\(\{onboarding:true\}\)/);
  assert.match(login, /setTimeout\(maybePromptPwaNotifications,700\)/);
});

test('notification permission remains behind an explicit athlete action', () => {
  const maybeStart = nav.indexOf('function maybePromptPwaNotifications()');
  const enableStart = nav.indexOf('async function enableAllReminderNotifications()');
  const setterStart = nav.indexOf('async function setReminderPreference(');
  const maybeSource = nav.slice(maybeStart, enableStart);
  const enableSource = nav.slice(enableStart, setterStart);
  assert.doesNotMatch(maybeSource, /Notification\.requestPermission/);
  assert.match(nav, /onclick="enableAllReminderNotifications\(\)"/);
  assert.match(enableSource, /Notification\.requestPermission\(\)/);
});

test('accepting the first permission prompt enables every reminder preference', () => {
  assert.match(nav, /REMINDER_OPTIONS\.forEach\(function\(o\)\{prefs\[o\.key\]=!!enabled;\}\)/);
  assert.match(nav, /setAllReminderPreferences\(true\);[\s\S]*renderReminderPreferences\(false\);[\s\S]*await syncPushSubscription\(\)/);
  assert.match(nav, /permission==='granted'[\s\S]*setAllReminderPreferences\(true\)/);
});

test('an already-granted device can enable every portal category without a second system prompt', () => {
  assert.match(nav, /var permission=Notification\.permission;/);
  assert.match(nav, /if\(permission==='default'\)\{try\{permission=await Notification\.requestPermission\(\)/);
  assert.match(nav, /showOnboarding&&'Notification'in window&&Notification\.permission!=='denied'/);
});

test('new shell versions publish onboarding changes to installed PWAs', () => {
  for (const [asset, minimum] of [['styles.css', 114], ['02-login-goals.js', 103], ['03-nav-nudges.js', 94]]) {
    const match = index.match(new RegExp(asset.replace('.', '\\.') + '\\?v=(\\d+)'));
    assert.ok(match, `${asset} should remain versioned`);
    assert.ok(Number(match[1]) >= minimum, `${asset} must not roll back before its onboarding release`);
    assert.ok(sw.includes(`${asset}?v=${match[1]}`), `${asset} should match the installed-PWA shell`);
  }
  const cache = sw.match(/dp-athlete-v(\d+)/);
  assert.ok(cache && Number(cache[1]) >= 144);
});
