import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const read = path => readFileSync(join(root, 'public', path), 'utf8');
const config = read('config.js');
const index = read('index.html');
const login = read('login.js');
const boot = read('js/10-boot.js');
const core = read('js/01-core.js');
const loginGoals = read('js/02-login-goals.js');
const authAthlete = readFileSync(join(root, 'api', 'auth-athlete.js'), 'utf8');

test('email OTP is the primary logged-out sign-in when enabled', () => {
  assert.match(config, /const EMAIL_AUTH_UI = true;/);
  assert.match(login, /function showPrimaryLogin\(notice\)\{showEmailLogin\(isEmailLoginEnabled\(\),isEmailLoginEnabled\(\)\?notice:''\);\}/);
  assert.match(boot, /if\(typeof showPrimaryLogin==='function'\)showPrimaryLogin\(\);\s*document\.getElementById\('loginScreen'\)\.style\.display='block';/);
});

test('authenticated access-code clients resume while stale pre-migration codes cannot bypass email-first login', () => {
  assert.match(boot, /if\(savedCode&&savedMethod==='code'\)\{doLogin\(savedCode\);return;\}/);
  assert.match(boot, /if\(savedCode&&!emailPrimary\)\{doLogin\(savedCode\);return;\}/);
  assert.doesNotMatch(boot, /if\(savedCode\)\{doLogin\(savedCode\);return;\}/);
});

test('explicit coach code links and access-code fallback remain available', () => {
  assert.match(boot, /if\(urlCode\)[\s\S]*?doLogin\(sanitizeCode\(urlCode\)\);/);
  assert.match(index, /id="loginMethodToggle"[^>]*>Use athlete access code<\/button>/);
  assert.match(login, /toggle\.textContent=show\?'Use athlete access code':'Sign in with email'/);
});

test('logout and paused-account recovery return to the primary sign-in', () => {
  assert.match(core, /function logoutToLogin\([\s\S]*?showPrimaryLogin\(\);[\s\S]*?loginScreen'\)\.style\.display='block';/);
  assert.match(loginGoals, /function pausedBackToLogin\([\s\S]*?showPrimaryLogin\(\);[\s\S]*?loginScreen'\)\.style\.display='block';/);
  assert.doesNotMatch(core, /function logout\(\)[\s\S]*?showEmailLogin\(false\)/);
});

test('eligible code sign-ins receive a one-time, dismissible email upgrade prompt', () => {
  assert.match(authAthlete, /email: athlete\.email,[\s\S]*auth_mode: athlete\.auth_mode,[\s\S]*auth_method: 'legacy'/);
  assert.match(loginGoals, /localStorage\.getItem\('dp_auth_method'\)!=='code'/);
  assert.match(loginGoals, /auth_mode\|\|''\)\.toLowerCase\(\)!=='both'/);
  assert.match(loginGoals, /localStorage\.setItem\(key,'shown'\);[\s\S]*emailUpgradePrompt/);
  assert.match(index, /id="emailUpgradePrompt"[^>]*hidden[\s\S]*id="emailUpgradeAcceptBtn"/);
  assert.match(index, /onclick="dismissEmailUpgradePrompt\(\)"/);
});

test('accepting the upgrade records analytics and immediately begins OTP sign-in', () => {
  assert.match(loginGoals, /track\('email_upgrade_prompt_shown'\)/);
  assert.match(loginGoals, /function acceptEmailUpgrade\([\s\S]*track\('email_upgrade_accepted'\)[\s\S]*logoutToLogin\(true\)[\s\S]*showEmailLogin\(true\)[\s\S]*await sendEmailCode\(\)/);
});

test('email upgrade is portal-only and never mutates roster authentication fields', () => {
  assert.match(authAthlete, /import \{ select \} from '\.\/_lib\/supabase-rest\.js';/);
  assert.doesNotMatch(authAthlete, /\b(?:update|upsert)\s*\(/);
});
