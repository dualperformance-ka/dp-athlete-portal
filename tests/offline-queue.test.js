import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const core = readFileSync(join(root, 'public', 'js', '01-core.js'), 'utf8');
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
        assert.equal(indexName, 'bucket');
        return { getAll(bucket) { return request(tx, () => [...map.values()].filter(row => row.bucket === bucket).map(row => structuredClone(row))); } };
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
    navigator: { onLine: true },
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
