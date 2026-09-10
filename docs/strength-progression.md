# Strength progression engine

`public/js/08-strength-engine.js` is the pure decision layer behind the strength
tracker. It has no DOM, no storage and no clock: the same inputs always produce
the same decision object, and `08-training.js` renders from it.

No database migration was needed for this work. Every coach field the engine
reads already exists on `session_exercises`; `api/write.js` now passes them
through as typed fields instead of flattening them into the display line.

## Pipeline

1. `normaliseStrengthPrescription(ex, resolvedName)` — what the coach asked for.
2. `normaliseStrengthSets(rows, pres, roleOverride)` — what the athlete did.
3. `strengthCalibrationDecision(...)` / `strengthProgressionDecision(...)`.
4. `strengthLiveLoadDecision(...)` — a weight-only, side-effect-free decision
   used while the athlete is still entering the current set.

`getWorkingRows()` in `08-training.js` decides which rows are programmed working
sets because it carries the legacy row-index and warm-up rules that older logs
depend on. Saved-history decisions use its reps-required view; live load changes
use its weight-only-capable view. Warm-ups and bonus rows are excluded in both.

## Policy

All thresholds live in `STRENGTH_POLICY`. Nothing is inlined at a call site.
`STRENGTH_POLICY.version` is stored with every draft and submission
(`__policyVersion`, and per exercise in `__strengthRx`), so a later rule change
cannot silently reinterpret an already-submitted workout.

Key defaults: target effort 2 RIR / RPE 8 when the coach sets none; at most one
known equipment rung of change at a time; 3 comparable completed sessions before
a plateau can be called, and at least 2 of them at a high effort.

## Recommendation precedence

1. Pain, technique, failed-rep or too-hard feedback.
2. Explicit coach configuration (`target_load`, `rpe`/`rir`, rep bounds and
   supported progression instructions).
3. Athlete difficulty, RPE and RIR feedback.
4. A deliberate working-load change.
5. Per-set rep performance.
6. Total-rep history as supporting context, never the sole gate.

A `progression_rule` is never executed as code. Supported shapes are `double`,
`exact reps`, `hold`, `top set`/`ramped` and `linear +Nkg`. Anything else is
displayed as written, falls back to double progression and sets `coachReview`.

## Decision table

Evaluated in this order; the first match wins.

| # | Condition | `decision` | Effect |
|---|---|---|---|
| 0 | Rep mode is seconds, distance or unsupported | `mode_deferred` | Hold the written target; rep logic never runs |
| 1 | No completed set and no load | `coach_target` / `calibrate` | Coach load if set, otherwise ask for a controllable load — no invented kg |
| 2 | Technique/pain anywhere | `reduce_load` / `technique_check` | Never increase; reduce or stop and flag the coach |
| 3 | Too hard/at limit anywhere | `reduce_load` / `hold_load` | Below the floor reduces; otherwise hold; both suppress increases |
| 4 | Too easy but any set is below the floor | `hold_load` | The programmed minimum outranks the easy signal |
| 5 | First working set rated too easy | `load_confirmed` / `increase_load` / `change_provisional` / `change_unconfirmed` | One same-day change at most; later sets confirm it; unknown equipment never gets a fabricated kg value |
| 6 | Too easy / excess RIR on any completed working set | `increase_load` | Override rep chasing, move one known rung or say “next available weight”, reset to the programmed floor |
| 7 | Load heavier than last confirmed, all required sets at the floor | `load_confirmed` | New baseline, even with fewer total reps |
| 7b | Load heavier but a later set missed the floor | `change_unconfirmed` | Attempt acknowledged, previous baseline kept |
| 8 | All required working sets at/above the ceiling, effort acceptable | `increase_load` / `increase_reps` | One rung; targets reset to that exercise's floor |
| 9 | 3+ comparable completed sessions, same load, no rep gain, high effort | `reduce_load` | One rung back plus a coach conversation |
| 10 | A completed session with a set under the floor | `hold_load` | Own the load first |
| 11 | Fewer completed working sets than programmed | `incomplete` | Hold; missing logs are never read as zero reps |
| 12 | Exact-rep rule | `hold_load` | Reps stay exactly as written; only load can move |
| 13 | Otherwise | `add_reps` | Same-load double progression adds one clean rep inside the range |

Every decision carries `tone`, `reason`, `confidence` (`coach_set`, `confirmed`,
`learned`, `estimated`, `low`) and `policyVersion`.

## Progression history and high-water marks

Every decision carries the record behind it, because a recommendation that
steps back reads as lost progress without one.

- `history` — completed sessions on this exercise, oldest to newest, capped at
  `STRENGTH_POLICY.historyPoints`. Warm-ups and bonus sets are excluded (it
  runs through the same working-set slice), and a session from another load
  context never appears.
- `peak.reached` — the heaviest load moved for a working set at the rep floor.
  A real achievement, even if the session was not consolidated.
- `peak.confirmed` — the heaviest load where every required set held the floor.
  The baseline the engine builds from.
- `belowPeak` / `workingToward` — set when the recommended load sits under a
  load already reached. That is a consolidation step, and the card says so
  rather than showing a bare lower number.

So an athlete who reaches 65kg and fatigues on the back sets sees
"Consolidating 65kg" and "Repeat 60kg to lock in 65kg", not "Start at 60kg".
On an assisted machine the peak is the *least* assistance, not the largest
number.

## Effort

Coach `rir` wins, then coach `rpe` (as `10 - rpe`), then the conservative
default. Athlete evidence comes from a logged RIR, a logged RPE, or the
four-outcome quality answer, which works with RPE logging switched off. RPE and
RIR are not treated as interchangeable: a material disagreement sets `conflict`,
holds the load and lowers confidence rather than picking a winner.

Quality codes are `on_target`, `too_easy`, `too_hard`, `form_pain`. The three
legacy codes still parse: `reserve` → too easy, `failure` → at limit (RIR 0),
`form_break` → technique/pain.

## Live load changes

A working-load input is evaluated on every keystroke, even before reps exist.
An increase switches the card to “Load Increased”; a decrease switches it to
“Load Reduced” and is never automatically undone. Both directions target the
bottom of that exercise's programmed range, repeat the prescribed RIR and use
the immediately preceding working load before falling back to saved history.
Only placeholders on the current and remaining unfinished working rows change;
entered values and completed rows are never rewritten. Once all sets are logged,
the normal shared progression decision takes over and the saved workout becomes
the next history baseline.

## Equipment

Rungs come from a coach increment, then from loads actually logged on the same
variation, unit and load convention, then from a clearly-labelled estimate.
Gaps below 0.5 or above 25 are ignored, and a lone load far off the ladder is
dropped as a likely typo — the source log is never modified. Assisted machines
run in reverse and stop at zero assistance. Nothing is suggested above
`maxLoadKg` or below zero.

History is isolated by `contextKey` (`exercise|unit|convention`). Sessions
logged before `__strengthRx` existed carry no context and stay comparable;
anything logged since declares its unit and convention, so a change to either
starts a fresh ladder.

## Card fitting

The milestone ladder was four `flex-shrink:0` nodes with `white-space:nowrap`
labels, so "Increase next" ran off the right edge of the card on a normal
phone. Nodes now share the width and labels wrap. Below 410px four labels
cannot be both legible and inside the card, so they become visually hidden
(still in the DOM, still read aloud) and the current step gets one full-width
line instead.

These overrides must stay *after* the original ladder rules in `styles.css` or
they lose the cascade; `check-portal.mjs` asserts that order.
`tests/e2e/strength-card-fit.spec.js` measures real overflow at 320/360/390/
414/430px, and separately checks that no label is forced to break mid-word.
