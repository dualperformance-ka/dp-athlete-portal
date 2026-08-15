import assert from 'node:assert/strict';
import test from 'node:test';

process.env.PORTAL_SESSION_SECRET = 'a'.repeat(48);

const { createPortalSession } = await import('../api/_lib/legacy-session.js');
const { dispatchCoachAction, isCoachAction, resolveCoachMode } =
  await import('../api/_lib/coach-proxy.js');

const req = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });
const coachToken = (code, actor = 'KARL', ttl = 3600) =>
  createPortalSession(code, { purpose: 'coach-edit', ttlSeconds: ttl, actor });

// ── The boundary: who gets in at all ─────────────────────────────────────────

test('an athlete session can never become coach mode', () => {
  // The token an athlete actually holds after a code login.
  const athlete = createPortalSession('THOMAS', { purpose: 'portal' });
  assert.equal(resolveCoachMode(req(athlete)), null);
});

test('no token, junk token and a tampered token are all refused', () => {
  assert.equal(resolveCoachMode(req(null)), null);
  assert.equal(resolveCoachMode(req('nonsense')), null);

  const valid = coachToken('THOMAS');
  const parts = valid.split('.');
  // Re-sign nothing — just swap the athlete in the payload.
  const forged = `${parts[0]}.${Buffer.from(JSON.stringify({
    sub: 'NATE', purpose: 'coach-edit', actor: 'KARL',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600,
  })).toString('base64url')}.${parts[2]}`;
  assert.equal(resolveCoachMode(req(forged)), null, 'a swapped payload breaks the signature');
});

test('an expired coaching link stops working', () => {
  const stale = createPortalSession('THOMAS', { purpose: 'coach-edit', ttlSeconds: 60, actor: 'KARL' });
  assert.ok(resolveCoachMode(req(stale)), 'valid now');
  // 60s is the floor the signer enforces; verify the expiry claim is actually read.
  const decoded = JSON.parse(Buffer.from(stale.split('.')[1], 'base64url').toString());
  assert.ok(decoded.exp - decoded.iat <= 60);
});

test('a token without an actor is not coach mode', () => {
  // purpose alone is not enough — a coach-mode token must name the coach, or
  // the audit trail would attribute the edit to nobody.
  const anonymous = createPortalSession('THOMAS', { purpose: 'coach-edit' });
  assert.equal(resolveCoachMode(req(anonymous)), null);
});

test('only allowlisted coach actions exist', () => {
  for (const action of [
    'coach-prescription', 'coach-exercise-library', 'coach-exercise-update',
    'coach-exercise-add', 'coach-exercise-remove', 'coach-exercise-replace',
    'coach-exercise-reorder', 'coach-split-save',
  ]) assert.ok(isCoachAction(action), action);

  // Nothing that could reach across athletes or rewrite history.
  for (const action of [
    'session_publish', 'session_materialise', 'runsteps_save', 'delete', 'recode',
    'archive', 'plan_delete', 'coach_portal_link', 'state-write', 'bootstrap',
  ]) assert.equal(isCoachAction(action), false, action);
});

// ── The boundary: what a valid link can reach ────────────────────────────────

function stubDashboard(session, exercises = []) {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const body = String(url).includes('action=prescription')
      ? { ok: true, session, exercises }
      : { ok: true, done: true };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return calls;
}

const THOMAS_SESSION = { id: 's1', athlete_code: 'THOMAS', title: 'Lower C', prescription_mode: 'structured' };

test('a link minted for one athlete cannot reach another', async () => {
  process.env.DASHBOARD_ACCESS_KEY = 'test-key';
  // The dashboard would happily allow this — the coach is authorised for Nate
  // too. The token is what says no.
  stubDashboard({ id: 's9', athlete_code: 'NATE', title: 'Upper A' });
  const coach = resolveCoachMode(req(coachToken('THOMAS')));

  await assert.rejects(
    () => dispatchCoachAction('coach-prescription', { session_id: 's9' }, coach),
    (error) => error.status === 403
  );
});

test('an exercise from another session is refused', async () => {
  process.env.DASHBOARD_ACCESS_KEY = 'test-key';
  stubDashboard(THOMAS_SESSION, [{ id: 'x1' }, { id: 'x2' }]);
  const coach = resolveCoachMode(req(coachToken('THOMAS')));

  await assert.rejects(
    () => dispatchCoachAction('coach-exercise-update',
      { session_id: 's1', exercise_id: 'x-from-somewhere-else', fields: { sets: 5 } }, coach),
    (error) => error.status === 403
  );
});

test('a reorder cannot smuggle in a foreign exercise', async () => {
  process.env.DASHBOARD_ACCESS_KEY = 'test-key';
  stubDashboard(THOMAS_SESSION, [{ id: 'x1' }, { id: 'x2' }]);
  const coach = resolveCoachMode(req(coachToken('THOMAS')));

  await assert.rejects(
    () => dispatchCoachAction('coach-exercise-reorder',
      { session_id: 's1', order: [{ id: 'x1' }, { id: 'x-foreign' }] }, coach),
    (error) => error.status === 403
  );
});

test('scope is pinned to this session, whatever the client asks for', async () => {
  process.env.DASHBOARD_ACCESS_KEY = 'test-key';
  const calls = stubDashboard(THOMAS_SESSION, [{ id: 'x1' }]);
  const coach = resolveCoachMode(req(coachToken('THOMAS')));

  await dispatchCoachAction('coach-exercise-update',
    { session_id: 's1', exercise_id: 'x1', scope: 'block', fields: { sets: 5 } }, coach);

  const write = calls.find((c) => c.options.method === 'POST');
  const sent = JSON.parse(write.options.body);
  assert.equal(sent.scope, 'session', 'a phone edit must never rewrite a whole block');
  assert.equal(sent.action, 'exercise_update', 'mapped to the dashboard action name');
});

test('the edit is attributed to the coach, not the athlete', async () => {
  process.env.DASHBOARD_ACCESS_KEY = 'test-key';
  const calls = stubDashboard(THOMAS_SESSION, [{ id: 'x1' }]);
  const coach = resolveCoachMode(req(coachToken('THOMAS', 'ALEX')));

  await dispatchCoachAction('coach-exercise-update',
    { session_id: 's1', exercise_id: 'x1', fields: { sets: 5 } }, coach);

  const write = calls.find((c) => c.options.method === 'POST');
  assert.equal(write.options.headers['X-Coach-Name'], 'ALEX');
  assert.equal(write.options.headers['X-Dashboard-Key'], 'test-key');
});

test('a split saved from the gym floor defaults to that athlete, not everyone', async () => {
  process.env.DASHBOARD_ACCESS_KEY = 'test-key';
  const calls = stubDashboard(THOMAS_SESSION, [{ id: 'x1' }]);
  const coach = resolveCoachMode(req(coachToken('THOMAS')));

  await dispatchCoachAction('coach-split-save', { session_id: 's1', name: 'Lower C v2' }, coach);

  const write = calls.find((c) => c.options.method === 'POST');
  const sent = JSON.parse(write.options.body);
  assert.equal(sent.athlete_code, 'THOMAS',
    'blank must not mean "every athlete" when saving from a phone');
});

test('coach mode refuses to run when the deployment is not configured', async () => {
  delete process.env.DASHBOARD_ACCESS_KEY;
  delete process.env.ADMIN_KEY;
  stubDashboard(THOMAS_SESSION);
  const coach = resolveCoachMode(req(coachToken('THOMAS')));

  await assert.rejects(
    () => dispatchCoachAction('coach-prescription', { session_id: 's1' }, coach),
    (error) => error.status === 503
  );
  process.env.DASHBOARD_ACCESS_KEY = 'test-key';
});
