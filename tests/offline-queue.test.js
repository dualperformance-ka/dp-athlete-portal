import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const core = readFileSync(join(root, 'public', 'js', '01-core.js'), 'utf8');
const worker = readFileSync(join(root, 'public', 'sw.js'), 'utf8');
const indexSource = readFileSync(join(root, 'public', 'index.html'), 'utf8');
const loginSource = readFileSync(join(root, 'public', 'login.js'), 'utf8');
const start = core.indexOf('function pendingCoachWritesKey');
const end = core.indexOf('// Coach prescription overrides', start);
const queueSource = core.slice(start, end);

function fakeLocalStorage(seed = {}) {
  const values = new Map(Object.entries(seed).map(([key, value]) => [key, String(value)]));
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function fakeIndexedDB() {
  const stores = new Map();
  const names = { contains: name => stores.has(name) };
  function request(tx, action) {
    const req = {};
    tx.pending++;
    queueMicrotask(() => {
      try { req.result = action(); if (req.onsuccess) req.onsuccess(); }
      catch (error) { req.error = error; if (req.onerror) req.onerror(); }
      tx.pending--;
      tx.finish();
    });
    return req;
  }
  function objectStore(tx, name) {
    const map = stores.get(name);
    return {
      createIndex() {},
      put(value) { return request(tx, () => { map.set(value.id ?? value.key, structuredClone(value)); return value.id ?? value.key; }); },
      delete(key) { return request(tx, () => map.delete(key)); },
      get(key) { return request(tx, () => map.has(key) ? structuredClone(map.get(key)) : undefined); },
      index(indexName) {
        assert.ok(indexName === 'bucket' || indexName === 'code');
        return { getAll(value) { return request(tx, () => [...map.values()].filter(row => row[indexName] === value).map(row => structuredClone(row))); } };
      },
    };
  }
  const db = {
    objectStoreNames: names,
    createObjectStore(name) {
      stores.set(name, new Map());
      return { createIndex() {} };
    },
    transaction(name) {
      const tx = {
        pending: 0, settled: false,
        objectStore: storeName => objectStore(tx, storeName),
        finish() {
          if (tx.pending || tx.settled) return;
          tx.settled = true;
          setImmediate(() => { if (tx.oncomplete) tx.oncomplete(); });
        },
      };
      setImmediate(() => tx.finish());
      return tx;
    },
  };
  return {
    open() {
      const req = {};
      setImmediate(() => {
        req.result = db;
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
    stores,
  };
}

function loadQueue({ storage = fakeLocalStorage(), idb = fakeIndexedDB() } = {}) {
  const context = {
    localStorage: storage,
    indexedDB: idb,
    athlete: null,
    _authToken: null,
    window: { addEventListener() {} },
    navigator: { onLine: true, storage: {} },
    document: { getElementById() { return null; }, addEventListener() {}, visibilityState: 'visible' },
    console,
    setTimeout,
    clearTimeout,
    structuredClone,
    track() {},
    showToast() {},
    loadConfirmedLogDates: undefined,
  };
  vm.createContext(context);
  vm.runInContext(queueSource + `
    this.readPendingCoachWrites=readPendingCoachWrites;
    this.persistPendingCoachWrites=persistPendingCoachWrites;
    this.retryPendingCoachWrites=retryPendingCoachWrites;
    this.readPortalOfflineState=readPortalOfflineState;
    this.queueCoachWrite=queueCoachWrite;
    this.readPendingPortalStateWrites=readPendingPortalStateWrites;
    this.queuePortalStateWrite=queuePortalStateWrite;
  `, context);
  return context;
}

test('pre-seeded localStorage queue and run cache migrate once without dropping data', async () => {
  const queued = [{ id: 'cw_existing', url: '/coach', payload: { type: 'training' } }];
  const runCache = { ts: Date.now(), revision: 'r1', byId: { run1: { name: 'Easy Run' } } };
  const storage = fakeLocalStorage({
    dp_pending_writes_KARL: JSON.stringify(queued),
    dp_run_library_cache_v3: JSON.stringify(runCache),
  });
  const context = loadQueue({ storage });

  assert.deepEqual(JSON.parse(JSON.stringify(await context.readPendingCoachWrites('KARL'))), queued);
  assert.deepEqual(JSON.parse(JSON.stringify(await context.readPortalOfflineState('dp_run_library_cache_v3'))), runCache);
  assert.equal(storage.getItem('dp_pending_writes_KARL'), null);
  assert.equal(storage.getItem('dp_run_library_cache_v3'), null);

  context._offlineMigrationPromise = null;
  assert.deepEqual(JSON.parse(JSON.stringify(await context.readPendingCoachWrites('KARL'))), queued, 'second migration does not duplicate or erase the queue');
});

test('unknown writes are re-homed under the athlete code when a retry still fails', async () => {
  const context = loadQueue();
  const queued = [{ id: 'cw_unknown', url: '/coach', payload: { type: 'weekly_checkin' } }];
  await context.persistPendingCoachWrites(queued, '_unknown');
  context.athlete = { code: 'KARL' };
  context.ingestWrite = async () => { throw new Error('still offline'); };

  await context.retryPendingCoachWrites(true);

  assert.equal((await context.readPendingCoachWrites('_unknown')).length, 0);
  const rehomed = await context.readPendingCoachWrites('KARL');
  assert.equal(rehomed.length, 1);
  assert.equal(rehomed[0].id, 'cw_unknown');
  assert.equal(rehomed[0].attempts, 1);
});

test('queue falls back to localStorage when IndexedDB throws', async () => {
  const storage = fakeLocalStorage();
  const context = loadQueue({ storage, idb: { open() { throw new Error('private browsing'); } } });
  const queued = [{ id: 'cw_fallback', url: '/coach', payload: { type: 'daily_body' } }];

  await context.persistPendingCoachWrites(queued, 'KARL');

  assert.deepEqual(JSON.parse(JSON.stringify(await context.readPendingCoachWrites('KARL'))), queued);
  assert.equal(storage.getItem('dp_pending_writes_KARL'), JSON.stringify(queued));
});

test('ordinary portal state writes have a durable latest-value outbox', async () => {
  const context = loadQueue();
  context.athlete = { code: 'KARL' };
  await context.queuePortalStateWrite('reschedules', { session1: '2026-08-27' }, new Error('offline'));
  await context.queuePortalStateWrite('reschedules', { session1: '2026-08-28' }, new Error('still offline'));

  const queued = await context.readPendingPortalStateWrites('KARL');
  assert.equal(queued.length, 1, 'newer state replaces the same key instead of duplicating it');
  assert.equal(queued[0].key, 'reschedules');
  assert.equal(queued[0].value.session1, '2026-08-28');
});

test('state outbox falls back to localStorage when IndexedDB is unavailable', async () => {
  const storage = fakeLocalStorage();
  const context = loadQueue({ storage, idb: { open() { throw new Error('private browsing'); } } });
  context.athlete = { code: 'KARL' };
  await context.queuePortalStateWrite('ticked', { session1: true }, new Error('offline'));

  assert.equal((await context.readPendingPortalStateWrites('KARL')).length, 1);
  assert.match(storage.getItem('dp_pending_state_writes_KARL'), /"key":"ticked"/);
});

test('background sync uses the same short-lived bearer token and preserves failed writes', () => {
  assert.match(worker, /addEventListener\('sync',[\s\S]*event\.tag === 'dp-flush-queue'/);
  assert.match(worker, /Authorization: `Bearer \$\{token\}`/);
  assert.match(worker, /dp_auth_athlete_code/);
  assert.match(worker, /queuedWriteBelongsToAthlete[\s\S]*item\.bucket === '_unknown'/);
  assert.match(worker, /writePortalState\('pending_writes', remaining\)[\s\S]*coachSuccessIds\.forEach/);
  assert.doesNotMatch(worker, /refresh_token|long-lived/i);
  assert.match(loginSource, /writePortalOfflineState\('dp_auth_token',_authToken\)/);
  assert.match(core, /removePortalOfflineState\('dp_auth_token'\)/);
  assert.match(core, /writePortalOfflineState\('dp_auth_athlete_code'/);
  assert.match(core, /removePortalOfflineState\('dp_auth_athlete_code'\)/);
});

test('background sync cannot send another athlete’s device queue', () => {
  const helperStart = worker.indexOf('function queuedWriteBelongsToAthlete');
  const helperEnd = worker.indexOf('\n}\n\nasync function flushOfflineQueue', helperStart) + 2;
  const context = {};
  vm.createContext(context);
  vm.runInContext(worker.slice(helperStart, helperEnd) + ';this.belongs=queuedWriteBelongsToAthlete;', context);

  assert.equal(context.belongs({ bucket: 'KARL', payload: { athleteCode: 'KARL' } }, 'KARL'), true);
  assert.equal(context.belongs({ bucket: 'ALEX', payload: { athleteCode: 'ALEX' } }, 'KARL'), false);
  assert.equal(context.belongs({ bucket: '_unknown', payload: { athleteCode: 'KARL' } }, 'KARL'), true);
  assert.equal(context.belongs({ bucket: '_unknown', payload: { athleteCode: 'ALEX' } }, 'KARL'), false);
});

test('Chromium periodic sync is permission-guarded and conservative', () => {
  assert.match(core, /navigator\.permissions\.query\(\{name:'periodic-background-sync'\}\)/);
  assert.match(core, /permission&&permission\.state==='granted'/);
  assert.match(core, /minInterval:12\*60\*60\*1000/);
  assert.match(worker, /addEventListener\('periodicsync'/);
});

test('foreground resume paths and the existing online path all flush the queue', () => {
  assert.match(core, /visibilityState==='visible'[\s\S]*retryPendingCoachWrites\(true,'visibility'\)/);
  assert.match(core, /addEventListener\('pageshow',[\s\S]*retryPendingCoachWrites\(true,'visibility'\)/);
  assert.match(core, /addEventListener\('online',[\s\S]*retryPendingCoachWrites\(true,'online'\)/);
  assert.match(worker, /addEventListener\('activate',[\s\S]*flushOfflineQueue\('sync'\)/);
  assert.match(core, /visibilityState==='visible'[\s\S]*retryPendingPortalStateWrites\(true,'visibility'\)/);
  assert.match(core, /addEventListener\('online',[\s\S]*retryPendingPortalStateWrites\(true,'online'\)/);
});

test('all pending updates are loud, retryable, and measured', () => {
  assert.match(indexSource, /id="queuePendingBanner"[\s\S]*manualRetryPendingCoachWrites\(\)/);
  assert.match(indexSource, /update waiting to send/);
  assert.match(core, /track\('queue_pending_shown',\{count:count\}\)/);
  assert.match(core, /track\('queue_flush_manual'\)/);
  assert.match(core, /offline_queue_flushed',\{count:totalSynced,trigger:trigger/);
  assert.match(core, /offline_state_flushed',\{count:synced,trigger:trigger/);
});

test('cloud hydration preserves newer local outbox values and merges queue mirrors', () => {
  assert.match(core, /if\(pendingStateKeys\[row\.key\]\)return;/);
  assert.match(core, /localPending\.concat\(cloudKeys\['pending_writes'\]\)/);
  assert.match(core, /pendingById\[item\.id\]/);
});

test('the portal asks the browser to protect offline storage after login', () => {
  assert.match(core, /navigator\.storage\.persisted/);
  assert.match(core, /navigator\.storage\.persist\(\)/);
  assert.match(core, /offline_storage_persistence/);
});
