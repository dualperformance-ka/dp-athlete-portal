import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePrefs } from '../api/_lib/push-devices.js';

const root = new URL('..', import.meta.url).pathname;
const nav = readFileSync(join(root, 'public', 'js', '03-nav-nudges.js'), 'utf8');
const boot = readFileSync(join(root, 'public', 'js', '10-boot.js'), 'utf8');
const login = readFileSync(join(root, 'public', 'js', '02-login-goals.js'), 'utf8');
const index = readFileSync(join(root, 'public', 'index.html'), 'utf8');
const sw = readFileSync(join(root, 'public', 'sw.js'), 'utf8');
const reminders = readFileSync(join(root, 'api', 'reminders.js'), 'utf8');

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
  const maybeSource = nav.slice(maybeStart, enableStart);
  assert.doesNotMatch(maybeSource, /Notification\.requestPermission/);
  assert.match(nav, /onclick="enableAllReminderNotifications\(\)"/);
  assert.match(nav.slice(enableStart), /Notification\.requestPermission\(\)/);
});

test('the prompt stops once permission has been granted', () => {
  const maybeStart = nav.indexOf('function maybePromptPwaNotifications()');
  const maybeSource = nav.slice(maybeStart, nav.indexOf('async function enableAllReminderNotifications()'));
  assert.match(maybeSource, /if\(notificationsGranted\(\)\)return;/);
});

// ── Reminders are coaching, not a preference ─────────────────────────────────
// Athletes receive every category. Removing the toggles is only safe because
// the decision moved server-side — if the UI stopped offering a choice while
// the send path still read per-device prefs, an athlete who had opted out
// before the change would silently keep receiving nothing.

test('the portal offers no per-category notification toggles', () => {
  assert.doesNotMatch(nav, /setReminderPreference/, 'the per-category setter must be gone');
  const listStart = nav.indexOf('function renderReminderPreferences');
  const listSource = nav.slice(listStart, nav.indexOf('function openPreferences'));
  assert.doesNotMatch(listSource, /<input type="checkbox"/, 'the reminder list must be read-only');
  assert.match(listSource, /preference-row is-static/);
});

test('the reminder list describes what arrives rather than offering switches', () => {
  assert.match(nav, /label:'Programme changes'/, 'the coach category must not still claim to be replies');
  assert.doesNotMatch(nav, /label:'Coach replies'/);
});

test('the client sends no preferences, so an exempt athlete keeps their choice', () => {
  const syncStart = boot.indexOf('async function syncPushSubscription()');
  const syncSource = boot.slice(syncStart, boot.indexOf('async function hardRefreshPortal()'));
  assert.match(syncSource, /action:'subscribe'/);
  assert.doesNotMatch(syncSource, /prefs:/, 'subscribe payload must not carry prefs');
  assert.doesNotMatch(syncSource, /anyOn/, 'subscription must not be gated on toggles');
  assert.match(syncSource, /Notification\.permission==='granted'/, 'permission is the only gate left');
});

test('subscribing never overwrites stored prefs with an empty object', () => {
  assert.match(reminders, /if \(cleanPrefs\) row\.prefs = cleanPrefs;/);
});

test('a managed athlete receives every category regardless of stored prefs', () => {
  const rows = [{ prefs: { sessions: true, checkins: false, photos: false, coach: false }, updated_at: '2026-08-19T00:00:00.000Z' }];
  assert.deepEqual(resolvePrefs(rows, { managed: true }), {
    sessions: true, checkins: true, photos: true, coach: true
  });
});

test('an exempt athlete keeps the choice they last made', () => {
  const rows = [
    { prefs: { sessions: true, checkins: true, photos: true, coach: true }, updated_at: '2026-08-17T04:37:09.877Z' },
    { prefs: { sessions: true, checkins: false, photos: false, coach: false }, updated_at: '2026-08-19T22:36:39.330Z' }
  ];
  assert.deepEqual(resolvePrefs(rows, { managed: false }), {
    sessions: true, checkins: false, photos: false, coach: false
  });
});

test('managed prefs cannot be mutated by a caller', () => {
  const first = resolvePrefs([], { managed: true });
  first.coach = false;
  assert.equal(resolvePrefs([], { managed: true }).coach, true, 'MANAGED_PREFS must not leak a shared object');
});

test('an athlete missing from the exemption lookup defaults to managed', () => {
  // The default has to be "receives everything" — a newly onboarded athlete
  // with no row must not silently get nothing.
  assert.match(reminders, /notifications_managed: 'is\.false'/);
  assert.match(reminders, /managed: !unmanaged\.has\(athlete\.code\)/);
  const loaderStart = reminders.indexOf('async function loadUnmanagedAthletes');
  const loaderSource = reminders.slice(loaderStart, reminders.indexOf('export default async function handler'));
  assert.match(loaderSource, /catch \(error\) \{[\s\S]*return new Set\(\);/, 'a missing column must fall back to managed');
});

test('new shell versions publish onboarding changes to installed PWAs', () => {
  for (const [asset, minimum] of [['styles.css', 114], ['02-login-goals.js', 103], ['03-nav-nudges.js', 97], ['10-boot.js', 103]]) {
    const match = index.match(new RegExp(asset.replace('.', '\\.') + '\\?v=(\\d+)'));
    assert.ok(match, `${asset} should remain versioned`);
    assert.ok(Number(match[1]) >= minimum, `${asset} must not roll back before its managed-notifications release`);
    assert.ok(sw.includes(`${asset}?v=${match[1]}`), `${asset} should match the installed-PWA shell`);
  }
  const cache = sw.match(/dp-athlete-v(\d+)/);
  assert.ok(cache && Number(cache[1]) >= 156);
});
