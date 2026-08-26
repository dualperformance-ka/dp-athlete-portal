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

test('the priority order is explicit and unchanged', () => {
  assert.match(nav, /var NUDGE_PRIORITY=\['goalsBanner','checkinNudge','callNudge','photoNudge'\];/);
});

test('a done state is never part of the demand stack', () => {
  const start = nav.indexOf('var NUDGE_PRIORITY=');
  const end = nav.indexOf('function syncWeekCardState(');
  const pass = nav.slice(start, end);
  assert.ok(start >= 0 && end > start, 'the priority pass should remain discoverable');
  assert.doesNotMatch(pass, /getElementById\('callConfirmedNudge'\)/);
  assert.doesNotMatch(pass, /strava-ack-banner/);
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
