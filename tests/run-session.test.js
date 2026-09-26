import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const runSource = readFileSync(join(root, 'public', 'js', '08-training-run.js'), 'utf8');
const trainingSource = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');
const loggingSource = readFileSync(join(root, 'public', 'js', '09-logging.js'), 'utf8');
const indexSource = readFileSync(join(root, 'public', 'index.html'), 'utf8');
const context = { window: {} };
vm.createContext(context);
vm.runInContext(runSource, context);

test('the run screen helpers load before training, and training uses them', () => {
  assert.ok(indexSource.indexOf('src="js/08-training-run.js') > 0);
  assert.ok(indexSource.indexOf('src="js/08-training-run.js') < indexSource.indexOf('src="js/08-training.js'));
  assert.match(trainingSource, /runPagerHtml\(i,pages\)/);
  // The main-set line is built in one place, never by gluing "/km" on.
  assert.doesNotMatch(trainingSource, /working_pace\+'\/km'/);
});

// Real coach entries from planned_sessions (Sep 2026).
test('the main set never repeats the pace and only a bare pace gets /km', () => {
  const m = context.runMainSetText;
  assert.equal(m('4 x 3 min @ 5:00-5:15/km', '5:00-5:15/km'), '4 x 3 min @ 5:00-5:15/km');
  assert.equal(m('5 x 4 min', '5:00-5:15'), '5 x 4 min @ 5:00-5:15/km');
  assert.equal(m('3x1km', '4:35-4:45/km'), '3x1km @ 4:35-4:45/km');
  assert.equal(m('12km', '5:10'), '12km @ 5:10/km');
  assert.equal(m('6 × 300m', '3:50-4:00'), '6 × 300m @ 3:50-4:00/km');
  assert.equal(m('4x400m + 4x100m', '400m in 92-94s'), '4x400m + 4x100m @ 400m in 92-94s');
  assert.equal(m('1 x 20 min continuous', 'RPE 3'), '1 x 20 min continuous · RPE 3');
  assert.equal(m('After 5 km: 4 x 20 sec strides.', 'Easy running; relaxed strides.'), 'After 5 km: 4 x 20 sec strides. · Easy running; relaxed strides.');
  assert.equal(m('After 2 km: 5 × 3 min @ VO2 pace.', 'About 5:00/km (RPE 8–9).'), 'After 2 km: 5 × 3 min @ VO2 pace. @ About 5:00/km (RPE 8–9).');
  assert.equal(m(null, '4:30-4:45'), '4:30-4:45/km');
  assert.equal(m('8 km continuous easy', ''), '8 km continuous easy');
  assert.equal(m('6x400m', '3:58–4:10 /km'), '6x400m @ 3:58–4:10 /km');
});

test('Strava numbers become display values, and missing ones stay missing', () => {
  const st = context.runStravaStats({
    id: 42, distance: 12110, moving_time: 2876, average_heartrate: 176.4, max_heartrate: 194,
    average_cadence: 84, total_elevation_gain: 18.2,
    splits_metric: [{ split: 1, distance: 1000, moving_time: 242 }, { split: 2, distance: 1000.4, moving_time: 241 }, { split: 13, distance: 110, moving_time: 25 }],
    map: { summary_polyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' },
  });
  assert.equal(st.distanceLabel, '12.1 km');
  assert.equal(st.timeLabel, '47:56');
  assert.equal(st.paceLabel, '3:57');
  assert.equal(st.avgHr, 176);
  assert.equal(st.cadence, 168);
  assert.equal(st.elevation, 18);
  assert.equal(st.splits.length, 3);
  assert.equal(context.runPace(st.splits[0].secPerKm), '4:02');
  const bare = context.runStravaStats({ distance: 7000, moving_time: 2102 });
  assert.equal(bare.avgHr, null);
  assert.equal(bare.cadence, null);
  assert.equal(bare.splits.length, 0);
  assert.equal(context.runClock(3725), '1:02:05');
});

test('the route polyline decodes and fits the box', () => {
  const pts = context.decodeRunPolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.deepEqual(JSON.parse(JSON.stringify(pts)), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
  const path = context.runRoutePath(pts, 320, 120, 12);
  assert.match(path, /^M[\d.]+ [\d.]+L/);
  path.match(/[\d.]+ [\d.]+/g).forEach((pair) => {
    const [x, y] = pair.split(' ').map(Number);
    assert.ok(x >= 0 && x <= 320 && y >= 0 && y <= 120, pair);
  });
  assert.equal(context.decodeRunPolyline('~').length, 0);
  assert.equal(context.runRoutePath([], 320, 120), '');
});

test('the check-in keeps the ids saveStravaFeedback reads', () => {
  context.logs = { r1: { rpe: '8', pain: 'no' } };
  const html = context.runCheckinHtml({ id: 'r1' }, 3);
  ['srpe_3', 'spain_3', 'snotes_3', 'sfb_3', 'srpeg_3', 'spaing_3'].forEach((id) => assert.match(html, new RegExp(`id="${id}"`)));
  assert.match(html, /data-rpe="8"[^>]*|aria-pressed="true" data-rpe="8"/);
  assert.match(html, /class="run-chip is-on" aria-pressed="true" data-rpe="8"/);
  assert.match(html, /class="run-pain is-on" aria-pressed="true" data-pain="no"/);
  assert.equal(context.runCheckinSummary('8', 'no'), 'RPE 8 · Hard · No pain');
  // The old number box and select are gone.
  assert.doesNotMatch(loggingSource, /function stravaFeedbackFormHtml/);
});

test('a missing answer is flagged on its chip group', () => {
  assert.match(loggingSource, /_stravaFeedbackFlag\('srpeg_'\+i\)/);
  assert.match(loggingSource, /_stravaFeedbackFlag\('spaing_'\+i\)/);
});

test('the footer tells the truth about a run', () => {
  context.window._stravaConnectedNow = true;
  context.isSessionLogged = () => true;
  const els = { srpe_0: { value: '' }, spain_0: { value: '' } };
  context.document = { getElementById: (id) => els[id] || null };
  context.logs = { a: { __stravaMatch: { activity: {} } } };
  let state = context.runFocusState({ id: 'a' }, 0);
  assert.equal(state.title, 'Run received from Strava');
  assert.equal(state.detail, '2 answers left');
  assert.equal(state.action, 'Send to coaches');
  assert.equal(state.submit, true);
  els.srpe_0.value = '7';
  assert.equal(context.runFocusState({ id: 'a' }, 0).detail, '1 answer left');
  els.spain_0.value = 'no';
  assert.equal(context.runFocusState({ id: 'a' }, 0).detail, 'Ready to send');
  context.logs.a.__stravaFeedbackAt = '2026-09-26T00:00:00Z';
  assert.equal(context.runFocusState({ id: 'a' }, 0).title, 'Sent to your coaches');
  context.isSessionLogged = () => false;
  context.logs = {};
  state = context.runFocusState({ id: 'b' }, 0);
  assert.equal(state.title, 'Not run yet');
  assert.equal(state.submit, false);
});

test('a race attempt is labelled a race even without the word', () => {
  assert.match(trainingSource, /attempt\\b\|time trial\|parkrun/);
});
