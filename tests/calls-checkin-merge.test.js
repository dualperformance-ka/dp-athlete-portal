import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const read = name => readFileSync(join(root, name), 'utf8');
const index = read('public/index.html');
const core = read('public/js/01-core.js');
const nav = read('public/js/03-nav-nudges.js');
const checkin = read('public/js/04-checkin.js');
const ingest = read('api/ingest.js');
const writeApi = read('api/write.js');
const migration = read('supabase/migrations/20260905040000_weekly_checkin_call_decision.sql');

// The Calls tab used to ask its own wins/niggles questions and sync them to a
// state key that never reached the database. Two surfaces asking the same
// question is the bug; a second surface that silently drops the answer is worse.
test('the Calls tab no longer collects its own prep answers', () => {
  for (const dead of ['CALLS_PREP_QUESTIONS', 'setCallsPrepAnswer', 'loadCallsPrep', 'callsPrepKey', 'callsPrepCount', 'callsPrepSaved']) {
    assert.ok(!nav.includes(dead), `${dead} should be gone from the Calls surface`);
  }
  assert.ok(!index.includes('callsPrep'), 'no prep inputs should remain in the shell');
});

test('nothing writes the retired calls_prep state key any more', () => {
  assert.ok(!/sbKey='calls_prep_'/.test(core), 'the localStorage mapping must be gone');
  assert.match(core, /row\.key\.startsWith\('calls_prep_'\)\) return;/,
    'a stale cloud row must be ignored rather than rehydrated into a dead local key');
});

// Deliberate: an older client still posts this key, and an unrecognised key is
// a 400, which lands in that device's outbox and retries forever.
test('the server still accepts calls_prep from clients on an older build', () => {
  assert.match(writeApi, /\/\^calls_prep_/, 'the pattern must stay allowed');
  assert.match(writeApi, /RETIRED 2026-09-05/, 'and be marked retired so it is removed deliberately');
});

test('the Calls tab routes to the check-in instead of duplicating it', () => {
  assert.match(nav, /function callsCheckinState\(\)/);
  assert.match(nav, /localStorage\.getItem\(checkinWeekKey\(\)\)/,
    'status must come from the same completion cache the nudge uses, not a second source of truth');
  assert.match(nav, /switchTab\(\\?'checkin\\?'\)/, 'the card must link through to the check-in');
  assert.match(nav, /return \{next:next,checkin:checkin,last:last\};/);
});

test('the one prep question worth keeping lives in the check-in now', () => {
  assert.match(index, /id="ciCallDecision"/, 'the field must exist in the shell');
  const stepFive = index.slice(index.indexOf('data-step="5"'));
  assert.ok(stepFive.indexOf('ciCallDecision') < stepFive.indexOf('ciTestimonial'),
    'it belongs in the final step, ahead of the reflection');
  assert.match(checkin, /'ciNotes','ciCallDecision','ciTestimonial'/,
    'it must be drafted like every other field, or a half-finished answer is lost');
  assert.match(checkin, /callDecision:document\.getElementById\('ciCallDecision'\)\.value/,
    'it must be submitted');
});

test('the answer has somewhere to land', () => {
  assert.match(ingest, /call_decision: text\(payload\.callDecision, 2000\)/,
    'ingest must map it onto the column');
  assert.match(migration, /add column if not exists call_decision text/);
  // upcoming_impact asks what is coming up that will affect training. Reusing it
  // would silently corrupt a field the coaches already read.
  assert.ok(!/upcomingImpact:document\.getElementById\('ciCallDecision'\)/.test(checkin),
    'the decision must not be folded into upcoming_impact');
  assert.match(ingest, /upcoming_impact: text\(payload\.upcomingImpact, 2000\)/,
    'upcoming_impact must keep its own meaning');
});

test('the km the portal already knows is prefilled, not asked for again', () => {
  assert.match(checkin, /setIfEmpty\('ciRunKm',Math\.round\(Number\(currentWeekKmData\.completed\)\*10\)\/10\)/);
  assert.match(checkin, /var setIfEmpty=function\(id,v\)\{var el=document\.getElementById\(id\);if\(el&&el\.value===''\)el\.value=v;\}/,
    'prefill must never overwrite something the athlete typed');
});

test('the check-in still collects every field the coaches read', () => {
  for (const field of ['runCompleted', 'runPlanned', 'runKm', 'runFeel', 'runWins', 'runNiggles',
    'liftCompleted', 'liftPlanned', 'liftFeel', 'liftWins', 'liftNiggles', 'sleep', 'energy',
    'soreness', 'nutrition', 'fuelling', 'socialEating', 'stress', 'motivation',
    'upcomingImpact', 'testimonial', 'callDecision']) {
    assert.match(checkin, new RegExp(`${field}:`), `${field} must still be submitted`);
  }
});
