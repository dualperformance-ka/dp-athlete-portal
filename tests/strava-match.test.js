import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import {
  DEFAULT_RELATIVE_EFFORT_PER_KM_THRESHOLD,
  activityEffort,
  classifyPrescribedIntensity,
  matchActivityToSession,
  stravaActivityKey,
} from '../public/js/strava-match.js';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const loggingSource = readFileSync(join(root, 'public', 'js', '09-logging.js'), 'utf8');

function rejectionHelpers(){
  const start=loggingSource.indexOf('function removeLatestStravaRejection');
  const end=loggingSource.indexOf('function stravaMatchActivityKey',start);
  assert.ok(start>=0&&end>start,'Strava rejection helper should remain discoverable');
  const context={};vm.createContext(context);vm.runInContext(loggingSource.slice(start,end),context);return context;
}

const session = { id: 'long-run', date: '2026-08-04', plannedKm: 12 };
const run = (id, km, extra = {}) => ({
  id,
  sport_type: 'Run',
  start_date_local: '2026-08-04T07:00:00',
  distance: km * 1000,
  moving_time: 3600,
  ...extra,
});

test('exact distance match completes with high confidence', () => {
  const result = matchActivityToSession(session, [run(1, 12)]);
  assert.equal(result.matched, true);
  assert.equal(result.confidence, 'high');
  assert.equal(result.activity.id, 1);
});

test('15% over and 15% under both complete', () => {
  assert.equal(matchActivityToSession(session, [run(2, 13.8)]).matched, true);
  assert.equal(matchActivityToSession(session, [run(3, 10.2)]).matched, true);
});

test('a 12km prescription has no upper distance limit but keeps its lower bound', () => {
  assert.equal(matchActivityToSession(session, [run(17, 14.35)]).matched, true);
  assert.equal(matchActivityToSession(session, [run(18, 15)]).matched, true);
  assert.equal(matchActivityToSession(session, [run(19, 30)]).matched, true);
  assert.equal(matchActivityToSession(session, [run(20, 10.19)]).matched, false);
});

test('a 30km run completes a 10km prescription', () => {
  const result = matchActivityToSession({ ...session, plannedKm: 10 }, [run(21, 30)]);
  assert.equal(result.matched, true);
  assert.equal(result.confidence, 'high');
  assert.equal(result.activity.id, 21);
});

test('a 4km commute ride does not complete a 12km run session', () => {
  const result = matchActivityToSession(session, [run(4, 4, { sport_type: 'Ride' })]);
  assert.equal(result.matched, false);
});

test('a short commute run is outside the planned-distance tolerance', () => {
  assert.equal(matchActivityToSession(session, [run(5, 4)]).matched, false);
});

test('WeightTraining never matches a run session', () => {
  const result = matchActivityToSession(session, [run(6, 12, { sport_type: 'WeightTraining' })]);
  assert.equal(result.matched, false);
});

test('two runs on one day map to two sessions, not one twice', () => {
  const activities = [run(7, 5.1), run(8, 12.1)];
  const first = matchActivityToSession({ id: 'easy', date: session.date, plannedKm: 5 }, activities);
  const second = matchActivityToSession(session, activities, {
    claimedActivityIds: [stravaActivityKey(first.activity)],
  });
  assert.equal(first.activity.id, 7);
  assert.equal(second.activity.id, 8);
});

test('a session with no planned distance returns low confidence', () => {
  const result = matchActivityToSession({ id: 'open-run', date: session.date }, [run(9, 13.1)]);
  assert.equal(result.matched, true);
  assert.equal(result.confidence, 'low');
});

test('a rejected pairing is not re-suggested', () => {
  const result = matchActivityToSession(session, [run(10, 12)], {
    rejections: { 'long-run': ['10'] },
  });
  assert.equal(result.matched, false);
  assert.ok(result.reasons.includes('rejected'));
});

test('undo removes only the latest rejection for the selected session', () => {
  const original={ easy: ['activity-1','activity-2'], tempo: ['activity-3'] };
  const restored=rejectionHelpers().removeLatestStravaRejection(original,'easy');
  assert.deepEqual(JSON.parse(JSON.stringify(restored)),{ easy: ['activity-1'], tempo: ['activity-3'] });
  assert.deepEqual(original,{ easy: ['activity-1','activity-2'], tempo: ['activity-3'] });
});

test('undo clears the session rejection key after restoring its only activity', () => {
  const restored=rejectionHelpers().removeLatestStravaRejection({ easy: ['activity-1'] },'easy');
  assert.deepEqual(JSON.parse(JSON.stringify(restored)),{});
});

test('prescribed tempo run at 2.4 relative effort per km downgrades to low confidence', () => {
  const tempo = { ...session, name: 'Tempo — 4 × 1500m' };
  const activity = run(11, 12, { relative_effort: 12 * 2.4 });
  const result = matchActivityToSession(tempo, [activity]);
  assert.equal(DEFAULT_RELATIVE_EFFORT_PER_KM_THRESHOLD, 3.0);
  assert.equal(result.confidence, 'low');
  assert.deepEqual(result.reasons, ['intensity_below_prescription']);
});

test('prescribed tempo run at 5.4 relative effort per km stays high confidence', () => {
  const tempo = { ...session, name: 'Tempo — 4 x 1500m' };
  const result = matchActivityToSession(tempo, [run(12, 12, { relative_effort: 12 * 5.4 })]);
  assert.equal(result.confidence, 'high');
  assert.deepEqual(result.reasons, []);
});

test('prescribed easy run executed at 5.4 relative effort per km stays high and is flagged for coaches', () => {
  const easy = { ...session, name: 'Easy 12km' };
  const result = matchActivityToSession(easy, [run(13, 12, { relative_effort: 12 * 5.4 })]);
  assert.equal(result.confidence, 'high');
  assert.deepEqual(result.reasons, ['ran_above_prescription']);
});

test('missing relative effort leaves the previous result unchanged', () => {
  const tempo = { ...session, name: 'Threshold intervals' };
  const result = matchActivityToSession(tempo, [run(14, 12)]);
  assert.equal(result.confidence, 'high');
  assert.deepEqual(result.reasons, []);
});

test('zero relative effort is treated as absent rather than easy', () => {
  const tempo = { ...session, name: 'Hill repeats — 12 x 90s' };
  const result = matchActivityToSession(tempo, [run(15, 12, { relative_effort: 0 })]);
  assert.equal(result.confidence, 'high');
  assert.deepEqual(result.reasons, []);
});

// ── The field-name regression that made all of the above dead code ───────────
//
// REST v3 SummaryActivity carries `suffer_score`. `relative_effort` is the UI
// name and what Strava's MCP returns — it has never been on the REST payload.
// The matcher read only `relative_effort`, so against real /athlete/activities
// data every effort lookup was undefined, classifyExecutedIntensity always
// returned null, and neither intensity reason could ever fire. The tests above
// passed the whole time because their fixtures used the name the code read.
//
// These tests pin the REST name specifically, so the same class of break cannot
// pass silently again.

test('the REST field name (suffer_score) drives the intensity check', () => {
  const tempo = { ...session, name: 'Tempo — 4 × 1500m' };
  const result = matchActivityToSession(tempo, [run(21, 12, { suffer_score: 12 * 2.4 })]);
  assert.equal(result.confidence, 'low');
  assert.deepEqual(result.reasons, ['intensity_below_prescription']);
});

test('suffer_score above the threshold keeps a prescribed tempo at high confidence', () => {
  const tempo = { ...session, name: 'Tempo — 4 x 1500m' };
  const result = matchActivityToSession(tempo, [run(22, 12, { suffer_score: 12 * 5.4 })]);
  assert.equal(result.confidence, 'high');
  assert.deepEqual(result.reasons, []);
});

test('an easy prescription executed hard is flagged from suffer_score too', () => {
  const easy = { ...session, name: 'Easy 12km' };
  const result = matchActivityToSession(easy, [run(23, 12, { suffer_score: 12 * 5.4 })]);
  assert.deepEqual(result.reasons, ['ran_above_prescription']);
});

test('suffer_score wins when both field names are present', () => {
  const tempo = { ...session, name: 'Threshold intervals' };
  // REST name says easy, UI name says hard. The REST name is the real payload.
  const result = matchActivityToSession(tempo, [
    run(24, 12, { suffer_score: 12 * 2.4, relative_effort: 12 * 9 }),
  ]);
  assert.equal(result.confidence, 'low');
  assert.deepEqual(result.reasons, ['intensity_below_prescription']);
});

test('activityEffort reads either field and rejects unusable values', () => {
  assert.equal(activityEffort({ suffer_score: 84 }), 84);
  assert.equal(activityEffort({ relative_effort: 84 }), 84);
  assert.equal(activityEffort({ suffer_score: 12, relative_effort: 99 }), 12);
  // suffer_score is heart-rate derived, so null is normal for a strapless run.
  // It must read as "unknown", never as zero effort.
  assert.equal(activityEffort({ suffer_score: null }), null);
  assert.equal(activityEffort({ suffer_score: 0 }), null);
  assert.equal(activityEffort({}), null);
  assert.equal(activityEffort(null), null);
});

// A null suffer_score is the common case for athletes without a HR strap. If it
// were treated as 0 effort, every quality session they ran would be flagged as
// under-run — a false accusation, every single time.
test('a strapless athlete is never accused of under-running the session', () => {
  const tempo = { ...session, name: 'Tempo — 4 × 1500m' };
  const result = matchActivityToSession(tempo, [run(25, 12, { suffer_score: null })]);
  assert.equal(result.confidence, 'high');
  assert.deepEqual(result.reasons, []);
});

test('an unparseable session name is unknown and does not downgrade', () => {
  const unknown = { ...session, name: 'Wednesday Run' };
  assert.equal(classifyPrescribedIntensity(unknown), 'unknown');
  const result = matchActivityToSession(unknown, [run(16, 12, { relative_effort: 12 * 2.4 })]);
  assert.equal(result.confidence, 'high');
  assert.deepEqual(result.reasons, []);
});

// Strides are how an easy run finishes, not a quality session. The coach note
// "finish with 4-6 × 20s strides" reads as rep notation to the classifier, so
// every easy run carrying that note was prescribed 'quality', executed 'easy'
// and flagged as under-run — Karl's 10.3 km easy run scored 16 relative effort,
// 1.55/km against a 3.0 threshold, so the flag was certain rather than close.
test('strides in a coach note do not make an easy run a quality session', () => {
  const strideNotes = [
    'Easy aerobic. Finish with 4-6 × 20s strides.',
    '6 x 20s strides',
    'finish with 4 × 100m strides',
    '4 x 15s hill strides',
    'add strides at the end',
  ];
  for (const description of strideNotes) {
    assert.equal(
      classifyPrescribedIntensity({ name: 'Easy + Strides', type: 'Easy Run', resolvedDescription: description }),
      'easy',
      `"${description}" describes an easy run`
    );
  }
});

test('real quality work is still caught, including alongside strides', () => {
  const qualityNotes = [
    '5 x 1km @ threshold',
    '20min at tempo',
    '8 x 45s hill reps',
    'easy 8km then 5 x 1km @ threshold',
    // Strides stripped, reps survive: never drop the whole sentence.
    '4 x 20s strides then 5 x 1km reps',
  ];
  for (const description of qualityNotes) {
    assert.equal(
      classifyPrescribedIntensity({ name: 'Session', resolvedDescription: description }),
      'quality',
      `"${description}" is quality work`
    );
  }
});

test('an easy run with strides no longer trips the under-run flag', () => {
  const session = {
    id: 'S1',
    date: '2026-08-19',
    name: 'Easy + Strides',
    type: 'Easy Run',
    resolvedDescription: 'Easy aerobic. Finish with 4-6 × 20s strides.',
  };
  // The real activity: 10.301 km, relative effort 16 → 1.55 per km.
  const activity = run(10.301, 60, { relative_effort: 16 });
  activity.start_date_local = '2026-08-19T06:16:03';
  const result = matchActivityToSession(session, [activity], { plannedKm: 10 });
  assert.equal(result.matched, true);
  assert.ok(!result.reasons.includes('intensity_below_prescription'),
    'an easy run finished with strides is not an under-run quality session');
  assert.equal(result.confidence, 'high');
});

test('the under-run prompt does not name a session shape it cannot know', () => {
  const code = loggingSource.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  assert.ok(!/did you do the intervals/.test(code),
    'the flag fires for tempo and hill sessions too, which have no intervals');
});
