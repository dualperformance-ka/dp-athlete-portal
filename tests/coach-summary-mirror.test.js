import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// The coaches dashboard shows the same weekly review to coaches, built with a
// verbatim copy of the pure rules in api/_lib/performance-summary.js (everything
// above the "── DATABASE ──" divider) in dp-coaches-dashboard
// server/performance-summary-core.js. The dashboard pins the same hash.
//
// If this fails you changed a metric rule. That is fine: copy the whole block
// into the dashboard file, update SHARED_RULES_SHA256 in BOTH repos
// (here and dp-coaches-dashboard tests/coach-weekly-summary.test.js), and ship
// both. Otherwise the athlete card and the coach card silently disagree.
const SHARED_RULES_SHA256 = 'd7ac7726980e156b023b846fa6fba5ac8a08c6bce7120781a0adb4692f253ee1';

test('the weekly-summary rules shared with the coaches dashboard are unchanged', () => {
  const source = readFileSync(new URL('../api/_lib/performance-summary.js', import.meta.url), 'utf8');
  const start = source.indexOf('export const SUMMARY_VERSION');
  const end = source.indexOf('// ── DATABASE');
  assert.ok(start > 0 && end > start, 'rule block landmarks not found');
  const body = source.slice(start, end).trimEnd() + '\n';
  assert.equal(createHash('sha256').update(body).digest('hex'), SHARED_RULES_SHA256);
});
