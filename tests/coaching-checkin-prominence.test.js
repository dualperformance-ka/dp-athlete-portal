import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// The Coaching tab gave the weekly check-in the same grey button as Book your
// call, Message your coaches and Notifications, under a quiet "Not yet". An
// owed check-in now leads the tab, names its due day, says when a draft has
// not been sent, and carries the screen's only filled action.

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const nav = readFileSync(join(root, 'public', 'js', '03-nav-nudges.js'), 'utf8');
const styles = readFileSync(join(root, 'public', 'styles.css'), 'utf8');

// callsCheckinState through renderCallsTab (the end of the file), run
// against a stub DOM.
const surfaceStart = nav.indexOf('function callsCheckinState(){');
assert.ok(surfaceStart > 0 && nav.indexOf('function renderCallsTab(){') > surfaceStart, 'Coaching surface landmarks moved');
const surface = nav.slice(surfaceStart);

function render({ done = false, draft = null, day = '2026-10-19T12:00:00' } = {}) {
  const store = new Map();
  if (done) store.set('dp_checkin_KARL_2026_43', '1');
  if (draft) store.set('dp_ci_draft_KARL_2026_43', JSON.stringify(draft));
  const mount = { innerHTML: '' };
  const RealDate = Date;
  const fixed = new RealDate(day);
  class FixedDate extends RealDate { constructor(...a) { super(...(a.length ? a : [fixed])); } static now() { return fixed.getTime(); } }
  const context = {
    Date: FixedDate, JSON, Object,
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null) },
    document: { getElementById: id => (id === 'callsSurface' ? mount : null) },
    checkinWeekKey: () => 'dp_checkin_KARL_2026_43',
    ciDraftKey: () => 'dp_ci_draft_KARL_2026_43',
    getCallBookedState: () => ({ booked: false, displayTime: '', startsAt: '', eventId: '' }),
    esc: s => String(s),
  };
  vm.runInNewContext(surface + '\nrenderCallsTab();', context);
  return { html: mount.innerHTML, context };
}

const cardOrder = html => [...html.matchAll(/<span class="calls-label">([^<]+)<\/span>/g)].map(m => m[1]);

test('an owed check-in is the first card and the only filled action', () => {
  const { html } = render();
  assert.deepEqual(cardOrder(html).slice(0, 2), ['Weekly check-in', 'Next call']);
  assert.equal((html.match(/calls-btn-cta/g) || []).length, 1);
  assert.match(html, /calls-btn-cta" onclick="openCheckinSheet\(\)">Complete your check-in</);
  assert.match(html, /calls-checkin-due/);
  assert.doesNotMatch(html, /Not yet/);
});

test('a submitted check-in steps back below the call and loses the accent', () => {
  const { html } = render({ done: true });
  assert.deepEqual(cardOrder(html).slice(0, 2), ['Next call', 'Weekly check-in']);
  assert.doesNotMatch(html, /calls-btn-cta|calls-checkin-due|calls-due-chip/);
  assert.match(html, /calls-label-ok">Submitted</);
  assert.match(html, />Review your check-in</);
});

test('a saved but unsent draft is called out as unsent', () => {
  const { html } = render({ draft: { _savedAt: 1, ciRunWins: 'Negative split' } });
  assert.match(html, /Started but not sent/);
  assert.match(html, /can\\'t see them until you submit|can't see them until you submit/);
  assert.match(html, />Finish and send</);
});

test('an empty draft (timestamp only) is not treated as started', () => {
  const { html } = render({ draft: { _savedAt: 1, ciRunWins: '' } });
  assert.doesNotMatch(html, /Started but not sent/);
  assert.match(html, />Complete your check-in</);
});

test('the chip names the due day, and turns amber on the day itself', () => {
  const cases = [
    ['2026-10-19T09:00:00', 'Due Sunday'],   // Monday
    ['2026-10-22T09:00:00', 'Due Sunday'],   // Thursday
    ['2026-10-24T09:00:00', 'Due tomorrow'], // Saturday
    ['2026-10-25T09:00:00', 'Due today'],    // Sunday
  ];
  for (const [day, label] of cases) {
    const { html } = render({ day });
    assert.match(html, new RegExp(`calls-due-chip[^"]*">${label}<`), `${day} → ${label}`);
    assert.equal(/calls-due-chip is-today/.test(html), label === 'Due today');
  }
});

test('the call-to-action uses the Log button colour and stays legible in daylight', () => {
  assert.match(styles, /\.calls-surface \.calls-btn\.calls-btn-cta,[^{]*\{background:var\(--c2\);border-color:var\(--c2\);color:var\(--action-ink\)/);
  assert.match(styles, /\.calls-due-chip\{[^}]*background:var\(--c2\);color:var\(--action-ink\)/);
  assert.match(styles, /\.calls-due-chip\.is-today\{background:var\(--watch\);color:var\(--ink-action\)\}/);
  // Daylight --c2 is #2B7F93: dark ink there is under AA, white passes. The
  // theme flips --action-ink; the component carries no daylight override.
  assert.match(styles, /--action-ink:var\(--ink-action\)/);
  assert.match(styles, /\.outdoor-mode\{[\s\S]*?--action-ink:var\(--color-white\);\s*--c1:#1F7FA6;--c2:#2B7F93/);
  assert.doesNotMatch(styles, /\.outdoor-mode[^{]*calls-(btn-cta|due-chip)/);
});
