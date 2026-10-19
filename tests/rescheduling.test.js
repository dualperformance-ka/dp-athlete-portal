import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const navSource = readFileSync(join(root, 'public', 'js', '03-nav-nudges.js'), 'utf8');
const loggingSource = readFileSync(join(root, 'public', 'js', '09-logging.js'), 'utf8');
const coreSource = readFileSync(join(root, 'public', 'js', '01-core.js'), 'utf8');
const apiSource = readFileSync(join(root, 'api', 'write.js'), 'utf8');

function rescheduleFunctions() {
  const start = navSource.indexOf('function setSessionDateOverride');
  const end = navSource.indexOf('var REMINDER_OPTIONS', start);
  assert.ok(start >= 0 && end > start, 'reschedule functions should remain discoverable');
  return navSource.slice(start, end);
}

function contextFor(session, stored = '{}') {
  let saved = stored;
  const context = {
    athlete: { code: 'ATHLETE1' },
    allSessions: [session],
    sessions: [session],
    dayPlanDateISO: null,
    localStorage: {
      getItem: () => saved,
      setItem: (key, value) => {
        assert.equal(key, 'dp_reschedules_ATHLETE1');
        saved = value;
      }
    },
    getWS: () => new Date(2026, 7, 3),
    localISO: (date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-'),
    localDateFromISO: (value) => new Date(`${value}T00:00:00`),
    renderTodaySection: () => {},
    renderCal: () => {},
    renderDayPlanDate: () => {},
    showToast: () => {}
  };
  vm.createContext(context);
  vm.runInContext(rescheduleFunctions(), context);
  return { context, stored: () => JSON.parse(saved) };
}

test('an athlete date override moves a workout into the selected week and is persisted', () => {
  const session = { id: 'session-1', date: '2026-07-29', plannedDate: '2026-07-29' };
  const { context, stored } = contextFor(session);

  assert.equal(context.setSessionDateOverride('session-1', '2026-08-05', { silent: true }), true);
  assert.equal(session.date, '2026-08-05');
  assert.equal(session.rescheduled, true);
  assert.equal(context.sessions.length, 1);
  assert.deepEqual(stored(), { 'session-1': '2026-08-05' });
});

test('moving a workout back to its coach-planned date removes the override', () => {
  const session = { id: 'session-1', date: '2026-08-05', plannedDate: '2026-08-04', rescheduled: true };
  const { context, stored } = contextFor(session, '{"session-1":"2026-08-05"}');

  context.setSessionDateOverride('session-1', '2026-08-04', { silent: true });
  assert.equal(session.rescheduled, false);
  assert.deepEqual(stored(), {});
});

test('saved run and gym dates promote the chosen log date to a schedule override', () => {
  assert.match(loggingSource, /if\(runDate!==s\.date\)setSessionDateOverride\(s\.id,runDate,\{silent:true\}\)/);
  assert.match(loggingSource, /if\(gymDate!==s\.date\)setSessionDateOverride\(s\.id,gymDate,\{silent:true\}\)/);
});

// The visible-range read used to return the whole programme so a moved
// session could reach the browser. It now returns the range plus exactly the
// sessions rescheduled INTO it, and the whole programme arrives separately
// (programme-sessions) after Today is on screen.
test('cloud hydration restores reschedules and the range read includes sessions moved into it', async () => {
  assert.match(coreSource, /row\.key==='reschedules'.*dp_reschedules_/);
  const { plannedSessionsInRange, programmeSessions } = await import('../api/write.js');
  const programme = [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', notion_page_id: null, planned_date: '2026-08-03', title: 'In range' },
    { id: 'aaaaaaaa-0000-4000-8000-000000000002', notion_page_id: 'legacy-page-2', planned_date: '2026-07-27', title: 'Moved in (cloud)' },
    { id: 'aaaaaaaa-0000-4000-8000-000000000003', notion_page_id: null, planned_date: '2026-08-20', title: 'Moved in (device)' },
    { id: 'aaaaaaaa-0000-4000-8000-000000000004', notion_page_id: null, planned_date: '2026-08-12', title: 'Next' },
    { id: 'aaaaaaaa-0000-4000-8000-000000000005', notion_page_id: null, planned_date: '2026-07-01', title: 'History' },
  ];
  const queries = [];
  const selectRows = async (table, query) => {
    queries.push({ table, query });
    assert.equal(query.athlete_code, 'eq.KARL', `${table} must stay athlete-scoped`);
    if (table === 'athlete_data') return [{ value: { 'legacy-page-2': '2026-08-05', 'aaaaaaaa-0000-4000-8000-000000000005': '2026-09-30' } }];
    assert.equal(query.publish_state, 'eq.published', 'drafts stay invisible');
    if (query.or) {
      return programme.filter((row) => query.or.includes(`"${row.id}"`) || (row.notion_page_id && query.or.includes(`"${row.notion_page_id}"`)));
    }
    if (query.planned_date === 'gt.2026-08-09') return [programme[3]];
    if (query.planned_date === 'gte.2026-08-03') return [programme[0]];
    throw new Error('unexpected query');
  };
  const result = await plannedSessionsInRange('KARL', '2026-08-03', '2026-08-09',
    { rescheduledIds: ['aaaaaaaa-0000-4000-8000-000000000003', 'bad id;drop'] }, selectRows);
  assert.deepEqual(result.rows.map((row) => row.title), ['Moved in (cloud)', 'In range', 'Moved in (device)']);
  assert.equal(result.next.title, 'Next');
  assert.ok(!result.rows.some((row) => row.title === 'History'), 'a session moved OUT of the range is not fetched');
  const ranged = queries.find((q) => q.query.planned_date === 'gte.2026-08-03');
  assert.equal(ranged.query.and, '(planned_date.lte.2026-08-09)');
  assert.ok(Number(ranged.query.limit) <= 200, 'never the 1,000-row programme for Today');
  assert.doesNotMatch(queries.find((q) => q.query.or).query.or, /bad id/, 'client ids are validated');

  // The whole programme is still available, off the critical path.
  let whole;
  await programmeSessions('KARL', async (table, query) => { whole = { table, query }; return programme; });
  assert.equal(whole.table, 'planned_sessions');
  assert.equal(whole.query.limit, '1000');
  assert.equal(whole.query.publish_state, 'eq.published');
  assert.equal(whole.query.planned_date, undefined);
  // A client built before the split sends no scope and still gets everything.
  assert.match(apiSource, /if \(body\.scope === 'range'\)/);
});
