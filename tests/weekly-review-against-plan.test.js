import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// The weekly review states how the week's work sat against its plan. Doing
// more than programmed is recognised as a fact, not flagged and not cheered.
const source = readFileSync(new URL('../public/js/07-progress.js', import.meta.url), 'utf8');
function slice(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `could not find ${from}`);
  return source.slice(start, end);
}
const context = vm.createContext({});
vm.runInContext(
  slice('var WR_ACTIVITY_NOUNS=', 'function wrDistanceText(')
  + slice('function wrActivityCount(', 'function wrEnduranceSection('),
  context,
);
const against = (e, sport, planned) => context.wrAgainstPlanText(e, sport, planned);
const run = (over) => ({ plannedDistanceKm: 23.2, plannedDistanceMetres: 23200, plannedDistanceSource: 'coach', sessionTarget: 3, actualSessions: 5, actualDistanceKm: 42.1, actualDistanceMetres: 42100, actualSource: 'strava', ...over });

test('more than the target is stated plainly, with the extra sessions', () => {
  assert.equal(against(run(), 'running', 3), '18.9 km beyond the target · 2 more runs than planned');
  assert.equal(against(run({ actualSessions: 4 }), 'running', 3), '18.9 km beyond the target · 1 more run than planned');
});

test('under and on target read just as neutrally', () => {
  assert.equal(against(run({ actualDistanceMetres: 19100, actualSessions: 3 }), 'running', 3), '4.1 km under the target');
  assert.equal(against(run({ actualDistanceMetres: 23230, actualSessions: 3 }), 'running', 3), 'On the target', 'inside the 50 m tolerance the Week tab uses');
});

test('a session-sum plan is "the plan", and the planned session count stands in for a target count', () => {
  const e = run({ plannedDistanceSource: 'typed', plannedDistanceMetres: 19500, plannedDistanceKm: 19.5, sessionTarget: null });
  assert.equal(against(e, 'running', 3), '22.6 km beyond the plan · 2 more runs than planned');
});

test('swimming stays in metres, and nothing is said without a plan or without data', () => {
  const swim = { plannedDistanceKm: 4.05, plannedDistanceMetres: 4050, plannedDistanceSource: 'coach', sessionTarget: 3, actualSessions: 3, actualDistanceMetres: 5175, actualSource: 'strava' };
  assert.equal(against(swim, 'swimming', 3), '1125 m beyond the target');
  assert.equal(against({ ...swim, plannedDistanceKm: null, plannedDistanceMetres: null }, 'swimming', 3), '');
  assert.equal(against({ ...swim, actualSource: 'unavailable' }, 'swimming', 3), '');
});

test('the copy never scolds or hypes', () => {
  const block = slice('function wrAgainstPlanText(', 'function wrEnduranceSection(');
  const copy = (block.match(/'[^']*'/g) || []).join(' ');
  assert.match(copy, /beyond /, 'the strings were found');
  assert.doesNotMatch(copy, /!|too much|overdid|careful|warning|great|crushed|smashed/i);
});
