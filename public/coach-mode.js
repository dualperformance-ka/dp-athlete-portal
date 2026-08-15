/* Dual Performance — coach mode inside the athlete portal.
 *
 * THIS FILE IS NOT PART OF THE ATHLETE BUNDLE. It is injected at runtime by
 * js/10-boot.js only when the URL carries a ?coach= token, so an athlete opening
 * their app never downloads it. That is a convenience, not the security
 * boundary — the boundary is the signed token the server checks on every call.
 *
 * Everything here talks to /api/portal-data, which forwards to the coaches
 * dashboard. No programming logic lives in the portal.
 */
(function () {
  'use strict';

  var token = null;
  var state = { session: null, exercises: [], sessions: [], library: null, busy: false };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(id) { return document.getElementById(id); }

  async function api(action, payload) {
    var response = await fetch('/api/portal-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(Object.assign({ action: action }, payload || {})),
      cache: 'no-store',
    });
    var data = {};
    try { data = await response.json(); } catch (e) {}
    if (response.status === 403) {
      throw new Error(data.error === 'coach_link_invalid'
        ? 'This coaching link has expired. Generate a new one from the dashboard.'
        : (data.error || 'Not allowed'));
    }
    if (!response.ok || data.ok === false) throw new Error(data.error || ('Failed (' + response.status + ')'));
    return data;
  }

  function toast(message, tone) {
    var box = el('cm-toast');
    if (!box) return;
    box.textContent = message;
    box.className = 'cm-toast is-visible' + (tone ? ' is-' + tone : '');
    clearTimeout(box._t);
    box._t = setTimeout(function () { box.className = 'cm-toast'; }, 4200);
  }

  // ── Shell ──────────────────────────────────────────────────────────────────

  function mount(athleteCode) {
    document.body.insertAdjacentHTML('beforeend',
      '<div class="cm-bar" id="cm-bar">' +
        '<span class="cm-pill">Coach Mode</span>' +
        '<span class="cm-who">Editing ' + esc(athleteCode) + '</span>' +
        '<button type="button" class="cm-btn" id="cm-open">Edit a session</button>' +
        '<button type="button" class="cm-btn cm-quiet" id="cm-exit">Exit</button>' +
      '</div>' +
      '<div class="cm-sheet hidden" id="cm-sheet" role="dialog" aria-modal="true" aria-label="Coach mode">' +
        '<div class="cm-card">' +
          '<div class="cm-head">' +
            '<div class="cm-title" id="cm-title">Choose a session</div>' +
            '<button type="button" class="cm-x" id="cm-close" aria-label="Close">&times;</button>' +
          '</div>' +
          '<div class="cm-body" id="cm-body"></div>' +
          '<div class="cm-foot" id="cm-foot"></div>' +
        '</div>' +
      '</div>' +
      '<div class="cm-toast" id="cm-toast"></div>');

    el('cm-open').addEventListener('click', openSessionList);
    el('cm-close').addEventListener('click', closeSheet);
    el('cm-exit').addEventListener('click', exitCoachMode);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !el('cm-sheet').classList.contains('hidden')) closeSheet();
    });
    document.body.classList.add('cm-active');
  }

  function closeSheet() { el('cm-sheet').classList.add('hidden'); }
  function openSheet() { el('cm-sheet').classList.remove('hidden'); }

  function exitCoachMode() {
    // Strip the token from the URL so a shared screen or a back button does not
    // leave coach mode armed.
    var url = new URL(location.href);
    url.searchParams.delete('coach');
    location.replace(url.toString());
  }

  // ── Session list ───────────────────────────────────────────────────────────
  // Read from the sessions the portal has already loaded for this athlete, so
  // coach mode shows exactly the week the coach is looking at.

  function visibleSessions() {
    var list = (typeof window.sessions !== 'undefined' && Array.isArray(window.sessions))
      ? window.sessions
      : (typeof sessions !== 'undefined' && Array.isArray(sessions) ? sessions : []);
    return list.filter(function (s) {
      return s && s.id && typeof getType === 'function' ? getType(s) === 'strength' : false;
    });
  }

  function openSessionList() {
    openSheet();
    el('cm-title').textContent = 'Choose a session';
    el('cm-foot').innerHTML = '';
    var list = visibleSessions();
    if (!list.length) {
      el('cm-body').innerHTML = '<div class="cm-empty">No strength sessions in the week on screen. ' +
        'Page to the week you want, then reopen this.</div>';
      return;
    }
    el('cm-body').innerHTML = '<div class="cm-list">' + list.map(function (s) {
      return '<button type="button" class="cm-row" data-id="' + esc(s.id) + '">' +
        '<span class="cm-row-name">' + esc(s.name || 'Session') + '</span>' +
        '<span class="cm-row-meta">' + esc(s.date || '') + '</span>' +
      '</button>';
    }).join('') + '</div>';
    Array.prototype.forEach.call(el('cm-body').querySelectorAll('.cm-row'), function (button) {
      button.addEventListener('click', function () { openSession(button.getAttribute('data-id')); });
    });
  }

  // ── One session ────────────────────────────────────────────────────────────

  async function openSession(sessionId) {
    el('cm-body').innerHTML = '<div class="cm-empty">Loading…</div>';
    el('cm-foot').innerHTML = '';
    try {
      var data = await api('coach-prescription', { session_id: sessionId });
      state.session = data.session;
      state.exercises = data.exercises || [];
      renderSession();
    } catch (error) {
      el('cm-body').innerHTML = '<div class="cm-empty cm-error">' + esc(error.message) + '</div>';
    }
  }

  function renderSession() {
    var s = state.session;
    el('cm-title').textContent = s.title || 'Session';

    if (s.prescription_mode !== 'structured') {
      el('cm-body').innerHTML = '<div class="cm-empty">' +
        'This session still uses a shared split, so editing it here would change it for ' +
        'every athlete. Take control of it in the dashboard first.</div>';
      el('cm-foot').innerHTML = '';
      return;
    }

    el('cm-body').innerHTML = '<div class="cm-ex-list">' + state.exercises.map(function (ex) {
      return '<div class="cm-ex" data-id="' + esc(ex.id) + '">' +
        '<div class="cm-ex-head">' +
          '<button type="button" class="cm-ex-name" data-act="replace">' + esc(ex.exercise_name) + '</button>' +
          '<button type="button" class="cm-x cm-danger" data-act="remove" aria-label="Remove">&times;</button>' +
        '</div>' +
        '<div class="cm-grid">' +
          num('Sets', 'sets', ex.sets) +
          num('Reps', 'rep_min', ex.rep_min) +
          num('to', 'rep_max', ex.rep_max) +
          num('RPE', 'rpe', ex.rpe) +
          num('Rest', 'rest_seconds', ex.rest_seconds) +
        '</div>' +
      '</div>';
    }).join('') + '</div>';

    el('cm-foot').innerHTML =
      '<button type="button" class="cm-btn" id="cm-add">+ Exercise</button>' +
      '<button type="button" class="cm-btn cm-primary" id="cm-saveas">Save as split</button>';

    bindSession();
  }

  function num(label, field, value) {
    return '<label class="cm-f"><span>' + esc(label) + '</span>' +
      '<input class="cm-input" type="number" step="any" data-field="' + field + '" ' +
      'value="' + (value == null ? '' : esc(value)) + '" aria-label="' + esc(label) + '"></label>';
  }

  function bindSession() {
    Array.prototype.forEach.call(el('cm-body').querySelectorAll('.cm-ex'), function (row) {
      var id = row.getAttribute('data-id');
      Array.prototype.forEach.call(row.querySelectorAll('[data-field]'), function (input) {
        input.addEventListener('change', function () { saveField(id, input); });
      });
      Array.prototype.forEach.call(row.querySelectorAll('[data-act]'), function (button) {
        button.addEventListener('click', function () {
          if (button.getAttribute('data-act') === 'remove') return removeExercise(id);
          openLibrary(id);
        });
      });
    });
    el('cm-add').addEventListener('click', function () { openLibrary(null); });
    el('cm-saveas').addEventListener('click', openSaveAs);
  }

  async function saveField(id, input) {
    var fields = {};
    var raw = input.value;
    fields[input.getAttribute('data-field')] = raw === '' ? null : Number(raw);
    try {
      await api('coach-exercise-update', {
        session_id: state.session.id, exercise_id: id, fields: fields,
      });
      toast('Saved', 'ok');
    } catch (error) {
      toast(error.message, 'bad');
      openSession(state.session.id);
    }
  }

  async function removeExercise(id) {
    var ex = state.exercises.find(function (row) { return row.id === id; });
    if (!confirm('Remove ' + (ex ? ex.exercise_name : 'this exercise') + ' from this session?')) return;
    try {
      await api('coach-exercise-remove', { session_id: state.session.id, exercise_id: id });
      await openSession(state.session.id);
      toast('Removed', 'ok');
    } catch (error) { toast(error.message, 'bad'); }
  }

  // ── Library ────────────────────────────────────────────────────────────────

  var replacingId = null;

  async function openLibrary(exerciseId) {
    replacingId = exerciseId;
    el('cm-title').textContent = exerciseId ? 'Replace exercise' : 'Add exercise';
    el('cm-body').innerHTML = '<div class="cm-empty">Loading library…</div>';
    el('cm-foot').innerHTML = '<button type="button" class="cm-btn" id="cm-back">← Back</button>';
    el('cm-back').addEventListener('click', function () { openSession(state.session.id); });

    if (!state.library) {
      try { state.library = await api('coach-exercise-library', {}); }
      catch (error) { el('cm-body').innerHTML = '<div class="cm-empty cm-error">' + esc(error.message) + '</div>'; return; }
    }
    renderLibrary('');
  }

  function renderLibrary(term) {
    var lib = state.library;
    var rows = term
      ? lib.results.filter(function (r) { return r.name.toLowerCase().indexOf(term.toLowerCase()) >= 0; })
      : lib.results;

    el('cm-body').innerHTML =
      '<input type="search" class="cm-input cm-search" id="cm-search" placeholder="Filter…" value="' + esc(term) + '">' +
      '<div class="cm-cats" id="cm-cats">' + lib.categories.map(function (c) {
        return '<button type="button" class="cm-cat" data-cat="' + esc(c) + '">' + esc(c) + '</button>';
      }).join('') + '</div>' +
      '<div class="cm-list">' + rows.slice(0, 200).map(function (r) {
        return '<button type="button" class="cm-row" data-id="' + esc(r.id) + '" data-name="' + esc(r.name) + '">' +
          '<span class="cm-row-name">' + esc(r.name) + '</span>' +
          '<span class="cm-row-meta">' + esc([r.category, r.equipment].filter(Boolean).join(' · ')) + '</span>' +
        '</button>';
      }).join('') + '</div>';

    var search = el('cm-search');
    search.addEventListener('input', function () { renderLibrary(search.value); });
    Array.prototype.forEach.call(el('cm-cats').querySelectorAll('.cm-cat'), function (button) {
      button.addEventListener('click', function () { renderLibrary(button.getAttribute('data-cat')); });
    });
    Array.prototype.forEach.call(el('cm-body').querySelectorAll('.cm-row'), function (button) {
      button.addEventListener('click', function () {
        pick(button.getAttribute('data-id'), button.getAttribute('data-name'));
      });
    });
  }

  async function pick(libraryId, name) {
    try {
      if (replacingId) {
        await api('coach-exercise-replace', {
          session_id: state.session.id, exercise_id: replacingId,
          exercise_name: name, exercise_library_id: libraryId,
        });
      } else {
        await api('coach-exercise-add', {
          session_id: state.session.id,
          fields: { exercise_name: name, exercise_id: libraryId, sets: 3, rep_min: 8, rep_max: 12, rest_seconds: 90 },
        });
      }
      await openSession(state.session.id);
      toast(replacingId ? 'Replaced' : 'Added', 'ok');
    } catch (error) { toast(error.message, 'bad'); }
  }

  // ── Save as split ──────────────────────────────────────────────────────────

  function openSaveAs() {
    el('cm-title').textContent = 'Save as split';
    el('cm-body').innerHTML =
      '<label class="cm-lbl" for="cm-split-name">Split name</label>' +
      '<input type="text" class="cm-input" id="cm-split-name" value="' + esc(state.session.title || '') + '">' +
      '<p class="cm-note">Saved for <strong>' + esc(state.session.athlete_code) + '</strong> only. ' +
      'Use the dashboard to make it available to every athlete.</p>';
    el('cm-foot').innerHTML =
      '<button type="button" class="cm-btn" id="cm-back">← Back</button>' +
      '<button type="button" class="cm-btn cm-primary" id="cm-split-go">Save split</button>';
    el('cm-back').addEventListener('click', function () { openSession(state.session.id); });
    el('cm-split-go').addEventListener('click', async function () {
      var name = el('cm-split-name').value.trim();
      if (!name) return toast('Give the split a name', 'warn');
      var button = el('cm-split-go');
      button.disabled = true; button.textContent = 'Saving…';
      try {
        var result = await api('coach-split-save', { session_id: state.session.id, name: name });
        toast('Saved "' + name + '" — ' + result.exercises + ' exercises', 'ok');
        openSession(state.session.id);
      } catch (error) {
        toast(error.message, 'bad');
        button.disabled = false; button.textContent = 'Save split';
      }
    });
  }

  // ── Boot ───────────────────────────────────────────────────────────────────

  window.DP_COACH_MODE = {
    start: function (coachToken, athleteCode) {
      token = coachToken;
      mount(athleteCode || '');
    },
  };
})();
