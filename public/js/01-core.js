// Public runtime constants are loaded from /config.js.
// ── WORKOUT SPLITS (Supabase = source of truth, hardcoded STR = fallback) ────
var SPLITS_BY_NAME={};
function getSplit(key){return SPLITS_BY_NAME[key]||STR[key]||[];}
async function loadWorkoutSplits(){
  try{
    var result=await portalRequest('workout-splits');
    var rows=result.rows||[];
    if(!rows.length)return;
    var map={};
    // global splits first, then athlete-specific variants override by name
    rows.forEach(function(r){ if(!r.athlete_code) map[r.name]=r.exercises||[]; });
    rows.forEach(function(r){ if(r.athlete_code&&athlete&&r.athlete_code===athlete.code) map[r.name]=r.exercises||[]; });
    SPLITS_BY_NAME=map;
    var names=Object.keys(map);
    GYM_KEYS=names.concat(GYM_KEYS.filter(function(k){return names.indexOf(k)<0;}));
    GYM_KEYS.sort(function(a,b){return b.length-a.length;}); // longest first so specific names match before generic
  }catch(e){console.warn('Workout splits load failed',e);}
}

// ── SUPABASE ──────────────────────────────────────────────────────────────────
var sbClient=null,_supabaseLoadPromise=null,_skipSbSync=false,_sessionOverrides={};
function ensureSupabaseClient(){
  if(sbClient) return Promise.resolve(sbClient);
  if(!SUPABASE_URL||SUPABASE_URL==='YOUR_SUPABASE_URL') return Promise.resolve(null);
  if(_supabaseLoadPromise) return _supabaseLoadPromise;
  _supabaseLoadPromise=new Promise(function(resolve){
    function initialise(){
      try{
        sbClient=window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{auth:{
          // PWA persistence: the session lives in localStorage and refreshes
          // itself, so athletes stay signed in across reopens until they log
          // out / clear storage / the refresh token dies.
          persistSession:true,
          autoRefreshToken:true,
          // MUST stay false: legacy coach links open the portal as ?code=THOMAS
          // and supabase-js would try to exchange that ?code= as an OAuth/PKCE
          // code. Email login uses explicit OTP entry — no URL detection needed.
          detectSessionInUrl:false,
          storageKey:'dp-portal-auth'
        }});
        initAuthStateListener();
        resolve(sbClient);
      }
      catch(e){console.warn('Supabase init failed',e);resolve(null);}
    }
    if(window.supabase){initialise();return;}
    var script=document.createElement('script');
    script.src='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.0/dist/umd/supabase.js';
    script.async=true;script.onload=initialise;
    script.onerror=function(){console.warn('Supabase library failed to load');resolve(null);};
    document.head.appendChild(script);
  });
  return _supabaseLoadPromise;
}

// ── EMAIL AUTH (Supabase session identity layer) ─────────────────────────────
// Identity model: auth.users.id -> athletes.auth_user_id -> athlete.code.
// A session only ever resolves (server-side) to the athlete's EXISTING legacy
// code — every read, write, historical lookup and sync below keeps flowing
// through that same code, so migrated athletes keep all prior data.
var _authToken=null,_authListenerBound=false;
function initAuthStateListener(){
  if(_authListenerBound||!sbClient||!sbClient.auth)return;
  _authListenerBound=true;
  sbClient.auth.onAuthStateChange(function(event,session){
    var method=localStorage.getItem('dp_auth_method');
    if(session&&session.access_token)_authToken=session.access_token;
    else if(method==='email')_authToken=null;
    // Email-authed athletes get a visible logout (legacy keeps it coach-only
    // via the ?code= link — unchanged).
    if(_authToken){var lb=document.getElementById('logoutBtn');if(lb)lb.style.display='';}
    // Refresh failed / signed out elsewhere while the portal is open: fall
    // back to the login screen's email panel with a friendly recovery path
    // ("send a new code") instead of silently 401-ing in the background.
    if(event==='SIGNED_OUT'
       &&localStorage.getItem('dp_auth_method')==='email'
       &&document.getElementById('portalScreen')
       &&document.getElementById('portalScreen').style.display!=='none'){
      handleAuthSessionLost();
    }
  });
}
// Merge the session token into fetch headers. Legacy (non-migrated) athletes
// have no session → headers unchanged → serverless endpoints keep the old path.
function authHeaders(base){
  var h=base||{};
  if(_authToken)h['Authorization']='Bearer '+_authToken;
  return h;
}
async function portalRequest(action,payload,options){
  if(!_authToken)throw new Error('Your session has expired. Please sign in again.');
  var body=Object.assign({action:action},payload||{});
  var response=await fetch('/api/portal-data',{
    method:'POST',
    headers:authHeaders({'Content-Type':'application/json'}),
    body:JSON.stringify(body),
    cache:'no-store',
    keepalive:!!(options&&options.keepalive)
  });
  var data={};
  try{data=await response.json();}catch(e){}
  if(response.status===401){handleAuthSessionLost();throw new Error('Your session has expired. Please sign in again.');}
  if(!response.ok||data.ok===false)throw new Error(data.error||('Sync failed '+response.status));
  return data;
}
function portalStateWrite(key,value,options){
  return portalRequest('state-write',{key:key,value:value},options);
}
async function getAuthSession(){
  var client=await ensureSupabaseClient();
  if(!client||!client.auth)return null;
  try{var r=await client.auth.getSession();return (r&&r.data&&r.data.session)||null;}catch(e){return null;}
}
// Ask the server who this session belongs to. Also performs the one-time
// auth_user_id link on an athlete's first OTP sign-in. Never creates athletes.
async function resolveAuthedAthlete(){
  if(!_authToken)return null;
  try{
    var r=await fetch('/api/auth-athlete',{headers:authHeaders({}),cache:'no-store'});
    if(r.status===403)return {error:'no_linked_athlete'};
    if(r.status===401)return {error:'invalid_session'};
    if(!r.ok)return null;
    return await r.json();
  }catch(e){return null;}
}
async function authSignOut(){
  try{var client=await ensureSupabaseClient();if(client&&client.auth)await client.auth.signOut();}catch(e){}
  _authToken=null;
  try{localStorage.removeItem('dp_legacy_session');}catch(e){}
}
function handleAuthSessionLost(){
  var method=localStorage.getItem('dp_auth_method');
  logoutToLogin(true);
  if(method==='email'&&typeof showEmailLogin==='function'){
    showEmailLogin(true,'Your session expired — enter your email and we’ll send a new code.');
  }else{
    if(typeof showEmailLogin==='function')showEmailLogin(false);
    if(typeof showLoginError==='function')showLoginError('Your access session expired — enter your coach-issued code again.');
  }
}

// Intercept all localStorage writes — auto-sync dp_ keys to Supabase.
// Drafts can fire on every keystroke, so the cloud write is DEBOUNCED (batched
// ~1.5s after the last change) instead of firing per keystroke. Pending writes
// are force-flushed the moment the athlete backgrounds or closes the tab, so the
// latest edits reach Supabase before a mobile browser evicts/reloads the page.
var _sbSyncTimers={},_sbSyncPending={};
var _saveStateTimer=null;
function setSaveState(state,label){
  var pill=document.getElementById('saveStatePill');if(!pill)return;
  pill.className='save-state-pill '+state;
  var text=pill.querySelector('b');if(text)text.textContent=label||(state==='saving'?'Syncing with coach':state==='offline'?'Saved on device · will sync':'Synced with coach');
  if(_saveStateTimer)clearTimeout(_saveStateTimer);
  if(state==='saved')_saveStateTimer=setTimeout(function(){pill.classList.add('quiet');},2200);else pill.classList.remove('quiet');
}
function _flushSbKey(sbKey){
  if(_sbSyncTimers[sbKey]){clearTimeout(_sbSyncTimers[sbKey]);delete _sbSyncTimers[sbKey];}
  var p=_sbSyncPending[sbKey];
  if(!p||!_authToken) return;
  delete _sbSyncPending[sbKey];
  portalStateWrite(sbKey,p.value,{keepalive:true})
    .then(function(){setSaveState('saved');})
    .catch(function(){_sbSyncPending[sbKey]=p;setSaveState('offline');});
}
function _flushAllSb(){Object.keys(_sbSyncPending).forEach(_flushSbKey);}
function _scheduleSbSync(code,sbKey,parsed){
  setSaveState(navigator.onLine?'saving':'offline');
  _sbSyncPending[sbKey]={code:code,value:parsed};
  if(_sbSyncTimers[sbKey]) clearTimeout(_sbSyncTimers[sbKey]);
  _sbSyncTimers[sbKey]=setTimeout(function(){_flushSbKey(sbKey);},1500);
}
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')_flushAllSb();});
window.addEventListener('pagehide',_flushAllSb);
window.addEventListener('online',function(){setSaveState('saving');_flushAllSb();retryPendingCoachWrites(true).then(function(){setSaveState('saved');});});
window.addEventListener('offline',function(){setSaveState('offline');});
(function(){
  var _orig=localStorage.setItem.bind(localStorage);
  localStorage.setItem=function(key,value){
    _orig(key,value);
    if(_skipSbSync||!_authToken||!key.startsWith('dp_')) return;
    var code=(athlete&&athlete.code)||'';if(!code) return;
    var sbKey=null;
    if(key==='dp_goals_'+code) sbKey='goals';
    else if(key==='dp_logs_'+code) sbKey='logs';
    else if(key==='dp_ticked_'+code) sbKey='ticked';
    else if(key==='dp_reschedules_'+code) sbKey='reschedules';
    else if(key==='dp_photos_'+code) sbKey='photos';
    else if(key.startsWith('dp_call_booked_')&&athlete&&athlete.code){var _cpfx='dp_call_booked_'+athlete.code.toUpperCase()+'_';if(key.startsWith(_cpfx))sbKey='call_booked_'+key.slice(_cpfx.length);}
    else if(key.startsWith('dp_daily_body_'+code+'_')) sbKey='daily_body_'+key.slice(('dp_daily_body_'+code+'_').length);
    else if(key.startsWith('dp_daily_nut_'+code+'_')) sbKey='daily_nut_'+key.slice(('dp_daily_nut_'+code+'_').length);
    if(!sbKey) return;
    try{_scheduleSbSync(code,sbKey,JSON.parse(value));}catch(e){}
  };
})();

function pendingCoachWritesKey(code){return 'dp_pending_writes_'+code;}
// Resolve the best athlete code available, even if the athlete object isn't
// ready yet — so a failed write is NEVER silently dropped for lack of a code.
function currentWriteCode(payload){
  if(athlete&&athlete.code) return athlete.code;
  if(payload&&payload.athleteCode) return String(payload.athleteCode);
  try{var c=localStorage.getItem('dp_last_athlete_code');if(c) return c;}catch(e){}
  return '_unknown';
}
function readPendingCoachWrites(code){
  code=code||currentWriteCode();
  try{
    var list=JSON.parse(localStorage.getItem(pendingCoachWritesKey(code))||'[]');
    return Array.isArray(list)?list:[];
  }catch(e){return [];}
}
async function persistPendingCoachWrites(list,code){
  code=code||currentWriteCode();
  try{localStorage.setItem(pendingCoachWritesKey(code),JSON.stringify(list));}catch(e){}
  // Mirror the retry queue to the authenticated server gateway.
  if(_authToken&&code&&code!=='_unknown'){
    try{
      await portalStateWrite('pending_writes',list);
    }catch(e){console.warn('Pending coach-write sync failed:',e);}
  }
}
async function queueCoachWrite(url,payload,error){
  // Robust: queue under the best code we can resolve; never bail for a missing code.
  var code=currentWriteCode(payload);
  if(code&&code!=='_unknown'){try{localStorage.setItem('dp_last_athlete_code',code);}catch(e){}}
  var list=readPendingCoachWrites(code);
  var writeId=payload&&payload.clientWriteId?payload.clientWriteId:('cw_'+Date.now()+'_'+Math.random().toString(36).slice(2));
  if(payload) payload.clientWriteId=writeId;
  var existing=list.find(function(item){return item.id===writeId;});
  if(existing){
    existing.payload=payload;existing.lastError=String(error&&error.message||error||'Write failed');existing.updatedAt=new Date().toISOString();
  }else{
    list.push({id:writeId,url:url,payload:payload,createdAt:new Date().toISOString(),attempts:0,lastError:String(error&&error.message||error||'Write failed')});
  }
  await persistPendingCoachWrites(list,code);
}
async function postJsonChecked(url,payload){
  if(payload&&!payload.clientWriteId) payload.clientWriteId='cw_'+Date.now()+'_'+Math.random().toString(36).slice(2);
  // authHeaders: migrated athletes send their session token so the server
  // derives athlete identity from auth (not the client payload); legacy
  // athletes have no token and the request is byte-identical to before.
  var response=await fetch(url,{method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:JSON.stringify(payload)});
  var text=await response.text();
  var data={};
  try{data=text?JSON.parse(text):{};}catch(e){data={raw:text};}
  if(!response.ok||data.ok===false){
    throw new Error((data&&(data.error||data.message))||('Write failed '+response.status));
  }
  return data;
}
// Authoritative write: /api/ingest persists to the structured Supabase tables
// (the dashboard's source of truth) AND mirrors to the coach target. ONLY an
// ingest success means the submission is safely in Supabase.
async function ingestWrite(url,payload){
  return postJsonChecked('/api/ingest',{targetUrl:url,payload:payload});
}
async function coachWrite(url,payload,opts){
  opts=opts||{};
  if(payload&&!payload.clientWriteId) payload.clientWriteId='cw_'+Date.now()+'_'+Math.random().toString(36).slice(2);
  if(athlete&&athlete.code){try{localStorage.setItem('dp_last_athlete_code',athlete.code);}catch(e){}}
  try{
    return await ingestWrite(url,payload); // persisted to Supabase (source of truth)
  }catch(ingestError){
    // Supabase persistence did NOT happen. Queue locally so it retries via /api/ingest.
    await queueCoachWrite(url,payload,ingestError);
    if(opts.required) throw ingestError;
    console.warn('Coach write queued for Supabase retry:',ingestError&&ingestError.message);
    return {ok:true,queued:true,error:ingestError&&ingestError.message};
  }
}
async function retryPendingCoachWrites(silent){
  var code=currentWriteCode();
  // Process the active code AND any writes parked under '_unknown' before a code was known.
  var buckets=[code];if(code!=='_unknown') buckets.push('_unknown');
  var totalSynced=0;
  for(var b=0;b<buckets.length;b++){
    var bucket=buckets[b];
    var list=readPendingCoachWrites(bucket);
    if(!list.length) continue;
    var keep=[],synced=0;
    for(var i=0;i<list.length;i++){
      var item=list[i];
      try{
        await ingestWrite(item.url,item.payload); // must reach Supabase to clear the queue
        synced++;
      }catch(e){
        item.attempts=(item.attempts||0)+1;
        item.lastError=String(e&&e.message||e||'Write failed');
        item.updatedAt=new Date().toISOString();
        keep.push(item);
      }
    }
    totalSynced+=synced;
    if(bucket==='_unknown'&&code!=='_unknown'){
      // Re-home any still-failing 'unknown' writes under the now-known code.
      var primary=readPendingCoachWrites(code).concat(keep);
      await persistPendingCoachWrites(primary,code);
      await persistPendingCoachWrites([],'_unknown');
    }else{
      await persistPendingCoachWrites(keep,bucket);
    }
  }
  if(totalSynced&&!silent) showToast(totalSynced+' pending coach update'+(totalSynced>1?'s':'')+' synced');
}
window.addEventListener('online',function(){retryPendingCoachWrites(false);});

// Coach prescription overrides now live directly on planned_sessions rows in
// Supabase — loadPlannedSessions() populates _sessionOverrides from each row.
async function loadPlannedSessions(startISO,endISO){
  try{
    var result=await portalRequest('planned-sessions',{start:startISO,end:endISO});
    var plannedRows=(result.rows||[]).slice();
    if(result.next&&!plannedRows.some(function(existing){return existing.id===result.next.id;}))plannedRows.push(result.next);
    _sessionOverrides={};
    return plannedRows.map(function(r){
      var key=r.notion_page_id||r.id;
      if(r.distance_km!=null||r.target_pace||r.warm_up||r.intervals||r.working_pace||r.rest||r.cool_down||r.notes){
        _sessionOverrides[key]={notion_page_id:key,name:null,
          distance_km:r.distance_km,target_pace:r.target_pace,warm_up:r.warm_up,
          intervals:r.intervals,working_pace:r.working_pace,rest:r.rest,
          cool_down:r.cool_down,notes:r.notes};
      }
      return{id:key,name:r.title||'Session',date:r.planned_date||'',
        sessionType:r.session_type||'',status:r.status||'Planned',
        runningSession:'',runningSessionIds:[],
        runningLibraryIds:r.library_id?[r.library_id]:[],
        runDetails:r.run_details||'',intensity:r.intensity||'',week:r.week_label||''};
    });
  }catch(e){ console.warn('Planned sessions load failed',e); return null; }
}

async function loadCloudData(code){
  _skipSbSync=true;
  programmeWeeks=12;
  try{
    var result=await portalRequest('state-read');
    var rows=result.rows||[];
    if(!rows.length){_skipSbSync=false;return;}
    // Build a set of keys that exist in Supabase
    var cloudKeys={};
    rows.forEach(function(row){cloudKeys[row.key]=row.value;});
    // Programme length (set by coaches in the dashboard Nutrition tab)
    var pw=parseInt(cloudKeys['programme_weeks'],10);
    if(!isNaN(pw)&&pw>0&&pw<=52) programmeWeeks=pw;
    // Coach-set start date is shared by both apps and takes priority over the
    // legacy Notion profile value for week calculations and portal display.
    var startOverride=String(cloudKeys['start_date_override']||'').trim();
    if(/^\d{4}-\d{2}-\d{2}$/.test(startOverride)) athlete.startDate=startOverride;
    // Write cloud data to localStorage (cloud is authoritative)
    rows.forEach(function(row){
      var lsKey=null;
      // LOGS: never let an older cloud copy clobber a newer local draft.
      // (Athletes were losing in-progress gym/run data on reload because the
      //  cloud copy was treated as authoritative even when a fresher local
      //  draft existed — e.g. the last keystrokes hadn't synced before the
      //  mobile browser reloaded the tab.)
      if(row.key==='logs'){
        var _cloudLogs=row.value||null;
        var _localLogs=null;try{_localLogs=JSON.parse(localStorage.getItem('dp_logs_'+code)||'null');}catch(e){}
        var _cloudT=(_cloudLogs&&_cloudLogs.__savedAt)||0;
        var _localT=(_localLogs&&_localLogs.__savedAt)||0;
        if(_localLogs&&_localT>_cloudT){
          // Local draft is newer — keep it, and push it up so other devices catch up.
          portalStateWrite('logs',_localLogs).catch(function(){});
        }else if(_cloudLogs){
          localStorage.setItem('dp_logs_'+code,JSON.stringify(_cloudLogs));
        }
        return;
      }
      if(row.key==='goals') lsKey='dp_goals_'+code;
      else if(row.key==='logs') lsKey='dp_logs_'+code;
      else if(row.key==='ticked') lsKey='dp_ticked_'+code;
      else if(row.key==='photos') lsKey='dp_photos_'+code;
      else if(row.key.startsWith('daily_body_')) lsKey='dp_daily_body_'+code+'_'+row.key.slice('daily_body_'.length);
      else if(row.key.startsWith('daily_nut_')) lsKey='dp_daily_nut_'+code+'_'+row.key.slice('daily_nut_'.length);
      else if(row.key==='ex_picks') lsKey='dp_ex_picks_'+code;
      else if(row.key.startsWith('call_booked_')) lsKey='dp_call_booked_'+(code?code.toUpperCase()+'_':'')+row.key.slice('call_booked_'.length);
      else if(row.key.startsWith('checkin_')) lsKey='dp_checkin_'+row.key.slice('checkin_'.length);
      else if(row.key==='pending_writes') lsKey=pendingCoachWritesKey(code);
      if(!lsKey||!row.value) return;
      localStorage.setItem(lsKey,JSON.stringify(row.value));
    });
    // Backfill: if photos exist locally but not in Supabase, push them up now
    if(!cloudKeys['photos']){
      var localPhotos=localStorage.getItem('dp_photos_'+code);
      if(localPhotos&&localPhotos!=='{}'){
        try{
          var parsedPhotos=JSON.parse(localPhotos);
          if(Object.keys(parsedPhotos).length>0){
            _skipSbSync=false;
            await portalStateWrite('photos',parsedPhotos);
            _skipSbSync=true;
          }
        }catch(e){}
      }
    }
    // Backfill: if goals exist locally but not in Supabase, push them up now
    if(!cloudKeys['goals']){
      var localGoals=localStorage.getItem('dp_goals_'+code);
      if(localGoals&&localGoals!=='{}'){
        try{
          var parsed=JSON.parse(localGoals);
          if(parsed.savedAt){
            _skipSbSync=false;
            await portalStateWrite('goals',parsed);
            _skipSbSync=true;
          }
        }catch(e){}
      }
    }
  }catch(e){console.warn('Cloud sync failed:',e);}
  finally{_skipSbSync=false;}
}

// Hydrate daily body logs from the structured Supabase source of truth. The
// readiness card can then use the same local-first path offline while every
// device receives the latest server copy at login.
async function loadStructuredBodyData(code){
  if(!code) return;
  var wasSkipping=_skipSbSync;
  try{
    var result=await portalRequest('body-logs');
    if(!result||!Array.isArray(result.rows)) return;
    _skipSbSync=true;
    result.rows.forEach(function(row){
      var logDate=String(row.log_date||'').slice(0,10);if(!logDate)return;
      var raw=row.raw_payload&&typeof row.raw_payload==='object'?row.raw_payload:{};
      var value=Object.assign({},raw,{
        type:'daily_body',athleteCode:code,date:logDate,
        weight:row.weight==null?'':String(row.weight),
        sleep:row.sleep==null?'':String(row.sleep),energy:row.energy==null?'':String(row.energy),
        stress:row.stress==null?'':String(row.stress),soreness:row.soreness==null?'':String(row.soreness),
        notes:row.notes||raw.notes||''
      });
      localStorage.setItem('dp_daily_body_'+code+'_'+logDate,JSON.stringify(value));
    });
  }catch(e){console.warn('Body log cloud hydration failed',e);}
  finally{_skipSbSync=wasSkipping;}
}

// ── STRENGTH LIBRARY ──────────────────────────────────────────────────────────
const STR = {
  "Lower A":[
    {"exercise":"Leg Extension","sets":"4","reps":"8","repRange":"8-12","warmupSets":"1","workingSets":"3","rest":"90s","notes":"First set warm-up","alts":["Single Leg Extension"]},
    {"exercise":"Bulgarian Split Squat","sets":"3","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"3","rest":"90s","notes":"","alts":["Dumbbell Bulgarian Split Squat","Hack Squat"]},
    {"exercise":"Seated Hamstring Curl","sets":"4","reps":"8","repRange":"8-12","warmupSets":"1","workingSets":"3","rest":"90s","notes":"First set warm-up","alts":["Lying Leg Curl"]},
    {"exercise":"Barbell Romanian Dead Lift","sets":"3","reps":"8","repRange":"6-10","warmupSets":"0","workingSets":"3","rest":"90s","notes":"","alts":["Dumbbell Romanian Deadlift"]},
    {"exercise":"Adduction Machine","sets":"2","reps":"8","repRange":"10-15","warmupSets":"0","workingSets":"2","rest":"90s","notes":""},
    {"exercise":"Standing Calf Raise","sets":"4","reps":"8","repRange":"10-15","warmupSets":"1","workingSets":"3","rest":"90s","notes":"","alts":["Seated Calf Raise"]},
    {"exercise":"Cable Abdominal Crunch","sets":"3","reps":"8","repRange":"10-15","warmupSets":"0","workingSets":"3","rest":"90s","notes":""}
  ],
  "Lower B":[
    {"exercise":"Lying Down Leg Press","sets":"3","reps":"8","repRange":"8-12","warmupSets":"1","workingSets":"2","rest":"120s","notes":""},
    {"exercise":"Seated Hamstring Curl","sets":"3","reps":"8","repRange":"8-12","warmupSets":"1","workingSets":"2","rest":"90s","notes":""},
    {"exercise":"Single Leg Step Down","sets":"3","reps":"8","repRange":"8-12","warmupSets":"1","workingSets":"2","rest":"90s","notes":""},
    {"exercise":"Hip Flexors","sets":"3","reps":"8","repRange":"10-15","warmupSets":"0","workingSets":"3","rest":"90s","notes":""},
    {"exercise":"Tibialis Raise","sets":"4","reps":"10","repRange":"12-20","warmupSets":"0","workingSets":"4","rest":"90s","notes":""},
    {"exercise":"Seated Calf Raise","sets":"4","reps":"8","repRange":"10-15","warmupSets":"1","workingSets":"3","rest":"90s","notes":""},
    {"exercise":"Cable Abdominal Crunch","sets":"3","reps":"8","repRange":"10-15","warmupSets":"0","workingSets":"3","rest":"90s","notes":""}
  ],
  "Upper A":[
    {"exercise":"Low Machine Row","sets":"4","reps":"8","repRange":"8-12","warmupSets":"2","workingSets":"2","rest":"90s","notes":"First 2 sets warm-up","alts":["Cable row (close grip)"]},
    {"exercise":"Wide Grip Machine Row","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Wide Grip Cable Row"]},
    {"exercise":"Pec Dec","sets":"3","reps":"8","repRange":"8-12","warmupSets":"1","workingSets":"2","rest":"90s","notes":"First set warm-up","alts":["Cable fly","Chest fly machine"]},
    {"exercise":"Incline Dumbbell Press","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Barbell incline bench press","Machine incline bench press"]},
    {"exercise":"Lat Pulldown","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Cable Lat Pulldown","Machine Lat Pulldown"]},
    {"exercise":"Machine Dips","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Assisted dips","Cable pushdown"]},
    {"exercise":"Machine Shoulder Press","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Dumbbell shoulder press","Seated barbell press"]},
    {"exercise":"Dumbbell Hammer Curl","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Bicep curl","Barbell curl"]},
    {"exercise":"Lateral Dumbbell Raise","sets":"2","reps":"10","repRange":"10-15","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Machine lateral raise","Cable lateral raise"]},
    {"exercise":"Tricep Rope Extension","sets":"2","reps":"8","repRange":"10-15","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Overhead rope extension","Cable pushdown (bar)"]},
    {"exercise":"Rear Delt Fly","sets":"2","reps":"10","repRange":"10-15","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Cable rear delt fly","Face pull"]},
    {"exercise":"Cable Abdominal Crunch","sets":"3","reps":"8","repRange":"10-15","warmupSets":"0","workingSets":"3","rest":"90s","notes":"","alts":["Crunch machine","Hanging knee raise"]}
  ],
  "Upper B":[
    {"exercise":"Low Machine Row","sets":"4","reps":"8","repRange":"8-12","warmupSets":"2","workingSets":"2","rest":"90s","notes":"First 2 sets warm-up","alts":["Cable row (close grip)","Low pulley row"]},
    {"exercise":"Mid Machine Row","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Seated cable row (wide)","Cable row (wide grip)"]},
    {"exercise":"Pec Dec","sets":"3","reps":"8","repRange":"8-12","warmupSets":"1","workingSets":"2","rest":"90s","notes":"First set warm up","alts":["Cable fly","Chest fly machine"]},
    {"exercise":"Incline Dumbbell Press","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Barbell incline bench press","Machine incline bench press"]},
    {"exercise":"Lat Pulldown","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Cable Lat Pulldown","Machine Lat Pulldown"]},
    {"exercise":"Machine Dips","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Parallel bar dip","Cable pushdown"]},
    {"exercise":"Machine Shoulder Press","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Dumbbell shoulder press","Seated barbell press"]},
    {"exercise":"Dumbbell Hammer Curl","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Bicep curl","Barbell curl"]},
    {"exercise":"Lateral Dumbbell Raise","sets":"2","reps":"8","repRange":"10-15","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Machine lateral raise","Cable lateral raise"]},
    {"exercise":"Tricep Rope Extension","sets":"2","reps":"8","repRange":"10-15","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Overhead rope extension","Cable pushdown (bar)"]},
    {"exercise":"Rear Delt Fly","sets":"2","reps":"10","repRange":"10-15","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Cable rear delt fly","Face pull"]},
    {"exercise":"Cable Abdominal Crunch","sets":"3","reps":"8","repRange":"10-15","warmupSets":"0","workingSets":"3","rest":"90s","notes":"","alts":["Crunch machine","Hanging knee raise"]}
  ]
};

// ── RUN LIBRARY ───────────────────────────────────────────────────────────────
const RUN={"Threshold Work":{"description":"Warm up 15min easy. Run at sustained threshold effort (RPE 7–8). Cool down easy.","type":"Threshold","intensity":"Threshold","surface":"Road","difficulty":"Intermediate"},"Easy Run":{"description":"Relaxed aerobic run at conversational pace (RPE 4–5). Focus on easy breathing and good form.","type":"Easy Run","intensity":"Aerobic","surface":"Road","difficulty":"Beginner"},"Long Run":{"description":"Long aerobic endurance run. Relaxed steady effort (RPE 5–6). Focus on time on feet and fueling.","type":"Long Run","intensity":"Aerobic","surface":"Road","difficulty":"Intermediate"},"Progressive Long Run":{"description":"Long run starting easy, gradually increasing pace in final third toward marathon effort.","type":"Long Run","intensity":"Aerobic","surface":"Road","difficulty":"Intermediate"},"Fast Finish Long Run":{"description":"Long run mostly easy with final 3–5km at marathon effort (RPE 7).","type":"Long Run","intensity":"Tempo","surface":"Road","difficulty":"Intermediate"},"12x1min Fartlek":{"description":"Warm up 10–15min easy. 12x1min strong (RPE 7–8) with 1min jog recovery. Cool down easy.","type":"Fartlek","intensity":"Aerobic","surface":"Road","difficulty":"Beginner"},"8x2min Fartlek":{"description":"Warm up 10–15min easy + strides. 8x2min steady hard (RPE 7) with 2min jog recovery. Cool down 10min easy.","type":"Fartlek","intensity":"Threshold","surface":"Road","difficulty":"Beginner"},"20min Tempo":{"description":"Warm up 10–15min easy. 20min tempo steady effort (RPE 7). Cool down 10min easy.","type":"Tempo","intensity":"Tempo","surface":"Road","difficulty":"Intermediate"},"25min Tempo":{"description":"Warm up 15min easy. 25min continuous tempo (RPE 7). Cool down 10–15min easy.","type":"Tempo","intensity":"Threshold","surface":"Road","difficulty":"Intermediate"},"5x1km Threshold":{"description":"Warm up 15min easy + strides. 5x1km threshold (RPE 7–8) with 90s jog recovery. Cool down 10min easy.","type":"Threshold","intensity":"Threshold","surface":"Road","difficulty":"Intermediate"},"6x400m Intervals":{"description":"Warm up 15min easy + drills. 6x400m fast (RPE 8) with 200m jog recovery. Cool down easy.","type":"Track","intensity":"VO2 Max","surface":"Track","difficulty":"Intermediate"},"6x800m Intervals":{"description":"Warm up 15min easy. 6x800m strong (RPE 8) with 2min jog recovery. Cool down easy.","type":"Track","intensity":"VO2 Max","surface":"Track","difficulty":"Intermediate"},"10x20s Hill Sprints":{"description":"Warm up 15min easy. 10x20s hill sprints (RPE 9) full recovery. Cool down easy.","type":"Hills","intensity":"Neuromuscular","surface":"Hills","difficulty":"Beginner"},"5km Recovery":{"description":"5km gentle recovery jog (RPE 3–4).","type":"Recovery","intensity":"Easy","surface":"Road","difficulty":"Beginner"},"6km Recovery":{"description":"6km very easy recovery run (RPE 3–4).","type":"Recovery","intensity":"Easy","surface":"Road","difficulty":"Beginner"}};

// ── STATE ─────────────────────────────────────────────────────────────────────
let athlete=null,weekOffset=0,nutWeekOffset=0,sessions=[],allSessions=[],ticked={},logs={},currentWeekKmData=null,exPicks={},currentNutTargets=null;
var programmeWeeks=12; // per-athlete programme length — loaded from Supabase athlete_data key 'programme_weeks' (default 12)
var _nutLastLoad=0; // timestamp of last nutrition load — gates refetch on rapid tab switching

// ── UTILS ─────────────────────────────────────────────────────────────────────
function localISO(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function localDateFromISO(value){
  var m=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m?new Date(Number(m[1]),Number(m[2])-1,Number(m[3])):new Date(value);
}
function getMon(d){var day=d.getDay(),diff=day===0?-6:1-day;return new Date(d.getFullYear(),d.getMonth(),d.getDate()+diff);}
function getWS(){var m=getMon(new Date());m.setDate(m.getDate()+weekOffset*7);return m;}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

// ── LEGACY PROFILE FIELD HELPERS ──────────────────────────────────────────────
// The Notion API proxy (api/apiAll → /api/notion) was removed on 2026-07-20.
// These pure property readers remain only to safely no-op over empty objects
// when building an athlete profile from roster data.
function getNotionTitle(props){
  for(var k in props){var p=props[k];if(p&&p.type==='title'&&p.title&&p.title.length){var t=p.title.map(function(x){return x.plain_text||'';}).join('');if(t.trim())return t.trim();}}
  var explicit=props['Name']||props['name'];
  if(explicit&&explicit.title&&explicit.title.length){return explicit.title.map(function(x){return x.plain_text||'';}).join('').trim();}
  return '';
}
function getRichText(prop){if(!prop)return '';return(prop.rich_text||[]).map(function(t){return t.plain_text||'';}).join('');}
function getSelect(prop){if(!prop)return '';return(prop.select&&prop.select.name)||(prop.status&&prop.status.name)||'';}
function getMultiSelect(prop){if(!prop||!prop.multi_select)return '';return(prop.multi_select||[]).map(function(t){return t.name||'';}).filter(Boolean).join(', ');}
function getFormulaString(prop){if(!prop||!prop.formula)return '';var f=prop.formula;return f.string||String(f.number||f.boolean||'');}
function getRollupText(prop){if(!prop||!prop.rollup)return '';var r=prop.rollup;if(r.type==='array')return(r.array||[]).map(function(x){return getPropText(x);}).filter(Boolean).join(', ');if(r.type==='number')return String(r.number||'');if(r.type==='date'&&r.date&&r.date.start)return r.date.start;return '';}
function getPropText(prop){
  if(!prop) return '';
  if(prop.type==='title') return(prop.title||[]).map(function(t){return t.plain_text||'';}).join('').trim();
  if(prop.type==='rich_text') return getRichText(prop).trim();
  if(prop.type==='select'||prop.type==='status') return getSelect(prop).trim();
  if(prop.type==='multi_select') return getMultiSelect(prop).trim();
  if(prop.type==='number') return prop.number!=null?String(prop.number):'';
  if(prop.type==='date') return prop.date&&prop.date.start?prop.date.start:'';
  if(prop.type==='formula') return getFormulaString(prop).trim();
  if(prop.type==='rollup') return getRollupText(prop).trim();
  return '';
}
function getRelationIds(prop){return prop&&prop.relation?(prop.relation||[]).map(function(r){return r.id;}).filter(Boolean):[];}

let runLibraryById={},runLibraryByName={};
// fetchRunLibrary is now a no-op — loadRunningLibrary populates all the same data
// (runLibraryById, runLibraryByName, RUNNING_LIBRARY_BY_ID) in a single RUN_DB query.
async function fetchRunLibrary(){
  // Data already populated by loadRunningLibrary via Promise.all in loadWeek
}

// ── SESSION TYPE ──────────────────────────────────────────────────────────────
function usesLeftRightReps(exerciseName){
  return /(?:single[\s-]?leg|split squat)/i.test(String(exerciseName||''));
}
function getType(s){
  var t=(s.sessionType||'').toLowerCase(),n=(s.name||'').toLowerCase();
  if(t==='note'||t==='notes'||t==='general'||t==='discovery'||t==='custom')return 'note';
  if(t==='strength'||GYM_KEYS.some(function(k){return n.indexOf(k.toLowerCase())>=0;}))return 'strength';
  if(t==='rest'||n==='rest')return 'rest';
  return 'run';
}
function sortSessionsForDisplay(list){
  var order={run:0,strength:1,rest:2};
  return(list||[]).slice().sort(function(a,b){
    var ao=order[getType(a)]!=null?order[getType(a)]:9;
    var bo=order[getType(b)]!=null?order[getType(b)]:9;
    if(ao!==bo) return ao-bo;
    return String(a.name||'').localeCompare(String(b.name||''));
  });
}


// Shared UI teardown for both explicit logout and a lost email session.
// preserveEmail=true keeps the remembered email/method so the recovery path
// ("send a new code") is one tap; explicit logout clears everything.
function logoutToLogin(preserveEmail){
  localStorage.removeItem('dp_auth_code');
  localStorage.removeItem('dp_legacy_session');
  if(!preserveEmail){
    try{localStorage.removeItem('dp_auth_method');localStorage.removeItem('dp_auth_email');}catch(e){}
  }
  if(athlete&&athlete.code){try{localStorage.removeItem('dp_profile_'+athlete.code);}catch(e){}}
  athlete=null;sessions=[];allSessions=[];ticked={};logs={};exPicks={};
  document.getElementById('portalScreen').style.display='none';
  document.getElementById('quicklogStrip').style.display='none';
  document.getElementById('loginScreen').style.display='block';
  document.getElementById('codeInput').value='';
  clearLoginError();
  renderCode();
}
function logout(){
  logoutToLogin(false);
  authSignOut(); // ends the Supabase session too (no-op for legacy code logins)
  if(typeof showEmailLogin==='function') showEmailLogin(false);
}
