import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const nav = readFileSync(join(root, 'public', 'js', '03-nav-nudges.js'), 'utf8');
const index = readFileSync(join(root, 'public', 'index.html'), 'utf8');
const css = readFileSync(join(root, 'public', 'styles.css'), 'utf8');

// ── The problem this fixes ───────────────────────────────────────────────────
//
// .top-shell-priority could stack five demands above today's session. A first
// login opened on five things we wanted FROM the athlete before one thing we
// were giving them.

test('the priority order is explicit, and pain outranks everything', () => {
  assert.match(nav, /var NUDGE_PRIORITY=\['painNudge','checkinNudge','callNudge','photoNudge','logNudge','goalsBanner'\];/);
});

test('a confirmed booking drops below the slot instead of competing for it', () => {
  const start = nav.indexOf('var NUDGE_PRIORITY=');
  const end = nav.indexOf('function syncWeekCardState(');
  const pass = nav.slice(start, end);
  assert.ok(start >= 0 && end > start, 'the priority pass should remain discoverable');
  assert.match(pass, /getElementById\('callConfirmedNudge'\)/);
  assert.match(pass, /card\.appendChild\(confirmed\)/);
  assert.doesNotMatch(pass, /card\.insertBefore\(confirmed,card\.firstElementChild\)/);
  assert.doesNotMatch(nav.match(/var NUDGE_PRIORITY=\[[^\n]+/)[0], /callConfirmedNudge/);
  assert.doesNotMatch(pass, /strava-ack-banner/);
  // and it stops being shown a day after this device first sees the booking
  assert.match(nav, /callConfirmationFresh\(st\)\?''/);
  assert.match(nav, /CALL_CONFIRM_WINDOW_MS=86400000/);
});

test('the due slot has a source for every step of the stated precedence', () => {
  assert.match(nav, /function painNudgeState\(/);
  assert.match(nav, /function logNudgeState\(/);
  // pain reads the same body log and threshold as getHomeInsights().warning
  assert.match(nav, /pain<5\)return null/);
  // the check-in row is due from Thursday through Sunday, not all week
  assert.match(nav, /var dueWindow=\(_d===0\|\|_d>=4\)/);
  // yesterday only
  assert.match(nav, /y\.setDate\(y\.getDate\(\)-1\)/);
});

test('collapsed is the default on every load — nothing is persisted', () => {
  assert.match(nav, /var _nudgeSummaryOpen=false/);
  assert.doesNotMatch(nav, /_nudgeSummaryOpen=.*localStorage/);
  assert.doesNotMatch(nav, /localStorage[^\n]*nudgeSummary/i);
});

test('one due nudge shows with no summary row at all', () => {
  assert.match(nav, /if\(due\.length<2\)\{[\s\S]*?row\.style\.display='none';/);
});

test('collapsing uses a class so each nudge keeps authority over its own display', () => {
  assert.match(nav, /el\.classList\.add\('nudge-collapsed'\)/);
  assert.match(nav, /el\.classList\.remove\('nudge-collapsed'\)/);
  assert.match(css, /\.nudge-collapsed\{display:none!important\}/);
});

test('the priority pass runs before the row count, and cannot re-enter it', () => {
  const sync = nav.slice(nav.indexOf('function syncWeekCardState('), nav.indexOf('// Completed rows leave'));
  assert.match(sync, /if\(!_nudgePriorityPass\)\{[\s\S]*applyNudgePriority\(card\)/);
  assert.ok(sync.indexOf('applyNudgePriority') < sync.indexOf('var due=0,rows=0;'));
});

test('expanding is measured', () => {
  assert.match(nav, /track\('nudge_summary_expanded',\{hidden:_nudgeSummaryHidden\}\)/);
});

test('the summary row is built in JavaScript — the markup order is untouched', () => {
  assert.doesNotMatch(index, /nudgeSummaryRow/);
  const priority = index.indexOf('class="top-shell-priority week-card"');
  const goals = index.indexOf('id="goalsBanner"');
  const training = index.indexOf('id="tab-training"');
  assert.ok(priority >= 0 && goals > priority && goals < training);
});
