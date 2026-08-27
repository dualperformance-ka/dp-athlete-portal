import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const root = new URL('..', import.meta.url).pathname;
const parserSource = readFileSync(join(root, 'public', 'js', '08-training-interval-rest.js'), 'utf8');
const trainingSource = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');
const indexSource = readFileSync(join(root, 'public', 'index.html'), 'utf8');
const context = {};
vm.createContext(context);
vm.runInContext(parserSource, context);

test('the interval rest parser remains a global loaded before training', () => {
  assert.equal(typeof context.getIntervalRestInfo, 'function');
  assert.doesNotMatch(trainingSource, /function getIntervalRestInfo/);
  assert.ok(indexSource.indexOf('src="js/08-training-interval-rest.js') < indexSource.indexOf('src="js/08-training.js'));
});

test('coach rep rest still overrides the derived prescription', () => {
  const result = context.getIntervalRestInfo({
    name: '6×400m track intervals',
    repRest: '2 min jog'
  }, 'Track intervals');
  assert.equal(result.restTime, '2 min jog');
  assert.equal(result.restType, 'Coach-specified Rest');
});

test('continuous easy sessions still have no interval rest card', () => {
  assert.equal(context.getIntervalRestInfo({ type: 'easy', intensity: 'aerobic' }, 'Easy Run'), null);
});
