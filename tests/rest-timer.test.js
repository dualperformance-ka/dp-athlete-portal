import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const source = readFileSync(join(root, 'public', 'js', '09-logging.js'), 'utf8');
const timerSource = source.slice(0, source.indexOf('function addSet'));

// A recording stand-in for the screen wake lock. iOS releases the real one
// whenever the page is hidden, so the lifecycle — not just the request — is
// what the tests care about.
function wakeLockStub(log) {
  let released = 0;
  return {
    api: {
      request: (type) => {
        log.push({ event: 'request', type });
        return Promise.resolve({
          release: () => { released++; log.push({ event: 'release' }); return Promise.resolve(); },
          addEventListener: () => {}
        });
      }
    },
    releases: () => released
  };
}

// Minimal Web Audio graph that records the notes actually scheduled.
function audioStub(notes) {
  let state = 'suspended';
  return {
    Ctor: function AudioContext() {
      state = 'running';
      return {
        get state() { return state; },
        currentTime: 0,
        resume: () => { state = 'running'; return Promise.resolve(); },
        createOscillator: () => ({
          type: '', frequency: { setValueAtTime: (hz) => notes.push(hz) },
          connect: () => {}, start: () => {}, stop: () => {}
        }),
        createGain: () => ({
          gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
          connect: () => {}
        }),
        destination: {}
      };
    }
  };
}

function timerContext(options = {}) {
  const stored = new Map();
  const notifications = [];
  const toasts = [];
  const vibrations = [];
  const wakeLog = [];
  const notes = [];
  const timer = { style: {}, getAttribute: () => '90' };
  const count = { textContent: '' };
  const fill = { style: {} };
  const wrongCard = { querySelector: () => ({ textContent: 'Dumbbell Bicep Curl' }) };
  function Notification(title, options) { notifications.push({ title, options }); }
  Notification.permission = 'granted';
  const wake = wakeLockStub(wakeLog);
  const audio = audioStub(notes);
  const navigatorStub = { vibrate: (pattern) => vibrations.push(pattern) };
  // Safari ships neither of these historically, so every capability is opt-in
  // and the timer must still work with both absent.
  if (options.wakeLock !== false) navigatorStub.wakeLock = wake.api;
  const context = {
    athlete: { code: 'TEST' },
    console,
    Date,
    JSON,
    Math,
    Promise,
    Notification,
    location: { pathname: '/portal', search: '' },
    navigator: navigatorStub,
    showToast: (message) => toasts.push(message),
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (callback) => callback(),
    localStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: (key) => stored.delete(key)
    },
    document: {
      visibilityState: 'visible',
      addEventListener: () => {},
      querySelectorAll: () => [],
      querySelector: () => wrongCard,
      getElementById: (id) => id === 'rest_0_1' ? timer : (id === 'rtc_0_1' ? count : (id === 'rtf_0_1' ? fill : null))
    },
    window: { addEventListener: () => {}, Notification }
  };
  if (options.audio !== false) context.window.AudioContext = audio.Ctor;
  vm.createContext(context);
  vm.runInContext(timerSource, context);
  return { context, notifications, stored, toasts, vibrations, wakeLog, notes, wake };
}

// The wake lock is requested through a promise, so let the microtask queue drain.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('visible rest timer finishes with an exact in-app cue for the right exercise', () => {
  const { context, notifications, stored, toasts, vibrations } = timerContext();

  context.startRest(0, 1, 'Lat Pulldown');
  const saved = JSON.parse(stored.get('dp_rest_timer_TEST'));
  assert.equal(saved.exerciseName, 'Lat Pulldown');

  context._rest.deadline = Date.now();
  context.finishRest(0, 1);
  assert.equal(notifications.length, 0);
  assert.deepEqual(toasts, ['Rest complete · Lat Pulldown']);
  assert.deepEqual(Array.from(vibrations[0]), [180, 90, 180]);
});

test('backgrounded rest timer sends one system notification three seconds early', () => {
  const { context, notifications, stored } = timerContext();
  context.document.visibilityState = 'hidden';
  context.startRest(0, 1, 'Lat Pulldown');
  context._rest.deadline = Date.now() + 3000;
  const saved = JSON.parse(stored.get('dp_rest_timer_TEST'));
  saved.deadline = context._rest.deadline;
  stored.set('dp_rest_timer_TEST', JSON.stringify(saved));

  context.renderRestTimer(0, 1);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, 'Rest nearly complete');
  assert.equal(notifications[0].options.body, 'Rest finishes in 3 seconds — get ready for Lat Pulldown.');
  assert.equal(JSON.parse(stored.get('dp_rest_timer_TEST')).notified, true);
});

test('restored timer uses its persisted exercise instead of the first card', () => {
  const { context, notifications, stored } = timerContext();
  context.document.visibilityState = 'hidden';
  stored.set('dp_rest_timer_TEST', JSON.stringify({
    key: '0_1', i: 0, ei: 1, total: 90,
    deadline: Date.now() - 1000,
    exerciseName: 'Rear Delt Fly'
  }));

  context.restoreRestTimer();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].options.body, 'Rest finished — time for Rear Delt Fly.');
});

// ── Screen wake lock ─────────────────────────────────────────────────────────
// The reason rest alerts arrived late: iOS freezes page JavaScript when the
// screen locks, so the interval never reaches the deadline. Holding the screen
// awake for the length of the rest keeps the common case honest.

test('starting a rest holds the screen awake', async () => {
  const { context, wakeLog } = timerContext();
  context.startRest(0, 1, 'Lat Pulldown');
  await settle();
  assert.deepEqual(wakeLog, [{ event: 'request', type: 'screen' }]);
});

test('finishing the rest releases the screen', async () => {
  const { context, wakeLog } = timerContext();
  context.startRest(0, 1, 'Lat Pulldown');
  await settle();
  context._rest.deadline = Date.now();
  context.finishRest(0, 1);
  assert.deepEqual(wakeLog.map((e) => e.event), ['request', 'release']);
});

test('skipping the rest releases the screen', async () => {
  const { context, wakeLog } = timerContext();
  context.startRest(0, 1, 'Lat Pulldown');
  await settle();
  context.skipRest(0, 1);
  assert.deepEqual(wakeLog.map((e) => e.event), ['request', 'release']);
});

test('returning to a running rest takes the wake lock back', async () => {
  // iOS drops the lock the moment the page hides, so restoring must re-request.
  const { context, wakeLog } = timerContext();
  context.startRest(0, 1, 'Lat Pulldown');
  await settle();
  context._restWakeLock = null; // as iOS leaves it after hiding the page
  context.restoreRestTimer();
  await settle();
  assert.deepEqual(wakeLog.map((e) => e.event), ['request', 'request']);
});

test('a browser without wake lock support still runs the timer', async () => {
  const { context, stored } = timerContext({ wakeLock: false });
  context.startRest(0, 1, 'Lat Pulldown');
  await settle();
  assert.equal(JSON.parse(stored.get('dp_rest_timer_TEST')).exerciseName, 'Lat Pulldown');
});

// ── Audible cue ──────────────────────────────────────────────────────────────
// navigator.vibrate is a no-op on every iOS device our athletes use, which left
// a silent on-screen toast as the only completion cue.

test('rest completion plays an audible chime', () => {
  const { context, notes } = timerContext();
  context.startRest(0, 1, 'Lat Pulldown');   // the set tap unlocks audio
  context._rest.deadline = Date.now();
  context.finishRest(0, 1);
  assert.deepEqual(notes, [880, 880, 1175], 'three blips, the last one higher');
});

test('a browser without Web Audio still completes cleanly', () => {
  const { context, toasts, notes } = timerContext({ audio: false });
  context.startRest(0, 1, 'Lat Pulldown');
  context._rest.deadline = Date.now();
  context.finishRest(0, 1);
  assert.deepEqual(notes, []);
  assert.deepEqual(toasts, ['Rest complete · Lat Pulldown']);
});

// ── Late alerts own the delay ────────────────────────────────────────────────

test('an alert fired long after the deadline says how long ago', () => {
  const { context, notifications } = timerContext();
  context.document.visibilityState = 'hidden';
  context._rest.deadline = Date.now() - 150000; // page was frozen for 2.5 min
  context.sendRestSystemAlert(0, 1, 'Rear Delt Fly');
  assert.equal(notifications[0].title, 'Rest complete');
  assert.equal(notifications[0].options.body, 'Rest for Rear Delt Fly finished 3 minutes ago.');
});

test('a barely-late alert still reads as timely', () => {
  const { context, notifications } = timerContext();
  context.document.visibilityState = 'hidden';
  context._rest.deadline = Date.now() - 2000;
  context.sendRestSystemAlert(0, 1, 'Rear Delt Fly');
  assert.equal(notifications[0].options.body, 'Rest finished — time for Rear Delt Fly.');
});

test('a late foreground return reports the overrun in the toast', () => {
  const { context, toasts } = timerContext();
  context._rest.deadline = Date.now() - 90000;
  context.showRestForegroundComplete(0, 1, 'Lat Pulldown');
  assert.deepEqual(toasts, ['Rest for Lat Pulldown finished 2 minutes ago']);
});

test('elapsed phrasing stays natural across the ranges', () => {
  const { context } = timerContext();
  assert.equal(context.restElapsedPhrase(20000), '20 seconds ago');
  assert.equal(context.restElapsedPhrase(59000), '59 seconds ago');
  assert.equal(context.restElapsedPhrase(61000), 'a minute ago');
  assert.equal(context.restElapsedPhrase(240000), '4 minutes ago');
});
