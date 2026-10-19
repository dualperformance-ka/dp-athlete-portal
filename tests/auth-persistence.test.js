import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const core = readFileSync(join(root, 'public', 'js', '01-core.js'), 'utf8');
const boot = readFileSync(join(root, 'public', 'js', '10-boot.js'), 'utf8');

test('access-code sessions are transparently renewed from authenticated device state', () => {
  assert.match(core, /function renewLegacySession\(\)/);
  assert.match(core, /method!=='code'\|\|!code/);
  assert.match(core, /action:'legacy-login',code:code/);
  // Remembered credentials are read and written through the never-throwing
  // safe-storage layer (00-safe-storage.js) on every auth path.
  assert.match(core, /method=safeStorageGet\('dp_auth_method'\)\|\|'';code=safeStorageGet\('dp_auth_code'\)\|\|''/);
  assert.match(core, /safeStorageSet\('dp_legacy_session',_authToken\)/);
});

test('an expired access-code API request renews once and is replayed', () => {
  assert.match(core, /if\(response\.status===401&&safeStorageGet\('dp_auth_method'\)==='code'\)/);
  // The replay is the one place portalRequest re-sends: a 401 proves the
  // server did nothing, so replaying cannot duplicate a write.
  assert.match(core, /var renewed=await renewLegacySession\(\);\s*if\(renewed\)\{\s*try\{fetched=await send\(\);/);
});

test('cold boot restores an authenticated access-code client after token expiry', () => {
  assert.match(boot, /var savedCode=safeStorageGet\('dp_auth_code'\)/);
  assert.match(boot, /var savedMethod=safeStorageGet\('dp_auth_method'\)/);
  assert.match(boot, /if\(savedCode&&savedMethod==='code'\)\{doLogin\(savedCode\);return;\}/);
});

test('explicit logout still disables automatic renewal', () => {
  assert.match(core, /function logoutToLogin\([\s\S]*?safeStorageRemove\('dp_auth_code'\)[\s\S]*?safeStorageRemove\('dp_legacy_session'\)[\s\S]*?safeStorageRemove\('dp_auth_method'\)/);
});
