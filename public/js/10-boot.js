// ── INIT ──────────────────────────────────────────────────────────────────────
var urlCode=new URLSearchParams(location.search).get('code');
// Sign-out is coach-only: the dashboard opens the portal with ?code=, athletes launch the installed app without it.
if(urlCode){var _lb=document.getElementById('logoutBtn');if(_lb)_lb.style.display='';}
// Session-aware boot: resolve the Supabase auth session FIRST so an
// email-migrated athlete reopening the PWA goes straight to the portal (no
// login flash). Legacy athletes have no session and fall through to the
// exact pre-migration paths (?code= link or saved dp_auth_code).
async function bootPortal(){
  // Client-side UI flag from config.js — the email toggle stays hidden until
  // enabled, so shipping this code changes nothing visible by default.
  if(typeof EMAIL_AUTH_UI!=='undefined'&&EMAIL_AUTH_UI){
    var _emailToggle=document.getElementById('loginMethodToggle');
    if(_emailToggle)_emailToggle.style.display='';
  }
  if(urlCode){doLogin(urlCode);return;} // legacy coach link — unchanged
  // Fast path: no persisted auth session in storage → skip loading supabase-js
  // before boot, so legacy athletes start exactly as fast as before.
  var hasStoredSession=false;
  try{hasStoredSession=!!localStorage.getItem('dp-portal-auth');}catch(e){}
  try{
    var session=hasStoredSession?await getAuthSession():null;
    if(session){
      _authToken=session.access_token;
      var me=await resolveAuthedAthlete();
      if(me&&me.ok&&me.exists&&me.code){
        if(me.active===false){showPausedScreen(me.name);return;}
        // Same pipeline as a code login → identical portal, same athlete_code,
        // same history. The session token rides along on API calls.
        doLogin(me.code);
        return;
      }
      if(me&&me.error==='invalid_session') await authSignOut();
      // no_linked_athlete: valid session but the coach hasn't enrolled this
      // email — fall through so a legacy saved code (if any) still works.
    }
  }catch(e){console.warn('Auth boot failed, falling back to legacy login',e);}
  var savedCode=localStorage.getItem('dp_auth_code');
  if(savedCode){doLogin(savedCode);return;}
  document.getElementById('loginScreen').style.display='block';
  // Email-migrated athletes land on the email panel by default (with a
  // one-tap "send a new code" recovery when their session expired).
  if(localStorage.getItem('dp_auth_method')==='email'&&typeof showEmailLogin==='function'){
    showEmailLogin(true);
  }
}
bootPortal();

// Mobile portal header: keep the full-width brand bar at the top, then turn it
// into a compact glass surface once content is moving underneath it.
function updateFloatingPortalHeader(){
  var portal=document.getElementById('portalScreen');
  var active=!!(portal&&portal.style.display!=='none'&&window.scrollY>18);
  document.body.classList.toggle('portal-header-scrolled',active);
}
window.addEventListener('scroll',updateFloatingPortalHeader,{passive:true});
window.addEventListener('resize',updateFloatingPortalHeader);
updateFloatingPortalHeader();

// ============================================================================
// RUNNING LIBRARY INTEGRATION
// Enhances calendar sessions with full workout details from the Supabase
// session_library table (source of truth — replaces the Notion library)
// ============================================================================

const RUNNING_LIBRARY_BY_ID = {};

// Fetch all Running Library workouts on page load
var RUN_LIB_CACHE_KEY='dp_run_library_cache_v2'; // v2 = Supabase-backed
var RUN_LIB_CACHE_TTL=60*60*1000; // 1 hour

async function loadRunningLibrary() {
  try {
    // Try localStorage cache first (stores processed data)
    try {
      var cached=JSON.parse(localStorage.getItem(RUN_LIB_CACHE_KEY)||'null');
      if(cached && cached.ts && (Date.now()-cached.ts)<RUN_LIB_CACHE_TTL && cached.byId){
        var ids=Object.keys(cached.byId);
        if(ids.length){
          console.log('Run library: loaded from cache ('+ids.length+' workouts)');
          ids.forEach(function(id){
            var entry=cached.byId[id];
            RUNNING_LIBRARY_BY_ID[id]=entry;
            runLibraryById[id]=Object.assign({},entry,{warmUp:entry.warmup||'',coolDown:entry.cooldown||'',sessionGoal:entry.goal||'',recoveryType:entry.recovery||''});
            if(entry.name) runLibraryByName[entry.name.toLowerCase()]=runLibraryById[id];
          });
          return;
        }
      }
    } catch(e){}

    if(!sbClient) return;
    console.log('Loading Running Library from Supabase...');
    var res = await sbClient.from('session_library').select('*').eq('archived', false);
    if (res.error || !res.data) { console.warn('Session library load failed', res.error); return; }
    processLibraryRows(res.data);
    // Cache the processed data
    try {
      localStorage.setItem(RUN_LIB_CACHE_KEY, JSON.stringify({ts:Date.now(), byId:RUNNING_LIBRARY_BY_ID}));
    } catch(e){}
    console.log('Running Library loaded from Supabase:', res.data.length, 'workouts');
  } catch (error) {
    console.error('Failed to load Running Library:', error);
  }
}

// Map a Supabase session_library row to the shape the portal renderers expect.
// Each template is keyed by BOTH its Supabase uuid and its migrated Notion page
// id, so old planned sessions linked by Notion id still resolve.
function processLibraryRows(rows) {
  rows.forEach(function(r) {
    var mapped = {
      name: r.name || '', type: r.session_type || '', description: r.description || '',
      difficulty: r.difficulty || '', distance: r.distance || '', duration: r.duration || '',
      rpe: r.rpe || '', intensity: r.intensity || '', phase: r.phase || '',
      surface: r.surface || '', fatigue: r.fatigue || '', recovery: r.recovery || '',
      goal: r.goal || '', warmup: r.warm_up || '', cooldown: r.cool_down || '',
      prereqs: r.prereqs || '', slot: r.slot || '', targetPace: r.target_pace || '',
      tags: '', alternative: r.alternative || ''
    };
    [r.id, r.notion_page_id].filter(Boolean).forEach(function(id) {
      RUNNING_LIBRARY_BY_ID[id] = mapped;
      runLibraryById[id] = Object.assign({}, runLibraryById[id] || {}, mapped, {
        warmUp: mapped.warmup, coolDown: mapped.cooldown,
        sessionGoal: mapped.goal, recoveryType: mapped.recovery
      });
    });
    if (mapped.name) runLibraryByName[mapped.name.toLowerCase()] = runLibraryById[r.id];
  });
}

// Get workout details from pre-loaded library using page ID
function getRunningLibraryWorkout(workoutIds) {
  if (!workoutIds || !workoutIds.length) return null;
  const workoutId = workoutIds[0];
  return RUNNING_LIBRARY_BY_ID[workoutId] || null;
}

function nl2brSafe(text){
  return esc(String(text||'')).replace(/\n/g,'<br>');
}

function detailRow(label,value){
  if(!value) return '';
  return `
    <div style="margin-bottom:12px;">
      <div style="font-family:var(--mono);font-size:10px;text-transform:uppercase;font-weight:600;letter-spacing:0.08em;color:var(--muted);margin-bottom:6px;">
        ${label}
      </div>
      <div style="font-size:15px;line-height:1.55;color:var(--text);white-space:normal;">
        ${nl2brSafe(value)}
      </div>
    </div>
  `;
}

// Enhanced workout modal with session-aware fallback logic
async function showEnhancedWorkoutModal(sessionIndex) {
  const s = sessions[sessionIndex];
  if (!s) return;

  let modal = document.getElementById('enhancedWorkoutModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'enhancedWorkoutModal';
    modal.style.cssText = 'display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:10000;align-items:center;justify-content:center;padding:20px;overflow-y:auto;';
    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) {
      if (e.target === modal) closeEnhancedModal();
    });
  }

  const resolved = resolveRunDisplay(s);
  const workout = resolved && resolved.related ? resolved.related : null;
  const meta = resolved && resolved.meta ? resolved.meta : null;

  const title =
    (resolved && resolved.title) ||
    (workout && workout.name) ||
    s.runningSession ||
    s.name ||
    'Run';

  const description =
    (workout && workout.description) ||
    (resolved && resolved.detail) ||
    s.runDetails ||
    '';

  const type =
    (workout && workout.type) ||
    (meta && meta.type) ||
    s.sessionType ||
    '';

  const goal =
    (workout && workout.goal) ||
    (meta && meta.sessionGoal) ||
    '';

  const intensity =
    (workout && workout.intensity) ||
    (meta && meta.intensity) ||
    s.intensity ||
    '';

  const phase =
    (workout && workout.phase) ||
    (meta && meta.phase) ||
    s.week ||
    '';

  const surface =
    (workout && workout.surface) ||
    (meta && meta.surface) ||
    '';

  const difficulty =
    (workout && workout.difficulty) ||
    (meta && meta.difficulty) ||
    '';

  const distance =
    (workout && workout.distance) ||
    (meta && meta.distance) ||
    '';

  const duration =
    (workout && workout.duration) ||
    (meta && meta.duration) ||
    '';

  const rpe =
    (workout && workout.rpe) ||
    (meta && meta.rpe) ||
    '';

  const warmup =
    (workout && workout.warmup) ||
    (workout && workout.warmUp) ||
    (meta && meta.warmUp) ||
    '';

  const cooldown =
    (workout && workout.cooldown) ||
    (workout && workout.coolDown) ||
    (meta && meta.coolDown) ||
    '';

  const recovery =
    (workout && workout.recovery) ||
    (workout && workout.recoveryType) ||
    (meta && meta.recoveryType) ||
    '';

  const modalHTML = `
    <div style="max-width:600px;width:100%;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:28px;margin:auto;max-height:90vh;overflow-y:auto;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border);">
        <div style="flex:1;">
          <div style="font-family:var(--display);font-size:26px;font-weight:700;text-transform:uppercase;letter-spacing:0.02em;color:var(--text);line-height:1.2;">
            ${esc(title)}
          </div>
          ${type ? `<div style="display:inline-block;margin-top:8px;padding:4px 12px;background:rgba(180,83,9,0.1);border:1px solid rgba(180,83,9,0.2);border-radius:6px;font-family:var(--mono);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--run);">${esc(type)}</div>` : ''}
        </div>
        <button onclick="closeEnhancedModal()" style="background:transparent;border:none;color:var(--muted);font-size:28px;cursor:pointer;line-height:1;padding:0;margin-left:16px;">&times;</button>
      </div>

      <div style="color:var(--text);">
        ${detailRow('Description', description)}
        ${detailRow('Session Goal', goal)}

        ${(intensity || phase || surface || difficulty || distance || duration || rpe || recovery || warmup || cooldown) ? `
          <div style="margin-top:18px;">
            <div style="font-family:var(--mono);font-size:10px;text-transform:uppercase;font-weight:600;letter-spacing:0.08em;color:var(--muted);margin-bottom:10px;">
              Workout Details
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:14px;line-height:1.6;color:var(--text);">
              ${intensity ? `<div><strong>Intensity Zone:</strong> ${esc(intensity)}</div>` : ''}
              ${phase ? `<div><strong>Phase:</strong> ${esc(phase)}</div>` : ''}
              ${surface ? `<div><strong>Surface:</strong> ${esc(surface)}</div>` : ''}
              ${difficulty ? `<div><strong>Difficulty:</strong> ${esc(difficulty)}</div>` : ''}
              ${distance ? `<div><strong>Distance:</strong> ${esc(distance)}</div>` : ''}
              ${duration ? `<div><strong>Duration:</strong> ${esc(duration)}</div>` : ''}
              ${rpe ? `<div><strong>RPE:</strong> ${esc(rpe)}</div>` : ''}
              ${recovery ? `<div><strong>Recovery:</strong> ${esc(recovery)}</div>` : ''}
            </div>
            ${warmup ? `<div style="margin-top:10px;font-size:14px;line-height:1.6;color:var(--text);"><strong>Warm Up:</strong> ${nl2brSafe(warmup)}</div>` : ''}
            ${cooldown ? `<div style="margin-top:10px;font-size:14px;line-height:1.6;color:var(--text);"><strong>Cool Down:</strong> ${nl2brSafe(cooldown)}</div>` : ''}
          </div>
        ` : ''}

        ${!description && !goal && !(intensity || phase || surface || difficulty || distance || duration || rpe || recovery || warmup || cooldown) ? `
          <div style="padding:24px;background:var(--surface2);border-radius:8px;text-align:center;">
            <div style="font-family:var(--mono);font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:0.06em;">No detailed run data found</div>
            <div style="font-size:13px;color:var(--muted);margin-top:6px;">Basic session: ${esc(s.name || 'Run')}</div>
          </div>
        ` : ''}
      </div>
    </div>
  `;

  modal.innerHTML = modalHTML;
  modal.style.display = 'flex';
}

function closeEnhancedModal() {
  const modal = document.getElementById('enhancedWorkoutModal');
  if (modal) modal.style.display = 'none';
}

window.showEnhancedWorkoutModal = showEnhancedWorkoutModal;
window.closeEnhancedModal = closeEnhancedModal;

// ============================================================================
// END RUNNING LIBRARY INTEGRATION
// ============================================================================

// ============================================================================
// STRAVA CONNECT BUTTON
// ============================================================================
(function(){
  var btn = document.getElementById('dp-strava-btn');

  window.initStrava = async function(code) {
    if (!code) return;
    var connectUrl = 'https://www.strava.com/oauth/authorize'
      + '?client_id=254938'
      + '&response_type=code'
      + '&redirect_uri=' + encodeURIComponent(window.location.origin + '/api/strava-callback')
      + '&scope=activity:read_all'
      + '&state=' + encodeURIComponent(code);

    btn.href = connectUrl;
    btn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0"><path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066z"/><path d="M11.234 13.828L7.07 6h5.886l4.143 7.828z" opacity=".7"/></svg> Connect Strava';
    btn.style.cssText = 'display:inline-flex;align-items:center;gap:5px;background:#fc4c02;color:#fff;border-color:#fc4c02;box-shadow:0 0 12px rgba(252,76,2,.6);text-decoration:none;font-weight:700;';

    try {
      var res  = await fetch('/api/strava?athlete=' + encodeURIComponent(code));
      var data = await res.json();
      if (data.connected) {
        btn.innerHTML = '✓ Strava';
        btn.style.cssText = 'display:inline-flex;align-items:center;background:transparent;color:rgba(74,222,128,.9);border-color:rgba(74,222,128,.35);box-shadow:none;text-decoration:none;pointer-events:none;';
        // Check if athlete has acknowledged the connection (cross-device via Supabase)
        window._stravaAthCode = code;
        if (sbClient) {
          try {
            var { data: ackRow } = await sbClient
              .from('athlete_data')
              .select('value')
              .eq('athlete_code', code)
              .eq('key', 'strava_ack')
              .maybeSingle();
            if (!ackRow || !ackRow.value || !ackRow.value.acked) {
              var banner = document.getElementById('strava-ack-banner');
              if (banner) banner.style.display = 'flex';
            }
          } catch(e) { /* silently skip banner on error */ }
        }
      } else {
        btn.href = data.connectUrl || connectUrl;
      }
      return data;
    } catch(e) {
      btn.href = connectUrl; // keep orange connect state on error
      return { connected:false, activities:[] };
    }
  };
})();

window.acknowledgeStrava = async function() {
  var banner = document.getElementById('strava-ack-banner');
  if (banner) banner.style.display = 'none';
  if (sbClient && window._stravaAthCode) {
    try {
      await sbClient.from('athlete_data').upsert({
        athlete_code: window._stravaAthCode,
        key: 'strava_ack',
        value: { acked: true, acked_at: new Date().toISOString() },
        updated_at: new Date().toISOString()
      }, { onConflict: 'athlete_code,key' });
    } catch(e) { console.warn('Strava ack save failed', e); }
  }
};
// ============================================================================
// END STRAVA CONNECT BUTTON
// ============================================================================


// ── PUSH REMINDERS ───────────────────────────────────────────────────────────
// Keeps the browser push subscription in sync with the athlete's reminder
// preferences. Subscriptions are stored in Supabase via /api/reminders and a
// daily Vercel cron sends whatever is due. On iPhone the portal must be added
// to the home screen before notifications are available.
function urlB64ToUint8(base64String){
  var padding='='.repeat((4-base64String.length%4)%4);
  var base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');
  var raw=window.atob(base64),arr=new Uint8Array(raw.length);
  for(var i=0;i<raw.length;i++)arr[i]=raw.charCodeAt(i);
  return arr;
}
function setPushStatus(msg,ok){
  try{localStorage.setItem('dp_push_status',msg);}catch(e){}
  var el=document.getElementById('pushStatus');
  if(el){el.textContent='Notifications: '+msg;el.style.color=ok?'var(--ok)':'var(--muted)';}
}
async function syncPushSubscription(){
  try{
    if(!athlete||!athlete.code)return;
    if(!('serviceWorker'in navigator)){setPushStatus('not supported in this browser',false);return;}
    if(!('PushManager'in window)){setPushStatus('not available — on iPhone, open from the home-screen icon',false);return;}
    if(typeof VAPID_PUBLIC_KEY==='undefined'||!VAPID_PUBLIC_KEY){setPushStatus('app update pending — close and reopen the portal',false);return;}
    var prefs=getReminderPreferences();
    var anyOn=REMINDER_OPTIONS.some(function(o){return !!prefs[o.key];});
    setPushStatus('setting up\u2026',false);
    // Robust service-worker acquisition: iOS PWAs can leave .ready hanging on a
    // fresh install, so register explicitly and time out instead of stalling.
    var reg=await navigator.serviceWorker.getRegistration();
    if(!reg){
      try{reg=await navigator.serviceWorker.register('/sw.js');}
      catch(e){setPushStatus('service worker failed: '+String(e&&e.message||e).slice(0,60),false);return;}
    }
    if(!reg.active){
      var ready=await Promise.race([
        navigator.serviceWorker.ready,
        new Promise(function(res){setTimeout(function(){res(null);},8000);})
      ]);
      if(!ready){setPushStatus('service worker not ready \u2014 close the app fully and reopen',false);return;}
      reg=ready;
    }
    var sub=await reg.pushManager.getSubscription();
    if(!anyOn){
      if(sub){
        try{await fetch('/api/reminders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'unsubscribe',endpoint:sub.endpoint})});}catch(e){}
        try{await sub.unsubscribe();}catch(e){}
      }
      setPushStatus('off',false);
      return;
    }
    if(!('Notification'in window)||Notification.permission!=='granted'){setPushStatus('waiting for permission — toggle a reminder and tap Allow',false);return;}
    if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlB64ToUint8(VAPID_PUBLIC_KEY)});
    var resp=await fetch('/api/reminders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'subscribe',code:athlete.code,subscription:sub.toJSON(),prefs:prefs,userAgent:navigator.userAgent,timezone:(Intl.DateTimeFormat().resolvedOptions().timeZone||'')})});
    var data=await resp.json().catch(function(){return{};});
    if(resp.ok&&data.ok){setPushStatus('active on this device ✓',true);}
    else{setPushStatus('server rejected: '+(data.error||resp.status),false);}
  }catch(e){setPushStatus('error: '+String(e&&e.message||e).slice(0,80),false);}
}
async function hardRefreshPortal(){
  showToast('Refreshing portal\u2026');
  try{var keys=await caches.keys();await Promise.all(keys.map(function(k){return caches.delete(k);}));}catch(e){}
  try{var reg=await navigator.serviceWorker.getRegistration();if(reg)await reg.update();}catch(e){}
  setTimeout(function(){location.reload();},300);
}
// Service worker registration
if('serviceWorker' in navigator){
  window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){});});
  // Check for updates whenever the app comes back to the foreground (key for
  // home-screen apps, which iOS keeps alive for days without a fresh load).
  document.addEventListener('visibilitychange',function(){
    if(document.visibilityState==='visible'){
      navigator.serviceWorker.getRegistration().then(function(reg){if(reg)reg.update().catch(function(){});});
    }
  });
  // When a new service worker takes over, reload once so athletes always run
  // the latest code. Guard: only when replacing an existing controller.
  var dpHadController=!!navigator.serviceWorker.controller,dpReloaded=false;
  navigator.serviceWorker.addEventListener('controllerchange',function(){
    if(dpHadController&&!dpReloaded){dpReloaded=true;showToast('Portal updated');setTimeout(function(){location.reload();},600);}
    dpHadController=true;
  });
}
