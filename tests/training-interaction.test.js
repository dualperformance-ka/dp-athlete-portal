import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const source = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');
const logging = readFileSync(join(root, 'public', 'js', '09-logging.js'), 'utf8');
const styles = readFileSync(join(root, 'public', 'styles.css'), 'utf8');

test('mobile week workouts are separate controls without invented AM or PM slots', () => {
  const renderStart = source.indexOf('function renderCal');
  const renderEnd = source.indexOf('// ── WEEKLY PLAN KM TARGET', renderStart);
  const renderSource = source.slice(renderStart, renderEnd);

  assert.match(renderSource, /<button type="button" class="mobile-week-session/);
  assert.match(renderSource, /onclick="openMobileWeekSession\(/);
  assert.match(renderSource, /data-session-index=/);
  assert.doesNotMatch(renderSource, /mobile-week-time|has-time|\?\s*'AM'\s*:\s*'PM'/);
});

test('completed mobile workouts get their own colour and tick', () => {
  assert.match(source, /getType\(s\)\+\(done\?' done':''\)/);
  assert.match(source, /class="mobile-week-complete"[\s\S]*#i-check/);
  assert.match(source, /function syncMobileWeekSessionCompletion\(i,done\)/);
  assert.match(styles, /\.mobile-week-session\.done\{background:[^}]+var\(--ok\)/);
  assert.match(styles, /\.mobile-week-session\.done \.mobile-week-complete\{display:grid\}/);
});

test('Strava synced workouts stay orange until RPE and niggle feedback is saved', () => {
  const helperStart=source.indexOf('function trainingSessionIsComplete');
  const helperEnd=source.indexOf('function buildCard',helperStart);
  const context={logs:{tempo:{distance:'14',__stravaMatch:{activity:{distance:14000}}}},logHasRealData:(value)=>Object.keys(value||{}).length>0};
  vm.createContext(context);
  vm.runInContext(source.slice(helperStart,helperEnd),context);

  assert.equal(context.trainingSessionNeedsFeedback({id:'tempo',status:'Completed'}),true);
  assert.equal(context.trainingSessionIsComplete({id:'tempo',status:'Completed'}),false);
  context.logs.tempo.rpe='8';
  context.logs.tempo.__stravaFeedbackAt='2026-08-25T00:00:00.000Z';
  assert.equal(context.trainingSessionNeedsFeedback({id:'tempo',status:'Completed'}),false);
  assert.equal(context.trainingSessionIsComplete({id:'tempo',status:'Completed'}),true);
  assert.match(source, /needsFeedback\?' pending-feedback'/);
  assert.match(source, /Finish RPE and niggle check-in/);
  assert.match(styles, /\.mobile-week-session\.pending-feedback\{background:[^}]+var\(--strava\)/);
  assert.match(styles, /\.mobile-week-session\.pending-feedback \.mobile-week-pending\{display:inline-flex\}/);
  assert.match(source, /Finish the RPE and niggle check-in to complete this session/);
  assert.match(logging, /entry\.__stravaFeedbackQueued=true/);
  assert.match(logging, /if\(result&&result\.queued\)[\s\S]*Retry feedback sync[\s\S]*return;/);
  assert.match(logging, /delete entry\.__stravaFeedbackQueued;entry\.__stravaFeedbackAt=/);
  assert.match(logging, /focusedSessionIndex===i[\s\S]*closeFocusedSession\(\)/);
  assert.match(styles, /\.strava-feedback \.savebtn\.is-sending/);
});

test('Home uses the Training tab completion state and marks completed sessions consistently', () => {
  const calendarStart = source.indexOf('function renderCal');
  const calendarEnd = source.indexOf('// ── WEEKLY PLAN KM TARGET', calendarStart);
  const homeStart = source.indexOf('function renderTodaySection');
  const homeEnd = source.indexOf('// Readiness is strictly', homeStart);
  const calendarSource = source.slice(calendarStart, calendarEnd);
  const homeSource = source.slice(homeStart, homeEnd);

  assert.match(source, /function trainingSessionIsComplete\(s\)/);
  assert.match(calendarSource, /var sessionDone=trainingSessionIsComplete/);
  assert.match(homeSource, /done=trainingSessionIsComplete\(s\)/);
  assert.match(homeSource, /todayitem'\+\(done\?' done':''\)/);
  assert.match(homeSource, /meta\.push\('Completed'\)/);
  assert.match(homeSource, /done\?'Completed <svg class="icon"><use href="#i-check"\/>/);
  assert.match(styles, /\.todayitem\.done\{border-color:var\(--ok-border\);background:var\(--ok-bg\)\}/);
  assert.match(styles, /\.today-action\.completed\{/);
});

test('Strava match controls stay inside the opened session, not the Home card', () => {
  const buildCardStart=source.indexOf('function buildCard');
  const buildCardEnd=source.indexOf('function resolveRunDisplay',buildCardStart);
  const homeStart=source.indexOf('function renderTodaySection');
  const homeEnd=source.indexOf('// Readiness is strictly',homeStart);
  const buildCardSource=source.slice(buildCardStart,buildCardEnd);
  const homeSource=source.slice(homeStart,homeEnd);
  assert.match(buildCardSource,/class="scb"[\s\S]*stravaMatchHtml\(s,i,'session'\)[\s\S]*buildBody\(s,i,type\)/);
  assert.doesNotMatch(homeSource,/stravaMatchHtml/);
  assert.doesNotMatch(homeSource,/strava-complete/);
});

test('mobile week calendar shows matched Strava distance without waiting for RPE', () => {
  const helperStart=source.indexOf('function calendarStravaDistanceKm');
  const helperEnd=source.indexOf('function calendarSessionIsKey',helperStart);
  assert.ok(helperStart>=0&&helperEnd>helperStart,'calendar Strava distance helpers should remain discoverable');

  const context={
    logs:{
      tempo:{
        distance:'14',
        rpe:'',
        __stravaMatch:{activity:{distance:14000}}
      }
    },
    _sessionOverrides:{},
    getType:()=> 'run',
    resolveRunDisplay:()=>({meta:{distance:'13km'}})
  };
  vm.createContext(context);
  vm.runInContext(source.slice(helperStart,helperEnd),context);

  assert.equal(context.calendarStravaDistanceKm({id:'tempo'}),14);
  assert.equal(context.monthSessionDetail({id:'tempo'}),'14km · Strava');
});

test('mobile week calendar keeps planned distance when there is no Strava match', () => {
  const helperStart=source.indexOf('function calendarStravaDistanceKm');
  const helperEnd=source.indexOf('function calendarSessionIsKey',helperStart);
  const context={
    logs:{},
    _sessionOverrides:{},
    getType:()=> 'run',
    resolveRunDisplay:()=>({meta:{distance:'13km'}})
  };
  vm.createContext(context);
  vm.runInContext(source.slice(helperStart,helperEnd),context);

  assert.equal(context.monthSessionDetail({id:'tempo'}),'13km');
});

test('mobile week calendar does not label a manual run log as Strava', () => {
  const helperStart=source.indexOf('function calendarStravaDistanceKm');
  const helperEnd=source.indexOf('function calendarSessionIsKey',helperStart);
  const context={
    logs:{tempo:{distance:'14',rpe:''}},
    _sessionOverrides:{},
    getType:()=> 'run',
    resolveRunDisplay:()=>({meta:{distance:'13km'}})
  };
  vm.createContext(context);
  vm.runInContext(source.slice(helperStart,helperEnd),context);

  assert.equal(context.monthSessionDetail({id:'tempo'}),'13km');
});

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

test('set auto-completion only waits for RPE while RPE logging is enabled', () => {
  let rpePreference = null;
  const fields = {
    'input[id^="w_"]': { value: '80' },
    'input[id^="r_"]': { value: '8' },
    'input[id^="rpe_"]': { value: '' }
  };
  const row = { querySelector: (selector) => fields[selector] || null };
  const button = { classList: classList() };
  const context = {
    console,
    Date,
    Math,
    Intl,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    document: {
      addEventListener: () => {},
      getElementById: (id) => id.startsWith('sr_') ? row : button,
      querySelector: () => null,
      querySelectorAll: () => []
    },
    window: {
      addEventListener: () => {},
      matchMedia: () => ({ matches: false })
    },
    localStorage: {
      getItem: (key) => key === 'dp_strength_rpe_enabled' ? rpePreference : null,
      setItem: (key, value) => { if (key === 'dp_strength_rpe_enabled') rpePreference = value; }
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  let completions = 0;
  context.togSet = () => { completions += 1; };

  context.autoCompleteStrengthSet(0, 0, 0);
  assert.equal(completions, 0, 'weight and reps alone must keep the set open');

  rpePreference = 'false';
  context.autoCompleteStrengthSet(0, 0, 0);
  assert.equal(completions, 1, 'weight and reps complete the set when RPE logging is off');

  rpePreference = null;
  fields['input[id^="rpe_"]'].value = '8';
  context.autoCompleteStrengthSet(0, 0, 0);
  assert.equal(completions, 2, 'the set completes after RPE is entered');
});

test('an already-ticked set collapses only after its final required column is filled', () => {
  const fields = {
    'input[id^="w_"]': { value: '80' },
    'input[id^="r_"]': { value: '8' },
    'input[id^="rpe_"]': { value: '8' }
  };
  const row = { querySelector: (selector) => fields[selector] || null };
  const card = {
    classList: classList(['exc', 'open']),
    querySelectorAll: () => [row],
    querySelector: () => null,
    getAttribute: () => ''
  };
  const button = {
    classList: classList(['on']),
    closest: () => card
  };
  row.querySelector = (selector) => selector === '.st' ? button : (fields[selector] || null);
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
      getElementById: (id) => id.startsWith('sr_') ? row : button,
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
  context.refreshStrengthExerciseState = () => {};

  fields['input[id^="rpe_"]'].value = '';
  context.autoCompleteStrengthSet(0, 0, 0);
  assert.equal(card.classList.contains('open'), true, 'missing RPE keeps the exercise open');

  fields['input[id^="rpe_"]'].value = '8';
  context.autoCompleteStrengthSet(0, 0, 0);
  assert.equal(card.classList.contains('open'), false, 'the final required value collapses the exercise');
});

test('submitted exercises cannot bypass enabled column requirements', () => {
  const refreshStart = source.indexOf('function refreshStrengthExerciseState');
  const refreshEnd = source.indexOf('function refreshStrengthExerciseStates', refreshStart);
  const refreshSource = source.slice(refreshStart, refreshEnd);
  assert.doesNotMatch(refreshSource, /strengthExerciseWasSubmitted|isSessionLogged/);
  assert.match(source, /renderedRows\.every\(function\(set,rowIndex\)[\s\S]*return !!set\.done&&strengthSavedSetHasRequiredInputs/);
});
