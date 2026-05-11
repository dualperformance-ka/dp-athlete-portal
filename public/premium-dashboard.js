(function () {
  var STORAGE_KEY = 'dp_premium_checkins';
  var mounted = false;

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, function (char) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;',
      }[char];
    });
  }

  function getCode() {
    return new URLSearchParams(window.location.search).get('code') || localStorage.getItem('dp_auth_code') || '';
  }

  function getAthleteName() {
    var heroName = $('.hn');
    if (heroName && heroName.textContent.trim()) return heroName.textContent.trim();
    var goalsName = $('.goals-name');
    if (goalsName && goalsName.textContent.trim()) return goalsName.textContent.trim();
    return 'Athlete';
  }

  function getTodaySession() {
    var todayPanelTitle = $('.todayname');
    var firstSession = $('.sname');
    var title = todayPanelTitle || firstSession;
    var meta = $('.todaymeta') || $('.smeta');

    return {
      title: title && title.textContent.trim() ? title.textContent.trim() : 'Today\'s session',
      meta: meta && meta.textContent.trim() ? meta.textContent.trim() : 'Complete the work, log the response, tell the coach what matters.',
    };
  }

  function readCheckins() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch (error) {
      return [];
    }
  }

  function writeCheckin(entry) {
    var entries = readCheckins();
    entries.unshift(entry);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, 20)));
  }

  function latestCheckin() {
    return readCheckins()[0] || null;
  }

  function scoreLabel(score) {
    if (!score && score !== 0) return 'No data';
    if (score >= 8) return 'Ready';
    if (score >= 5) return 'Steady';
    return 'Needs review';
  }

  function coachAlert(values) {
    if (values.painFlag) return 'Coach review';
    if (values.energy <= 3 || values.motivation <= 3 || values.soreness >= 8) return 'Watch';
    return 'Normal';
  }

  function injectStyles() {
    if ($('#premiumDashboardStyles')) return;
    var style = document.createElement('style');
    style.id = 'premiumDashboardStyles';
    style.textContent = `
      .premium-command{background:#101010;color:#fff;border-radius:14px;padding:18px;margin:0 0 16px;box-shadow:0 16px 34px rgba(0,0,0,.16)}
      .premium-command__top{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;margin-bottom:14px}
      .premium-kicker{font-family:var(--mono,monospace);font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:rgba(255,255,255,.48);margin-bottom:4px}
      .premium-title{font-family:var(--display,sans-serif);font-size:28px;line-height:1;text-transform:uppercase;letter-spacing:.03em;font-weight:800}
      .premium-badge{font-family:var(--mono,monospace);font-size:10px;text-transform:uppercase;letter-spacing:.07em;border:1px solid rgba(255,255,255,.16);border-radius:999px;padding:6px 9px;color:rgba(255,255,255,.72);white-space:nowrap}
      .premium-grid{display:grid;grid-template-columns:1.2fr .8fr;gap:10px;margin-bottom:12px}
      .premium-card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09);border-radius:10px;padding:13px}
      .premium-label{font-family:var(--mono,monospace);font-size:9px;text-transform:uppercase;letter-spacing:.09em;color:rgba(255,255,255,.48);margin-bottom:6px}
      .premium-session{font-family:var(--display,sans-serif);font-size:23px;line-height:1;text-transform:uppercase;color:#f59e0b;font-weight:800}
      .premium-copy{font-size:13px;line-height:1.45;color:rgba(255,255,255,.72);margin-top:6px}
      .premium-readiness{font-family:var(--display,sans-serif);font-size:34px;line-height:1;font-weight:800;color:#bfdbfe}
      .premium-actions{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
      .premium-action{border:1px solid rgba(255,255,255,.11);background:rgba(255,255,255,.05);color:#fff;border-radius:9px;padding:11px 9px;text-align:left;cursor:pointer;font-family:var(--body,sans-serif)}
      .premium-action strong{display:block;font-family:var(--display,sans-serif);font-size:16px;text-transform:uppercase;letter-spacing:.03em;line-height:1}
      .premium-action span{display:block;font-size:11px;color:rgba(255,255,255,.52);margin-top:4px;line-height:1.3}
      .premium-panel{display:none;background:var(--surface,#fff);border:1px solid var(--border,rgba(0,0,0,.08));border-radius:12px;padding:16px;margin-bottom:16px}
      .premium-panel.open{display:block}
      .premium-panel h3{font-family:var(--display,sans-serif);font-size:23px;text-transform:uppercase;letter-spacing:.03em;margin:0 0 4px}
      .premium-panel p{font-size:13px;color:var(--muted,#5a5a5a);margin:0 0 14px;line-height:1.5}
      .premium-form-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
      .premium-field{display:flex;flex-direction:column;gap:5px;margin-bottom:10px}
      .premium-field label{font-family:var(--mono,monospace);font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim,#999)}
      .premium-field input,.premium-field textarea{width:100%;border:1px solid var(--border-mid,rgba(0,0,0,.13));border-radius:8px;background:var(--surface2,#eceae5);padding:11px 12px;font:inherit;outline:none;color:var(--text,#0a0a0a)}
      .premium-field textarea{min-height:92px;resize:vertical;line-height:1.45}
      .premium-check{display:flex;gap:9px;align-items:center;margin:2px 0 12px;font-size:13px;color:var(--muted,#5a5a5a)}
      .premium-check input{width:18px;height:18px;accent-color:#0a0a0a}
      .premium-submit{width:100%;border:0;background:#0a0a0a;color:#fff;border-radius:9px;padding:13px;font-family:var(--display,sans-serif);font-size:17px;text-transform:uppercase;font-weight:800;letter-spacing:.05em;cursor:pointer}
      .premium-submit.saved{background:#15803d}
      .coach-alert{border-color:rgba(245,158,11,.35);background:rgba(245,158,11,.08)}
      @media(max-width:560px){.premium-grid,.premium-actions,.premium-form-grid{grid-template-columns:1fr}.premium-title{font-size:24px}.premium-command__top{display:block}.premium-badge{display:inline-block;margin-top:10px}}
    `;
    document.head.appendChild(style);
  }

  function dashboardMarkup() {
    var session = getTodaySession();
    var checkin = latestCheckin();
    var readiness = checkin ? Math.round((checkin.energy + checkin.sleep + checkin.motivation + (11 - checkin.soreness)) / 4) : null;
    var alert = checkin ? checkin.alertLevel : 'Awaiting check-in';

    return `
      <section class="premium-command" id="premiumCommandCenter">
        <div class="premium-command__top">
          <div>
            <div class="premium-kicker">Command Center</div>
            <div class="premium-title">Today\'s athlete brief</div>
          </div>
          <div class="premium-badge">${esc(alert)}</div>
        </div>
        <div class="premium-grid">
          <div class="premium-card">
            <div class="premium-label">Today\'s session</div>
            <div class="premium-session">${esc(session.title)}</div>
            <div class="premium-copy">${esc(session.meta)}</div>
          </div>
          <div class="premium-card ${alert === 'Coach review' ? 'coach-alert' : ''}">
            <div class="premium-label">Readiness</div>
            <div class="premium-readiness">${readiness == null ? '--' : readiness + '/10'}</div>
            <div class="premium-copy">${esc(scoreLabel(readiness))}</div>
          </div>
        </div>
        <div class="premium-actions">
          <button class="premium-action" data-premium-open="checkin"><strong>Check in</strong><span>Energy, sleep, soreness, motivation.</span></button>
          <button class="premium-action" data-premium-open="session"><strong>Log session</strong><span>RPE, notes, and pain flag.</span></button>
          <button class="premium-action" data-premium-open="coach"><strong>Coach note</strong><span>What needs attention today.</span></button>
        </div>
      </section>
      <section class="premium-panel" id="premiumCheckinPanel">
        <h3>Readiness Check-In</h3>
        <p>This turns athlete feedback into a simple coach signal before training quality drops.</p>
        <form id="premiumCheckinForm">
          <div class="premium-form-grid">
            ${numberField('energy', 'Energy', 7)}
            ${numberField('sleep', 'Sleep quality', 7)}
            ${numberField('soreness', 'Soreness', 4)}
            ${numberField('motivation', 'Motivation', 7)}
            ${numberField('rpe', 'Session RPE', 7)}
          </div>
          <label class="premium-check"><input type="checkbox" name="painFlag"> Pain or injury concern today</label>
          <div class="premium-field"><label>Notes for coach</label><textarea name="notes" placeholder="Anything that changes how today should be coached?"></textarea></div>
          <button class="premium-submit" type="submit">Save athlete check-in</button>
        </form>
      </section>
      <section class="premium-panel" id="premiumCoachPanel">
        <h3>Coach Focus</h3>
        <p id="premiumCoachCopy">Hold the standard on the key session, then use the check-in to flag fatigue, pain, or low motivation before it becomes a bigger problem.</p>
      </section>
    `;
  }

  function numberField(name, label, value) {
    return `<div class="premium-field"><label>${esc(label)} / 10</label><input name="${esc(name)}" type="number" min="1" max="10" value="${value}"></div>`;
  }

  function mount() {
    if (mounted || $('#premiumCommandCenter')) return;
    var target = $('.tab-content.active') || $('.tab-content') || document.body;
    if (!target || target === document.body && !$('.hn')) return;

    injectStyles();
    target.insertAdjacentHTML('afterbegin', dashboardMarkup());
    bindEvents();
    mounted = true;
  }

  function openPanel(name) {
    var checkin = $('#premiumCheckinPanel');
    var coach = $('#premiumCoachPanel');
    if (checkin) checkin.classList.toggle('open', name === 'checkin' || name === 'session');
    if (coach) coach.classList.toggle('open', name === 'coach');
  }

  function bindEvents() {
    document.querySelectorAll('[data-premium-open]').forEach(function (button) {
      button.addEventListener('click', function () {
        openPanel(button.getAttribute('data-premium-open'));
      });
    });

    var form = $('#premiumCheckinForm');
    if (!form) return;

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      var data = new FormData(form);
      var session = getTodaySession();
      var entry = {
        athleteCode: getCode(),
        athleteName: getAthleteName(),
        sessionTitle: session.title,
        energy: Number(data.get('energy')),
        sleep: Number(data.get('sleep')),
        soreness: Number(data.get('soreness')),
        motivation: Number(data.get('motivation')),
        rpe: Number(data.get('rpe')),
        painFlag: data.get('painFlag') === 'on',
        notes: String(data.get('notes') || '').trim(),
        createdAt: new Date().toISOString(),
      };
      entry.alertLevel = coachAlert(entry);
      writeCheckin(entry);

      var button = $('.premium-submit', form);
      button.textContent = 'Saving...';
      button.disabled = true;

      try {
        var response = await fetch('/api/checkin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entry),
        });
        if (!response.ok) throw new Error('Check-in API unavailable');
        var saved = await response.json();
        entry.alertLevel = saved.alertLevel || entry.alertLevel;
        writeCheckin(entry);
        button.textContent = entry.alertLevel === 'Coach Review' ? 'Coach alerted' : 'Check-in saved';
      } catch (error) {
        button.textContent = 'Saved on device';
      }

      button.classList.add('saved');
      setTimeout(function () {
        mounted = false;
        var command = $('#premiumCommandCenter');
        var panel = $('#premiumCheckinPanel');
        var coach = $('#premiumCoachPanel');
        if (command) command.remove();
        if (panel) panel.remove();
        if (coach) coach.remove();
        mount();
      }, 900);
    });
  }

  function observeTabs() {
    document.addEventListener('click', function (event) {
      if (event.target.closest('.tab')) {
        setTimeout(function () {
          mounted = false;
          mount();
        }, 80);
      }
    });
  }

  function boot() {
    observeTabs();
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      mount();
      if (mounted || tries > 40) clearInterval(timer);
    }, 250);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
