import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Coach-written messages (type 'custom') used to render exactly like the
// automatic reminders. They now carry a "From your coach" label, a brand
// accent, sit first while unread, and glow once the first time they are seen.

const source = readFileSync(new URL('../public/js/03-nav-nudges.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

function slice(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `could not find ${from}`);
  return source.slice(start, end);
}

function harness({ open = true, storage = {} } = {}) {
  const list = { innerHTML: '' };
  const modal = { classList: { contains: () => open } };
  const store = { ...storage };
  const context = vm.createContext({
    document: { getElementById: id => (id === 'notificationInboxList' ? list : id === 'notificationInboxModal' ? modal : null) },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    esc: v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    notificationTime: () => '24 Sep at 4:53 am',
    _notificationInboxMutating: false,
    _notificationInbox: [],
  });
  vm.runInContext(slice('function isCoachMessage(item)', 'function applyNotificationInboxResponse('), context);
  return { context, list, store };
}

const inbox = [
  { id: 'a', type: 'sessions', title: "Today's training", body: 'Recovery 4km', created_at: '2026-09-24T20:00:00Z', read_at: null, pushed_at: '2026-09-24T20:00:01Z' },
  { id: 'b', type: 'coach', title: 'Your programme changed', body: 'Upper A added', created_at: '2026-09-24T19:00:00Z', read_at: null },
  { id: 'c', type: 'custom', title: 'Great work', body: 'Nailed Upper A. <b>That</b> is the standard', created_at: '2026-09-23T19:23:00Z', read_at: null, pushed_at: null },
  { id: 'd', type: 'custom', title: 'Old note', body: 'read already', created_at: '2026-09-10T00:00:00Z', read_at: '2026-09-11T00:00:00Z' },
];

test('an unread coach message is pinned first; everything else keeps its order', () => {
  const { context } = harness();
  const sorted = vm.runInContext('sortNotificationInbox', context)(inbox);
  assert.deepEqual(sorted.map(i => i.id), ['c', 'a', 'b', 'd']);
});

test('coach messages are labelled and accented; automatic reminders are unchanged', () => {
  const { context, list } = harness();
  context._notificationInbox = inbox;
  vm.runInContext('renderNotificationInbox()', context);
  const cards = list.innerHTML.split('<div class="notification-item').slice(1);
  assert.match(cards[0], /^ is-unread is-coach is-new"/);
  assert.match(cards[0], /From your coach/);
  assert.match(cards[0], /Nailed Upper A\. &lt;b&gt;That&lt;\/b&gt;/, 'still escaped');
  // The delivery footer is noise on a personal message.
  assert.doesNotMatch(cards[0], /· Inbox|Sent to your device/);
  // Reminders keep their plain card and footer.
  assert.doesNotMatch(cards[1], /is-coach|From your coach/);
  assert.match(cards[1], /Sent to your device/);
  // A read coach message keeps its label but is not pinned or glowing.
  assert.match(cards[3], /^ is-coach"/);
});

test('the glow happens once, only when the inbox is actually open', () => {
  const closed = harness({ open: false });
  closed.context._notificationInbox = inbox;
  vm.runInContext('renderNotificationInbox()', closed.context);
  assert.equal(closed.store.dp_coach_msg_seen, undefined, 'a background refresh does not use up the glow');

  const opened = harness();
  opened.context._notificationInbox = inbox;
  vm.runInContext('renderNotificationInbox()', opened.context);
  assert.deepEqual(JSON.parse(opened.store.dp_coach_msg_seen), ['c']);
  vm.runInContext('renderNotificationInbox()', opened.context);
  assert.doesNotMatch(opened.list.innerHTML, /is-new/);
});

test('storage failures never break the inbox', () => {
  const { context, list } = harness();
  context.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  context._notificationInbox = inbox;
  vm.runInContext('renderNotificationInbox()', context);
  assert.match(list.innerHTML, /From your coach/);
});

test('styles: accent, label and a reduced-motion-safe glow, all from tokens', () => {
  // Monochrome system: contrast, not hue. A 4px warm-white edge on a lifted surface.
  assert.match(css, /\.notification-item\.is-coach\{border-color:var\(--t-3\);background:var\(--surface2\);box-shadow:inset 4px 0 0 var\(--text\)\}/);
  assert.match(css, /\.notification-coach-tag\{/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\.notification-item\.is-new\{animation:none\}\}/);
});
