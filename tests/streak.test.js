import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const core = readFileSync(join(root, 'public', 'js', '01-core.js'), 'utf8');
const training = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');
const index = readFileSync(join(root, 'public', 'index.html'), 'utf8');

// The streak sits with the portal's other date helpers, so the slice takes
// localISO, localDateFromISO and getMon with it — those ARE the Monday-start
// convention, and testing against a reimplementation of them would prove
// nothing.
function streakHelpers() {
  const start = core.indexOf('function localISO(');
  const end = core.indexOf('function getWS(');
  assert.ok(start >= 0 && end > start, 'the streak helper should remain discoverable');
  const context = {};
  vm.createContext(context);
  vm.runInContext(core.slice(start, end), context);
  return context;
}

const { computeLoggingStreak } = streakHelpers();

// Mondays: 2026-08-03, 08-10, 08-17, 08-24. 2026-08-26 is the Wednesday of the
// 08-24 week; 2026-08-30 is the Sunday that closes it.
const THIS_WED = '2026-08-26';

test('no sessions is no streak', () => {
  assert.equal(computeLoggingStreak([], THIS_WED), 0);
  assert.equal(computeLoggingStreak(null, THIS_WED), 0);
  assert.equal(computeLoggingStreak(undefined, THIS_WED), 0);
});

test('one session this week is a one week streak', () => {
  assert.equal(computeLoggingStreak(['2026-08-25'], THIS_WED), 1);
});

test('several sessions in one week are still one week', () => {
  assert.equal(
    computeLoggingStreak(['2026-08-24', '2026-08-25', '2026-08-26'], THIS_WED),
    1,
  );
});

test('a clean run of weeks counts every one of them', () => {
  const dates = ['2026-08-25', '2026-08-18', '2026-08-11', '2026-08-04'];
  assert.equal(computeLoggingStreak(dates, THIS_WED), 4);
});

test('a missed week breaks the streak at the gap', () => {
  // Nothing in the week of 2026-08-10.
  const dates = ['2026-08-25', '2026-08-18', '2026-08-04', '2026-07-28'];
  assert.equal(computeLoggingStreak(dates, THIS_WED), 2);
});

// ── The current week is live, not yet judged ─────────────────────────────────
//
// The whole reason this is weeks and not days. An athlete opening the portal on
// Monday morning must not watch a nine-week streak reset before they have had a
// chance to train.

test('a current week with nothing logged yet leaves the prior streak intact', () => {
  const dates = ['2026-08-18', '2026-08-11', '2026-08-04'];
  assert.equal(computeLoggingStreak(dates, THIS_WED), 3);
});

test('the same streak still stands on the Monday of the new week', () => {
  const dates = ['2026-08-18', '2026-08-11', '2026-08-04'];
  assert.equal(computeLoggingStreak(dates, '2026-08-24'), 3);
});

test('logging in the current week extends rather than replaces the run', () => {
  const dates = ['2026-08-24', '2026-08-18', '2026-08-11'];
  assert.equal(computeLoggingStreak(dates, THIS_WED), 3);
});

test('two empty weeks do end the streak', () => {
  // Nothing in the 08-24 week and nothing in the 08-17 week either.
  const dates = ['2026-08-11', '2026-08-04'];
  assert.equal(computeLoggingStreak(dates, THIS_WED), 0);
});

// ── Week boundaries ──────────────────────────────────────────────────────────

test('Sunday belongs to the week that is ending, not the one starting', () => {
  // 2026-08-30 is a Sunday: same week as Monday 2026-08-24.
  assert.equal(computeLoggingStreak(['2026-08-30', '2026-08-24'], '2026-08-30'), 1);
  // 2026-08-23 is the Sunday of the PREVIOUS week.
  assert.equal(computeLoggingStreak(['2026-08-25', '2026-08-23'], THIS_WED), 2);
});

test('week boundaries hold across the turn of the year', () => {
  // Mondays: 2025-12-22, 2025-12-29, 2026-01-05, 2026-01-12.
  const dates = ['2026-01-12', '2026-01-05', '2025-12-29', '2025-12-22'];
  assert.equal(computeLoggingStreak(dates, '2026-01-14'), 4);
});

test('a year-end gap breaks the streak like any other gap', () => {
  // Nothing in the week of 2025-12-29.
  const dates = ['2026-01-12', '2026-01-05', '2025-12-22'];
  assert.equal(computeLoggingStreak(dates, '2026-01-14'), 2);
});

test('an ISO week 53 year rolls over without a special case', () => {
  // 2021-01-03 is a Sunday and belongs to the Monday 2020-12-28 week, so with
  // 2020-12-21 that is two consecutive weeks either side of new year.
  assert.equal(computeLoggingStreak(['2021-01-03', '2020-12-21'], '2021-01-03'), 2);
  assert.equal(computeLoggingStreak(['2021-01-03', '2020-12-21'], '2020-12-28'), 2);
  // 2021-01-04 opens a new, still-empty week — the run behind it stands.
  assert.equal(computeLoggingStreak(['2021-01-03', '2020-12-21'], '2021-01-04'), 2);
});

// ── Input tolerance ──────────────────────────────────────────────────────────

test('future dates never inflate the streak', () => {
  const dates = ['2026-09-15', '2026-09-08', '2026-08-25'];
  assert.equal(computeLoggingStreak(dates, THIS_WED), 1);
});

test('duplicate and unusable dates are ignored', () => {
  const dates = ['2026-08-25', '2026-08-25', '', null, 'not-a-date', '2026-08-18'];
  assert.equal(computeLoggingStreak(dates, THIS_WED), 2);
});

test('timestamps and Date objects are accepted alongside ISO days', () => {
  const dates = ['2026-08-25T06:30:00.000Z', new Date(2026, 7, 18)];
  assert.equal(computeLoggingStreak(dates, THIS_WED), 2);
});

test('an unusable reference date returns zero rather than throwing', () => {
  assert.equal(computeLoggingStreak(['2026-08-25'], 'not-a-date'), 0);
});

// ── The surface ──────────────────────────────────────────────────────────────

test('the streak shows from two weeks up, and nowhere else', () => {
  const start = training.indexOf('function syncHeroStreak(');
  const end = training.indexOf('function syncHeroShell(');
  const surface = training.slice(start, end);
  assert.ok(start >= 0 && end > start, 'the hero streak surface should remain discoverable');
  assert.match(surface, /if\(weeks<2\)\{el\.hidden=true;/);
  assert.match(surface, /el\.textContent=weeks\+' week streak';/);
  assert.match(surface, /track\('streak_shown',\{weeks:weeks\}\)/);
  // One line, no flame, no animation.
  assert.doesNotMatch(surface, /🔥|flame|animate/i);
});

test('the streak line sits with the week number on the hero', () => {
  const week = index.indexOf('id="heroWeek"');
  const streak = index.indexOf('id="heroWeekStreak"');
  assert.ok(week >= 0 && streak > week, 'the streak should render next to the week number');
  assert.match(index.slice(week, streak + 200), /class="hero-week-streak"/);
});
