import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// Regression cover for the production Sentry event
//   SecurityError: Storage disabled  (onunhandledrejection)
// raised when browser storage exists but its methods throw. The browser-level
// cover is tests/e2e/storage-disabled.spec.js; these run the same sources in a
// VM so every storage shape is exercised on each `node --test`.

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const safeStorageSource = read('public', 'js', '00-safe-storage.js');
const core = read('public', 'js', '01-core.js');
const boot = read('public', 'js', '10-boot.js');
const index = read('public', 'index.html');
const sw = read('public', 'sw.js');

const securityError = () => new DOMException('Storage disabled', 'SecurityError');

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
  };
}

function throwingStorage() {
  return {
    getItem() { throw securityError(); },
    setItem() { throw securityError(); },
    removeItem() { throw securityError(); },
  };
}

// Window shapes the portal meets in the wild.
const SHAPES = {
  'localStorage is not defined': () => ({}),
  'localStorage is null': () => ({ localStorage: null }),
  'reading localStorage throws SecurityError': () => {
    const win = {};
    Object.defineProperty(win, 'localStorage', { get() { throw securityError(); } });
    return win;
  },
  'every storage method throws SecurityError': () => ({ localStorage: throwingStorage() }),
};

function loadSafeStorage(win) {
  win.window = win;
  vm.runInNewContext(safeStorageSource, win);
  return win;
}

for (const [shape, make] of Object.entries(SHAPES)) {
  test(`safe storage never throws when ${shape}`, () => {
    const win = loadSafeStorage(make());
    assert.equal(win.safeStorageGet('dp_auth_code'), null);
    assert.equal(win.safeStorageSet('dp_auth_code', 'KARL'), false);
    assert.equal(win.safeStorageRemove('dp_auth_code'), false);
  });
}

test('safe storage returns null for a missing value and the stored string otherwise', () => {
  const store = memoryStorage({ dp_auth_method: 'code' });
  const win = loadSafeStorage({ localStorage: store });
  assert.equal(win.safeStorageGet('dp_auth_code'), null);
  assert.equal(win.safeStorageGet('dp_auth_method'), 'code');
  assert.equal(win.safeStorageSet('dp_auth_code', 'KARL'), true);
  assert.equal(store.data.get('dp_auth_code'), 'KARL');
  assert.equal(win.safeStorageRemove('dp_auth_method'), true);
  assert.equal(store.data.has('dp_auth_method'), false);
});

test('safe storage resolves localStorage per call, so the sync interceptor still sees its writes', () => {
  const store = memoryStorage();
  const win = loadSafeStorage({ localStorage: store });
  const seen = [];
  const native = store.setItem;
  store.setItem = (key, value) => { seen.push(key); native(key, value); };
  win.safeStorageSet('dp_goals_KARL', '{}');
  assert.deepEqual(seen, ['dp_goals_KARL']);
});

test('only one method throwing degrades just that operation', () => {
  const store = memoryStorage({ dp_legacy_session: 'token' });
  store.removeItem = () => { throw securityError(); };
  const win = loadSafeStorage({ localStorage: store });
  assert.equal(win.safeStorageGet('dp_legacy_session'), 'token');
  assert.equal(win.safeStorageRemove('dp_legacy_session'), false);
});

// ── 01-core.js storage interceptor ──────────────────────────────────────────

const interceptorStart = core.indexOf('(function(){\n  // Native storage may be missing');
const interceptorEnd = core.indexOf('try{store.setItem=interceptSetItem;}catch(e){}\n})();');
const interceptor = core.slice(interceptorStart, interceptorEnd + 'try{store.setItem=interceptSetItem;}catch(e){}\n})();'.length);

function runInterceptor(win) {
  const scheduled = [];
  Object.assign(win, {
    window: win, _skipSbSync: false, _authToken: 'token', athlete: { code: 'KARL' },
    _scheduleSbSync: (code, sbKey) => scheduled.push(sbKey),
  });
  vm.runInNewContext(interceptor, win);
  return scheduled;
}

test('the interceptor source is located by its landmarks', () => {
  assert.ok(interceptorStart > 0 && interceptorEnd > interceptorStart, 'interceptor landmarks moved');
  assert.doesNotMatch(interceptor, /localStorage\.setItem\.bind\(localStorage\)/,
    'binding the bare global throws at load time when storage is null or blocked');
});

for (const [shape, make] of Object.entries(SHAPES)) {
  test(`the storage interceptor is skipped without throwing when ${shape}`, () => {
    assert.doesNotThrow(() => runInterceptor(make()));
  });
}

test('the storage interceptor is skipped when storage refuses to be patched', () => {
  const store = Object.freeze(memoryStorage());
  assert.doesNotThrow(() => vm.runInNewContext('"use strict";' + interceptor, {
    window: { localStorage: store }, _skipSbSync: false, _authToken: 'token', athlete: { code: 'KARL' }, _scheduleSbSync() {},
  }));
});

test('with working storage the interceptor still writes natively and schedules dp_ sync', () => {
  const store = memoryStorage();
  const win = { localStorage: store };
  const scheduled = runInterceptor(win);
  store.setItem('dp_goals_KARL', '{"a":1}');
  store.setItem('unrelated', 'x');
  assert.equal(store.data.get('dp_goals_KARL'), '{"a":1}');
  assert.equal(store.data.get('unrelated'), 'x');
  assert.deepEqual(scheduled, ['goals']);
});

// ── 10-boot.js startup sequence ─────────────────────────────────────────────

const bootSequence = boot.slice(0, boot.indexOf('// Mobile portal header'));

/**
 * Run the real boot sequence (bootPortal, the logged-out fallback, the
 * analytics loader and the invocation) against a stub DOM.
 */
async function runBoot(win, overrides = {}) {
  const elements = {
    loginScreen: { style: { display: 'none' } },
    loginMethodToggle: { style: { display: 'none' } },
  };
  const calls = { doLogin: [], warnings: [], primaryLogin: 0, scripts: [] };
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const context = Object.assign(win, {
    window: win,
    location: { search: '', href: 'https://portal.example/index.html' },
    history: { replaceState() {} },
    URL, URLSearchParams,
    EMAIL_AUTH_UI: true,
    console: { warn: (...args) => calls.warnings.push(args.join(' ')), log() {}, error() {} },
    document: {
      getElementById: id => elements[id] || null,
      createElement: () => ({}),
      head: { appendChild: el => calls.scripts.push(el.src) },
    },
    _authToken: null,
    removePortalOfflineState: async () => {},
    writePortalOfflineState: async () => {},
    getAuthSession: async () => null,
    resolveAuthedAthlete: async () => null,
    authSignOut: async () => {},
    sanitizeCode: code => code,
    showPausedScreen() {},
    showPrimaryLogin: () => { calls.primaryLogin += 1; },
    doLogin: code => calls.doLogin.push(code),
  }, overrides);
  vm.runInNewContext(safeStorageSource, context);
  vm.runInNewContext(bootSequence, context);
  await new Promise(resolve => setTimeout(resolve, 20));
  process.off('unhandledRejection', onUnhandled);
  return { elements, calls, unhandled, context };
}

function assertLoggedOutBoot({ elements, calls, unhandled, context }) {
  assert.equal(elements.loginScreen.style.display, 'block', 'logged-out login screen is shown');
  assert.ok(calls.primaryLogin >= 1, 'primary login panel is prepared');
  assert.deepEqual(calls.doLogin, []);
  assert.equal(context.__dpAnalyticsStarted, true, 'analytics still starts');
  assert.deepEqual(calls.scripts, ['/_vercel/insights/script.js']);
  assert.deepEqual(unhandled, []);
}

for (const [shape, make] of Object.entries(SHAPES)) {
  test(`boot shows the logged-out login and starts analytics when ${shape}`, async () => {
    const result = await runBoot(make());
    assertLoggedOutBoot(result);
    assert.deepEqual(result.calls.warnings, []);
  });
}

test('boot survives removeItem throwing while discarding a rejected legacy session', async () => {
  const store = memoryStorage({ dp_legacy_session: 'expired' });
  store.removeItem = () => { throw securityError(); };
  const result = await runBoot({ localStorage: store }, { resolveAuthedAthlete: async () => ({ error: 'invalid_session' }) });
  assertLoggedOutBoot(result);
});

test('a bootPortal rejection never escapes as an unhandled rejection', async () => {
  const store = memoryStorage({ dp_legacy_session: 'token' });
  // resolveAuthedAthlete is awaited outside bootPortal's try block, so a throw
  // there rejects bootPortal itself.
  const result = await runBoot({ localStorage: store }, {
    resolveAuthedAthlete: async () => { throw new Error('network stack exploded'); },
  });
  assertLoggedOutBoot(result);
  assert.equal(result.calls.warnings.length, 1);
  assert.match(result.calls.warnings[0], /^Portal boot failed; showing login network stack exploded$/);
});

test('working storage keeps every restore path', async () => {
  const athlete = { ok: true, exists: true, code: 'KARL' };
  const legacy = await runBoot({ localStorage: memoryStorage({ dp_legacy_session: 'tok' }) }, { resolveAuthedAthlete: async () => athlete });
  assert.equal(legacy.context._authToken, 'tok');
  assert.deepEqual(legacy.calls.doLogin, ['KARL']);

  const remembered = await runBoot({ localStorage: memoryStorage({ dp_auth_code: 'KARL', dp_auth_method: 'code' }) });
  assert.deepEqual(remembered.calls.doLogin, ['KARL']);

  const premigration = await runBoot({ localStorage: memoryStorage({ dp_auth_code: 'KARL' }) });
  assert.deepEqual(premigration.calls.doLogin, [], 'email-first login still ignores a method-less remembered code');
  assert.equal(premigration.elements.loginScreen.style.display, 'block');

  const email = await runBoot({ localStorage: memoryStorage({ 'dp-portal-auth': '{}' }) }, {
    getAuthSession: async () => ({ access_token: 'email-session' }),
    resolveAuthedAthlete: async () => athlete,
  });
  assert.equal(email.context._authToken, 'email-session');
  assert.deepEqual(email.calls.doLogin, ['KARL']);
  for (const run of [legacy, remembered, premigration, email]) {
    assert.equal(run.context.__dpAnalyticsStarted, true);
    assert.deepEqual(run.unhandled, []);
  }
});

// ── Wiring ──────────────────────────────────────────────────────────────────

test('bootPortal reads and removes storage only through the safe layer', () => {
  const body = boot.slice(boot.indexOf('async function bootPortal(){'), boot.indexOf('function showLoggedOutLogin(){'));
  assert.doesNotMatch(body, /localStorage\./);
  assert.match(boot, /bootPortal\(\)\.catch\(function\(error\)\{[\s\S]*?showLoggedOutLogin\(\);\s*\}\)\.finally\(function\(\)\{loadVercelAnalytics\(\);\}\);/);
});

test('the safe-storage layer loads before every script that uses it and is in the offline shell', () => {
  const safe = index.indexOf('<script src="js/00-safe-storage.js?v=');
  assert.ok(safe > 0, 'index.html loads 00-safe-storage.js');
  assert.ok(safe < index.indexOf('<script src="js/01-core.js?v='));
  const version = index.match(/js\/00-safe-storage\.js\?v=(\d+)/)[1];
  assert.ok(sw.includes(`'/js/00-safe-storage.js?v=${version}'`), 'sw.js shell caches the same version');
});
