import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const index = readFileSync(join(root, 'public', 'index.html'), 'utf8');
const core = readFileSync(join(root, 'public', 'js', '01-core.js'), 'utf8');
const loginGoals = readFileSync(join(root, 'public', 'js', '02-login-goals.js'), 'utf8');
const boot = readFileSync(join(root, 'public', 'js', '10-boot.js'), 'utf8');

test('athletes never receive a header logout control', () => {
  assert.doesNotMatch(index, /id="logoutBtn"/);
  assert.doesNotMatch(core, /logoutBtn/);
  assert.doesNotMatch(boot, /logoutBtn/);
});

test('Contact sign-out is hidden by default and revealed only for access-code coaches', () => {
  assert.match(index, /id="coachLogoutBtn"[^>]*style="display:none"/);
  assert.match(loginGoals, /localStorage\.getItem\('dp_auth_method'\)==='code'/);
  assert.match(loginGoals, /getElementById\('coachLogoutBtn'\)[\s\S]{0,120}isCoachSession\?'flex':'none'/);
  assert.doesNotMatch(boot, /coachLogoutBtn/);
});

// Sign out left the profile sheet: an athlete signs in once and stays signed
// in, so the control only ever cost them their session. It now lives at the
// bottom of Preferences behind the same access-code gate as Contact's.
test('the profile sheet offers no sign-out at all', () => {
  const sheet = index.slice(index.indexOf('class="profile-menu-list"'), index.indexOf('id="preferencesModal"'));
  assert.doesNotMatch(sheet, /logout\(\)/);
  assert.doesNotMatch(sheet, /Sign out/);
});

test('Preferences sign-out is hidden by default and revealed only for access-code coaches', () => {
  assert.match(index, /id="preferencesSignOut"[^>]*style="display:none"/);
  // Inside the Preferences modal, and after the data controls.
  const prefs = index.slice(index.indexOf('id="preferencesModal"'), index.indexOf('id="dataRequestModal"'));
  assert.match(prefs, /id="preferencesSignOut"/);
  assert.ok(prefs.indexOf('class="data-controls"') < prefs.indexOf('id="preferencesSignOut"'));
  assert.match(loginGoals, /getElementById\('preferencesSignOut'\)[\s\S]{0,120}isCoachSession\?'block':'none'/);
  assert.doesNotMatch(boot, /preferencesSignOut/);
});
