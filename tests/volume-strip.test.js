import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const nutritionSource = readFileSync(join(root, 'public', 'js', '06-nutrition.js'), 'utf8');
const css = readFileSync(join(root, 'public', 'styles.css'), 'utf8');

// The strip lives in a browser bundle with no module boundary, so lift the two
// pure functions out by source range — the same technique the Strava rejection
// helpers are tested with in strava-match.test.js.
function volumeHelpers() {
  const start = nutritionSource.indexOf('function fmtKmVal');
  const end = nutritionSource.indexOf('function volumeStripHtml');
  assert.ok(start >= 0 && end > start, 'volume display helpers should remain discoverable');
  const context = {};
  vm.createContext(context);
  vm.runInContext(nutritionSource.slice(start, end), context);
  return context;
}

const { volumeWeekDisplay } = volumeHelpers();

const week = (over) => ({ week: 5, planned: 87, actual: null, isPast: true, isCurrent: false, isFuture: false, ...over });

// ── The bug this fixes ───────────────────────────────────────────────────────
//
// The strip printed `planned` under every bar while the bar itself was drawn
// from `actual`. A week planned at 75km and run at 85.6km displayed "75" — the
// chart hid the single number a coach most needs to see.

test('a completed week shows what was actually run, not what was planned', () => {
  const display = volumeWeekDisplay(week({ actual: 88.1 }));
  assert.equal(display.value, '88.1', 'the headline number is the actual distance');
  assert.equal(display.showActual, true);
});

test('the real overreach case is visible', () => {
  // Karl's week 4: planned 75, ran 85.6. Previously displayed as "75".
  const display = volumeWeekDisplay(week({ planned: 75, actual: 85.6 }));
  assert.equal(display.value, '85.6');
  assert.equal(display.delta, '+10.6');
});

test('the delta is signed, so colour is never the only cue', () => {
  assert.equal(volumeWeekDisplay(week({ actual: 88.1 })).delta, '+1.1');
  assert.equal(volumeWeekDisplay(week({ actual: 84.6 })).delta, '−2.4');
  // Over/on target is flagged with a class; under target deliberately is not,
  // so a small miss is recessive rather than an alarm.
  assert.equal(volumeWeekDisplay(week({ actual: 88.1 })).deltaClass, ' over');
  assert.equal(volumeWeekDisplay(week({ actual: 84.6 })).deltaClass, '');
});

test('landing exactly on target reads as a tick, not "+0"', () => {
  const display = volumeWeekDisplay(week({ planned: 80, actual: 80 }));
  assert.equal(display.value, '80');
  assert.equal(display.delta, '✓');
  assert.equal(display.deltaClass, ' over');
});

test('rounding noise under 50 metres counts as on target', () => {
  assert.equal(volumeWeekDisplay(week({ planned: 80, actual: 80.04 })).delta, '✓');
  assert.equal(volumeWeekDisplay(week({ planned: 80, actual: 79.96 })).delta, '✓');
});

// ── The current week ─────────────────────────────────────────────────────────
//
// Flipping the current week to actual would print a bare "0" every Monday
// morning, which reads as failure rather than as a week that has not happened.

test('the current week keeps the target as its headline number', () => {
  const display = volumeWeekDisplay(week({ isPast: false, isCurrent: true, planned: 86, actual: 0 }));
  assert.equal(display.value, '86', 'the current week shows the target, not 0 km run so far');
  assert.equal(display.delta, '0 so far');
  assert.equal(display.deltaClass, '', 'progress mid-week is not a pass or a fail');
});

test('the current week reports progress once there is some', () => {
  const display = volumeWeekDisplay(week({ isPast: false, isCurrent: true, planned: 86, actual: 31.2 }));
  assert.equal(display.value, '86');
  assert.equal(display.delta, '31.2 so far');
});

// ── Weeks with no actual to show ─────────────────────────────────────────────

test('a future week shows the plan and no delta', () => {
  const display = volumeWeekDisplay(week({ isPast: false, isFuture: true, planned: 73, actual: null }));
  assert.equal(display.value, '73');
  assert.equal(display.delta, '');
});

// Weeks before the athlete's Strava history report actual=null, which is "we do
// not know", not "they ran nothing". Showing 0 there would invent a failure.
test('a week older than the Strava history falls back to the plan', () => {
  const display = volumeWeekDisplay(week({ actual: null }));
  assert.equal(display.value, '87');
  assert.equal(display.delta, '');
  assert.equal(display.showActual, false);
});

// ...but a completed week genuinely inside the synced range, with no runs, is a
// real zero. Hiding it would be the same class of lie as the planned-only label.
test('a completed week with no running shows a real zero', () => {
  const display = volumeWeekDisplay(week({ actual: 0 }));
  assert.equal(display.value, '0');
  assert.equal(display.delta, '−87');
});

test('a week with actual but no coach target shows the distance alone', () => {
  // Karl's week 1: ran 57.4 with no weekly target set.
  const display = volumeWeekDisplay(week({ planned: null, actual: 57.4 }));
  assert.equal(display.value, '57.4');
  assert.equal(display.delta, '', 'no target means there is nothing to be over or under');
});

test('a week with neither number renders blank rather than a stray 0', () => {
  const display = volumeWeekDisplay(week({ planned: null, actual: null }));
  assert.equal(display.value, '');
  assert.equal(display.delta, '');
});

// ── Presentation contract ────────────────────────────────────────────────────

test('the delta slot is always rendered so bars share a baseline', () => {
  assert.match(nutritionSource, /class="vstrip-delta'\+disp\.deltaClass\+'"/,
    'the delta span must be emitted unconditionally, empty when there is nothing to say');
  assert.match(css, /\.vstrip-delta\{[^}]*min-height:9px/,
    'the empty delta must still reserve its line, or the bars misalign');
});

test('the unit is stated once in the heading, not on every bar', () => {
  assert.match(nutritionSource, /class="vstrip-unit">km</,
    'the heading carries the unit');
  assert.ok(!/vstrip-km">'\+[^;]*\+' ?km/.test(nutritionSource),
    'bar labels must stay bare numbers — nine repetitions of "km" is noise at 40px');
});

test('screen readers still get both numbers, named', () => {
  // The visual shortcut "the big number is what you ran" is unavailable to a
  // screen reader, so the label must spell out planned and run explicitly.
  assert.match(nutritionSource, /km planned'/);
  assert.match(nutritionSource, /km run'/);
  assert.match(nutritionSource, /class="vstrip-delta'\+disp\.deltaClass\+'" aria-hidden="true"/,
    'the delta is decorative for screen readers — the aria-label already carries both numbers');
});

test('the footer reports what was actually run, not only the plan', () => {
  assert.match(nutritionSource, /run so far/);
  assert.match(nutritionSource, /km planned across the block/);
  assert.match(nutritionSource, /var anyActual=/,
    'an athlete with no synced history should keep the old peak-based footer');
});

// Under target must not borrow a warning colour: --warn does not exist in the
// base theme, and a 1km miss is not worth an alarm.
test('only the over-target state takes a status colour', () => {
  assert.match(css, /\.vstrip-delta\.over\{color:var\(--ok\)\}/);
  assert.ok(!/\.vstrip-delta[^{]*\{[^}]*var\(--danger\)/.test(css),
    'a missed week is reported, not scolded');
});

// ── Palette discipline ───────────────────────────────────────────────────────
//
// Every week that hit its target used to flood its whole column with --ok, so a
// normal block of good weeks rendered as four fully saturated green bars — the
// loudest thing on a screen whose palette keeps saturation for live numbers.
// Hitting the week is now a 2px cap on the column; the signed delta and the cap
// carry it, and the column stays in the run colour it is measuring.

test('a week that hit its target is capped, not flooded with green', () => {
  const hit = css.match(/\.vstrip-week\.is-hit[^\n]*/g) || [];
  assert.ok(hit.length, 'the hit state must still be styled');
  assert.ok(
    !hit.some(rule => /\.vstrip-bar b\{background:var\(--(?:ok|done)\)/.test(rule)),
    'a hit week must not repaint the whole bar in the status colour',
  );
  assert.match(css, /\.vstrip-week\.is-hit \.vstrip-bar b::after\{[^}]*height:2px[^}]*var\(--done\)/,
    'the hit marker is a 2px cap on top of the column');
});

test('the live week is the brightest column and the only one that glows', () => {
  assert.match(css, /\.vstrip-week\.is-current \.vstrip-bar b\{[\s\S]*?background:linear-gradient\(180deg,var\(--run\)/,
    'the current week takes the full readout colour');
  assert.match(css, /\.vstrip-week\.is-current\{[^}]*box-shadow:inset 0 -2px 0 var\(--run\)/,
    'the current week is lit from its baseline rather than outlined — a 1px box read as a selection artefact');
});

// ── The collapsed head ───────────────────────────────────────────────────────
//
// The head put the panel title and the whole coachTargetSummary() sentence on
// one line, both ellipsised: at 390px it read "Weekly volum…" beside
// "… Ride 51…." — an app clipping its own heading and cutting a numeral in
// half. Fit is proved at six phone widths in tests/e2e/volume-strip-fit.spec.js;
// this holds the shape that makes it fit.

test('the collapsed head states one figure and names the other sports', () => {
  assert.match(nutritionSource, /class="vstrip-readout"><b>'\+fmtKmVal/,
    'the running week is a readout, not a sentence');
  assert.match(nutritionSource, /sport==='cycling'\?'ride':'swim'/,
    'the other sports are named, not numbered — a second and third figure is what made the line too long');
  assert.ok(!/\.vstrip-sum\{[^}]*max-width/.test(css),
    'nothing in the head may be clamped to a width that cuts a figure in half');
  assert.ok(!/\.vstrip-(?:sum|title|also)\{[^}]*text-overflow:ellipsis/.test(css),
    'the head has room for its own text now, so nothing there needs an ellipsis');
});

test('the full sport-by-sport summary survives as the accessible name', () => {
  assert.match(nutritionSource, /aria-label="'\+esc\('Weekly volume'\+\(summary\?'\. '\+summary:''\)\)\+'"/,
    'shortening the visible head must not take the other sports away from a screen reader');
});

// Numerals belong to the mono face in this design system; the panel set them in
// the UI sans, which is what made a data panel read as a web page.
test('every figure in the panel is set in the mono face', () => {
  for (const selector of ['.vstrip-km', '.vstrip-delta', '.sport-target-distance', '.vstrip-foot']) {
    const rule = css.match(new RegExp(selector.replace('.', '\\.') + '\\{[^}]*\\}'));
    assert.ok(rule, `${selector} should still be styled`);
    assert.match(rule[0], /font-family:var\(--mono\)/, `${selector} carries figures, so it takes the mono face`);
  }
});
