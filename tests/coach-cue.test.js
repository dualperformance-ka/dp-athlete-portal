import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
// The focus helpers were split out of 08-training.js into
// 08-training-focus.js. They share one global scope in the browser, so the
// slices below read both files concatenated IN LOAD ORDER — the same order
// index.html and APP_SHELL use — rather than pinning one filename.
const source = [
  readFileSync(join(root, 'public', 'js', '08-training-focus.js'), 'utf8'),
  readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8'),
].join('\n');

// The focus helpers live in a browser bundle with no module boundary, so lift
// the pure range out by source markers — the same technique readiness.test.js
// and volume-strip.test.js use. Everything from focusDate up to (not
// including) todayFocusContext is global-free by design; todayFocusContext is
// where the DOM and the clock start, and it is deliberately outside the slice.
function focusHelpers() {
  const start = source.indexOf('function focusDate(');
  const end = source.indexOf('function todayFocusContext(');
  assert.ok(start >= 0 && end > start, 'the derived-focus helpers should remain discoverable');
  const context = {};
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context;
}

const { deriveTodayFocus } = focusHelpers();

// 2026-08-26 is a Wednesday, 2026-08-29 a Saturday, 2026-08-30 a Sunday.
const WED = '2026-08-26';
const SAT = '2026-08-29';
const SUN = '2026-08-30';

const ctx = (over) => ({
  date: WED,
  sessions: [{ name: 'Easy Run 6km', type: 'run' }],
  planned: 8,
  completed: 3,
  readiness: null,
  kmDone: 20,
  kmTarget: 40,
  week: 5,
  next: null,
  loggedDates: [],
  ...over,
});

// ── Rule 1 — nothing scheduled ───────────────────────────────────────────────

test('a rest day points at the next session instead of inventing work', () => {
  const line = deriveTodayFocus(ctx({
    sessions: [],
    next: { date: '2026-08-27', name: 'Threshold 8km' },
  }));
  assert.match(line, /No session scheduled today/);
  assert.match(line, /Threshold 8km/);
  assert.match(line, /tomorrow/);
});

test('a rest day with no known next session still says what today is', () => {
  const line = deriveTodayFocus(ctx({ sessions: [], next: null }));
  assert.equal(line, 'No session scheduled today. Recovery day.');
});

test('a next session further out is named by weekday, then by date', () => {
  const weekday = deriveTodayFocus(ctx({ sessions: [], next: { date: '2026-08-29', name: 'Long Run' } }));
  assert.match(weekday, /on Saturday/);
  const dated = deriveTodayFocus(ctx({ sessions: [], next: { date: '2026-09-12', name: 'Long Run' } }));
  assert.match(dated, /on 12 Sep/);
});

// ── Rule 2 — low readiness ───────────────────────────────────────────────────

test('low logged readiness moves the target to completion', () => {
  const line = deriveTodayFocus(ctx({ readiness: 32 }));
  assert.match(line, /Readiness logged at 32/);
  assert.match(line, /completing the session, not the intensity/);
});

test('readiness at the 40 boundary is not treated as low', () => {
  assert.doesNotMatch(deriveTodayFocus(ctx({ readiness: 40 })), /Readiness logged/);
  assert.match(deriveTodayFocus(ctx({ readiness: 39 })), /Readiness logged/);
});

// ── Rule 3 — consecutive training days ───────────────────────────────────────

test('a third consecutive training day asks for quality over volume', () => {
  const line = deriveTodayFocus(ctx({ loggedDates: ['2026-08-25', '2026-08-24'] }));
  assert.match(line, /^Third training day in a row/);
  assert.match(line, /next key session is not compromised/);
});

test('two consecutive days is not enough to fire the fatigue rule', () => {
  const line = deriveTodayFocus(ctx({ loggedDates: ['2026-08-25'] }));
  assert.doesNotMatch(line, /training day in a row/);
});

test('a gap in the logged dates resets the consecutive count', () => {
  const line = deriveTodayFocus(ctx({ loggedDates: ['2026-08-24', '2026-08-23', '2026-08-22'] }));
  assert.doesNotMatch(line, /training day in a row/);
});

test('longer runs of training days are counted, not capped at three', () => {
  const line = deriveTodayFocus(ctx({
    loggedDates: ['2026-08-25', '2026-08-24', '2026-08-23'],
  }));
  assert.match(line, /^Fourth training day in a row/);
});

// ── Rule 4 — session intent ──────────────────────────────────────────────────

test('an interval session states the interval intent', () => {
  const line = deriveTodayFocus(ctx({ sessions: [{ name: 'VO2 Intervals 6x800', type: 'run' }] }));
  assert.match(line, /^Interval session/);
});

test('a long run states the long run intent', () => {
  const line = deriveTodayFocus(ctx({ sessions: [{ name: 'Long Run 18km', type: 'run' }] }));
  assert.match(line, /^Long run/);
  assert.match(line, /not the pace/);
});

test('a threshold session states the threshold intent', () => {
  const line = deriveTodayFocus(ctx({ sessions: [{ name: 'Tempo 3x10min', type: 'run' }] }));
  assert.match(line, /^Threshold session/);
});

test('session intent reads the description and type, not only the name', () => {
  const line = deriveTodayFocus(ctx({
    sessions: [{ name: 'Wednesday Run', type: 'run', description: 'Fartlek — 8 x 90s hard' }],
  }));
  assert.match(line, /^Interval session/);
});

// ── Rule 5 — behind the weekly kilometre target ──────────────────────────────

test('behind target late in the week shows what closing the gap costs', () => {
  const line = deriveTodayFocus(ctx({ date: SAT, kmDone: 20, kmTarget: 40 }));
  assert.equal(line, '20km of 40km with 2 days left. Closing that is about 10km a day.');
});

test('the last day of the week reads as a single day', () => {
  const line = deriveTodayFocus(ctx({ date: SUN, kmDone: 32.5, kmTarget: 40 }));
  assert.match(line, /with 1 day left/);
  assert.match(line, /about 7.5km a day/);
});

test('mid-week the kilometre gap rule stays quiet', () => {
  const line = deriveTodayFocus(ctx({ date: WED, kmDone: 5, kmTarget: 40 }));
  assert.doesNotMatch(line, /Closing that/);
});

test('a met target never produces a gap sentence', () => {
  const line = deriveTodayFocus(ctx({ date: SAT, kmDone: 41, kmTarget: 40 }));
  assert.doesNotMatch(line, /Closing that/);
});

// ── Rule 6 — the planned week is already complete ────────────────────────────

test('a completed week frames today as consolidation', () => {
  const line = deriveTodayFocus(ctx({ planned: 8, completed: 8 }));
  assert.match(line, /All 8 planned sessions this week are already logged/);
  assert.match(line, /consolidation, not catch-up/);
});

// ── Rule 7 — first session of the programme week ─────────────────────────────

test('the first session of the week names the programme week', () => {
  const line = deriveTodayFocus(ctx({ completed: 0, week: 5 }));
  assert.match(line, /^First session of week 5\./);
});

test('an unknown programme week still produces the first-session framing', () => {
  const line = deriveTodayFocus(ctx({ completed: 0, week: null }));
  assert.match(line, /^First session of the week\./);
});

// ── Rule 8 — fallback ────────────────────────────────────────────────────────

test('the fallback states what today is and where it sits in the week', () => {
  const line = deriveTodayFocus(ctx());
  assert.equal(line, 'Today: Easy Run 6km. Session 4 of 8 this week.');
});

test('two sessions on one day are both named', () => {
  const line = deriveTodayFocus(ctx({
    sessions: [{ name: 'Easy Run 6km' }, { name: 'Upper A' }],
  }));
  assert.match(line, /Easy Run 6km and Upper A/);
});

// ── Priority order ───────────────────────────────────────────────────────────

test('low readiness outranks the session type', () => {
  const line = deriveTodayFocus(ctx({
    readiness: 25,
    sessions: [{ name: 'VO2 Intervals', type: 'run' }],
  }));
  assert.match(line, /^Readiness logged at 25/);
});

test('a rest day outranks low readiness', () => {
  const line = deriveTodayFocus(ctx({ sessions: [], readiness: 20, next: null }));
  assert.match(line, /^No session scheduled today/);
});

test('accumulated fatigue outranks the session type', () => {
  const line = deriveTodayFocus(ctx({
    loggedDates: ['2026-08-25', '2026-08-24'],
    sessions: [{ name: 'Long Run 18km', type: 'run' }],
  }));
  assert.match(line, /^Third training day in a row/);
});

test('the session type outranks the kilometre gap', () => {
  const line = deriveTodayFocus(ctx({
    date: SAT,
    kmDone: 10,
    kmTarget: 40,
    sessions: [{ name: 'Long Run 24km', type: 'run' }],
  }));
  assert.match(line, /^Long run/);
});

test('the kilometre gap outranks a completed week', () => {
  const line = deriveTodayFocus(ctx({ date: SAT, kmDone: 10, kmTarget: 40, planned: 8, completed: 8 }));
  assert.match(line, /Closing that/);
});

test('a completed week outranks the first-session framing', () => {
  // Both cannot honestly be true, but the order still has to be deterministic.
  const line = deriveTodayFocus(ctx({ planned: 8, completed: 8, week: 5, kmTarget: 0 }));
  assert.match(line, /consolidation/);
});

// ── Missing data ─────────────────────────────────────────────────────────────

test('missing data falls through to the next rule instead of guessing', () => {
  const line = deriveTodayFocus({
    date: WED,
    sessions: [{ name: 'Easy Run 6km' }],
    readiness: null,
    kmTarget: 0,
    kmDone: null,
    planned: null,
    completed: null,
    loggedDates: null,
  });
  assert.equal(line, 'Today: Easy Run 6km.');
});

test('an unusable date does not crash the date-dependent rules', () => {
  const line = deriveTodayFocus(ctx({ date: 'not-a-date', loggedDates: ['2026-08-25', '2026-08-24'] }));
  assert.ok(line.length > 0);
  assert.doesNotMatch(line, /NaN|undefined|Invalid/);
});

test('a session with no name still produces a usable line', () => {
  const line = deriveTodayFocus(ctx({ sessions: [{}], planned: null, completed: null }));
  assert.equal(line, 'One session scheduled today.');
});

// ── Invariants ───────────────────────────────────────────────────────────────

const everyShape = [
  undefined,
  {},
  { sessions: [] },
  { date: WED, sessions: [] },
  ctx(),
  ctx({ sessions: [] }),
  ctx({ readiness: 10 }),
  ctx({ loggedDates: ['2026-08-25', '2026-08-24'] }),
  ctx({ sessions: [{ name: 'Long Run 20km' }] }),
  ctx({ sessions: [{ name: 'Key Session — 5km time trial' }] }),
  ctx({ date: SAT, kmDone: 1, kmTarget: 50 }),
  ctx({ planned: 8, completed: 8 }),
  ctx({ completed: 0 }),
  ctx({ planned: 0, completed: 0 }),
  ctx({ sessions: [{ name: '' }], planned: null, completed: null }),
  { date: 'x', sessions: [{ name: 'Y' }] },
];

test('the focus line is never empty, whatever the context', () => {
  everyShape.forEach((shape) => {
    const line = deriveTodayFocus(shape);
    assert.equal(typeof line, 'string');
    assert.ok(line.trim().length > 0, `empty focus line for ${JSON.stringify(shape)}`);
  });
});

test('generated text never carries a coach name', () => {
  everyShape.forEach((shape) => {
    const line = deriveTodayFocus(shape);
    assert.doesNotMatch(line, /\bkarl\b|\balex\b|\bcoach\b/i, `coach voice leaked into: ${line}`);
  });
});

test('generated text keeps a training-log tone — no hype punctuation', () => {
  everyShape.forEach((shape) => {
    const line = deriveTodayFocus(shape);
    assert.doesNotMatch(line, /!/, `exclamation mark in: ${line}`);
  });
});

// ── The render boundary ──────────────────────────────────────────────────────
//
// The avatars are the signal that a person wrote the line. Derived text must
// never borrow that signal, and the label has to change with it.

test('only a coach note renders the avatars, and it renders verbatim', () => {
  const start = source.indexOf('function renderCoachMoment(');
  const end = source.indexOf('function syncHeroShell(', start);
  const render = source.slice(start, end);
  assert.match(render, /var avatars=fromCoach\?/);
  assert.match(render, /coach-avatars/);
  assert.match(render, /fromCoach\?'Coach cue for today':'Today’s focus'/);
  assert.match(render, /esc\(note\)/);
  assert.match(render, /track\('coach_cue_shown',\{source:fromCoach\?'coach':'derived'\}\)/);
});

test('the focus split loads before the training bundle that calls into it', () => {
  const index = readFileSync(join(root, 'public', 'index.html'), 'utf8');
  const sw = readFileSync(join(root, 'public', 'sw.js'), 'utf8');
  assert.ok(index.indexOf('src="js/08-training-focus.js') < index.indexOf('src="js/08-training.js'),
    'index.html must load 08-training-focus.js before 08-training.js');
  assert.ok(sw.indexOf("/js/08-training-focus.js") < sw.indexOf("/js/08-training.js?"),
    'APP_SHELL must list 08-training-focus.js before 08-training.js');
});
