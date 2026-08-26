# Phase 4 — Rebuild the design system once

You are working in the `dp-athlete-portal` repo. Phases 1-3 are done: instrumentation, the derived
coach cue and nudge priority, IndexedDB queue, Playwright journeys in CI, a build step.

**Do not start this phase until the Playwright suite from Phase 3 is green in CI.** This phase
rewrites the CSS cascade and splits the largest file in the codebase. The existing `node --test`
suite asserts against source *text*, so it will stay green through a refactor that visually destroys
the app. Playwright is the only thing standing between you and that outcome. If those journeys are
not running, stop and say so.

Work the tasks in order. One commit per task, verification block after each, and take a screenshot
comparison at each step.

---

## Non-negotiable repo rules

**1. Versioned asset ritual** — `?v=N` in `index.html`, the same in `APP_SHELL` in `sw.js`, bump
`CACHE_NAME`, then `node scripts/check-portal.mjs --update-versions`.

**2. `check-portal.mjs` reads specific files for specific literal strings.** This phase will trip it
repeatedly if you don't read the script first. Known assertions that constrain you:

- Literal CSS string `.save-state-pill.saved{opacity:0;pointer-events:none}` must exist in
  `styles.css`
- Markers `_rowIndex`, `working-set-note`, `ns-warmup-map`, `Today's progression target` and
  `Final working set: stay at ` must exist in **`js/08-training.js` or `styles.css`** — this
  directly constrains Task 4
- `js/06-nutrition.js` must contain `var open=!collapsible;` and must not contain `dp_vstrip_open`
- `js/02-login-goals.js` must retain its bootstrap hydration ordering
- `#goalsBanner` must sit inside `.top-shell-priority.week-card` before `#tab-training`
- Balanced braces and balanced `/* */` in all three stylesheets

**3. `api/` ceiling is 12 files.** Nothing in this phase needs a server change.

**4. Do not touch the reminder scheduler.**

---

## Verification block

```bash
node scripts/check-portal.mjs
node --test
npx playwright test
node scripts/check-portal.mjs --update-versions
```

All four, every task. Plus a visual pass — see "How to verify visually" below.

---

## How to verify visually

Text-matching tests cannot see a broken cascade. For every task in this phase:

1. Screenshot these six states before and after, at 390px and at 1440px:
   home (with a session), today's session expanded, strength logging with sets entered, the weekly
   check-in mid-step, Progress, and the Contact tab
2. Do all twelve in **both** dark and outdoor (light) mode
3. Diff them. Any change you did not intend is a regression — investigate before moving on

Outdoor mode is where cascade mistakes surface first, because much of it is built from per-component
overrides rather than tokens. Check it every time, not at the end.

---

## Task 1 — Settle the typeface question

**The decision is made. Inter stays. Do not revisit it.**

Today `styles.css` line 1 declares `--display:'Barlow Condensed'`, `--body:'Barlow'`,
`--mono:'DM Mono'`. Line ~2517, inside a later reskin layer, overrides all three to Inter and a
system mono stack. Barlow and Barlow Condensed were **never loaded** by the Google Fonts request, so
those first two tokens have been dead since they were written.

**Do:**

- Delete the Barlow declarations from the line-1 `:root`. They are lies in the source.
- Keep Inter for `--display` and `--body`, defined exactly once.
- **Mono needs a real decision, and I want it made deliberately rather than inherited.** DM Mono is
  loaded from Google Fonts and `var(--mono)` is used 155 times in `styles.css`, but the later
  override puts `ui-monospace` ahead of it, so DM Mono is paid for and largely unused. Set DM Mono
  first in the stack with system mono as fallback, screenshot the data-heavy surfaces (hero metric
  grid, set logging, volume strip, PB history) in both themes, and **show me before committing.**
  If DM Mono hurts legibility at the small sizes those surfaces use, say so and we keep system mono.
- Confirm the Google Fonts `<link>` in `index.html` requests exactly what is used and nothing more.

---

## Task 2 — One type scale, one radius scale

**Type.** There are 25+ distinct font sizes, and roughly 380 declarations at 11px or smaller —
including 12 at 7px, 50 at 8px, 106 at 9px and 107 at 10px. This is an app used one-handed, mid
session, sometimes in direct sun.

- Define a scale of seven steps as tokens, **floor at 12px**. Nothing below 12px survives.
- Map every existing size to its nearest step. Where a mapping makes a component overflow, fix the
  component's layout — do not reintroduce a smaller size.
- Uppercase micro-labels are the main casualty. They can keep their letter-spacing and weight
  treatment at 12px; they will take more horizontal room, so check the metric grid and the nudge
  rows at 390px specifically.

**Radius.** 20 distinct values from 4px to 28px, plus `999px`. Cards sitting at 10, 11, 12 and 13px
next to each other are why the layout reads slightly unresolved.

- Six tokens plus a pill token. Map everything.

Both scales get defined in the single token block created in Task 3, not scattered.

---

## Task 3 — Collapse the cascade

`styles.css` is 349KB across 5,492 lines containing **nine separate `:root` blocks**, each a
successive redesign layered on the last rather than replacing it. There are three competing
definitions of `--bg`, 315 `!important` declarations holding the newest layer on top, 180 unique hex
literals against 32 tokens, and about 119 class names no HTML or JS references.

**Work in this order — it matters:**

**3a. One token block.** Consolidate all nine `:root` blocks into a single block at the top of the
file, containing the final effective value of every token. Resolve conflicts by keeping what
currently *wins* the cascade, not what reads best. Do this first and change nothing visually — the
computed values must be identical afterwards. Verify with the screenshot pass before continuing.

**3b. Delete dead classes.** About 119 class names appear in CSS but nowhere in HTML or JS.
Generate the list yourself rather than trusting a stale one:

```js
// classes in CSS that appear in no HTML or JS source
```

Be careful with two categories before deleting: classes constructed dynamically in JS via string
concatenation, and classes only ever added by `classList.add()` with a computed name. Grep for
fragments, not just whole names. When in doubt, keep it and list it for me.

**3c. Sweep the hex literals.** 180 unique values including `#fff` 107 times and eight different
near-blacks. Getting the eight near-blacks down to three surface tokens is most of the win. Target
the top 30 literals; you do not need to reach zero.

**3d. Reduce `!important`.** Most of the 315 exist to hold a later layer above an earlier one. With
the layers collapsed, many become unnecessary. Remove them where the tests and screenshots agree
nothing changes. Do not chase zero — leave the ones genuinely fighting third-party or inline styles,
and report the final count.

**3e. Inline styles.** `index.html` carries 241 inline `style` attributes, which is the second reason
the stylesheet can't be reasoned about. Move the ones that represent real component styling into
classes. Leave the ones setting genuinely dynamic values. This is opportunistic — do what is clean,
not what is exhaustive.

---

## Task 4 — Split `08-training.js`

2,481 lines and 144 top-level functions in the single most-edited file in the repo.

**The trap:** `check-portal.mjs` asserts that the literal strings `_rowIndex`, `working-set-note`,
`ns-warmup-map`, `Today's progression target` and `Final working set: stay at ` exist in
**`js/08-training.js` or `styles.css`**. Split those markers into a new file and the check fails.
Either keep the code owning those markers in `08-training.js`, or update the check script to look
across the new files — if you change the check script, say so loudly in your report and explain
exactly what it now covers.

**Split along the existing section banners**, which already mark the real seams:

| Lines | Section | Suggested home |
|---|---|---|
| 1-236 | Load week | stays in `08-training.js` |
| 237-311 | Render calendar | `08-training.js` |
| 312-603 | Weekly plan km target | candidate for extraction |
| 604-696 | RPE + alternative workout helpers | candidate |
| 697-931 | Interval rest time parser | candidate — self-contained, easiest first split |
| 932-1128 | Today's focus | keep with the cue logic |
| 1129-1483 | Streak | candidate |
| 1484+ | Real weight increments | candidate |

**Start with the interval rest parser.** It is self-contained, has clear inputs and outputs, and
gives you a low-risk proof that the split mechanics work before you touch anything load-bearing.

Every new file is a new versioned asset: add it to `index.html` in the correct load order, to
`APP_SHELL` in `sw.js`, bump `CACHE_NAME`, and run `--update-versions`. **Load order matters** —
`10-boot.js` must stay last, and anything `08-training.js` depends on must load before it.

Do not convert to ES modules. Do not change function signatures. Do not rename anything. This is a
file move, nothing more.

---

## Out of scope

- No new features
- No copy changes beyond what a type-scale change forces
- No layout redesign — this phase changes tokens and file organisation, not composition
- No native shell, wearables or coach dashboard — Phase 5
- No changes to auth, RLS, Strava, reminders or the offline queue

## Finish by reporting

- Files changed per task
- Final `?v=` numbers, new files added, and `CACHE_NAME`
- All four verification commands passing
- Before/after counts: `:root` blocks, `!important`, unique hex values, distinct font sizes,
  distinct radii, dead classes removed, `styles.css` size
- The DM Mono screenshots from Task 1, before you commit that decision
- Any class you were unsure about deleting, listed rather than guessed
- Any check-script assertion you had to modify, and why
