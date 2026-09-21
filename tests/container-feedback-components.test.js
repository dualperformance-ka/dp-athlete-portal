import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const styles = read('public', 'styles.css');
const desktop = read('public', 'desktop.css');
const index = read('public', 'index.html');
const core = read('public', 'js', '01-core.js');
const logging = read('public', 'js', '09-logging.js');
const training = read('public', 'js', '08-training.js');
const focus = read('public', 'js', '08-training-focus.js');
const nudges = read('public', 'js', '03-nav-nudges.js');
const a11y = read('public', 'accessibility.js');

// ── A tiny DOM, enough for the two behavioural suites below ──────────────────
function classList(node) {
  const set = new Set();
  return {
    add: (...n) => n.forEach((x) => set.add(x)),
    remove: (...n) => n.forEach((x) => set.delete(x)),
    contains: (n) => set.has(n),
    toggle(n, on) { const want = on === undefined ? !set.has(n) : !!on; want ? set.add(n) : set.delete(n); return want; },
    get list() { return [...set]; },
    _set: set,
    _owner: node,
  };
}
function element(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    attrs: {},
    style: { display: '' },
    _text: '',
    get textContent() { return this._text || this.children.map((c) => c.textContent).join(''); },
    set textContent(v) { this._text = String(v); this.children.length = 0; },
    appendChild(c) { this.children.push(c); this._text = ''; return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    get className() { return this.classList.list.join(' '); },
    set className(v) { this.classList._set.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    querySelector() { return null; },
  };
  el.classList = classList(el);
  return el;
}
function clock() {
  let now = 0, id = 0;
  const jobs = new Map();
  return {
    setTimeout(fn, ms) { const key = ++id; jobs.set(key, { at: now + (ms || 0), fn }); return key; },
    clearTimeout(key) { jobs.delete(key); },
    tick(ms) {
      now += ms;
      [...jobs.entries()].filter(([, j]) => j.at <= now).sort((a, b) => a[1].at - b[1].at)
        .forEach(([key, job]) => { jobs.delete(key); job.fn(); });
    },
    get pending() { return jobs.size; },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 1 · SHEET — one component for every overlay
// ══════════════════════════════════════════════════════════════════════════════

test('every overlay shares one sheet implementation rather than four', () => {
  // The base rule names the component and every legacy alias in one selector.
  assert.match(styles, /\.sheet,\.hb-modal,\.ql-modal,\.photo-modal\{display:none;position:fixed/);
  assert.match(styles, /\.sheet-inner,\.hb-modal-inner,\.ql-modal-inner,\.photo-modal-inner\{/);
  assert.match(styles, /\.sheet-close,\.hb-modal-close,\.ql-modal-close,\.photo-modal-close\{/);
  // …and the three standalone copies it replaced are gone.
  assert.doesNotMatch(styles, /\n\.hb-modal\{display:none/);
  assert.doesNotMatch(styles, /\n\.ql-modal\{display:none/);
  assert.doesNotMatch(styles, /\n\.photo-modal\{display:none/);
  // Three different backdrop opacities collapsed onto one token at 55%.
  assert.match(styles, /--scrim:rgba\(0,0,0,\.55\)/);
  assert.match(styles, /\.sheet,\.hb-modal,\.ql-modal,\.photo-modal\{[^}]*background:var\(--scrim\)/);
  assert.doesNotMatch(styles, /\.(?:ql|hb|photo)-modal\{[^}]*background:rgba\(0,0,0,\.[67]\)/);
});

test('the sheet has a handle, a --dur-sheet open and a sticky action footer', () => {
  assert.match(styles, /\.sheet-handle,\.hb-modal-header::before,\.ql-modal-header::before,\.photo-modal-header::before\{/);
  assert.match(styles, /animation:sheetIn var\(--dur-sheet\)/);
  assert.match(styles, /animation:sheetScrim var\(--dur-sheet\)/);
  assert.match(styles, /@keyframes sheetIn\{/);
  assert.match(styles, /\.sheet-actions\{position:sticky;bottom:0/);
  // Reduced motion keeps the sheet, drops the movement.
  assert.match(styles, /@media\(prefers-reduced-motion:reduce\)\{[\s\S]{0,600}?\.photo-modal\.open>\.photo-modal-inner\{animation:none\}/);
  // The primary action of each composer sheet actually sits in the footer.
  for (const id of ['qlbSubmitBtn', 'qlnSubmitBtn', 'dataRequestConfirm', 'coachNoteSend']) {
    assert.match(index, new RegExp('<div class="sheet-actions">[^<]*<button[^>]*id="' + id + '"'), id);
  }
});

test('the drag tracks the finger and the release is the only animated part', () => {
  assert.match(styles, /transform:translateY\(var\(--sheet-drag,0px\)\)/);
  assert.match(styles, /\.photo-modal\.is-dragging>\*\{animation:none;transition:none\}/);
  assert.match(styles, /\.photo-modal\.is-releasing>\*\{animation:none;transition:transform var\(--dur-sheet\)/);
  assert.match(core, /setProperty\('--sheet-drag'/);
  assert.match(core, /pointerdown[\s\S]*pointermove[\s\S]*pointerup/);
  // A downward drag only counts from the top of the sheet's own scroll, so it
  // never fights a long form's body scroll.
  assert.match(core, /drag\.inner\.scrollTop>0/);
});

test('opening a sheet locks the page behind it without shifting it', () => {
  assert.match(styles, /body\.sheet-open\{overflow:hidden\}/);
  assert.match(core, /window\.innerWidth-document\.documentElement\.clientWidth/);
  assert.match(core, /body\.style\.paddingRight=gap\+'px'/);
});

test('the session focus overlay is left out of the sheet component', () => {
  const sheetSelectors = styles.match(/\.sheet[^{}\n]*\{/g) || [];
  assert.ok(sheetSelectors.length > 0);
  sheetSelectors.forEach((sel) => assert.doesNotMatch(sel, /focus-overlay/));
  assert.doesNotMatch(core, /SHEET_SELECTOR='[^']*focus-overlay/);
  // It keeps its own full-screen rules.
  assert.match(styles, /\.focus-overlay\{position:fixed;inset:0/);
});

test('the overlays already trap focus, close on Escape and return focus', () => {
  // This was NOT added here: accessibility.js owns it and already covers every
  // overlay, which is why this step did not rebuild it. Asserted so a later
  // sheet change cannot quietly drop an overlay out of that coverage.
  for (const sel of ['.hb-modal', '.ql-modal', '.photo-modal', '.day-plan-overlay', '.profile-menu']) {
    assert.ok(a11y.includes(sel), sel);
  }
  assert.match(a11y, /event\.key === 'Escape'/);
  assert.match(a11y, /returnFocus.*focus\(\)/s);
  // Every overlay closes on a backdrop tap and has a close control Escape can
  // find by accessible name.
  const backdrops = index.match(/class="(?:ql|hb|photo)-modal"[^>]*onclick="[^"]*"/g) || [];
  assert.ok(backdrops.length >= 12, 'expected every modal to keep its backdrop handler');
  backdrops.forEach((tag) => assert.match(tag, /event\.target===this|closePhotoModal\(event\)/));
  const closers = index.match(/class="(?:ql|hb|photo)-modal-close"[^>]*aria-label="Close[^"]*"/g) || [];
  assert.ok(closers.length >= 12, 'every sheet needs a Close-named control for Escape');
});

// ══════════════════════════════════════════════════════════════════════════════
// 2 · TOAST — queues instead of clobbering
// ══════════════════════════════════════════════════════════════════════════════

function toastHarness() {
  const start = logging.indexOf('var TOAST_MS=');
  const end = logging.indexOf('// Sliders start visually "untouched"');
  assert.ok(start >= 0 && end > start, 'the toast block should remain discoverable');
  const node = element();
  const time = clock();
  const context = {
    document: {
      getElementById: (id) => (id === 'toast' ? node : null),
      createElement: (tag) => element(tag),
    },
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(logging.slice(start, end), context);
  return { node, time, context };
}

test('a second toast queues rather than overwriting the one on screen', () => {
  const { node, time, context } = toastHarness();
  context.showToast('Body check-in logged');
  assert.equal(node.textContent, 'Body check-in logged');
  context.showToast('Back Squat +5kg — new PB');
  assert.equal(node.textContent, 'Body check-in logged', 'the first message must not be clobbered');
  time.tick(3000);
  time.tick(200);
  assert.equal(node.textContent, 'Back Squat +5kg — new PB');
});

test('a toast lasts three seconds and is dismissible', () => {
  const { node, time, context } = toastHarness();
  context.showToast('Saved');
  time.tick(2999);
  assert.equal(node.style.display, 'block');
  time.tick(1);
  assert.equal(node.style.display, 'none');
  context.showToast('Saved again');
  assert.equal(typeof node.onclick, 'function');
  node.onclick();
  assert.equal(node.style.display, 'none', 'tapping a toast should dismiss it');
});

test('an error toast persists, and a newer error replaces it', () => {
  const { node, time, context } = toastHarness();
  context.showToast('Could not reach your coaches', 'error');
  time.tick(60000);
  assert.equal(node.style.display, 'flex', 'a failed submission must not time out');
  assert.ok(node.children.some((c) => c.classList.contains('toast-dismiss')));
  context.showToast('Still offline', 'error');
  assert.equal(node.textContent.includes('Still offline'), true);
  assert.equal(node.textContent.includes('Could not reach'), false);
});

test('the toast is a status region and cannot cover the bottom bar', () => {
  assert.match(index, /id="toast"[^>]*role="status"/);
  assert.match(index, /id="toast"[^>]*aria-live="polite"/);
  assert.match(styles, /\.toast\{position:fixed;bottom:calc\(var\(--bottom-bar-h\) \+ var\(--sp-3\)\)/);
  assert.match(styles, /--bottom-bar-h:0px/);
  // Non-zero only where the bar is actually rendered.
  assert.match(styles, /:root\{--bottom-bar-h:calc\(66px \+ 8px \+ env\(safe-area-inset-bottom\)\)\}/);
});

// ══════════════════════════════════════════════════════════════════════════════
// 3 · SYNC PILL — synced / sending / queued, on any logged object
// ══════════════════════════════════════════════════════════════════════════════

function syncHarness() {
  const start = core.indexOf('var SYNC_STATE_CLASS=');
  const end = core.indexOf('var SAVE_STATE_SYNC=');
  assert.ok(start >= 0 && end > start, 'the sync-state block should remain discoverable');
  const context = { document: { getElementById: () => null } };
  vm.createContext(context);
  vm.runInContext(core.slice(start, end), context);
  return context;
}

test('any logged object can carry the sync state, not just the dock buttons', () => {
  const { setSyncState } = syncHarness();
  const row = element();
  assert.equal(setSyncState(row, 'sending', 'Nutrition log'), 'sending');
  assert.ok(row.classList.contains('is-sending'));
  assert.equal(row.getAttribute('data-sync-state'), 'sending');
  assert.match(row.getAttribute('aria-label'), /not yet sent/);
  assert.equal(setSyncState(row, 'synced', 'Nutrition log'), 'synced');
  assert.ok(row.classList.contains('is-synced'));
  assert.ok(!row.classList.contains('is-sending'), 'the three states are exclusive');
  assert.equal(setSyncState(row, 'queued'), 'queued');
  assert.ok(row.classList.contains('is-queued'));
  // No state at all is a real answer: nothing logged yet today.
  assert.equal(setSyncState(row, null), null);
  assert.equal(row.getAttribute('data-sync-state'), null);
  assert.equal(setSyncState(null, 'sending'), null);
});

test('sending is the only sync state that animates on a loop', () => {
  assert.match(styles, /\.sync-pill\.is-sending>span,\.save-state-pill\.saving span\{background:var\(--readout\);animation:pdot/);
  assert.match(styles, /\.sync-pill\.is-synced>span\{background:var\(--done\);animation:none\}/);
  assert.doesNotMatch(styles, /\.sync-pill\.is-queued>span\{[^}]*animation:(?!none)/);
  assert.match(styles, /@media\(prefers-reduced-motion:reduce\)\{\.sync-pill\.is-sending>span,\.save-state-pill\.saving span\{animation:none\}\}/);
  // The state drives the dot colour, so a carrier does not need the pill skin.
  assert.match(styles, /\[data-sync-state="sending"\]\{--sync-dot:var\(--readout\)\}/);
  assert.match(styles, /\[data-sync-state="queued"\]\{--sync-dot:var\(--watch\)\}/);
});

test('the dock and the header pill both go through the shared state', () => {
  assert.match(logging, /setSyncState\(el,s==='logged'\?'synced':s==='sending'\?'sending':null\)/);
  assert.match(core, /setSyncState\(pill,SAVE_STATE_SYNC\[state\]\)/);
  // The dock's reason for a distinct "sending" state is the whole point of the
  // component and must survive the generalisation.
  assert.match(core, /saved on this device but not yet sent/);
});

// ══════════════════════════════════════════════════════════════════════════════
// 4 · COACH NOTE — only ever on words a coach wrote
// ══════════════════════════════════════════════════════════════════════════════

test('the coach note renders avatars only on a coach-authored note', () => {
  const start = focus.indexOf('function renderCoachMoment(');
  assert.ok(start >= 0, 'renderCoachMoment should remain discoverable');
  const render = focus.slice(start, focus.indexOf('\n}', start) + 2);
  // The avatars are the signal a human wrote it, so they hang off fromCoach and
  // nothing else. This is the rule the refactor had to preserve.
  assert.match(render, /var avatars=fromCoach\?'<div class="coach-avatars">/);
  assert.match(render, /:''/);
  assert.match(render, /var fromCoach=!!note/);
  assert.match(render, /coach-moment'\+\(fromCoach\?'':' is-derived'\)/);
  assert.match(render, /No avatars on derived text/);
  // Derived text cannot borrow a coach's voice either.
  assert.doesNotMatch(render, /Karl says|Alex says|we want you to/i);
  assert.match(styles, /\.coach-moment\.is-derived\{grid-template-columns:minmax\(0,1fr\) auto\}/);
  assert.match(styles, /\.coach-moment\.is-derived \.coach-moment-label\{font-weight:600;color:var\(--muted\)\}/);
});

// ══════════════════════════════════════════════════════════════════════════════
// 5 · DUE ROW — the Phase 1 due slot, precedence intact
// ══════════════════════════════════════════════════════════════════════════════

test('the due row is a component and its precedence order is unchanged', () => {
  assert.match(styles, /\.due-row,\.nudge-strip\{background:var\(--g-1\)/);
  assert.match(nudges, /var NUDGE_PRIORITY=\['painNudge','checkinNudge','callNudge','photoNudge','logNudge','goalsBanner'\]/);
  // One due row stays in place, the rest fold behind the summary row.
  assert.match(nudges, /if\(due\.length<2\)/);
  assert.match(nudges, /var hidden=due\.slice\(1\)/);
  // A confirmed booking is status, not a demand, so it never takes the slot.
  assert.match(nudges, /card\.appendChild\(confirmed\)/);
});

test('due rows read their plate surface from one rule in both themes', () => {
  assert.match(styles, /\.top-shell-priority \.due-row,\n\.top-shell-priority \.nudge-strip,/);
  assert.doesNotMatch(styles, /html:not\(\.outdoor-mode\) \.top-shell-priority \.nudge-strip/);
  // One glow keyframe set, driven by --nudge-due, instead of a light copy.
  assert.doesNotMatch(styles, /nudgeGlowLight/);
  assert.match(styles, /@keyframes nudgeGlow\{[\s\S]*?color-mix\(in srgb,var\(--nudge-due\)/);
});

// ══════════════════════════════════════════════════════════════════════════════
// 6 · SET ROW — read mid-set at arm's length
// ══════════════════════════════════════════════════════════════════════════════

test('the set row keeps its own density spec', () => {
  assert.match(styles, /\.set-row,\.setrow,\.setrow-single\{min-height:44px\}/);
  assert.match(styles, /\.sin,\.rpe-in,\.snum\{font-variant-numeric:tabular-nums\}/);
  // 32px disc, 44x44 target: the extra 6px a side is invisible hit area, so
  // nothing shrank or grew to reach the floor.
  assert.match(styles, /\.st\{position:relative;width:32px;height:32px/);
  assert.match(styles, /\.st::after\{content:'';position:absolute;inset:-6px/);
  // A 12px floor on every label in the row.
  assert.match(styles, /\.slbl\{font-family:var\(--mono\);font-size:var\(--fs-label\)/);
  assert.match(styles, /\.snum\{font-family:var\(--mono\);font-size:var\(--fs-label\)/);
  assert.match(styles, /--fs-label:12px/);
});

test('a very narrow screen scrolls the set row instead of shrinking it', () => {
  // The floor is on the fields, not a magic container width: they stop at 64px
  // and the card scrolls sideways rather than squeezing them.
  assert.match(styles, /@media\(max-width:340px\)\{[\s\S]*?\.exc\{overflow-x:auto/);
  assert.match(styles, /\.slbls,\.setrow\{grid-template-columns:22px minmax\(64px,1fr\) minmax\(64px,1fr\) 44px 36px\}/);
  assert.match(styles, /\.slbls-single,\.setrow-single\{grid-template-columns:22px minmax\(56px,1fr\)/);
});

// ══════════════════════════════════════════════════════════════════════════════
// 7 · DAY CELL — the week board unit
// ══════════════════════════════════════════════════════════════════════════════

test('the day cell carries type, label, name, completion and a hold affordance', () => {
  assert.match(styles, /\.day-cell,\.mobile-week-session\{display:grid/);
  // Type indicator is the step-2 shape plus colour, not colour alone.
  assert.match(training, /session-mark session-mark--'\+getType\(s\)/);
  assert.match(styles, /\.session-mark--run\{[^}]*border-radius:var\(--r-pill\)/);
  assert.match(styles, /\.day-cell\.is-holding,\.mobile-week-session\.is-holding\{box-shadow:inset 6px 0 0 var\(--watch\)/);
  assert.match(training, /DAY CELL · long-press to reschedule/);
  assert.match(training, /HOLD_MS=500/);
  assert.match(training, /openDayCellReschedule/);
  // The hold must not also fire the tap that ends it.
  assert.match(training, /var fired=hold&&hold\.fired/);
  // Completion state stays on the cell.
  assert.match(styles, /\.mobile-week-session\.done \.mobile-week-complete\{display:grid\}/);
});

// ══════════════════════════════════════════════════════════════════════════════
// 8 · No component colour lives in a daylight block any more
// ══════════════════════════════════════════════════════════════════════════════

test('this step deleted daylight overrides rather than adding any', () => {
  const converted = [
    'sheet', 'sheet-inner', 'sheet-actions', 'sheet-handle', 'sheet-close',
    'ql-modal', 'ql-modal-inner', 'ql-modal-header', 'ql-modal-body', 'ql-modal-close',
    'hb-modal', 'hb-modal-inner', 'hb-modal-header', 'hb-modal-body', 'hb-modal-close',
    'photo-modal', 'photo-modal-inner', 'photo-modal-header', 'photo-modal-close', 'photo-modal-guide',
    'profile-menu', 'profile-menu-sheet', 'profile-menu-handle', 'profile-menu-grid', 'profile-menu-close', 'profile-menu-due',
    'day-plan-overlay', 'day-plan-dialog', 'day-plan-close', 'day-plan-pager', 'day-plan-kicker', 'day-plan-rest',
    'toast', 'toast-error', 'toast-dismiss',
    'sync-pill', 'save-state-pill',
    'coach-moment', 'coach-moment-tag', 'coach-avatars',
    'due-row', 'nudge-strip', 'nudge-strip-title', 'nudge-strip-sub', 'nudge-strip-arr', 'nudge-strip-icon', 'nudge-summary',
    'set-row', 'setrow', 'setrow-single', 'slbl', 'snum', 'st',
    'day-cell', 'mobile-week-session', 'mobile-week-day', 'mobile-week-complete', 'mobile-week-key', 'mobile-week-status',
  ];
  const daylight = [];
  for (const sheet of [styles, desktop]) {
    for (const match of sheet.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      match[1].split(',').forEach((selector) => {
        if (/(^|[\s>+~])(?:html)?\.outdoor-mode\b/.test(selector)) daylight.push(selector);
      });
    }
  }
  converted.forEach((name) => assert.ok(
    !daylight.some((selector) => new RegExp('\\.' + name + '(?:[^a-zA-Z0-9_-]|$)').test(selector)),
    name,
  ));
});

test('the semantic inks the components needed became tokens, not overrides', () => {
  for (const token of ['--done-text:', '--watch-text:', '--strava-text:', '--readout-text:',
    '--readout-soft:', '--readout-line:', '--scrim:', '--control-line:', '--bottom-bar-h:',
    '--toast-alert:', '--pb-text:', '--vpb-text:']) {
    assert.ok(styles.includes(token), token);
  }
  // Each one is defined twice: once for the instrument, once for daylight.
  for (const token of ['--done-text:', '--readout-text:', '--control-line:', '--pb-text:']) {
    assert.ok(styles.split(token).length - 1 >= 2, token + ' needs a daylight value');
  }
});
