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

`getWorkingSlice()` in `08-training.js` still decides which rows are programmed
working sets, because it carries the legacy row-index and warm-up rules that
older logs depend on. The engine is handed that slice.

## Policy

All thresholds live in `STRENGTH_POLICY`. Nothing is inlined at a call site.
`STRENGTH_POLICY.version` is stored with every draft and submission
(`__policyVersion`, and per exercise in `__strengthRx`), so a later rule change
cannot silently reinterpret an already-submitted workout.

Key defaults: target effort 2 RIR / RPE 8 when the coach sets none; at most one
known equipment rung of change at a time; 3 comparable completed sessions before
a plateau can be called, and at least 2 of them at a high effort.

## Recommendation precedence

1. Explicit, valid coach configuration (`target_load`, `rpe`/`rir`, rep bounds,
   a supported `progression_rule`).
2. The last confirmed recommendation for the same variation and load convention.
3. The most recent valid completed session for that exact context.
4. Conservative first-session calibration, with no fabricated kg value.

A `progression_rule` is never executed as code. Supported shapes are `double`,
`exact reps`, `hold`, `top set`/`ramped` and `linear +Nkg`. Anything else is
displayed as written, falls back to double progression and sets `coachReview`.

## Decision table

Evaluated in this order; the first match wins.

| # | Condition | `decision` | Effect |
|---|---|---|---|
| 0 | Rep mode is seconds, distance or unsupported | `mode_deferred` | Hold the written target; rep logic never runs |
| 1 | No completed set and no load | `coach_target` / `calibrate` | Coach load if set, otherwise ask for a controllable load — no invented kg |
| 2 | First working set rated too hard / technique / pain | `reduce_load` | One rung easier next session; pain also sets `painFlag` + `coachReview` |
| 3 | First working set rated too easy | `load_confirmed` / `change_provisional` / `change_unconfirmed` | One rung today for blank sets; carried forward only once a later set reaches the floor |
| 4 | Technique or pain on any other working set | `technique_check` | Never an increase; reduce or skip, and flag the coach |
| 5 | Load heavier than last confirmed, all required sets at the floor | `load_confirmed` | New baseline, even with fewer total reps |
| 5b | Load heavier but a later set missed the floor | `change_unconfirmed` | Attempt acknowledged, previous baseline kept |
| 6 | All required working sets at/above the ceiling, effort acceptable | `increase_load` / `increase_reps` | One rung; targets reset to the floor. Bodyweight adds reps; assisted at zero becomes a bodyweight attempt; no known increment becomes `coach_review` |
| 7 | 3+ comparable completed sessions, same load, no rep gain, high effort | `reduce_load` | One rung back plus a coach conversation |
| 7b | Same, but effort was never rated | `hold_load` (`Hold And Log`) | Hold and ask for better data |
| 8 | A completed session with a set under the floor | `hold_load` (`Build The Reps`) | Own the load first |
| 9 | Fewer completed working sets than programmed | `incomplete` | Hold; missing logs are never read as zero reps |
| 10 | Exact-rep rule | `hold_load` | Reps stay exactly as written; only load can move |
| 11 | Otherwise | `add_reps` | Double progression: one extra total rep, never past the ceiling |

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
