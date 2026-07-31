import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const source = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');

function classList(initial = []) {
  const classes = new Set(initial);
  return {
    add: (...names) => names.forEach((name) => classes.add(name)),
    remove: (...names) => names.forEach((name) => classes.delete(name)),
    contains: (name) => classes.has(name),
    toggle(name, force) {
      const enabled = force === undefined ? !classes.has(name) : force;
      if (enabled) classes.add(name);
      else classes.delete(name);
      return enabled;
    }
  };
}

test('completing an exercise collapses it without opening the next exercise', () => {
  const nextCard = { classList: classList(['exc']) };
  const card = {
    classList: classList(['exc', 'open']),
    nextElementSibling: nextCard,
    getAttribute: () => 'Upper A'
  };
  const button = {
    classList: classList(),
    style: {},
    setAttribute: () => {},
    closest: () => card
  };
  const context = {
    console,
    Date,
    Math,
    Intl,
    setTimeout: (callback) => callback(),
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    document: {
      addEventListener: () => {},
      getElementById: (id) => id === 'st_0_0_0' ? button : null,
      querySelector: () => null,
      querySelectorAll: () => []
    },
    window: {
      addEventListener: () => {},
      matchMedia: () => ({ matches: false })
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {}
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.draftGym = () => {};
  context.refreshStrengthExerciseState = () => {};
  context.strengthExerciseIsComplete = () => true;
  context.startRest = () => {};

  context.togSet(0, 0, 0);

  assert.equal(card.classList.contains('open'), false);
  assert.equal(nextCard.classList.contains('open'), false);
});
