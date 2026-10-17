import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The athlete-facing side of progressive overload: the Today's plan card, the
// collapsed "done" line, and the next-session prescription after an exercise.
// Every number on these surfaces must be the engine's own, and the copy must
// answer four questions: what weight, how many reps per working set, how hard,
// and what has to happen before the load changes.
const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const engineSource = readFileSync(join(root, 'public', 'js', '08-strength-engine.js'), 'utf8');
const trainingSource = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');

function makeContext() {
  const context = {
    console, Date, Math, Intl,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    esc: (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]),
    document: {
      documentElement: { classList: { toggle: () => {} } },
      addEventListener: () => {}, getElementById: () => null,
      querySelector: () => null, querySelectorAll: () => [],
    },
    window: { addEventListener: () => {}, matchMedia: () => ({ matches: false }) },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  vm.createContext(context);
  vm.runInContext(engineSource, context);
  vm.runInContext(trainingSource, context);
  return context;
}
// What a sighted athlete reads: tags stripped, screen-reader-only text removed.
const visible = (html) => html.replace(/<span class="exl-sr">[^<]*<\/span>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const row = { exercise: 'Low Machine Row', sets: '4', reps: '8', repRange: '8-12', warmupSets: '2', workingSets: '2' };
const rowPrevious = [
  { weight: '13.6', reps: '12', done: true }, { weight: '33.6', reps: '9', done: true },
  { weight: '38.6', reps: '9', done: true, effort: 'on_target' }, { weight: '38.6', reps: '9', done: true },
];

function plan(context, ex, previous, { history = [], current = [], nowRow = 0, live = null, rec: given = null } = {}) {
  const rec = given || context._nsRecommendation(ex, previous, ex.exercise, history);
  const ctx = { ex, rec, pres: rec.prescription, live, current, warm: parseInt(ex.warmupSets, 10) || 0, nowRow };
  return { rec, html: context._exlTargetHtml(ctx) };
}

test('the plan card shows the exact target for every working set, not only the range', () => {
  const context = makeContext();
  const { rec, html } = plan(context, row, rowPrevious);
  assert.deepEqual(Array.from(rec.target), [10, 9], 'the engine target this card must show');
  const text = visible(html);
  assert.match(text, /^Today’s plan Now: warm-up 1 of 2 38\.6 kg Work 1 10 reps Work 2 9 reps/);
  // The range is still there, as a guardrail after the targets.
  assert.match(text, /Range 8–12 · Stop with about 2 clean reps left Build reps Reach/);
  // RIR/RPE stay available as the secondary terms, in the Why sheet.
  assert.doesNotMatch(text, /RIR|RPE/);
  assert.match(context._nsBody(context._nsRecommendation(row, rowPrevious, row.exercise, [])), /about 2 clean reps left \(RIR 2 · RPE 8\)/);
  assert.ok(text.indexOf('Work 2 9 reps') < text.indexOf('Range 8–12'), 'targets come before the range');
  assert.doesNotMatch(html, /exl-big">8–12</, 'the range is no longer the headline number');
  // The condition that moves the load.
  assert.match(text, /Reach 12 \/ 12 at this effort to unlock the next weight\./);
  // Exactly one chip per programmed working set: the two warm-ups are not targets.
  assert.equal(html.match(/class="exl-set[ "]/g).length, 2);
});

test('the chips are the engine’s array, so a different recommendation changes them', () => {
  const context = makeContext();
  const { rec, html } = plan(context, row, rowPrevious);
  const forged = { ...rec, target: [11, 7] };
  const other = context._exlTargetHtml({ ex: row, rec: forged, pres: rec.prescription, current: [], warm: 2, nowRow: 2 });
  assert.match(visible(html), /Work 1 10 reps Work 2 9 reps/);
  assert.match(visible(other), /Work 1 11 reps Work 2 7 reps/);
});

test('the current set is marked in words and done working sets show what they got', () => {
  const context = makeContext();
  const current = [
    { _rowIndex: 0, weight: '13.6', reps: '12', done: true },
    { _rowIndex: 1, weight: '33.6', reps: '9', done: true },
    { _rowIndex: 2, weight: '38.6', reps: '11', done: true, effort: 'on_target' },
  ];
  const { html } = plan(context, row, rowPrevious, { current, nowRow: 3 });
  assert.match(visible(html), /Now: Work 2 38\.6 kg Work 1 ✓ 11 reps Work 2 9 reps/);
  assert.match(html, /<li class="exl-set is-now">.*?Work 2.*?<span class="exl-sr">, current set<\/span>/);
  assert.match(html, /<span class="exl-sr">, done, target 10<\/span>/);
  // Screen readers get the group and every target without needing colour.
  assert.match(html, /role="group" aria-label="Today’s plan"/);
  assert.match(html, /<ol class="exl-sets" aria-label="Reps on each working set">/);
  assert.match(html, /role="img" aria-label="Progress step 1 of 3: Build reps"/);
});

test('the progression indicator has three behaviour-led steps and never promises an increase', () => {
  const context = makeContext();
  const stage = (current, next) => {
    const rec = context._nsRecommendation(row, rowPrevious, row.exercise, []);
    return context._exlStage({ ex: row, rec, pres: rec.prescription, current, next, live: null });
  };
  assert.equal(stage([]), 1, 'Build reps');
  assert.equal(stage([{ _rowIndex: 2, weight: '38.6', reps: '12' }]), 2, 'Confirm all working sets');
  const topped = [{ _rowIndex: 2, weight: '38.6', reps: '12' }, { _rowIndex: 3, weight: '38.6', reps: '12' }];
  assert.equal(stage(topped, { decision: 'increase_load' }), 3, 'Increase earned, once the engine says so');
  // Same reps, but the engine holds (hard effort / pain): the step stays at 2.
  assert.equal(stage(topped, { decision: 'hold_load' }), 2);
  assert.equal(stage(topped, { decision: 'technique_check' }), 2);
  assert.doesNotMatch(trainingSource, /'Increase next'|'One more set'|'Load unlocked'/);
});

test('a live load change immediately shows the new load and the reset rep target', () => {
  const context = makeContext();
  const hip = { exercise: 'Hip Abduction', sets: '4', workingSets: '4', reps: '15', repRange: '15-20', targetRir: 2 };
  const previous = [
    { weight: '63', reps: '19', done: true }, { weight: '63', reps: '15', done: true },
    { weight: '63', reps: '15', done: true }, { weight: '63', reps: '15', done: true },
  ];
  const current = [{ _rowIndex: 0, weight: '63', reps: '19', done: true }, { _rowIndex: 1, weight: '68', reps: '', done: false }];
  const baseline = context._nsRecommendation(hip, previous, hip.exercise, []);
  const before = visible(context._exlTargetHtml({ ex: hip, rec: baseline, pres: baseline.prescription, current: [], warm: 0, nowRow: 0 }));
  assert.match(before, /63 kg/);
  const live = context._nsLiveProgress(hip, current, baseline, hip.exercise, [], previous);
  const shown = context._nsApplyLiveLoadRecommendation(baseline, live);
  const after = visible(context._exlTargetHtml({ ex: hip, rec: shown, pres: shown.prescription, current, live, warm: 0, nowRow: 1 }));
  assert.match(after, /^Today’s plan · load changed Now: Work 2 68 kg Work 1 ✓ 19 reps Work 2 15 reps Work 3 15 reps Work 4 15 reps/);
  assert.match(after, /Load Increased Aim for 15 clean reps/);
  assert.match(after, /Stop with about 2 clean reps left/);
});

test('no reliable load means calibration instructions, never an invented weight', () => {
  const context = makeContext();
  const press = { exercise: 'Incline Dumbbell Press', sets: '3', workingSets: '3', reps: '8', repRange: '8-12' };
  const { rec, html } = plan(context, press, []);
  assert.equal(rec.decision, 'calibrate');
  assert.match(visible(html), /Pick your load Range 8–12 .* Pick a setting you control for 8 clean reps/);
  assert.doesNotMatch(html, /exl-big">\d/, 'no number is shown as a load');
  assert.doesNotMatch(html, /class="exl-sets"/, 'no targets invented outside the engine');
});

test('an unknown equipment step says "next available weight" instead of a number', () => {
  const context = makeContext();
  const band = { exercise: 'Band Pull Apart', sets: '3', workingSets: '3', reps: '8', repRange: '8-12' };
  const { rec, html } = plan(context, band, [
    { weight: '10', reps: '12', effort: 'too_easy' }, { weight: '10', reps: '12' }, { weight: '10', reps: '12' },
  ]);
  assert.equal(rec.weightKg, null);
  assert.match(visible(html), /Next available weight Work 1 8 reps/);
  // The final-set prompt never names an estimated step as a number either.
  const press = { exercise: 'Incline Dumbbell Press', sets: '2', workingSets: '2', reps: '8', repRange: '8-12' };
  const live = context._nsLiveProgress(press, [{ weight: '30', reps: '12' }], {}, press.exercise, [], null);
  assert.equal(live.prompt, 'Final working set: stay at 30kg and aim for 12. Hit it at this effort to unlock the next available weight next session.');
});

test('assisted, unilateral, exact-rep, bodyweight, ramped and timed prescriptions keep their meaning', () => {
  const context = makeContext();
  const assisted = { exercise: 'Assisted Pull-up', sets: '3', workingSets: '3', repRange: '6-10' };
  const a = visible(plan(context, assisted, [{ weight: '30', reps: '8' }, { weight: '30', reps: '7' }, { weight: '30', reps: '7' }]).html);
  assert.match(a, /30 kg assist Work 1 9 reps Work 2 7 reps Work 3 7 reps/);
  assert.match(a, /to unlock less assistance\./, 'the assisted direction is reversed in words');

  const uni = { exercise: 'Bulgarian Split Squat', sets: '2', workingSets: '2', repRange: '8-12' };
  const u = plan(context, uni, [{ weight: '20', repsLeft: '10', repsRight: '9' }, { weight: '20', repsLeft: '9', repsRight: '9' }]);
  assert.deepEqual(Array.from(u.rec.target), [10, 9], 'the weaker side sets the next target');
  assert.match(visible(u.html), /20 kg Work 1 10 reps Work 2 9 reps/);

  const exact = { exercise: 'Back Squat', sets: '3', workingSets: '3', reps: '5' };
  const e = visible(plan(context, exact, [{ weight: '100', reps: '5' }, { weight: '100', reps: '5' }, { weight: '100', reps: '4' }]).html);
  assert.match(e, /Work 1 5 reps Work 2 5 reps Work 3 5 reps Exactly 5 reps/);
  assert.match(e, /Hit 5 on every working set cleanly and the load moves\./);
  assert.doesNotMatch(e, /Range|Reach/);

  const bw = { exercise: 'Push-up', sets: '3', workingSets: '3', repRange: '10-15' };
  const b = visible(plan(context, bw, [{ weight: '0', reps: '12' }, { weight: '0', reps: '11' }, { weight: '0', reps: '10' }]).html);
  assert.match(b, /Bodyweight Work 1 13 reps/);
  assert.match(b, /to unlock more reps\./);
  assert.doesNotMatch(b, /0 kg/);

  const ramp = { exercise: 'Barbell Bench Press', sets: '3', workingSets: '3', repRange: '6-10' };
  const r = plan(context, ramp, [{ weight: '60', reps: '8' }, { weight: '70', reps: '6' }, { weight: '60', reps: '9' }]);
  assert.equal(r.rec.ramped, true);
  assert.match(visible(r.html), /Top set 70 kg .* Back-off sets 60kg/, 'a top-set plan is not flattened to one load');

  const plank = { exercise: 'Plank', sets: '2', workingSets: '2', reps: '30', repMode: 'seconds' };
  const p = visible(plan(context, plank, [{ weight: '0', reps: '30' }]).html);
  assert.match(p, /Hold 30s · Work at the effort your coach wrote/);
  assert.doesNotMatch(p, /clean reps left|Reach/);
});

// ── The collapsed "done" line ───────────────────────────────────────────────

test('the collapsed summary shows working sets only — warm-ups never appear', () => {
  const context = makeContext();
  const today = [
    { _rowIndex: 0, weight: '13.6', reps: '10', done: true },
    { _rowIndex: 1, weight: '33.6', reps: '8', done: true },
    { _rowIndex: 2, weight: '38.6', reps: '12', done: true, effort: 'on_target' },
    { _rowIndex: 3, weight: '38.6', reps: '11', done: true },
  ];
  assert.equal(context.strengthWorkingSummaryText(row, today, false), '38.6kg × 12 · 11');
  // Legacy logs with no row index still use the programmed window.
  const legacy = today.map(({ _rowIndex, ...set }) => set);
  assert.equal(context.strengthWorkingSummaryText(row, legacy, false), '38.6kg × 12 · 11');
  // The DOM refresh goes through the same window, not every visible row.
  const refresh = trainingSource.slice(trainingSource.indexOf('function refreshStrengthExerciseState('), trainingSource.indexOf('function refreshStrengthExerciseStates('));
  assert.match(refresh, /strengthCardWorkingSummary\(card,assisted\)/);
  assert.doesNotMatch(refresh, /parts\.push/);
});

test('bonus sets never change the collapsed summary', () => {
  const context = makeContext();
  const dips = { exercise: 'Machine Dips', sets: '2', workingSets: '2', reps: '8', repRange: '8-12' };
  const today = [
    { _rowIndex: 0, weight: '82.8', reps: '10', done: true, effort: 'on_target' },
    { _rowIndex: 1, weight: '82.8', reps: '9', done: true },
  ];
  const withBonus = today.concat([{ _rowIndex: 2, weight: '100', reps: '3', done: true }]);
  assert.equal(context.strengthWorkingSummaryText(dips, today, false), '82.8kg × 10 · 9');
  assert.equal(context.strengthWorkingSummaryText(dips, withBonus, false), '82.8kg × 10 · 9');
});

test('the summary keeps assisted direction and uses the weaker side for unilateral work', () => {
  const context = makeContext();
  const assisted = { exercise: 'Assisted Pull-up', sets: '3', workingSets: '3', repRange: '6-10' };
  assert.equal(context.strengthWorkingSummaryText(assisted, [
    { weight: '30', reps: '8' }, { weight: '30', reps: '7' }, { weight: '30', reps: '7' },
  ], true), '30kg assist × 8 · 7 · 7');
  // Changed loads keep their own number each, so less assistance reads right.
  assert.equal(context.strengthWorkingSummaryText(assisted, [
    { weight: '30', reps: '8' }, { weight: '25', reps: '7' }, { weight: '25', reps: '7' },
  ], true), '30kg assist × 8 · 25kg assist × 7 · 25kg assist × 7');
  const uni = { exercise: 'Bulgarian Split Squat', sets: '2', workingSets: '2', repRange: '8-12' };
  assert.equal(context.strengthWorkingSummaryText(uni, [
    { weight: '20', repsLeft: '10', repsRight: '9' }, { weight: '20', repsLeft: '12', repsRight: '11' },
  ], false), '20kg × 9 · 11');
});

test('the summary is display only: the saved sets are not changed', () => {
  const context = makeContext();
  const today = [
    { _rowIndex: 0, weight: '13.6', reps: '10', done: true },
    { _rowIndex: 2, weight: '38.6', reps: '12', done: true },
    { _rowIndex: 3, weight: '38.6', reps: '11', done: true },
  ];
  const before = JSON.stringify(today);
  context.strengthWorkingSummaryText(row, today, false);
  assert.equal(JSON.stringify(today), before);
});

// ── After the exercise: the exact next-session prescription ─────────────────

test('the finished result shows the next load, every working-set target, effort and the unlock', () => {
  const context = makeContext();
  const today = [
    { _rowIndex: 0, weight: '13.6', reps: '12', done: true },
    { _rowIndex: 1, weight: '33.6', reps: '9', done: true },
    { _rowIndex: 2, weight: '38.6', reps: '12', done: true, effort: 'on_target' },
    { _rowIndex: 3, weight: '38.6', reps: '11', done: true },
  ];
  const next = context._nsRecommendation(row, today, row.exercise, [{ sets: rowPrevious }]);
  assert.equal(next.decision, 'add_reps');
  assert.deepEqual(Array.from(next.target), [12, 12]);
  const rec = context._nsRecommendation(row, rowPrevious, row.exercise, []);
  const html = context._exlResultHtml({ ex: row, rec, pres: rec.prescription, current: today, prevEffort: rowPrevious, complete: true, next, warm: 2 });
  const text = visible(html);
  assert.match(text, /Working sets done Work 1 38\.6 × 12 Work 2 38\.6 × 11 23 working-set reps · beat last session by 5/);
  assert.match(text, /Next session · Stay at this weight Stay at 38\.6kg Work 1 12 reps Work 2 12 reps Stop with about 2 clean reps left/);
  assert.match(text, /One more clean rep on Work 2 at this effort unlocks the next weight\./);
  assert.match(html, /aria-label="Next session: Stay at this weight\. Stay at 38\.6kg\. Working set 1: 12 reps, Working set 2: 12 reps\."/);
});

test('next-session outcomes are told apart in words: increase, hold, reduce, consolidate, coach, safety', () => {
  const context = makeContext();
  const pres = context.strengthPrescriptionFor({ exercise: 'Leg Press', sets: '3', workingSets: '3', repRange: '8-12' }, 'Leg Press');
  const kind = (next) => context.strengthNextPlan(next, pres, [12, 12, 12]);
  assert.equal(kind({ decision: 'increase_load', target: [8, 8, 8] }).label, 'Increase earned');
  assert.match(kind({ decision: 'increase_load', target: [8, 8, 8] }).condition, /reps reset to 8\. Build back to 12 on every working set/);
  assert.equal(kind({ decision: 'add_reps', target: [12, 12, 11] }).label, 'Stay at this weight');
  const down = kind({ decision: 'reduce_load', target: [8, 8, 8] });
  assert.equal(down.label, 'Lighter start next time');
  assert.match(down.condition, /keeps every rep clean/);
  assert.doesNotMatch(down.label + down.condition, /fail|lost|regress|worse/i, 'a sensible reduction is never framed as failure');
  assert.equal(kind({ decision: 'coach_review', coachReview: true }).label, 'Your coach sets the next step');
  const safety = kind({ decision: 'technique_check', painFlag: true, target: [8, 8, 8] });
  assert.equal(safety.kind, 'safety');
  assert.match(safety.label, /Form or pain/);
  assert.match(safety.condition, /tell your coach/);
  assert.equal(kind({ decision: 'load_confirmed', target: [9, 9, 9] }).label, 'New baseline confirmed');
});

test('consolidation still says the athlete is locking in a load already reached', () => {
  const context = makeContext();
  const leg = { exercise: 'Leg Press', sets: '3', workingSets: '3', reps: '8', repRange: '8-12' };
  const history = [{ date: '2026-09-01', sets: [{ weight: '60', reps: '12' }, { weight: '60', reps: '12' }, { weight: '60', reps: '11' }] }];
  const today = [{ weight: '65', reps: '9', done: true }, { weight: '65', reps: '6', done: true }, { weight: '65', reps: '5', done: true }];
  const next = context._nsRecommendation(leg, today, 'Leg Press', history);
  assert.equal(next.decision, 'change_unconfirmed');
  const nextPlan = context.strengthNextPlan(next, next.prescription, [9, 6, 5]);
  assert.equal(nextPlan.label, 'Locking in 65kg');
  assert.match(nextPlan.condition, /already moved 65kg/);
  const html = context._exlResultHtml({ ex: leg, rec: next, pres: next.prescription, current: today, prevEffort: history[0].sets, complete: true, next });
  assert.match(visible(html), /Next session · Locking in 65kg Repeat 60kg to lock in 65kg Work 1 8 reps/);
  // And on the plan card the next time it opens.
  const card = visible(context._exlTargetHtml({ ex: leg, rec: next, pres: next.prescription, current: [], nowRow: 0 }));
  assert.match(card, /60 kg .* Repeat 60kg to lock in 65kg\. 8 clean reps on every working set locks it in\./);
});

test('historical logs with legacy effort codes still render and still progress', () => {
  const context = makeContext();
  const press = { exercise: 'Incline Dumbbell Press', sets: '3', workingSets: '3', reps: '8', repRange: '8-12' };
  // reserve (too easy) still earns the increase; failure (at limit) still holds.
  const easy = plan(context, press, [{ weight: '30', reps: '12', effort: 'reserve' }, { weight: '30', reps: '12' }, { weight: '30', reps: '12' }]);
  assert.equal(easy.rec.decision, 'increase_load');
  const hard = plan(context, press, [{ weight: '30', reps: '10', effort: 'failure' }, { weight: '30', reps: '10' }, { weight: '30', reps: '9' }]);
  assert.equal(hard.rec.decision, 'hold_load');
  assert.match(visible(hard.html), /Last time ran hard: hold this load, then reach 12 \/ 12 \/ 12/);
  const broke = plan(context, press, [{ weight: '30', reps: '10', effort: 'form_break' }, { weight: '30', reps: '10' }, { weight: '30', reps: '9' }]);
  assert.equal(broke.rec.painFlag, true);
  // A legacy answer reads in the new words on a reopened picker.
  const pres = context.strengthPrescriptionFor(press, press.exercise);
  assert.match(context.strengthEffortPickerHtml(0, 0, 0, 'failure', null, 1, false, false, pres), /<span>0–1 clean reps left ✓<\/span>/);
  assert.match(context.strengthEffortPickerHtml(0, 0, 0, 'failure', null, 1, false, false, pres), /data-effort-code="too_hard" class="active" aria-pressed="true"/);
});

test('the Why sheet explains progressive overload briefly, in the details only', () => {
  const context = makeContext();
  const html = context.strengthOverloadExplainerHtml(context.strengthPrescriptionFor(row, row.exercise));
  assert.match(html, /Build clean reps at the same load\. When every working set reaches the top of the range at the prescribed effort, the next weight unlocks\. Technique and pain always override progression\./);
  for (const item of ['one more clean rep', 'every working set confirmed', 'the same reps at the right effort', 'more load, once the range is earned', 'locking in a heavier attempt', 'a lighter load when technique or pain needs it']) {
    assert.match(html, new RegExp(item));
  }
  assert.match(context.strengthOverloadExplainerHtml({ assisted: true }), /less assistance unlocks/);
  assert.match(trainingSource, /data-exl-section="why"><div class="exl-sec-t">Why this load<\/div>'\+_nsBody\(_ov\)\+strengthOverloadExplainerHtml\(_ovPres\)/);
  assert.doesNotMatch(context._exlTargetHtml({ ex: row, rec: context._nsRecommendation(row, rowPrevious, row.exercise, []), pres: context.strengthPrescriptionFor(row, row.exercise), current: [], nowRow: 0 }), /How progress works/);
});
