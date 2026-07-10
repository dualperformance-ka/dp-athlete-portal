// Public runtime constants are loaded from /config.js.
// ── WORKOUT SPLITS (Supabase = source of truth, hardcoded STR = fallback) ────
var SPLITS_BY_NAME={};
function getSplit(key){return SPLITS_BY_NAME[key]||STR[key]||[];}
async function loadWorkoutSplits(){
  if(!sbClient) return;
  try{
    var splitQuery=sbClient.from('workout_splits').select('name,athlete_code,exercises').eq('archived',false);
    if(athlete&&athlete.code) splitQuery=splitQuery.or('athlete_code.is.null,athlete_code.eq.'+athlete.code);
    var res=await splitQuery;
    if(res.error||!res.data||!res.data.length) return;
    var map={};
    // global splits first, then athlete-specific variants override by name
    res.data.forEach(function(r){ if(!r.athlete_code) map[r.name]=r.exercises||[]; });
    res.data.forEach(function(r){ if(r.athlete_code&&athlete&&r.athlete_code===athlete.code) map[r.name]=r.exercises||[]; });
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
      try{sbClient=window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY);resolve(sbClient);}
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
  var text=pill.querySelector('b');if(text)text.textContent=label||(state==='saving'?'Saving':state==='offline'?'Offline · will sync':'Saved');
  if(_saveStateTimer)clearTimeout(_saveStateTimer);
  if(state==='saved')_saveStateTimer=setTimeout(function(){pill.classList.add('quiet');},2200);else pill.classList.remove('quiet');
}
function _flushSbKey(sbKey){
  if(_sbSyncTimers[sbKey]){clearTimeout(_sbSyncTimers[sbKey]);delete _sbSyncTimers[sbKey];}
  var p=_sbSyncPending[sbKey];
  if(!p||!sbClient) return;
  delete _sbSyncPending[sbKey];
  try{
    sbClient.from('athlete_data').upsert(
      {athlete_code:p.code,key:sbKey,value:p.value,updated_at:new Date().toISOString()},
      {onConflict:'athlete_code,key'}
    ).then(function(r){if(r&&r.error)setSaveState('offline','Will sync');else setSaveState('saved');},function(){setSaveState('offline','Will sync');});
  }catch(e){setSaveState('offline','Will sync');}
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
window.addEventListener('online',function(){setSaveState('saving','Syncing');_flushAllSb();retryPendingCoachWrites(true).then(function(){setSaveState('saved');});});
window.addEventListener('offline',function(){setSaveState('offline');});
(function(){
  var _orig=localStorage.setItem.bind(localStorage);
  localStorage.setItem=function(key,value){
    _orig(key,value);
    if(_skipSbSync||!sbClient||!key.startsWith('dp_')) return;
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
  // Mirror the queue to Supabase only when we have a real code (athlete_data needs one).
  if(sbClient&&code&&code!=='_unknown'){
    try{
      await sbClient.from('athlete_data').upsert(
        {athlete_code:code,key:'pending_writes',value:list,updated_at:new Date().toISOString()},
        {onConflict:'athlete_code,key'}
      );
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
  var response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
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
    return await ingestWrite(url,payload); // safely persisted to Supabase + mirrored
  }catch(ingestError){
    // Supabase persistence did NOT happen. Best-effort direct write so the coach
    // still sees it immediately, but ALWAYS queue so Supabase gets it on retry.
    try{await postJsonChecked(url,payload);}catch(directErr){}
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
  if(!sbClient) return null;
  try{
    var weekQuery=sbClient.from('planned_sessions').select('*')
      .eq('athlete_code',athlete.code)
      .gte('planned_date',startISO)
      .lte('planned_date',endISO)
      .order('planned_date',{ascending:true});
    var nextQuery=sbClient.from('planned_sessions').select('*')
      .eq('athlete_code',athlete.code)
      .gt('planned_date',endISO)
      .order('planned_date',{ascending:true})
      .limit(1);
    var queryResults=await Promise.all([weekQuery,nextQuery]);
    var res=queryResults[0],nextRes=queryResults[1];
    if(res.error||!res.data) return null;
    var plannedRows=res.data.slice();
    if(nextRes&&!nextRes.error&&nextRes.data&&nextRes.data.length){
      nextRes.data.forEach(function(row){if(!plannedRows.some(function(existing){return existing.id===row.id;}))plannedRows.push(row);});
    }
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
  if(!sbClient) return;
  _skipSbSync=true;
  programmeWeeks=12;
  try{
    var res=await sbClient.from('athlete_data').select('key,value').eq('athlete_code',code);
    if(res.error||!res.data||!res.data.length){_skipSbSync=false;return;}
    // Build a set of keys that exist in Supabase
    var cloudKeys={};
    res.data.forEach(function(row){cloudKeys[row.key]=row.value;});
    // Programme length (set by coaches in the dashboard Nutrition tab)
    var pw=parseInt(cloudKeys['programme_weeks'],10);
    if(!isNaN(pw)&&pw>0&&pw<=52) programmeWeeks=pw;
    // Coach-set start date is shared by both apps and takes priority over the
    // legacy Notion profile value for week calculations and portal display.
    var startOverride=String(cloudKeys['start_date_override']||'').trim();
    if(/^\d{4}-\d{2}-\d{2}$/.test(startOverride)) athlete.startDate=startOverride;
    // Write cloud data to localStorage (cloud is authoritative)
    res.data.forEach(function(row){
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
          try{sbClient.from('athlete_data').upsert({athlete_code:code,key:'logs',value:_localLogs,updated_at:new Date().toISOString()},{onConflict:'athlete_code,key'}).then(function(){},function(){});}catch(e){}
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
            await sbClient.from('athlete_data').upsert({athlete_code:code,key:'photos',value:parsedPhotos,updated_at:new Date().toISOString()},{onConflict:'athlete_code,key'});
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
            await sbClient.from('athlete_data').upsert({athlete_code:code,key:'goals',value:parsed,updated_at:new Date().toISOString()},{onConflict:'athlete_code,key'});
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
    var response=await fetch('/api/my-logs?code='+encodeURIComponent(code),{cache:'no-store'});
    if(!response.ok) return;
    var result=await response.json();
    if(!result||!Array.isArray(result.body)) return;
    _skipSbSync=true;
    result.body.forEach(function(row){
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

// ── NOTION HELPERS ────────────────────────────────────────────────────────────
async function api(endpoint,body){
  try{var r=await fetch('/api/notion',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint,body})});if(!r.ok)return null;return r.json();}
  catch(e){return null;}
}
async function apiAll(endpoint,body){
  var allResults=[],cursor=null,hasMore=true;
  while(hasMore){
    var params=Object.assign({},body,{page_size:100});
    if(cursor) params.start_cursor=cursor;
    var data=await api(endpoint,params);
    if(!data||!data.results) break;
    allResults=allResults.concat(data.results);
    hasMore=data.has_more||false;cursor=data.next_cursor||null;
    if(!hasMore||!cursor) break;
  }
  return {results:allResults};
}
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


function logout(){
  localStorage.removeItem('dp_auth_code');
  if(athlete&&athlete.code){try{localStorage.removeItem('dp_profile_'+athlete.code);}catch(e){}}
  athlete=null;sessions=[];allSessions=[];ticked={};logs={};exPicks={};
  document.getElementById('portalScreen').style.display='none';
  document.getElementById('quicklogStrip').style.display='none';
  document.getElementById('loginScreen').style.display='block';
  document.getElementById('codeInput').value='';
  clearLoginError();
  renderCode();
}
// ── LOGIN ─────────────────────────────────────────────────────────────────────
function login(){
  var c=sanitizeCode((document.getElementById('codeInput').value||'').trim());
  if(!c){showLoginError('Enter your access code');return;}
  manualLoginIntent=true;
  doLogin(c);
}
// Roster validation — Supabase public.athletes via /api/athletes is the
// single source of truth. Unknown codes are rejected; paused (active=false)
// athletes get the paused-access screen. The Notion profile fetch below is a
// legacy read for existing athletes' profile fields only — new athletes have
// no Notion row and log in fine with roster data alone.
async function validateRosterCode(code){
  try{
    var r=await fetch('/api/athletes?action=validate&code='+encodeURIComponent(code),{cache:'no-store'});
    if(!r.ok) return null;
    return await r.json();
  }catch(e){return null;}
}
function showPausedScreen(name){
  var el=document.getElementById('pausedScreen');if(!el)return;
  var n=document.getElementById('pausedName');
  if(n) n.textContent=name?('Hey '+String(name).split(' ')[0]+' —'):'Hey —';
  document.getElementById('loginScreen').style.display='none';
  document.getElementById('portalScreen').style.display='none';
  var strip=document.getElementById('quicklogStrip');if(strip) strip.style.display='none';
  el.style.display='flex';
}
function pausedBackToLogin(){
  localStorage.removeItem('dp_auth_code');
  var el=document.getElementById('pausedScreen');if(el) el.style.display='none';
  document.getElementById('loginScreen').style.display='block';
  var inp=document.getElementById('codeInput');if(inp) inp.value='';
  renderCode();
}
function buildAthleteProfile(p,code,roster){
  var props=p?(p.properties||{}):{};
  var name=(roster&&roster.name)||(p?getNotionTitle(props):'')||'Athlete'; // roster name first — dashboard is the source of truth
  return {id:p?p.id:null,notionPageId:p?p.id:null,name:name,code:code,
    goalRace:getSelect(props['Goal Race'])||getRichText(props['Goal Race'])||(roster&&roster.race_target)||'',
    peakWeek:(props['Weekly KM Target']&&props['Weekly KM Target'].number!=null?String(props['Weekly KM Target'].number):'')||getRichText(props['Weekly KM Target'])||'',
    weight:getRichText(props['Body Weight (kg)'])||'',startWeight:getRichText(props['Starting Weight'])||getRichText(props['Body Weight (kg)'])||'',bodyFat:getRichText(props['Body Fat %'])||'',
    time5k:getRichText(props['5km Time'])||'',time10k:getRichText(props['10km Time'])||'',
    timeHalf:getRichText(props['Half Marathon Time'])||'',timeMarathon:getRichText(props['Marathon Time'])||'',
    lrPace:getRichText(props['Long Run Pace'])||'',
    why:getRichText(props['Your Why'])||'',m4:getRichText(props['Milestone W4'])||'',
    m8:getRichText(props['Milestone W8'])||'',m12:getRichText(props['Milestone W12'])||'',
    targetWeight:getRichText(props['Target Weight'])||'—',
    startDate:(props['Start Date']&&props['Start Date'].date&&props['Start Date'].date.start)||(roster&&roster.start_date)||'—',
    checkinUrl:getRichText(props['Check-in URL'])||'CHECKIN_URL',whatsapp:getRichText(props['WhatsApp'])||''
  };
}
// Legacy Notion profile read (optional for roster-validated athletes).
async function fetchAthleteProfile(code,roster){
  var data=null;
  try{data=await api('databases/'+ATHLETE_DB+'/query',{filter:{property:'Code',rich_text:{equals:code}},page_size:5});}catch(e){}
  var p=(data&&data.results&&data.results.length)?data.results[0]:null;
  if(!p&&!(roster&&roster.exists)) return null;
  return buildAthleteProfile(p,code,roster);
}
function saveProfileCache(code,profile){try{localStorage.setItem('dp_profile_'+code,JSON.stringify(profile));}catch(e){}}
async function doLogin(code){
  var btn=document.getElementById('loginBtn')||document.querySelector('.lbtn');
  btn.textContent='Authenticating...';btn.disabled=true;btn.classList.add('loading');
  clearLoginError();
  function resetBtn(){btn.textContent='Enter Portal';btn.disabled=false;btn.classList.remove('loading');}
  var showWelcome=manualLoginIntent;
  manualLoginIntent=false;
  // Start everything the login needs in parallel: Supabase library, roster
  // validation, and (below) the Notion profile — instead of one after another.
  var supabaseReady=ensureSupabaseClient();
  var rosterPromise=validateRosterCode(code);
  var cached=null;
  if(!showWelcome){try{cached=JSON.parse(localStorage.getItem('dp_profile_'+code)||'null');}catch(e){}}
  if(cached&&cached.code===code){
    // Returning user: enter instantly on the cached profile. Roster status and
    // a fresh profile are verified in the background.
    athlete=cached;
    rosterPromise.then(function(roster){
      if(roster&&!roster.exists){logout();showLoginError('Access code not recognised');renderCode();return;}
      if(roster&&roster.exists&&!roster.active){showPausedScreen(roster.name);return;}
      fetchAthleteProfile(code,roster).then(function(fresh){
        if(!fresh) return;
        athlete=fresh;saveProfileCache(code,fresh);
        var hn=document.getElementById('heroName');if(hn) hn.textContent=athlete.name;
        populateStatic();
      });
    });
  }else{
    // 1) Roster check (source of truth). null = endpoint unreachable → legacy fallback.
    var roster=await rosterPromise;
    if(roster&&!roster.exists){resetBtn();showLoginError('Access code not recognised');renderCode();return;}
    if(roster&&roster.exists&&!roster.active){resetBtn();showPausedScreen(roster.name);return;}
    // 2) Notion profile enrichment.
    var fresh=await fetchAthleteProfile(code,roster);
    resetBtn();
    if(!fresh){showLoginError('Access code not recognised');renderCode();return;}
    if(showWelcome) showLoginSuccess(fresh.name);
    athlete=fresh;saveProfileCache(code,fresh);
  }
  resetBtn();
  localStorage.setItem('dp_auth_code',code);
  await supabaseReady;
  await Promise.all([(async function(){await loadCloudData(code);await loadStructuredBodyData(code);})(),loadSessionLogs()]);
  ticked=JSON.parse(localStorage.getItem('dp_ticked_'+code)||'{}');
  logs=JSON.parse(localStorage.getItem('dp_logs_'+code)||'{}');
  exPicks=JSON.parse(localStorage.getItem('dp_ex_picks_'+code)||'{}');
  hideLoginSuccess();
  document.getElementById('loginScreen').style.display='none';
  document.getElementById('portalScreen').style.display='block';
  document.getElementById('quicklogStrip').style.display='flex';
  document.getElementById('heroName').textContent=athlete.name;
  populateStatic();
  retryPendingCoachWrites(true);
  // Start Strava before loading the week so kilometre totals can use it as the
  // primary completed-distance source without briefly showing a manual total.
  window._stravaLoadPromise=window.initStrava ? window.initStrava(athlete.code) : Promise.resolve({connected:false,activities:[]});
  loadWeek();
  initCallNudge();
  initCheckinNudge();
  syncPushSubscription();
}

function populateStatic(){
  document.getElementById('goalName').textContent=athlete.name;
  var saved=JSON.parse(localStorage.getItem('dp_goals_'+athlete.code)||'{}');
  setRaceFromValue(saved.goalRace||athlete.goalRace||'');
  document.getElementById('gPeakWeek').value=saved.peakWeek||athlete.peakWeek||'';
  document.getElementById('gRaceDate').value=saved.raceDate||'';
  document.getElementById('gWeight').value=saved.startWeight||saved.weight||athlete.startWeight||athlete.weight||'';
  document.getElementById('gTargetWeight').value=saved.targetWeight||(athlete.targetWeight!=='—'?athlete.targetWeight:'')||'';
  document.getElementById('gBodyFat').value=saved.bodyFat||athlete.bodyFat||'';
  document.getElementById('g5k').value=saved.time5k||athlete.time5k||'';
  document.getElementById('g10k').value=saved.time10k||athlete.time10k||'';
  document.getElementById('gHalf').value=saved.timeHalf||athlete.timeHalf||'';
  document.getElementById('gMarathon').value=saved.timeMarathon||athlete.timeMarathon||'';
  document.getElementById('gLRPace').value=saved.lrPace||athlete.lrPace||'';
  document.getElementById('gWhy').value=saved.why||athlete.why||'';
  document.getElementById('gM4').value=saved.m4||athlete.m4||'';
  document.getElementById('gM8').value=saved.m8||athlete.m8||'';
  document.getElementById('gM12').value=saved.m12||athlete.m12||'';
  var goalsComplete=!!(saved.savedAt);
  var gBanner=document.getElementById('goalsBanner'),gDot=document.getElementById('goalsDot');
  if(gBanner) gBanner.style.display=goalsComplete?'none':'block';
  if(gDot) gDot.style.display=goalsComplete?'none':'inline-block';
  if(saved.savedAt){
    var d=new Date(saved.savedAt);
    document.getElementById('goalsSavedTime').textContent=d.toLocaleDateString('en-AU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
    document.getElementById('goalsSavedBadge').classList.add('show');
  }
  document.getElementById('commsStart').textContent=athlete.startDate;
  if(athlete.checkinUrl!=='CHECKIN_URL'){document.querySelectorAll('[href="CHECKIN_URL"]').forEach(function(el){el.href=athlete.checkinUrl;});}
}

function selectRace(btn){
  document.querySelectorAll('.race-opt').forEach(function(b){b.classList.remove('selected');});
  btn.classList.add('selected');
  document.getElementById('otherRaceField').style.display=btn.dataset.val==='Other'?'':'none';
  if(btn.dataset.val!=='Other') document.getElementById('gRaceOther').value='';
}
function setRaceFromValue(val){
  if(!val) return;var v=val.trim();
  var btns=document.querySelectorAll('.race-opt'),matched=false;
  btns.forEach(function(b){if(b.dataset.val.toLowerCase().replace(/\s/g,'')=== v.toLowerCase().replace(/\s/g,'')){b.classList.add('selected');matched=true;}else{b.classList.remove('selected');}});
  if(!matched&&v){btns.forEach(function(b){if(b.dataset.val==='Other') b.classList.add('selected');});document.getElementById('otherRaceField').style.display='';document.getElementById('gRaceOther').value=v;}
}

// ── EXERCISE PICKS (persisted per-exercise memory) ───────────────────────────
// Rebuild the header PB / e1RM / Vol stat block for one exercise slot from the
// chosen exercise's OWN history. Called when an athlete switches a variant so the
// stats never show a different exercise's records. (markInlinePbs refills Vol live.)
function refreshExerciseStat(i,ei,resolvedEx){
  var statEl=document.getElementById('exstat_'+i+'_'+ei);if(!statEl) return;
  var s=sessions[i];if(!s) return;
  var stored=pbComputeStored(resolvedEx,s.id);
  var isSingleLeg=resolvedEx.toLowerCase().indexOf('single leg')>=0;
  var sh='';
  if(stored.load) sh+='<div class="ex-stat ex-stat-pb"><svg class="icon"><use href="#i-trophy"/></svg> PB '+esc(pbRound1(pbNum(stored.load.weight)))+'kg</div>';
  if(!isSingleLeg&&stored.volume) sh+='<div class="ex-stat ex-stat-vol-pb"><svg class="icon"><use href="#i-trophy"/></svg> Vol PB '+esc(Math.round(stored.volume.value).toLocaleString())+'kg</div>';
  if(stored.e1rm) sh+='<div class="ex-stat ex-stat-e1rm">e1RM '+esc(pbRound1(stored.e1rm.value))+'kg</div>';
  if(!isSingleLeg) sh+='<div id="vol_'+i+'_'+ei+'" class="ex-stat ex-stat-vol">Vol 0kg</div>';
  statEl.innerHTML=sh;
}
function pickEx(exName,chosen){
  exPicks[exName]=chosen;
  localStorage.setItem('dp_ex_picks_'+athlete.code,JSON.stringify(exPicks));
  if(sbClient){try{sbClient.from('athlete_data').upsert({athlete_code:athlete.code,key:'ex_picks',value:exPicks,updated_at:new Date().toISOString()},{onConflict:'athlete_code,key'}).then(function(){}).catch(function(){});}catch(e){}}
  var safeKey=exName.replace(/[^a-z0-9]/gi,'_');
  document.querySelectorAll('[data-pg="'+safeKey+'"]').forEach(function(p){
    p.classList.toggle('active',p.dataset.pv===chosen);
  });
  var nameEl=document.getElementById('exn_'+safeKey);
  if(nameEl) nameEl.textContent=chosen;
  // Re-pull the chosen variant's own history: PB / e1RM / Vol header + LAST/TARGET
  // pill + inline set badges all refresh to match, so stats stay per-exercise.
  var card=nameEl?nameEl.closest('.exc'):null;
  var setsEl=card?card.querySelector('[id^="sets_"]'):null;
  var m=setsEl?setsEl.id.match(/^sets_(\d+)_(\d+)$/):null;
  if(m){
    var i=+m[1],ei=+m[2],s=sessions[i];
    if(s){
      var splitKey=GYM_KEYS.find(function(k){return((s.name||'').indexOf(k)>=0);})||'Upper A';
      refreshExerciseStat(i,ei,chosen);
      try{refreshStrengthFeedback(i,splitKey);}catch(e){}
      try{markInlinePbs(i,splitKey);}catch(e){}
    }
  }
}

async function saveGoals(){
  var btn=document.getElementById('goalsSaveBtn');btn.textContent='Saving...';btn.disabled=true;
  var selectedRaceBtn=document.querySelector('.race-opt.selected');
  var raceVal=selectedRaceBtn?(selectedRaceBtn.dataset.val==='Other'?document.getElementById('gRaceOther').value.trim():selectedRaceBtn.dataset.val):'';
  var goals={goalRace:raceVal,peakWeek:document.getElementById('gPeakWeek').value.trim(),raceDate:document.getElementById('gRaceDate').value.trim(),
    startWeight:document.getElementById('gWeight').value.trim(),weight:document.getElementById('gWeight').value.trim(),targetWeight:document.getElementById('gTargetWeight').value.trim(),
    bodyFat:document.getElementById('gBodyFat').value.trim(),time5k:document.getElementById('g5k').value.trim(),
    time10k:document.getElementById('g10k').value.trim(),timeHalf:document.getElementById('gHalf').value.trim(),
    timeMarathon:document.getElementById('gMarathon').value.trim(),lrPace:document.getElementById('gLRPace').value.trim(),
    why:document.getElementById('gWhy').value.trim(),m4:document.getElementById('gM4').value.trim(),
    m8:document.getElementById('gM8').value.trim(),m12:document.getElementById('gM12').value.trim(),savedAt:new Date().toISOString()};
  localStorage.setItem('dp_goals_'+athlete.code,JSON.stringify(goals));
  // Explicit Supabase upsert — don't rely solely on the monkey-patch
  if(sbClient){try{await sbClient.from('athlete_data').upsert({athlete_code:athlete.code,key:'goals',value:goals,updated_at:new Date().toISOString()},{onConflict:'athlete_code,key'});}catch(e){console.warn('Goals Supabase sync failed:',e);}}
  athlete.startWeight=goals.startWeight||athlete.startWeight;
  var coachResult=await coachWrite(GOALS_WEBHOOK,Object.assign({type:'goals',athleteId:athlete.notionPageId,athleteName:athlete.name,athleteCode:athlete.code,submittedAt:goals.savedAt},goals));
  btn.textContent='Saved ✓';btn.classList.add('saved');
  var d=new Date(goals.savedAt);
  document.getElementById('goalsSavedTime').textContent=d.toLocaleDateString('en-AU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
  document.getElementById('goalsSavedBadge').classList.add('show');
  var gBanner=document.getElementById('goalsBanner'),gDot=document.getElementById('goalsDot');
  if(gBanner) gBanner.style.display='none';
  if(gDot) gDot.style.display='none';
  showToast(coachResult.queued?'Goals saved - coach dashboard sync pending':'Goals saved ✓');
  setTimeout(function(){btn.textContent='Save Goals';btn.classList.remove('saved');btn.disabled=false;},2500);
}

// ── TABS ──────────────────────────────────────────────────────────────────────
// ── CALL NUDGE ────────────────────────────────────────────────────────────────
function callNudgeWeekKey(){
  var now=new Date();
  var d=new Date(now);d.setHours(0,0,0,0);
  d.setDate(d.getDate()+3-(d.getDay()+6)%7);
  var w1=new Date(d.getFullYear(),0,4);
  var isoWeek=1+Math.round(((d-w1)/86400000-3+(w1.getDay()+6)%7)/7);
  var isoYear=d.getFullYear();
  var acode=(athlete&&athlete.code)?athlete.code.toUpperCase()+'_':'';
  return'dp_call_booked_'+acode+isoYear+'_'+(isoWeek<10?'0':'')+isoWeek;
}
function initCallNudge(){
  var nudge=document.getElementById('callNudge');
  var confirmed=document.getElementById('callConfirmedNudge');
  var dot=document.getElementById('tabDotCheckin');
  var raw=localStorage.getItem(callNudgeWeekKey());
  if(!raw){
    if(nudge) nudge.style.display='';
    if(confirmed) confirmed.style.display='none';
    if(dot) dot.classList.add('visible');
  } else {
    if(nudge) nudge.style.display='none';
    // Show confirmed strip with time if available
    var displayTime=null;
    try{var p=JSON.parse(raw);if(p&&p!=='1'&&p!==1)displayTime=p;}catch(e){if(raw&&raw!=='1')displayTime=raw;}
    var titleEl=document.getElementById('callConfirmedTitle');
    if(titleEl) titleEl.textContent=displayTime?'Call booked · '+displayTime:'Call booked this week';
    if(confirmed) confirmed.style.display='';
    if(dot) dot.classList.remove('visible');
  }
}
function checkinWeekKey(){
  var now=new Date();
  var d=new Date(now);d.setHours(0,0,0,0);
  // Grace window: a Mon/Tue submission reports on the week that just finished,
  // so anchor the key to that week too (matches the Week Ending default in
  // initCheckin). Shift the reference date back into the previous week before
  // the ISO-week calc, so a late check-in can't land under the new week's key
  // and overwrite / suppress the current week's submission.
  var day=d.getDay(); // 0=Sun .. 6=Sat
  if(day===1||day===2){d.setDate(d.getDate()-3);} // Mon/Tue -> previous week
  d.setDate(d.getDate()+3-(d.getDay()+6)%7);
  var w1=new Date(d.getFullYear(),0,4);
  var isoWeek=1+Math.round(((d-w1)/86400000-3+(w1.getDay()+6)%7)/7);
  var isoYear=d.getFullYear();
  return'dp_checkin_'+isoYear+'_'+(isoWeek<10?'0':'')+isoWeek;
}
function initCheckinNudge(){
  var nudge=document.getElementById('checkinNudge');
  if(!nudge) return;
  var done=!!localStorage.getItem(checkinWeekKey());
  nudge.style.display=done?'none':'';
  var mobileDot=document.getElementById('mobileCheckinDot');if(mobileDot)mobileDot.classList.toggle('visible',!done);
}
function hideCheckinNudge(){
  localStorage.setItem(checkinWeekKey(),'1');
  var nudge=document.getElementById('checkinNudge');
  if(nudge) nudge.style.display='none';
  var mobileDot=document.getElementById('mobileCheckinDot');if(mobileDot)mobileDot.classList.remove('visible');
}
function initPhotoNudge(){
  var nudge=document.getElementById('photoNudge');
  if(!nudge) return;
  var week=getCurrentProgrammeWeek();
  var photos=JSON.parse(localStorage.getItem('dp_photos_'+athlete.code)||'{}');
  var hasPhotos=photos['week'+week]&&Object.keys(photos['week'+week]).length>0;
  nudge.style.display=hasPhotos?'none':'';
  var dot=document.getElementById('tabDotProgress');
  if(dot) dot.classList.toggle('visible',!hasPhotos);
  var mobileDot=document.getElementById('mobileProgressDot');if(mobileDot)mobileDot.classList.toggle('visible',!hasPhotos);
}
function hidePhotoNudge(){
  var nudge=document.getElementById('photoNudge');
  if(nudge) nudge.style.display='none';
  var dot=document.getElementById('tabDotProgress');
  if(dot) dot.classList.remove('visible');
  var mobileDot=document.getElementById('mobileProgressDot');if(mobileDot)mobileDot.classList.remove('visible');
}
function openCallBooking(){
  switchTab('checkin');
  setTimeout(function(){ openCallModal(); },180);
}
function openCallModal(){
  var m=document.getElementById('callModal');
  var f=document.getElementById('WRivrNxfNTVER2xMit1z_1782710919820');
  if(f){var ds=f.getAttribute('data-src'); if(ds&&f.src.indexOf('leadconnectorhq')===-1) f.src=ds;}
  if(m) m.classList.add('open');
  document.body.style.overflow='hidden';
}
function closeCallModal(){
  var m=document.getElementById('callModal');
  if(m) m.classList.remove('open');
  document.body.style.overflow='';
}
// ---- Booking confirmation (GHL / LeadConnector, with legacy Calendly fallback) ----
function dpFormatBookedTime(iso){
  try{
    if(!iso) return '';
    var d=new Date(iso);
    if(isNaN(d)) return '';
    return d.toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'})+
      ' · '+d.toLocaleTimeString('en-AU',{hour:'numeric',minute:'2-digit',hour12:true});
  }catch(ex){return '';}
}
function dpMarkCallBooked(displayTime){
  var wkey=callNudgeWeekKey();
  var saveVal=displayTime||'1';
  localStorage.setItem(wkey,JSON.stringify(saveVal));
  var nudge=document.getElementById('callNudge');
  if(nudge) nudge.style.display='none';
  var confirmed=document.getElementById('callConfirmedNudge');
  if(confirmed) confirmed.style.display='';
  var titleEl=document.getElementById('callConfirmedTitle');
  if(titleEl) titleEl.textContent=displayTime?'Call booked · '+displayTime:'Call booked this week';
  var dot=document.getElementById('tabDotCheckin');
  if(dot) dot.classList.remove('visible');
  setTimeout(function(){try{closeCallModal();}catch(ex){}},1500);
  if(sbClient&&athlete&&athlete.code){
    var _wkpfx='dp_call_booked_'+athlete.code.toUpperCase()+'_';
    var sbKey='call_booked_'+wkey.slice(_wkpfx.length);
    sbClient.from('athlete_data').upsert(
      {athlete_code:athlete.code,key:sbKey,value:saveVal,updated_at:new Date().toISOString()},
      {onConflict:'athlete_code,key'}
    ).then(function(){},function(err){console.warn('Call booked sync failed:',err);});
  }
}
window.addEventListener('message',function(e){
  if(!e.data) return;
  // GHL / LeadConnector booking confirmation
  var fromGhl=(typeof e.origin==='string')&&/(leadconnectorhq|msgsndr)\.com/i.test(e.origin);
  if(fromGhl){
    var payloadStr='';
    try{payloadStr=(typeof e.data==='string')?e.data:JSON.stringify(e.data);}catch(ex){}
    if(/appointment|booking/i.test(payloadStr)&&/(book|confirm|success|created|scheduled|complete)/i.test(payloadStr)){
      var d=(typeof e.data==='object')?e.data:{};
      var st=d.startTime||(d.appointment&&d.appointment.startTime)||(d.payload&&(d.payload.startTime||d.payload.start_time));
      dpMarkCallBooked(dpFormatBookedTime(st));
      return;
    }
  }
  // Legacy Calendly fallback
  if(e.data.event&&e.data.event==='calendly.event_scheduled'){
    var startTime=e.data.payload&&e.data.payload.event&&e.data.payload.event.start_time;
    dpMarkCallBooked(dpFormatBookedTime(startTime));
  }
});

function switchTab(tab){
  document.querySelectorAll('.tab').forEach(function(t){var active=t.dataset.tab===tab;t.classList.toggle('active',active);t.setAttribute('aria-selected',active?'true':'false');});
  document.querySelectorAll('.tab-content').forEach(function(c){c.classList.toggle('active',c.id==='tab-'+tab);});
  toggleMoreMenu(false);
  setMobileNav(tab==='training'?'home':tab);
  var isTraining=tab==='training';
  document.getElementById('wbar').style.display=isTraining?'':'none';
  if(tab==='nutrition'&&Date.now()-_nutLastLoad>60000) loadNutrition(); // skip refetch if loaded <60s ago (week shifts & post-save always reload directly)
  if(tab==='checkin') initCheckin();
  if(tab==='progress') loadProgress();
}

function setMobileNav(tab){
  document.querySelectorAll('.mobile-nav-item').forEach(function(item){
    var active=item.dataset.mobileTab===tab;
    item.classList.toggle('active',active);
    if(active) item.setAttribute('aria-current','page');else item.removeAttribute('aria-current');
  });
}
function goPortalHome(){
  switchTab('training');setMobileNav('home');
  window.scrollTo({top:0,behavior:'smooth'});
}
function goTrainingPlan(){
  switchTab('training');setMobileNav('training');
  var plan=document.getElementById('calEl');
  if(plan) setTimeout(function(){plan.scrollIntoView({behavior:'smooth',block:'start'});},40);
}
function openReschedule(i){
  var input=document.getElementById('reschedule_'+i);if(!input)return;
  if(input.showPicker)input.showPicker();else input.click();
}
function rescheduleSession(i,date){
  if(!date||!sessions[i])return;var map={};try{map=JSON.parse(localStorage.getItem('dp_reschedules_'+athlete.code)||'{}');}catch(e){}
  map[sessions[i].id]=date;localStorage.setItem('dp_reschedules_'+athlete.code,JSON.stringify(map));
  sessions[i].date=date;var match=allSessions.find(function(s){return s.id===sessions[i].id;});if(match)match.date=date;
  renderTodaySection();renderCal(getWS());showToast('Session moved · coach sync pending');
}
var REMINDER_OPTIONS=[
  {key:'sessions',label:'Training sessions',sub:'A reminder before planned training'},
  {key:'checkins',label:'Weekly check-ins',sub:'A nudge when your review is due'},
  {key:'photos',label:'Progress photos',sub:'A reminder on your photo week'},
  {key:'coach',label:'Coach replies',sub:'Updates when coaching feedback arrives'}
];
function getReminderPreferences(){try{return JSON.parse(localStorage.getItem('dp_reminders_'+((athlete&&athlete.code)||'default'))||'{}');}catch(e){return{};}}
function openPreferences(){
  toggleMoreMenu(false);var prefs=getReminderPreferences(),list=document.getElementById('notificationPreferences');
  list.innerHTML='<button onclick="hardRefreshPortal()" style="margin-bottom:14px;width:100%;padding:12px;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:inherit;font-size:14px;font-weight:600;cursor:pointer">\u21bb Refresh portal</button>'
    +REMINDER_OPTIONS.map(function(o){return '<label class="preference-row"><span><strong>'+o.label+'</strong><small>'+o.sub+'</small></span><input type="checkbox" '+(prefs[o.key]?'checked':'')+' onchange="setReminderPreference(\''+o.key+'\',this.checked)"><i></i></label>';}).join('')
    +'<div id="pushStatus" style="font-family:var(--mono);font-size:10px;margin-top:10px;color:var(--muted)">Notifications: '+(localStorage.getItem('dp_push_status')||'not set up yet')+'</div>';
  syncPushSubscription();
  document.getElementById('preferencesModal').classList.add('open');document.body.style.overflow='hidden';
}
function closePreferences(){document.getElementById('preferencesModal').classList.remove('open');document.body.style.overflow='';}
async function setReminderPreference(key,enabled){
  var wanted=enabled;
  if(enabled&&'Notification'in window&&Notification.permission==='default'){try{var permission=await Notification.requestPermission();if(permission!=='granted')enabled=false;}catch(e){enabled=false;}}
  if(enabled&&'Notification'in window&&Notification.permission==='denied')enabled=false;
  var prefs=getReminderPreferences();prefs[key]=enabled;localStorage.setItem('dp_reminders_'+athlete.code,JSON.stringify(prefs));
  if(wanted&&!enabled){
    // Permission was refused — keep the toggle honest.
    var idx=REMINDER_OPTIONS.map(function(o){return o.key;}).indexOf(key);
    var inputs=document.querySelectorAll('#notificationPreferences input');
    if(idx>-1&&inputs[idx])inputs[idx].checked=false;
    showToast('Notifications are blocked — allow them in your browser or phone settings');
  } else {
    showToast(enabled?'Reminder enabled':'Reminder disabled');
  }
  syncPushSubscription();
}
function getWeeklySummary(){
  var insight=getHomeInsights(),volume=0,wins=[];
  sessions.forEach(function(s){var entry=logs[s.id];if(!entry||typeof entry!=='object')return;Object.keys(entry).forEach(function(k){if(!Array.isArray(entry[k]))return;entry[k].forEach(function(set){var w=parseFloat(set.weight),r=parseInt(set.reps,10);if(!isNaN(w)&&!isNaN(r))volume+=w*r;});});if(isSessionLogged(s.id))wins.push(s.name);});
  return {insight:insight,volume:Math.round(volume),wins:wins};
}
function openWeeklySummary(){
  toggleMoreMenu(false);var s=getWeeklySummary(),i=s.insight,body=document.getElementById('weeklySummaryBody');
  body.innerHTML='<div class="summary-hero"><span>'+i.compliance+'%</span><div><strong>Weekly adherence</strong><small>'+i.completed+' of '+i.planned+' planned sessions logged</small></div></div><div class="summary-grid"><div><small>Training volume</small><strong>'+s.volume.toLocaleString()+'kg</strong></div><div><small>Readiness</small><strong>'+(i.readiness==null?'Not logged':i.readiness+'/100')+'</strong></div><div><small>Running</small><strong>'+(i.kmTarget?i.kmDone.toFixed(1)+' / '+i.kmTarget.toFixed(1)+'km':'No target')+'</strong></div><div><small>PB history</small><strong>'+i.pbs+' exercises</strong></div></div><div class="summary-wins"><strong>Wins this week</strong><p>'+(s.wins.length?s.wins.map(esc).join(' · '):'Log your first completed session to start building the week.')+'</p></div>'+renderCoachMoment([]);
  document.getElementById('weeklySummaryModal').classList.add('open');document.body.style.overflow='hidden';
}
function closeWeeklySummary(){document.getElementById('weeklySummaryModal').classList.remove('open');document.body.style.overflow='';}
function getPbHistoryData(){
  var exerciseMap={},sessionMap={};
  (allSessions||[]).concat(sessions||[]).forEach(function(s){if(s&&s.id)sessionMap[s.id]=s;});
  Object.keys(logs||{}).forEach(function(sessionId,order){
    if(sessionId.indexOf('__')===0)return;var entry=logs[sessionId];if(!entry||typeof entry!=='object'||Array.isArray(entry))return;
    Object.keys(entry).forEach(function(name){
      if(name.indexOf('__')===0||!Array.isArray(entry[name]))return;var clean=pbCleanSets(entry[name]);if(!clean.length)return;
      var key=pbNormName(name),item=exerciseMap[key]||(exerciseMap[key]={name:name,sessions:[]});
      var matched=sessionMap[sessionId],date=matched&&matched.date?matched.date:'';
      var load=Math.max.apply(null,clean.map(function(s){return s.weight;}));
      var e1rms=clean.map(function(s){return pbE1rm(s.weight,s.reps);}).filter(function(v){return v!=null;});
      var volume=clean.reduce(function(sum,s){return sum+(s.reps<=PB_REP_CAP?s.weight*s.reps:0);},0);
      item.sessions.push({id:sessionId,date:date,order:order,sets:clean,load:load,e1rm:e1rms.length?Math.max.apply(null,e1rms):null,volume:volume});
    });
  });
  return Object.keys(exerciseMap).map(function(key){
    var item=exerciseMap[key];item.sessions.sort(function(a,b){return(a.date||'9999').localeCompare(b.date||'9999')||a.order-b.order;});
    var best={load:0,e1rm:0,volume:0,date:'',previousLoad:null},records=[];
    item.sessions.forEach(function(s){if(s.load>best.load){records.push(s.load);best.previousLoad=records.length>1?records[records.length-2]:null;best.load=s.load;best.date=s.date||best.date;}best.e1rm=Math.max(best.e1rm,s.e1rm||0);best.volume=Math.max(best.volume,s.volume||0);});
    item.best=best;return item;
  }).sort(function(a,b){return a.name.localeCompare(b.name);});
}
function formatPbDate(value){if(!value)return'No date recorded';var d=localDateFromISO(value);return isNaN(d.getTime())?value:d.toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'});}
function renderPbHistory(query){
  var list=document.getElementById('pbHistoryList');if(!list)return;var q=String(query||'').trim().toLowerCase();
  var data=getPbHistoryData().filter(function(item){return !q||item.name.toLowerCase().indexOf(q)>=0;});
  document.getElementById('pbHistorySubtitle').textContent=data.length+(data.length===1?' exercise':' exercises')+' with recorded history';
  if(!data.length){list.innerHTML='<div class="pb-history-empty">No matching exercise history yet.</div>';return;}
  list.innerHTML=data.map(function(item){
    var b=item.best,delta=b.previousLoad!=null?b.load-b.previousLoad:null;
    var history=item.sessions.slice().reverse().map(function(s){return '<div class="pb-session-row"><span>'+esc(formatPbDate(s.date))+'</span><strong>'+s.sets.map(function(set){return esc(set.weight)+'kg × '+esc(set.reps);}).join(' · ')+'</strong></div>';}).join('');
    return '<details class="pb-history-card"><summary><div class="pb-history-heading"><span>'+esc(item.name)+'</span><small>'+esc(formatPbDate(b.date))+'</small></div><div class="pb-load"><strong>'+esc(pbRound1(b.load))+'kg</strong><small>'+(delta!=null&&delta>0?'+'+esc(pbRound1(delta))+'kg from prior PB':'Load PB')+'</small></div></summary><div class="pb-metrics"><div><small>Estimated 1RM</small><strong>'+(b.e1rm?esc(pbRound1(b.e1rm))+'kg':'—')+'</strong></div><div><small>Volume PB</small><strong>'+(b.volume?esc(Math.round(b.volume).toLocaleString())+'kg':'—')+'</strong></div><div><small>Sessions</small><strong>'+item.sessions.length+'</strong></div></div><div class="pb-session-history"><div class="pb-session-title">Recorded sets</div>'+history+'</div></details>';
  }).join('');
}
function openPbHistory(){var modal=document.getElementById('pbHistoryModal'),search=document.getElementById('pbHistorySearch');if(search)search.value='';renderPbHistory('');modal.classList.add('open');document.body.style.overflow='hidden';setTimeout(function(){if(search)search.focus();},80);}
function closePbHistory(){document.getElementById('pbHistoryModal').classList.remove('open');document.body.style.overflow='';}
function exportAthleteData(){
  var data={exportedAt:new Date().toISOString(),athlete:{name:athlete.name,code:athlete.code},logs:logs,goals:JSON.parse(localStorage.getItem('dp_goals_'+athlete.code)||'{}'),photos:getPhotos(),reminders:getReminderPreferences()};
  var blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='dual-performance-'+athlete.code+'-data.json';a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);
}
function toggleMoreMenu(open){
  var menu=document.getElementById('moreMenu');if(!menu)return;
  var shouldOpen=typeof open==='boolean'?open:!menu.classList.contains('open');
  menu.classList.toggle('open',shouldOpen);menu.setAttribute('aria-hidden',shouldOpen?'false':'true');
  var button=document.querySelector('[data-mobile-tab="more"]');if(button)button.setAttribute('aria-expanded',shouldOpen?'true':'false');
  document.body.classList.toggle('menu-open',shouldOpen);
  if(shouldOpen)setMobileNav('more');
}
function applyOutdoorMode(enabled){
  document.documentElement.classList.toggle('outdoor-mode',!!enabled);
  var button=document.getElementById('themeToggle');
  if(button){
    button.setAttribute('aria-pressed',enabled?'true':'false');
    var label=button.querySelector('.theme-toggle-label');if(label)label.textContent=enabled?'Indoor':'Outdoor';
    var hint=enabled?'Switch to indoor (dark) mode':'Switch to outdoor (light) mode';
    button.title=hint;button.setAttribute('aria-label',hint);
  }
  var moreLabel=document.querySelector('.more-outdoor strong');if(moreLabel)moreLabel.textContent=enabled?'Indoor mode':'Outdoor mode';
  var moreSub=document.querySelector('.more-outdoor small');if(moreSub)moreSub.textContent=enabled?'Back to the dark theme':'Higher contrast for bright conditions';
  try{localStorage.setItem('dp_outdoor_mode',enabled?'1':'0');}catch(e){}
}
function toggleOutdoorMode(){applyOutdoorMode(!document.documentElement.classList.contains('outdoor-mode'));}
try{if(localStorage.getItem('dp_outdoor_mode')==='1')applyOutdoorMode(true);}catch(e){}

// ── CHECK-IN WIZARD ───────────────────────────────────────────────────────────
var CI_STEP=1,CI_TOTAL=5;
function ciGoStep(n){
  if(n<1||n>CI_TOTAL) return;
  document.querySelectorAll('.ci-step-panel').forEach(function(p){p.classList.remove('active');});
  var panel=document.querySelector('.ci-step-panel[data-step="'+n+'"]');
  if(panel) panel.classList.add('active');
  CI_STEP=n;
  document.querySelectorAll('.ci-sdot').forEach(function(dot,i){
    dot.classList.remove('active','done');
    if(i+1===n) dot.classList.add('active');
    else if(i+1<n) dot.classList.add('done');
  });
  var counter=document.getElementById('ciStepCounter');
  if(counter) counter.textContent=n+' of '+CI_TOTAL;
  var back=document.getElementById('ciBtnBack'),next=document.getElementById('ciBtnNext');
  var navRow=document.getElementById('ciNavRow');
  var isLast=n===CI_TOTAL;
  if(back){back.style.display=n>1?'':'none';}
  if(next){next.style.display=isLast?'none':'';}
  if(navRow){navRow.classList.toggle('solo',n===1||isLast);}
  window.scrollTo({top:0,behavior:'smooth'});
}
function ciStep(dir){ciGoStep(CI_STEP+dir);}

function initCheckin(){
  var nameEl=document.getElementById('ciName');if(nameEl&&!nameEl.value) nameEl.value=athlete.name;
  var weEl=document.getElementById('ciWeekEnding');
  if(weEl&&!weEl.value){
    // Default the Week Ending to the Sunday of the week being reported on.
    // Sun -> today. Mon/Tue -> previous Sunday (grace window for day-after
    // submissions, so a late check-in still counts toward the week just
    // finished). Wed-Sat -> the upcoming Sunday. Uses local date (not UTC)
    // to avoid the default drifting a day near midnight.
    var d=new Date(),day=d.getDay(),sun=new Date(d);
    if(day===0){/* today is Sunday — week ends today */}
    else if(day<=2){sun.setDate(d.getDate()-day);}   // Mon/Tue -> last Sunday
    else{sun.setDate(d.getDate()+(7-day));}            // Wed-Sat -> next Sunday
    weEl.value=localISO(sun);
  }
}

async function submitCheckin(){
  var btn=document.getElementById('ciSubmitBtn');
  var name=document.getElementById('ciName').value.trim();
  if(!name){showToast('Please enter your name');return;}
  btn.textContent='Submitting...';btn.disabled=true;
  var weekEndVal=document.getElementById('ciWeekEnding').value;
  var wkNum=1;
  if(athlete&&athlete.startDate&&athlete.startDate!=='—'&&weekEndVal){
    var _s=localDateFromISO(athlete.startDate);var _w=localDateFromISO(weekEndVal);
    wkNum=Math.max(1,Math.min(12,Math.floor((_w-_s)/(7*24*60*60*1000))+1));
  }else{wkNum=getCurrentProgrammeWeek();}
  var notionTitle=name.toUpperCase().trim()+' — Week '+wkNum;
  var payload={name:notionTitle,athleteName:name,athleteCode:athlete&&athlete.code||'',athleteId:athlete&&athlete.notionPageId||'',weekEnding:weekEndVal,
    runCompleted:document.getElementById('ciRunComp').value||'0',runPlanned:document.getElementById('ciRunPlan').value||'0',
    runKm:document.getElementById('ciRunKm').value||'0',runFeel:document.getElementById('ciRunFeel').value,
    runWins:document.getElementById('ciRunWins').value||'None',runNiggles:document.getElementById('ciRunNiggles').value||'None',
    liftCompleted:document.getElementById('ciLiftComp').value||'0',liftPlanned:document.getElementById('ciLiftPlan').value||'0',
    liftFeel:document.getElementById('ciLiftFeel').value,liftWins:document.getElementById('ciLiftWins').value||'None',
    liftNiggles:document.getElementById('ciLiftNiggles').value||'None',sleep:document.getElementById('ciSleep').value,
    energy:document.getElementById('ciEnergy').value,soreness:document.getElementById('ciSoreness').value,
    nutrition:document.getElementById('ciNut').value,fuelling:document.getElementById('ciFuelling').value||'Not selected',
    socialEating:document.getElementById('ciSocial').value||'None',stress:document.getElementById('ciStress').value,
    motivation:document.getElementById('ciMot').value,upcomingImpact:document.getElementById('ciNotes').value||'',
    testimonial:document.getElementById('ciTestimonial').value||''};
  var sbCiKey='checkin_'+checkinWeekKey().slice('dp_checkin_'.length);
  localStorage.setItem('dp_'+sbCiKey,JSON.stringify(payload));
  if(sbClient&&athlete&&athlete.code){
    try{
      sbClient.from('athlete_data').upsert(
        {athlete_code:athlete.code,key:sbCiKey,value:payload,updated_at:new Date().toISOString()},
        {onConflict:'athlete_code,key'}
      ).then(function(){},function(err){console.warn('Checkin sync failed:',err);});
    }catch(e){console.warn('Checkin sync failed:',e);}
  }
  try{
    var checkinResult=await coachWrite(CHECKIN_WEBHOOK,Object.assign({type:'weekly_checkin'},payload));
    hideCheckinNudge();
    document.getElementById('ciFormContent').style.display='none';document.getElementById('ciSuccess').style.display='block';
    showToast(checkinResult.queued?'Check-in saved - coach dashboard sync pending':'Check-in submitted ✓');
  }catch(e){btn.textContent='Submit Check-in';btn.disabled=false;showToast('Could not submit — please try again');}
}
function resetCheckin(){document.getElementById('ciFormContent').style.display='block';document.getElementById('ciSuccess').style.display='none';var btn=document.getElementById('ciSubmitBtn');btn.textContent='Submit Check-in';btn.disabled=false;ciGoStep(1);}
function todayISO2(){return localISO(new Date());}
// ── SESSION COUNTER ───────────────────────────────────────────────────────────
function renderGymTracker(){
  var bar=document.getElementById('gymBar');
  if(!bar) return;
  var lifts=(sessions||[]).filter(function(s){return getType(s)==='strength';});
  if(!lifts.length){bar.style.display='none';return;}
  var done=lifts.filter(function(s){return logHasRealData(logs[s.id])||s.status==='Completed'||ticked[s.id];}).length;
  document.getElementById('gymTargetVal').textContent=lifts.length;
  document.getElementById('gymDoneVal').textContent=done;
  var hit=done>=lifts.length;
  var pctEl=document.getElementById('gymPctVal');
  if(pctEl) pctEl.textContent=hit?'All done ✓':Math.round(done/lifts.length*100)+'%';
  bar.classList.toggle('km-hit',hit);
  var segs=document.getElementById('gymSegs');
  if(segs){
    var h='';
    for(var i=0;i<lifts.length;i++) h+='<div class="gym-seg'+(i<done?' on':'')+'"></div>';
    segs.innerHTML=h;
  }
  bar.style.display='';
}
function updateSessionCounter(){
  try{renderGymTracker();}catch(e){}
  var total=sessions.length;
  var done=sessions.filter(function(s){return logHasRealData(logs[s.id])||s.status==='Completed';}).length;
  var marked=sessions.filter(function(s){return !(logHasRealData(logs[s.id])||s.status==='Completed')&&ticked[s.id];}).length;
  var el=document.getElementById('heroSessionsDone');
  var val=document.getElementById('heroSessionsDoneVal');
  if(!el||!val) return;
  if(total>0){val.textContent=done+' / '+total+' done'+(marked>0?' · '+marked+' marked':'');el.style.display='';}
  else{el.style.display='none';}
}

// ── QUICK LOG ─────────────────────────────────────────────────────────────────
function openQuickLog(type){
  var today=todayISO2();
  if(type==='body'){
    var dateEl=document.getElementById('qlbDate');
    if(dateEl&&!dateEl.value) dateEl.value=today;
    // Load previous day body data for reference
    (function(){
      var prevPanel=document.getElementById('qlbPrevDay');
      if(!prevPanel||!athlete||!athlete.code) return;
      var d=new Date(today+'T00:00:00');
      d.setDate(d.getDate()-1);
      var yest=localISO(d);
      var raw=null;
      try{raw=localStorage.getItem('dp_daily_body_'+athlete.code+'_'+yest);}catch(e){}
      if(!raw){prevPanel.style.display='none';return;}
      var prev=null;try{prev=JSON.parse(raw);}catch(e){}
      if(!prev){prevPanel.style.display='none';return;}
      var days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      var months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      var dd=new Date(yest+'T00:00:00');
      var lbl='Yesterday ('+days[dd.getDay()]+' '+dd.getDate()+' '+months[dd.getMonth()]+')';
      document.getElementById('qlbPrevDayLabel').textContent=lbl;
      document.getElementById('qlbPrevWeight').textContent=prev.weight?prev.weight+'kg':'—';
      document.getElementById('qlbPrevSleep').textContent=prev.sleep?prev.sleep+'/10':'—';
      document.getElementById('qlbPrevEnergy').textContent=prev.energy?prev.energy+'/10':'—';
      document.getElementById('qlbPrevStress').textContent=prev.stress?prev.stress+'/10':'—';
      document.getElementById('qlbPrevSore').textContent=prev.soreness?prev.soreness+'/10':'—';
      var notesEl=document.getElementById('qlbPrevNotes');
      if(prev.notes){notesEl.textContent='"'+prev.notes+'"';notesEl.style.display='block';}
      else{notesEl.style.display='none';}
      prevPanel.style.display='block';
    })();
    document.getElementById('qlBodyModal').classList.add('open');
    document.body.style.overflow='hidden';
  } else {
    var dateEl=document.getElementById('qlnDate');
    if(dateEl&&!dateEl.value) dateEl.value=today;
    // Load previous day nutrition for reference
    (function(){
      var prevPanel=document.getElementById('qlnPrevDay');
      if(!prevPanel||!athlete||!athlete.code) return;
      // Calculate yesterday's date
      var d=new Date(today+'T00:00:00');
      d.setDate(d.getDate()-1);
      var yest=localISO(d);
      var raw=null;
      // Check Supabase-synced localStorage first
      try{raw=localStorage.getItem('dp_daily_nut_'+athlete.code+'_'+yest);}catch(e){}
      if(!raw){prevPanel.style.display='none';return;}
      var prev=null;try{prev=JSON.parse(raw);}catch(e){}
      if(!prev){prevPanel.style.display='none';return;}
      // Format label e.g. "Yesterday (Mon 27 Apr)"
      var days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      var months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      var dd=new Date(yest+'T00:00:00');
      var lbl='Yesterday ('+days[dd.getDay()]+' '+dd.getDate()+' '+months[dd.getMonth()]+')';
      document.getElementById('qlnPrevDayLabel').textContent=lbl;
      document.getElementById('qlnPrevCal').textContent=prev.calories||'—';
      document.getElementById('qlnPrevPro').textContent=prev.protein?prev.protein+'g':'—';
      document.getElementById('qlnPrevCarb').textContent=prev.carbs?prev.carbs+'g':'—';
      document.getElementById('qlnPrevFat').textContent=prev.fat?prev.fat+'g':'—';
      document.getElementById('qlnPrevFibre').textContent=prev.fibre?prev.fibre+'g':'—';
      var notesEl=document.getElementById('qlnPrevNotes');
      if(prev.notes){notesEl.textContent='"'+prev.notes+'"';notesEl.style.display='block';}
      else{notesEl.style.display='none';}
      prevPanel.style.display='block';
    })();
    // Populate target badges in form labels
    (function(){
      function setTgt(id,val,unit){
        var el=document.getElementById(id);
        if(!el) return;
        if(val!=null){el.textContent='target · '+val.display+unit;el.style.display='inline';}
        else{el.style.display='none';}
      }
      var t=currentNutTargets||{};
      setTgt('qlnTgtCal',t.cal,' kcal');
      setTgt('qlnTgtPro',t.pro,'g');
      setTgt('qlnTgtCarb',t.carb,'g');
      setTgt('qlnTgtFat',t.fat,'g');
      setTgt('qlnTgtFibre',t.fibre,'g');
    })();
    updateNutFeedback();
    document.getElementById('qlNutModal').classList.add('open');
    document.body.style.overflow='hidden';
  }
}
function closeQuickLog(type){
  var id=type==='body'?'qlBodyModal':'qlNutModal';
  var el=document.getElementById(id);if(el) el.classList.remove('open');
  document.body.style.overflow='';
}
function updateNutFeedback(){
  var fb=document.getElementById('qlnFeedback');
  if(!fb) return;
  var t=currentNutTargets;
  var cal=parseFloat(document.getElementById('qlnCal').value)||0;
  var pro=parseFloat(document.getElementById('qlnPro').value)||0;
  var carb=parseFloat(document.getElementById('qlnCarbs').value)||0;
  var fat=parseFloat(document.getElementById('qlnFat').value)||0;
  var fibre=parseFloat(document.getElementById('qlnFibre').value)||0;
  var hasAny=cal||pro||carb||fat||fibre;
  if(!t||!hasAny){fb.style.display='none';return;}
  function chip(label,val,tgt,unit){
    if(tgt==null) return '';
    var pct=tgt.min>0?Math.round(val/tgt.min*100):0;
    var color,status,barColor;
    if(val===0){color='var(--dim)';status='not entered';barColor='var(--border-mid)';}
    else if(pct>=100){color='#15803d';status='✓ on target';barColor='#22c55e';}
    else if(pct>=90){color='#b45309';status='close — '+pct+'%';barColor='#2a3342';}
    else if(pct>=75){color='#b45309';status='almost — '+pct+'%';barColor='#2a3342';}
    else{color='#dc2626';status='under — '+pct+'%';barColor='#f87171';}
    var fillW=Math.min(pct,100);
    return '<div class="qln-fb-item">'
      +'<div class="qln-fb-label">'+label+'</div>'
      +'<div class="qln-fb-val" style="color:'+color+'">'+(val||0)+unit
        +'<span style="font-family:var(--mono);font-size:9px;color:var(--dim);font-weight:400"> / '+tgt.display+unit+'</span></div>'
      +'<div class="qln-fb-bar"><div class="qln-fb-fill" style="width:'+fillW+'%;background:'+barColor+'"></div></div>'
      +'<div class="qln-fb-status" style="color:'+color+'">'+status+'</div>'
      +'</div>';
  }
  var html='<div class="qln-fb-title">vs. this week\'s targets</div><div class="qln-fb-grid">'
    +chip('Calories',cal,t.cal,' kcal')
    +chip('Protein',pro,t.pro,'g')
    +chip('Carbs',carb,t.carb,'g')
    +chip('Fat',fat,t.fat,'g')
    +chip('Fibre',fibre,t.fibre,'g')
    +'</div>';
  fb.innerHTML=html;
  fb.style.display='block';
}
async function submitQuickBody(){
  var btn=document.getElementById('qlbSubmitBtn');btn.textContent='Logging...';btn.disabled=true;
  var bodyDate=document.getElementById('qlbDate').value||todayISO2();
  var pain=document.getElementById('qlbPain').value||'0',painLocation=document.getElementById('qlbPainLocation').value||'',notes=document.getElementById('qlbNotes').value||'';
  if(Number(pain)>0)notes=('Pain '+pain+'/10'+(painLocation?' · '+painLocation:'')+(notes?' · '+notes:''));
  var payload={type:'daily_body',athleteName:athlete.name,athleteCode:athlete.code,athleteId:athlete.notionPageId,
    date:bodyDate,weight:document.getElementById('qlbWeight').value||'',
    sleep:document.getElementById('qlbSleep').value,energy:document.getElementById('qlbEnergy').value,
    stress:document.getElementById('qlbStress').value,soreness:document.getElementById('qlbSore').value,pain:pain,painLocation:painLocation,coachAlert:Number(pain)>=5,notes:notes};
  localStorage.setItem('dp_daily_body_'+athlete.code+'_'+payload.date,JSON.stringify(payload));
  var bodyResult=await coachWrite(DAILY_BODY_WEBHOOK,payload);
  closeQuickLog('body');
  showToast(bodyResult.queued?'Body logged - coach dashboard sync pending':'Body logged ✓');
  btn.textContent='Log Body';btn.disabled=false;
  // Reset for next use
  document.getElementById('qlbDate').value='';document.getElementById('qlbWeight').value='';
  document.getElementById('qlbSleep').value='5';document.getElementById('qlbSleepVal').textContent='5';
  document.getElementById('qlbEnergy').value='5';document.getElementById('qlbEnergyVal').textContent='5';
  document.getElementById('qlbStress').value='5';document.getElementById('qlbStressVal').textContent='5';
  document.getElementById('qlbSore').value='5';document.getElementById('qlbSoreVal').textContent='5';
  document.getElementById('qlbPain').value='0';document.getElementById('qlbPainVal').textContent='0';document.getElementById('qlbPainLocation').value='';document.getElementById('qlbPainLocationWrap').style.display='none';
  document.getElementById('qlbNotes').value='';
  var prevPanel=document.getElementById('qlbPrevDay');if(prevPanel) prevPanel.style.display='none';
  if(weekOffset===0&&document.getElementById('tab-training').classList.contains('active'))renderTodaySection();
}
async function submitQuickNut(){
  var btn=document.getElementById('qlnSubmitBtn');btn.textContent='Logging...';btn.disabled=true;
  var nutDate=document.getElementById('qlnDate').value||todayISO2();
  var payload={type:'daily_nutrition',athleteName:athlete.name,athleteCode:athlete.code,athleteId:athlete.notionPageId,
    date:nutDate,notes:document.getElementById('qlnNotes').value||''};
  // Only send numeric macros that actually have a value — empty strings break Notion number fields
  [['calories','qlnCal'],['protein','qlnPro'],['carbs','qlnCarbs'],['fat','qlnFat'],['fibre','qlnFibre']].forEach(function(_f){
    var _v=document.getElementById(_f[1]).value;
    if(_v!==''&&_v!=null) payload[_f[0]]=_v;
  });
  localStorage.setItem('dp_daily_nut_'+athlete.code+'_'+nutDate,JSON.stringify(payload));
  var nutResult=await coachWrite(DAILY_NUT_WEBHOOK,payload);
  closeQuickLog('nut');
  showToast(nutResult.queued?'Nutrition logged - coach dashboard sync pending':'Nutrition logged ✓');
  btn.textContent='Log Nutrition';btn.disabled=false;
  // Reset for next use
  document.getElementById('qlnDate').value='';document.getElementById('qlnCal').value='';
  document.getElementById('qlnPro').value='';document.getElementById('qlnCarbs').value='';
  document.getElementById('qlnFat').value='';document.getElementById('qlnFibre').value='';
  document.getElementById('qlnNotes').value='';
  var prevPanel=document.getElementById('qlnPrevDay');if(prevPanel) prevPanel.style.display='none';
}

// ── HANDBOOK ──────────────────────────────────────────────────────────────────
var HB_CONTENT=[
  {title:'How This Works',body:'<div class="nutrnote">You have two coaches — Karl owns your running, Alex owns your strength. Every week follows a structure: train, log, check in, review. The more honest you are with your data, the better we can coach you.</div>'},
  {title:'Weekly Rhythm',body:'<div style="display:grid;gap:14px"><div style="display:flex;gap:12px;align-items:flex-start"><div style="font-family:var(--mono);font-size:10px;color:#fff;background:#0a0a0a;padding:4px 10px;border-radius:4px;white-space:nowrap;margin-top:2px">MON–SAT</div><div style="font-size:14px;color:var(--muted)">Execute your sessions. Log weights and runs in the portal as you go.</div></div><div style="display:flex;gap:12px;align-items:flex-start"><div style="font-family:var(--mono);font-size:10px;color:#fff;background:#0a0a0a;padding:4px 10px;border-radius:4px;white-space:nowrap;margin-top:2px">SUNDAY</div><div style="font-size:14px;color:var(--muted)">Submit your weekly check-in. Be honest about what happened and what didn\'t.</div></div><div style="display:flex;gap:12px;align-items:flex-start"><div style="font-family:var(--mono);font-size:10px;color:#fff;background:#0a0a0a;padding:4px 10px;border-radius:4px;white-space:nowrap;margin-top:2px">WEEKLY</div><div style="font-size:14px;color:var(--muted)">Coaching call with Karl & Alex. We review your week and set the focus for the next one.</div></div></div>'},
  {title:'Training Rules',body:'<div style="display:grid;gap:14px"><div style="display:flex;gap:12px"><div style="color:var(--run);font-weight:700;font-size:18px;flex-shrink:0;min-width:28px">01</div><div style="font-size:14px;color:var(--muted)">Never skip the session marked <strong style="color:var(--text)">KEY</strong>. Miss an easy run before you miss a key session.</div></div><div style="display:flex;gap:12px"><div style="color:var(--run);font-weight:700;font-size:18px;flex-shrink:0;min-width:28px">02</div><div style="font-size:14px;color:var(--muted)">Easy means easy. If you can\'t hold a conversation, you\'re going too hard.</div></div><div style="display:flex;gap:12px"><div style="color:var(--run);font-weight:700;font-size:18px;flex-shrink:0;min-width:28px">03</div><div style="font-size:14px;color:var(--muted)">Log every session — even the bad ones. Especially the bad ones.</div></div><div style="display:flex;gap:12px"><div style="color:var(--run);font-weight:700;font-size:18px;flex-shrink:0;min-width:28px">04</div><div style="font-size:14px;color:var(--muted)">Pain is not the same as discomfort. Flag anything sharp, sudden or swollen.</div></div><div style="display:flex;gap:12px"><div style="color:var(--run);font-weight:700;font-size:18px;flex-shrink:0;min-width:28px">05</div><div style="font-size:14px;color:var(--muted)">Rest days are training days. Sleep, eat, recover — this is where adaptation happens.</div></div></div>'},
  {title:'Nutrition Principles',body:'<div style="display:grid;gap:14px"><div style="display:flex;gap:12px"><div style="color:var(--strength);font-weight:700;font-size:18px;flex-shrink:0;min-width:28px">01</div><div style="font-size:14px;color:var(--muted)">Protein is the priority. Hit your target before worrying about anything else.</div></div><div style="display:flex;gap:12px"><div style="color:var(--strength);font-weight:700;font-size:18px;flex-shrink:0;min-width:28px">02</div><div style="font-size:14px;color:var(--muted)">Fuel your hard sessions. Don\'t train hard on an empty tank.</div></div><div style="display:flex;gap:12px"><div style="color:var(--strength);font-weight:700;font-size:18px;flex-shrink:0;min-width:28px">03</div><div style="font-size:14px;color:var(--muted)">Saturday dinner matters. Load carbs the night before your long run.</div></div><div style="display:flex;gap:12px"><div style="color:var(--strength);font-weight:700;font-size:18px;flex-shrink:0;min-width:28px">04</div><div style="font-size:14px;color:var(--muted)">Consistency beats perfection. An 80% week every week beats a perfect week once a month.</div></div></div>'},
  {title:'Progressive Overload',body:'<div class="nutrnote" style="margin-bottom:16px">The foundation of getting stronger. Gradually increase the challenge so your body has a reason to adapt.</div><div style="background:var(--surface2);border-radius:8px;padding:14px;margin-bottom:18px;text-align:center"><div style="font-family:var(--display);font-size:18px;font-weight:700;letter-spacing:.03em;color:var(--strength)">8 reps → 10 reps → 12 reps → increase weight → repeat</div></div><div style="display:grid;gap:14px"><div style="display:flex;gap:12px;align-items:flex-start"><div style="font-family:var(--display);font-size:18px;font-weight:700;color:var(--strength);flex-shrink:0;min-width:26px">1</div><div><div style="font-weight:600;font-size:14px;margin-bottom:3px">Start at 8 reps</div><div style="font-size:13px;color:var(--muted)">Choose a weight that\'s challenging but controlled for all sets.</div></div></div><div style="display:flex;gap:12px;align-items:flex-start"><div style="font-family:var(--display);font-size:18px;font-weight:700;color:var(--strength);flex-shrink:0;min-width:26px">2</div><div><div style="font-weight:600;font-size:14px;margin-bottom:3px">Build the reps</div><div style="font-size:13px;color:var(--muted)">Each session aim for one more rep than last time.</div></div></div><div style="display:flex;gap:12px;align-items:flex-start"><div style="font-family:var(--display);font-size:18px;font-weight:700;color:var(--strength);flex-shrink:0;min-width:26px">3</div><div><div style="font-weight:600;font-size:14px;margin-bottom:3px">Hit 12 reps — increase weight</div><div style="font-size:13px;color:var(--muted)">Once all sets at 12 reps with good form — add weight and return to 8.</div></div></div></div>'},
  {title:'Getting the Most',body:'<div class="nutrnote">Show up to calls prepared. Know what went well, what didn\'t, and what questions you have. The more you put in, the more we can give back. Log your sessions, submit your check-ins, and be honest.</div>'},
  {title:'Glossary',body:'<div style="display:grid;gap:16px"><div style="border-bottom:1px solid var(--border);padding-bottom:14px"><div style="font-family:var(--mono);font-size:10px;color:var(--run);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Easy Run</div><div style="font-size:14px;color:var(--muted)">Conversational pace. Should feel comfortable. Zone 2.</div></div><div style="border-bottom:1px solid var(--border);padding-bottom:14px"><div style="font-family:var(--mono);font-size:10px;color:var(--run);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Tempo</div><div style="font-size:14px;color:var(--muted)">Comfortably hard. You can speak in short sentences.</div></div><div style="border-bottom:1px solid var(--border);padding-bottom:14px"><div style="font-family:var(--mono);font-size:10px;color:var(--run);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Intervals</div><div style="font-size:14px;color:var(--muted)">Hard efforts with recovery. Pace is prescribed in your session.</div></div><div style="border-bottom:1px solid var(--border);padding-bottom:14px"><div style="font-family:var(--mono);font-size:10px;color:var(--run);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Long Run</div><div style="font-size:14px;color:var(--muted)">Your weekly base builder. Easy effort, big aerobic stimulus.</div></div><div><div style="font-family:var(--mono);font-size:10px;color:var(--run);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">RPE</div><div style="font-size:14px;color:var(--muted)">Rate of Perceived Exertion. 1–10 scale of how hard something felt.</div></div></div>'}
];
function openHB(i){var c=HB_CONTENT[i];document.getElementById('hbModalTitle').textContent=c.title;document.getElementById('hbModalBody').innerHTML=c.body;document.getElementById('hbModal').classList.add('open');document.body.style.overflow='hidden';}
function closeHB(){document.getElementById('hbModal').classList.remove('open');document.body.style.overflow='';}
function toggleAcc(id){var content=document.getElementById(id+'Content');var arrow=document.getElementById(id+'Arrow');var open=content.style.display==='none';content.style.display=open?'block':'none';arrow.classList.toggle('open',open);}
function shiftWeek(d){weekOffset+=d;loadWeek();}
function goToday(){weekOffset=0;loadWeek();}
function shiftNutWeek(d){nutWeekOffset+=d;loadNutrition();}
function goNutToday(){nutWeekOffset=0;loadNutrition();}


function numFromProp(prop){
  if(!prop) return null;
  if(prop.type==='number'&&prop.number!=null) return Number(prop.number);
  if(prop.type==='formula'&&prop.formula&&prop.formula.number!=null) return Number(prop.formula.number);
  if(prop.type==='rollup'&&prop.rollup&&prop.rollup.type==='number'&&prop.rollup.number!=null) return Number(prop.rollup.number);
  var txt=getPropText(prop);
  if(txt==null||txt==='') return null;
  var n=parseFloat(String(txt).replace(/[^0-9.\-]/g,''));
  return isNaN(n)?null:n;
}
function textFromAny(pr,keys){
  for(var i=0;i<keys.length;i++){var v=getPropText(pr[keys[i]]);if(v) return v;}
  return '';
}
// Week 0 is the discovery week — render it as "Discovery Week" everywhere the
// athlete sees a week label. (Data-matching keys like week_label queries keep
// using the raw "Week N" form so lookups don't break.)
function isDiscoveryWeek(v){
  if(v===0) return true;
  if(v==null) return false;
  var s=String(v).trim().toLowerCase();
  return s==='0'||s==='week 0'||s==='discovery'||s==='discovery week';
}
function getDisplayWeekNumber(offset){
  var weekNum=getCurrentProgrammeWeek();
  var displayWeek=weekNum+offset;
  if(displayWeek<0) displayWeek=0;
  if(displayWeek>52) displayWeek=52;
  return displayWeek;
}
function getWeekDateRangeFromOffset(offset){
  var m=getMon(new Date());m.setDate(m.getDate()+offset*7);
  var e=new Date(m.getFullYear(),m.getMonth(),m.getDate()+6);
  return {start:m,end:e,startISO:localISO(m),endISO:localISO(e)};
}
function deriveCompletedKmFromSessions(sessionList){
  return (sessionList||[]).filter(function(s){return getType(s)==='run';}).reduce(function(sum,s){
    var sessionLog=logs[s.id]||{};
    var d=parseFloat(String(sessionLog.distance||'').replace(/[^0-9.\-]/g,''));
    return sum + (isNaN(d)?0:d);
  },0);
}
function deriveCompletedKmFromStrava(activities,offset){
  var range=getWeekDateRangeFromOffset(offset||0);
  return Math.round((activities||[]).reduce(function(total,activity){
    var type=String(activity&&((activity.sport_type||activity.type))||'');
    if(type.toLowerCase().indexOf('run')<0) return total;
    var date=String(activity.start_date_local||activity.start_date||'').slice(0,10);
    if(!date||date<range.startISO||date>range.endISO) return total;
    var metres=Number(activity.distance);
    return total+(isNaN(metres)||metres<0?0:metres/1000);
  },0)*10)/10;
}

function formatDateTimeDMY(dateStr){
  if(!dateStr) return '';
  var d=new Date(dateStr);
  if(isNaN(d.getTime())) return String(dateStr);
  var day=String(d.getDate()).padStart(2,'0');
  var month=String(d.getMonth()+1).padStart(2,'0');
  var year=d.getFullYear();
  var hours=String(d.getHours()).padStart(2,'0');
  var mins=String(d.getMinutes()).padStart(2,'0');
  return day+'-'+month+'-'+year+' '+hours+':'+mins;
}
function parseKmFromText(txt){
  txt=String(txt||'');
  if(!txt) return null;
  var match=txt.match(/distance\s*:?\s*([0-9]+(?:\.[0-9]+)?)\s*km/i);
  if(match) return Number(match[1]);
  match=txt.match(/\b([0-9]+(?:\.[0-9]+)?)\s*km\b/i);
  if(match) return Number(match[1]);
  return null;
}
async function getWeeklyCompletedKmFromTracker(offset){
  if(!ATHLETE_SESSION_TRACKER_DB || ATHLETE_SESSION_TRACKER_DB.indexOf('PASTE_YOUR')===0) return null;
  var range=getWeekDateRangeFromOffset(offset||0);
  // Server-side date filter: fetch one week instead of the whole database.
  // If the DB's date property isn't 'Date', the filtered query returns nothing
  // and we fall back to the old full scan.
  var allRows=await apiAll('databases/'+ATHLETE_SESSION_TRACKER_DB+'/query',{
    filter:{and:[
      {property:'Date',date:{on_or_after:range.startISO}},
      {property:'Date',date:{on_or_before:range.endISO}}
    ]},
    sorts:[{property:'Date',direction:'descending'}]
  });
  if(!allRows||!allRows.results||!allRows.results.length){
    allRows=await apiAll('databases/'+ATHLETE_SESSION_TRACKER_DB+'/query',{
      sorts:[{property:'Date',direction:'descending'}]
    });
  }
  if(!allRows||!allRows.results) return null;
  var athleteIdClean=(athlete.notionPageId||'').replace(/-/g,'');
  var athleteNameUpper=(athlete.name||'').toUpperCase().trim();
  var athleteCodeUpper=(athlete.code||'').toUpperCase().trim();
  var total=0;
  allRows.results.forEach(function(r){
    var pr=r.properties||{};
    var rowDate=textFromAny(pr,['Date','Session Date','Planned Date']);
    if(!rowDate) return;
    var rowISO=rowDate.slice(0,10);
    if(rowISO<range.startISO || rowISO>range.endISO) return;

    var athleteMatch=false;
    var athRel=pr['Athlete']&&pr['Athlete'].relation||[];
    athleteMatch=athRel.some(function(a){return a.id.replace(/-/g,'')===athleteIdClean;});
    if(!athleteMatch){
      var athleteTxt=(textFromAny(pr,['Athlete','Athlete Name','Name'])||'').toUpperCase().trim();
      athleteMatch=athleteTxt===athleteNameUpper||athleteTxt===athleteCodeUpper||(getNotionTitle(pr)||'').toUpperCase().indexOf(athleteNameUpper)===0;
    }
    if(!athleteMatch) return;

    var sessionType=(textFromAny(pr,['Session Type'])||'').toLowerCase();
    var sessionName=(textFromAny(pr,['Session','Session Name'])||'').toLowerCase();
    var exerciseLog=(textFromAny(pr,['Exercise Log','exerciseLog'])||'');
    var fullName=((getNotionTitle(pr)||'')+' '+sessionName+' '+exerciseLog).toLowerCase();
    var looksRun=sessionType.indexOf('run')>=0 ||
      sessionName.indexOf('run')>=0 ||
      /long run|easy run|tempo|interval|threshold|fartlek|recovery|hill|track/.test(fullName) ||
      /distance\s*:/.test(fullName);
    if(!looksRun) return;

    var completedProp=pr['Completed'];
    var completed=completedProp&&completedProp.checkbox===true;
    var status=(textFromAny(pr,['Status'])||'').toLowerCase();
    var looksDone=completed||status.indexOf('complete')>=0||status.indexOf('done')>=0||status.indexOf('finish')>=0||status==='';
    if(!looksDone) return;

    var km=numFromProp(pr['Distance (km)']);
    if(km==null) km=numFromProp(pr['Distance']);
    if(km==null) km=numFromProp(pr['KM']);
    if(km==null) km=parseKmFromText(exerciseLog);
    if(km==null) km=parseKmFromText(fullName);
    if(km==null) km=0;
    total+=Number(km||0);
  });
  return total;
}
async function loadWeeklyKmData(offset){
  currentWeekKmData=null;
  if(!WEEKLY_KM_DB || WEEKLY_KM_DB.indexOf('PASTE_YOUR')===0) return null;
  var range=getWeekDateRangeFromOffset(offset);
  var displayWeek=getDisplayWeekNumber(offset);
  var athleteIdClean=(athlete.notionPageId||'').replace(/-/g,'');
  var athleteNameUpper=(athlete.name||'').toUpperCase().trim();
  var athleteCodeUpper=(athlete.code||'').toUpperCase().trim();
  var matchRow=function(r){
    var pr=r.properties||{};
    var rowName=getNotionTitle(pr).toUpperCase().trim();
    var athleteMatch=rowName===athleteNameUpper||rowName===athleteCodeUpper;
    if(!athleteMatch){
      var athRel=pr['Athlete']&&pr['Athlete'].relation||[];
      athleteMatch=athRel.some(function(a){return a.id.replace(/-/g,'')===athleteIdClean;});
    }
    if(!athleteMatch){
      var athleteTxt=textFromAny(pr,['Athlete Name','Name','Athlete Code','Code']).toUpperCase().trim();
      athleteMatch=athleteTxt===athleteNameUpper||athleteTxt===athleteCodeUpper;
    }
    if(!athleteMatch) return false;
    var weekStart=textFromAny(pr,['Week Start','Week start','Start Date']);
    var weekLabel=textFromAny(pr,['Week','Week Label']);
    var weekNumber=numFromProp(pr['Week Number'])||numFromProp(pr['Week #'])||null;
    var startMatch=weekStart && weekStart.slice(0,10)===range.startISO;
    var labelMatch=weekLabel && weekLabel.toLowerCase()===('Week '+displayWeek).toLowerCase();
    var numMatch=weekNumber===displayWeek;
    return startMatch||labelMatch||numMatch;
  };
  // Server-side filter: fetch only this week's rows. Falls back to the old
  // full scan if nothing matches (e.g. rows keyed by week label/number only).
  var allKm=await apiAll('databases/'+WEEKLY_KM_DB+'/query',{
    filter:{property:'Week Start',date:{equals:range.startISO}},
    sorts:[{property:'Week Start',direction:'ascending'}]});
  var matched=(allKm&&allKm.results?allKm.results:[]).filter(matchRow);
  if(!matched.length){
    allKm=await apiAll('databases/'+WEEKLY_KM_DB+'/query',{sorts:[{property:'Week Start',direction:'ascending'}]});
    if(!allKm||!allKm.results) return null;
    matched=allKm.results.filter(matchRow);
  }
  if(!matched.length) return null;
  var pr=matched[0].properties||{};
  var target=numFromProp(pr['Target KM']) ?? numFromProp(pr['Weekly KM Target']) ?? numFromProp(pr['KM Target']) ?? numFromProp(pr['Target']);
  var completed=numFromProp(pr['Completed KM']) ?? numFromProp(pr['Current KM']) ?? numFromProp(pr['KM Completed']) ?? numFromProp(pr['Progress KM']);
  if(completed==null) completed=deriveCompletedKmFromSessions(sessions);
  currentWeekKmData={
    pageId:matched[0].id,
    target:target,
    completed:completed||0,
    weekLabel:textFromAny(pr,['Week','Week Label']) || ('Week '+displayWeek),
    note:textFromAny(pr,['Notes','Coach Notes','Comment']),
    weekStart:textFromAny(pr,['Week Start','Week start','Start Date']) || range.startISO,
    weekEnd:textFromAny(pr,['Week End','Week end','End Date']) || range.endISO
  };
  return currentWeekKmData;
}
function renderKmTracker(kmData){
  var bar=document.getElementById('kmBar');
  if(!bar) return;
  if(!kmData || kmData.target==null || isNaN(kmData.target) || Number(kmData.target)<=0){
    bar.style.display='none';
    return;
  }
  var target=Number(kmData.target);
  var done=Number(kmData.completed||0);
  if(isNaN(done)||done<0) done=0;
  var pct=Math.min(100,Math.round(done/target*100));
  var fmt=function(n){return n.toFixed(1).replace(/\.0$/,'');};
  document.getElementById('kmTargetVal').textContent=fmt(target);
  var doneEl=document.getElementById('kmDoneVal');
  if(doneEl) doneEl.textContent=fmt(done);
  var hit=done>=target;
  var pctEl=document.getElementById('kmPctVal');
  if(pctEl) pctEl.textContent=hit?'Target hit ✓':pct+'%';
  var srcEl=document.getElementById('kmSrcStrava');
  if(srcEl) srcEl.style.display=(kmData.source==='strava')?'':'none';
  bar.classList.toggle('km-hit',hit);
  bar.style.display='';
  // Set width on the next frame so the CSS transition animates from 0
  var fill=document.getElementById('kmFill');
  if(fill){
    requestAnimationFrame(function(){fill.style.width=pct+'%';});
  }
}
// ── LOAD NUTRITION + KM TRACKER ───────────────────────────────────────────────

async function loadNutrition(){
  var weekNum=getCurrentProgrammeWeek();
  var displayWeek=weekNum+nutWeekOffset;
  if(displayWeek<0) displayWeek=0;
  if(displayWeek>programmeWeeks) displayWeek=programmeWeeks;

  currentWeekKmData=null;
  document.getElementById('nutWLabel').textContent=isDiscoveryWeek(displayWeek)?'Discovery Week':'Week '+displayWeek;
  document.getElementById('nutLoadingEl').style.display='block';
  document.getElementById('nutContent').style.display='none';
  document.getElementById('nutNoplan').style.display='none';

  var weekLabel='Week '+displayWeek;

  // Kick off the completed-KM tracker scan now — it's the slowest fetch and is
  // independent of the nutrition row, so it runs in parallel.
  var trackerPromise=getWeeklyCompletedKmFromTracker(nutWeekOffset).catch(function(){return null;});

  // Nutrition plans now live in Supabase (nutrition_plans) — single source of
  // truth shared with the coaches dashboard. One row per athlete per week.
  var row=null;
  if(sbClient){
    try{
      var res=await sbClient.from('nutrition_plans').select('*')
        .eq('athlete_code',(athlete.code||'').toUpperCase().trim())
        .eq('week_label',weekLabel)
        .maybeSingle();
      if(!res.error) row=res.data;
    }catch(e){console.warn('nutrition_plans load failed',e);}
  }

  _nutLastLoad=Date.now();
  document.getElementById('nutLoadingEl').style.display='none';

  if(!row){
    document.getElementById('nutNoplan').style.display='block';
    document.getElementById('kmBar').style.display='none';
    return;
  }

  currentWeekKmData={week:weekLabel,target:null,completed:null,source:'nutrition_row'};

  function getMacro(v){
    if(v==null) return '—';
    var s=String(v).trim();
    return s===''?'—':s;
  }

  var mCal=getMacro(row.calories);
  var mPro=getMacro(row.protein);
  var mCarb=getMacro(row.carbs);
  var mFat=getMacro(row.fats);
  var mFibre=getMacro(row.fibre);
  document.getElementById('nutCal').textContent=mCal;
  document.getElementById('nutPro').textContent=mPro;
  document.getElementById('nutCarb').textContent=mCarb;
  document.getElementById('nutFat').textContent=mFat;
  document.getElementById('nutFibre').textContent=mFibre;
  function toNutNum(v){
    if(typeof v==='number') return {display:String(v),min:v};
    if(!v||v==='—') return null;
    var s=String(v).trim();
    var n=parseFloat(s); // stops at first non-numeric char, so "35-38" → 35
    return isNaN(n)?null:{display:s,min:n};
  }
  currentNutTargets={cal:toNutNum(mCal),pro:toNutNum(mPro),carb:toNutNum(mCarb),fat:toNutNum(mFat),fibre:toNutNum(mFibre)};

  var note=(row.notes||'').trim();
  var noteEl=document.getElementById('nutCoachNote');
  if(note){
    noteEl.innerHTML='<svg class="icon icon-run"><use href="#i-chat"/></svg> '+esc(note);
    noteEl.style.display='block';
  }else{
    noteEl.style.display='none';
  }

  // Weekly KM: manual target wins; otherwise auto-sum this week's planned
  // session distances (with "Weekly KM Total: 65km" rows as a floor).
  var kmTarget=row.weekly_km_target!=null?Number(row.weekly_km_target):null;
  if(kmTarget==null&&sbClient){
    try{
      var ps=await sbClient.from('planned_sessions')
        .select('distance_km,title,session_type')
        .eq('athlete_code',(athlete.code||'').toUpperCase().trim())
        .eq('week_label',weekLabel);
      if(!ps.error&&ps.data&&ps.data.length){
        var sum=0,declared=0;
        ps.data.forEach(function(r2){
          if(r2.session_type==='Weekly KM Total'||/km total/i.test(r2.title||'')){
            var m=(r2.title||'').match(/(\d+(?:\.\d+)?)\s*km/i);
            if(m) declared=Math.max(declared,parseFloat(m[1]));
            return;
          }
          var d=parseFloat(r2.distance_km);
          if(isNaN(d)||d<=0){
            // Fall back to distance in the session title, e.g. "Easy Run — 12km"
            var tm=(r2.title||'').match(/(\d+(?:\.\d+)?)\s*km\b(?!\s*pace)/i);
            d=tm?parseFloat(tm[1]):0;
          }
          if(d>0) sum+=d;
        });
        var auto=Math.round(Math.max(sum,declared)*10)/10;
        if(auto>0) kmTarget=auto;
      }
    }catch(e){}
  }
  var nutritionCompleted=row.completed_km!=null?Number(row.completed_km):0;
  var trackerCompleted=await trackerPromise;
  var localCompleted=deriveCompletedKmFromSessions(sessions);
  var stravaResult=null;
  try{stravaResult=window._stravaLoadPromise ? await window._stravaLoadPromise : null;}catch(e){}
  var hasStrava=!!(stravaResult&&stravaResult.connected);
  var stravaCompleted=hasStrava?deriveCompletedKmFromStrava(stravaResult.activities,nutWeekOffset):null;
  // One source only: Strava wins when connected, then submitted portal logs,
  // then this device's draft logs, and finally the legacy nutrition total.
  var kmCompleted=hasStrava ? stravaCompleted :
    (trackerCompleted!=null&&trackerCompleted>0 ? trackerCompleted :
      (localCompleted>0 ? localCompleted : nutritionCompleted));

  currentWeekKmData.target=kmTarget;
  currentWeekKmData.completed=kmCompleted;
  currentWeekKmData.source=hasStrava?'strava':(trackerCompleted>0?'portal':(localCompleted>0?'local':'nutrition_row'));

  if(kmTarget!=null){
    renderKmTracker({target:kmTarget,completed:kmCompleted,source:currentWeekKmData.source});
  }else{
    document.getElementById('kmBar').style.display='none';
  }

  document.getElementById('nutContent').style.display='block';
  if(weekOffset===0&&document.getElementById('tab-training').classList.contains('active'))renderTodaySection();
}

// ── PHOTO UPLOAD ──────────────────────────────────────────────────────────────
var currentPhotoWeek=null,currentAngle=null;
var ANGLES=['Front','Side','Back','Front Flexed','Back Flexed'];
function getPhotos(){return JSON.parse(localStorage.getItem('dp_photos_'+athlete.code)||'{}');}
function savePhotos(photos){localStorage.setItem('dp_photos_'+athlete.code,JSON.stringify(photos));hidePhotoNudge();}
function renderPhotoGrid(){
  var grid=document.getElementById('photoGrid');if(!grid) return;
  var photos=getPhotos(),html='';
  var curWeek=getCurrentProgrammeWeek();
  for(var w=0;w<=programmeWeeks;w++){
    var wLabel=w===0?'Discovery Week':'Week '+w;
    var weekPhotos=photos['week'+w]||{};var count=Object.keys(weekPhotos).length;var firstUrl=count?weekPhotos[Object.keys(weekPhotos)[0]]:'';
    var isCurrent=w===curWeek;
    html+='<div class="photo-cell'+(count?' has-photo':'')+(isCurrent?' current-week':'')+'" onclick="openPhotoModal('+w+')">';
    if(isCurrent&&!firstUrl) html+='<div class="photo-cell current-week-badge" style="font-family:var(--mono);font-size:8px;color:var(--run);text-transform:uppercase;letter-spacing:.06em;position:absolute;top:5px;left:6px;z-index:2;font-weight:700;line-height:1">NOW</div>';
    if(firstUrl){html+='<img src="'+firstUrl+'" alt="'+wLabel+'" /><div class="photo-count">'+count+'/5</div><div class="photo-overlay">'+wLabel+'</div>';}
    else{html+='<div class="photo-add">+</div><div class="photo-label">'+wLabel+'</div>';}
    html+='</div>';
  }
  grid.innerHTML=html;
}
function openPhotoModal(week){currentPhotoWeek=week;document.getElementById('photoModalTitle').textContent=(week===0?'Discovery Week':'Week '+week)+' Photos';renderAngleGrid(week);document.getElementById('photoModal').classList.add('open');document.body.style.overflow='hidden';}
function closePhotoModal(e){if(e&&e.target!==document.getElementById('photoModal')&&!e.target.classList.contains('photo-modal-close')) return;document.getElementById('photoModal').classList.remove('open');document.body.style.overflow='';renderPhotoGrid();}
function renderAngleGrid(week){
  var photos=getPhotos(),weekPhotos=photos['week'+week]||{},html='';
  ANGLES.forEach(function(angle){
    var key=angle.toLowerCase().replace(/\s/g,'_');var url=weekPhotos[key]||'';
    html+='<div class="angle-slot'+(url?' has-photo':'')+'" id="aslot_'+key+'"'+(url?'':' onclick="triggerAngleUpload(\''+angle+'\')"')+'>';
    if(url){html+='<img src="'+url+'" /><div class="aslot-overlay">'+angle+'</div><button onclick="deleteAnglePhoto(\''+angle+'\')" style="position:absolute;top:6px;right:6px;z-index:3;background:rgba(0,0,0,.6);border:none;border-radius:50%;width:26px;height:26px;color:#fff;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1">×</button>';}
    else{html+='<div class="aslot-add">+</div><div class="aslot-label">'+angle+'</div>';}
    html+='</div>';
  });
  document.getElementById('angleGrid').innerHTML=html;
}
function deleteAnglePhoto(angle){
  if(!confirm('Remove '+angle+' photo for Week '+currentPhotoWeek+'?')) return;
  var key=angle.toLowerCase().replace(/\s/g,'_');var photos=getPhotos();
  if(photos['week'+currentPhotoWeek]){delete photos['week'+currentPhotoWeek][key];if(!Object.keys(photos['week'+currentPhotoWeek]).length) delete photos['week'+currentPhotoWeek];savePhotos(photos);renderAngleGrid(currentPhotoWeek);showToast(angle+' photo removed');}
}
function triggerAngleUpload(angle){currentAngle=angle;document.getElementById('angleInput').click();}
async function handleAngleUpload(input){
  if(!input.files||!input.files[0]) return;
  var file=input.files[0],week=currentPhotoWeek,angle=currentAngle,key=angle.toLowerCase().replace(/\s/g,'_');
  var slot=document.getElementById('aslot_'+key);if(slot) slot.classList.add('uploading');
  var safeName=(athlete.name||athlete.code).toLowerCase().replace(/\s+/g,'_');
  var fullPublicId='dp_progress/'+safeName+'/week'+week+'/'+safeName+'_week'+week+'_'+key;
  var formData=new FormData();
  formData.append('file',file);
  formData.append('upload_preset',CLOUDINARY_PRESET);
  formData.append('public_id',fullPublicId);
  formData.append('context','athlete='+athlete.name+'|week=Week '+week+'|angle='+angle);
  formData.append('tags','dp_progress,'+safeName+',week'+week);
  try{
    var res=await fetch('https://api.cloudinary.com/v1_1/'+CLOUDINARY_CLOUD+'/image/upload',{method:'POST',body:formData});
    var data=await res.json();
    if(data.secure_url){
      var photos=getPhotos();if(!photos['week'+week]) photos['week'+week]={};photos['week'+week][key]=data.secure_url;
      savePhotos(photos);
      // Explicit Supabase sync — don't rely solely on localStorage interceptor
      if(sbClient&&athlete&&athlete.code){
        try{await sbClient.from('athlete_data').upsert({athlete_code:athlete.code,key:'photos',value:photos,updated_at:new Date().toISOString()},{onConflict:'athlete_code,key'});}
        catch(e){console.warn('Photo cloud sync failed:',e);}
      }
      renderAngleGrid(week);showToast(angle+' uploaded ✓');initPhotoNudge();
    }
    else{showToast('Upload failed — try again');}
  }catch(e){showToast('Upload failed — check connection');}
  if(slot) slot.classList.remove('uploading');input.value='';
}

// ── PROGRESS ──────────────────────────────────────────────────────────────────
function formatKgDelta(v){if(v==null||isNaN(v)) return '—';var n=Number(v);var rounded=Math.abs(n)<0.05?0:n;return(rounded>0?'+':'')+rounded.toFixed(1)+'kg';}
function renderWeightChart(entries,targetWeight){
  var chartEl=document.getElementById('pgChart');var emptyEl=document.getElementById('pgChartEmpty');var statsEl=document.getElementById('pgChartStats');
  if(!chartEl||!emptyEl||!statsEl) return;
  chartEl.innerHTML='';emptyEl.style.display='none';statsEl.style.display='';
  var points=entries.slice().reverse().map(function(r){
    var pr=r.properties;var date=pr['Date']&&pr['Date'].date&&pr['Date'].date.start||'';
    var wPr=pr['Weight'];var weight=wPr&&wPr.number!=null?wPr.number:parseFloat(getRichText(wPr||{}));
    return{date:date,weight:weight};
  }).filter(function(x){return x.date&&x.weight!=null&&!isNaN(x.weight);});
  if(points.length<2){emptyEl.style.display='block';statsEl.style.display='none';document.getElementById('pg7d').textContent='—';document.getElementById('pgWeeklyRate').textContent='—';document.getElementById('pgToTarget').textContent='—';return;}
  var width=640,height=220,padL=16,padR=12,padT=12,padB=26;
  var minW=Math.min.apply(null,points.map(function(p){return p.weight;}));var maxW=Math.max.apply(null,points.map(function(p){return p.weight;}));
  var span=Math.max(0.8,maxW-minW);minW=minW-span*0.12;maxW=maxW+span*0.12;
  var usableW=width-padL-padR,usableH=height-padT-padB;
  var coords=points.map(function(p,i){return{x:padL+(usableW*(points.length===1?0.5:i/(points.length-1))),y:padT+((maxW-p.weight)/(maxW-minW))*usableH,label:p.date,weight:p.weight};});
  var poly=coords.map(function(c){return c.x.toFixed(1)+','+c.y.toFixed(1);}).join(' ');
  var areaPoly=poly+' '+coords[coords.length-1].x.toFixed(1)+','+(height-padB)+' '+coords[0].x.toFixed(1)+','+(height-padB);
  var yTicks=[minW,(minW+maxW)/2,maxW];
  var yLines=yTicks.map(function(v){var y=padT+((maxW-v)/(maxW-minW))*usableH;return '<line x1="'+padL+'" y1="'+y.toFixed(1)+'" x2="'+(width-padR)+'" y2="'+y.toFixed(1)+'" stroke="rgba(255,255,255,.08)" stroke-width="1"/><text x="'+(width-padR)+'" y="'+(y-6).toFixed(1)+'" text-anchor="end" fill="rgba(255,255,255,.42)" style="font-family:var(--mono);font-size:10px">'+v.toFixed(1)+'kg</text>';}).join('');
  var xLabels='<text x="'+coords[0].x.toFixed(1)+'" y="'+(height-8)+'" text-anchor="start" fill="rgba(255,255,255,.42)" style="font-family:var(--mono);font-size:10px">'+new Date(points[0].date).toLocaleDateString('en-AU',{day:'numeric',month:'short'})+'</text><text x="'+coords[coords.length-1].x.toFixed(1)+'" y="'+(height-8)+'" text-anchor="end" fill="rgba(255,255,255,.42)" style="font-family:var(--mono);font-size:10px">'+new Date(points[points.length-1].date).toLocaleDateString('en-AU',{day:'numeric',month:'short'})+'</text>';
  var dots=coords.map(function(c,idx){var isLast=idx===coords.length-1;return '<circle cx="'+c.x.toFixed(1)+'" cy="'+c.y.toFixed(1)+'" r="'+(isLast?4.4:3.2)+'" fill="'+(isLast?'#ffffff':'rgba(255,255,255,.88)')+'"/>';}).join('');
  var targetLine='';var targetNum=targetWeight!=null&&!isNaN(targetWeight)?Number(targetWeight):null;
  if(targetNum!=null&&targetNum>=minW&&targetNum<=maxW){var ty=padT+((maxW-targetNum)/(maxW-minW))*usableH;targetLine='<line x1="'+padL+'" y1="'+ty.toFixed(1)+'" x2="'+(width-padR)+'" y2="'+ty.toFixed(1)+'" stroke="rgba(146,210,237,.35)" stroke-dasharray="4 4" stroke-width="1"/><text x="'+padL+'" y="'+(ty-6).toFixed(1)+'" fill="rgba(146,210,237,.72)" style="font-family:var(--mono);font-size:10px">Target '+targetNum.toFixed(1)+'kg</text>';}
  chartEl.innerHTML='<svg viewBox="0 0 '+width+' '+height+'" width="100%" height="220" role="img" aria-label="Weight trend chart">'+yLines+targetLine+'<polygon points="'+areaPoly+'" fill="rgba(146,210,237,.09)"></polygon><polyline points="'+poly+'" fill="none" stroke="#92d2ed" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"></polyline>'+dots+xLabels+'</svg>';
  var latestDate=new Date(points[points.length-1].date);var sevenAgo=new Date(latestDate);sevenAgo.setDate(sevenAgo.getDate()-7);
  var compare=points[0];for(var i=points.length-1;i>=0;i--){if(new Date(points[i].date)<=sevenAgo){compare=points[i];break;}}
  var sevenDelta=points[points.length-1].weight-compare.weight;
  var totalDays=Math.max(1,Math.round((new Date(points[points.length-1].date)-new Date(points[0].date))/(1000*60*60*24)));
  var weeklyRate=((points[points.length-1].weight-points[0].weight)/totalDays)*7;
  document.getElementById('pg7d').textContent=formatKgDelta(sevenDelta);document.getElementById('pg7d').style.color=sevenDelta<0?'var(--ok)':sevenDelta>0?'var(--run)':'var(--text)';
  document.getElementById('pgWeeklyRate').textContent=formatKgDelta(weeklyRate);document.getElementById('pgWeeklyRate').style.color=weeklyRate<0?'var(--ok)':weeklyRate>0?'var(--run)':'var(--text)';
  var toTargetEl=document.getElementById('pgToTarget');
  if(targetNum!=null){var remaining=targetNum-points[points.length-1].weight;toTargetEl.textContent=formatKgDelta(remaining);toTargetEl.style.color=remaining<0?'var(--ok)':remaining>0?'var(--run)':'var(--text)';}
  else{toTargetEl.textContent='—';toTargetEl.style.color='var(--text)';}
}


async function loadProgress(){
  renderPhotoGrid();
  var savedGoals=JSON.parse(localStorage.getItem('dp_goals_'+athlete.code)||'{}');
  var portalStartWeight=savedGoals.startWeight||savedGoals.weight||athlete.startWeight||'';
  document.getElementById('pgStart').textContent=portalStartWeight?portalStartWeight+'kg':'';
  document.getElementById('pgTarget').textContent=athlete.targetWeight||'—';
  document.getElementById('pgLoadingEl').style.display='block';
  document.getElementById('pgWeightLog').style.display='none';
  document.getElementById('pgNoData').style.display='none';
  // Pull Supabase (primary — portal logs) and Notion (direct entries) in parallel.
  // Supabase is processed first so Notion only fills gaps.
  var sbEntries={};
  // Primary source of truth: structured daily_body_logs read server-side via
  // /api/my-logs (service key). athlete_data + Notion below only fill gaps — keeps
  // the athlete's progress in sync with what the coach dashboard sees.
  var myLogsPromise=(athlete&&athlete.code)?fetch('/api/my-logs?code='+encodeURIComponent(athlete.code)).then(function(r){return r.ok?r.json():null;}).catch(function(){return null;}):Promise.resolve(null);
  var sbPromise=sbClient?sbClient.from('athlete_data').select('key,value').eq('athlete_code',athlete.code).like('key','daily_body_%').then(function(r){return r;},function(){return null;}):Promise.resolve(null);
  var nPromise=athlete.notionPageId?api('databases/'+DAILY_BODY_DB+'/query',{filter:{property:'AthleteID',rich_text:{equals:athlete.notionPageId}},sorts:[{property:'Date',direction:'descending'}],page_size:100}).catch(function(){return null;}):Promise.resolve(null);
  var both=await Promise.all([myLogsPromise,sbPromise,nPromise]);
  var myRes=both[0],sbRes=both[1],nRes=both[2];
  try{
    if(myRes&&myRes.body){myRes.body.forEach(function(row){var date=String(row.log_date||'').slice(0,10);if(date&&row.weight!=null&&row.weight!==''&&!sbEntries[date]) sbEntries[date]={date:date,weight:String(row.weight),sleep:row.sleep,energy:row.energy,stress:row.stress,soreness:row.soreness,notes:row.notes};});}
  }catch(e){}
  try{
    if(sbRes&&sbRes.data){sbRes.data.forEach(function(row){var date=row.key.replace('daily_body_','');if(row.value&&row.value.weight&&!sbEntries[date]) sbEntries[date]=row.value;});}
  }catch(e){}
  try{
    if(nRes&&nRes.results){nRes.results.forEach(function(row){var props=row.properties||{};var date=props['Date']&&props['Date'].date&&props['Date'].date.start?props['Date'].date.start.slice(0,10):'';var wt=props['Weight']&&props['Weight'].number!=null?props['Weight'].number:null;if(date&&wt!=null&&!sbEntries[date]){sbEntries[date]={date:date,weight:String(wt)};}});}
  }catch(e){}
  document.getElementById('pgLoadingEl').style.display='none';
  var entries=Object.values(sbEntries).filter(function(e){return e.weight&&!isNaN(parseFloat(e.weight));}).map(function(e){return{date:e.date,weight:parseFloat(e.weight)};}).sort(function(a,b){return b.date.localeCompare(a.date);});
  if(!entries.length){document.getElementById('pgNoData').style.display='block';renderWeightChart([],null);return;}
  // Remap to format expected by rest of function (weight chart etc uses r.properties)
  // We'll handle the Supabase path inline below
  var currentWeight=entries[0].weight;
  var firstLoggedWeight=entries[entries.length-1].weight;
  var targetFromAthlete=athlete.targetWeight&&athlete.targetWeight!=='—'?athlete.targetWeight:null;
  var targetFinal=(savedGoals.targetWeight?savedGoals.targetWeight+'kg':null)||targetFromAthlete||'—';
  var startWeight=parseFloat(String(portalStartWeight).replace(/[^0-9.\-]/g,''));
  if(isNaN(startWeight)) startWeight=firstLoggedWeight;
  document.getElementById('pgStart').textContent=portalStartWeight?portalStartWeight+'kg':(startWeight?startWeight+'kg':'');
  document.getElementById('pgCurrent').textContent=currentWeight?currentWeight+'kg':'—';
  document.getElementById('pgTarget').textContent=targetFinal;
  if(startWeight&&currentWeight&&!isNaN(startWeight)){
    var change=(currentWeight-startWeight).toFixed(1);var positive=change>0;
    var changeEl=document.getElementById('pgChange');changeEl.textContent=(positive?'+':'')+change+'kg';changeEl.style.color=positive?'var(--run)':'var(--ok)';
    document.getElementById('pgChangeLbl').textContent=portalStartWeight?'kg since starting weight':'kg since first weigh-in';
  }
  var targetNumber=parseFloat(String(targetFinal).replace(/[^0-9.\-]/g,''));
  var syntheticForChart=entries.map(function(e){return{properties:{'Weight':{number:e.weight},'Date':{date:{start:e.date}}}};});
  renderWeightChart(syntheticForChart,isNaN(targetNumber)?null:targetNumber);
  var COLLAPSED_ROWS=5;
  var html='<table style="width:100%;border-collapse:collapse"><thead><tr><th style="font-family:var(--mono);font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);padding:6px 4px;text-align:left;border-bottom:1px solid var(--border-mid)">Date</th><th style="font-family:var(--mono);font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);padding:6px 4px;text-align:right;border-bottom:1px solid var(--border-mid)">Weight</th><th style="font-family:var(--mono);font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);padding:6px 4px;text-align:right;border-bottom:1px solid var(--border-mid)">Change</th></tr></thead><tbody>';
  entries.forEach(function(e,idx){
    var dateLabel=e.date?formatDateTimeDMY(e.date):'';
    var changeStr='—',changeColor='var(--dim)';
    if(idx<entries.length-1){var prevWeight=entries[idx+1].weight;if(prevWeight!=null){var diff=(e.weight-prevWeight).toFixed(1);changeStr=(diff>0?'+':'')+diff+'kg';changeColor=diff>0?'var(--run)':diff<0?'var(--ok)':'var(--dim)';}}
    var hidden=idx>=COLLAPSED_ROWS?' class="wl-extra" style="display:none;border-bottom:1px solid var(--border)"':' style="border-bottom:1px solid var(--border)"';
    html+='<tr'+hidden+'><td style="padding:10px 4px;font-size:13px">'+dateLabel+'</td><td style="padding:10px 4px;font-family:var(--display);font-size:18px;font-weight:700;text-align:right">'+e.weight+'<span style="font-family:var(--mono);font-size:11px;color:var(--dim);font-weight:400">kg</span></td><td style="padding:10px 4px;font-family:var(--mono);font-size:12px;text-align:right;color:'+changeColor+'">'+changeStr+'</td></tr>';
  });
  html+='</tbody></table>';
  var remaining=entries.length-COLLAPSED_ROWS;
  if(remaining>0){
    html+='<button id="pgWeightToggle" onclick="toggleWeightLog()" style="width:100%;margin-top:10px;padding:10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;color:rgba(255,255,255,.6);font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.06em;cursor:pointer">Show all '+entries.length+' entries</button>';
  }
  var logEl=document.getElementById('pgWeightLog');logEl.innerHTML=html;logEl.style.display='block';
}

function toggleWeightLog(){
  var btn=document.getElementById('pgWeightToggle');
  var rows=document.querySelectorAll('#pgWeightLog .wl-extra');
  var expanded=btn.getAttribute('data-expanded')==='1';
  rows.forEach(function(r){r.style.display=expanded?'none':'';});
  if(expanded){btn.textContent=btn.getAttribute('data-show-label');btn.setAttribute('data-expanded','0');}
  else{btn.setAttribute('data-show-label',btn.textContent);btn.textContent='Show less';btn.setAttribute('data-expanded','1');}
}

function getCurrentProgrammeWeek(){
  var wkS=sessions.find(function(s){return s.week;});
  if(wkS){var m=wkS.week.match(/\d+/);if(m) return parseInt(m[0]);}
  if(athlete.startDate&&athlete.startDate!=='—'){var start=localDateFromISO(athlete.startDate);var now=new Date();var diff=Math.floor((now-start)/(7*24*60*60*1000))+1;return Math.max(1,Math.min(programmeWeeks,diff));}
  return 1;
}

// ── LOAD WEEK ─────────────────────────────────────────────────────────────────
async function loadWeek(){
  var ws=getWS(),we=new Date(ws.getFullYear(),ws.getMonth(),ws.getDate()+6);
  var wsISO=localISO(ws),weISO=localISO(we);
  var label=ws.toLocaleDateString('en-AU',{day:'numeric',month:'short'})+' – '+we.toLocaleDateString('en-AU',{day:'numeric',month:'short'});
  document.getElementById('wlabel').textContent=label;
  document.getElementById('wbar').style.display='';
  document.getElementById('loadingEl').style.display='block';
  document.getElementById('calEl').style.display='none';document.getElementById('noplanEl').style.display='none';
  // Run library + workout splits + plan fetch in parallel — all from Supabase
  var results=await Promise.all([
    loadRunningLibrary(),
    loadWorkoutSplits(),
    loadPlannedSessions(wsISO,weISO)
  ]);
  var mapped=results[2];
  document.getElementById('loadingEl').style.display='none';
  if(!mapped){showNoplan();return;}
  var reschedules={};try{reschedules=JSON.parse(localStorage.getItem('dp_reschedules_'+athlete.code)||'{}');}catch(e){}
  mapped.forEach(function(s){if(reschedules[s.id])s.date=reschedules[s.id];});
  allSessions=mapped;
  sessions=allSessions.filter(function(s){return s.date&&s.date>=wsISO&&s.date<=weISO;});
  if(weekOffset===0) initPhotoNudge();
  renderTodaySection();
  var wkS=sessions.find(function(s){return s.week;});
  if(wkS){
    var _hl=document.querySelector('.hero-week-label');
    var _hn=document.getElementById('heroWeek');
    if(isDiscoveryWeek(wkS.week)){
      if(_hl) _hl.style.display='none';
      _hn.classList.add('discovery');
      _hn.textContent='Discovery Week';
    }else{
      if(_hl) _hl.style.display='';
      _hn.classList.remove('discovery');
      _hn.textContent=wkS.week;
    }
  }
  var runs=sessions.filter(function(s){return getType(s)==='run';});
  var lifts=sessions.filter(function(s){return getType(s)==='strength';});
  document.getElementById('ciRuns').textContent=runs.length;document.getElementById('ciLifts').textContent=lifts.length;
  updateSessionCounter();
  loadNutrition(); // also populates KM tracker
  if(!sessions.length){showNoplan();return;}
  renderCal(ws);
}
function showNoplan(){document.getElementById('noplanEl').style.display='block';var tEl=document.getElementById('todayEl');if(tEl) tEl.style.display='none';}

// ── RENDER CALENDAR ───────────────────────────────────────────────────────────
function renderCal(ws){
  var todayISO=localISO(new Date()),html='<div class="week-plan-title">This week</div>';
  for(var di=0;di<7;di++){
    var d=new Date(ws.getFullYear(),ws.getMonth(),ws.getDate()+di);
    var iso=localISO(d),isToday=iso===todayISO;
    var dayLabel=d.toLocaleDateString('en-AU',{day:'numeric',month:'short'});
    var daySessions=sortSessionsForDisplay(sessions.filter(function(s){return s.date===iso;}));
    html+='<div class="dg"><div class="dgh'+(isToday?' today':'')+'"><span class="dgname">'+DAYS[di]+'</span><span class="dgdate">'+dayLabel+'</span>'+(isToday?'<span class="todaybadge">Today</span>':'')+'</div>';
    if(!daySessions.length){html+='<div class="restday">Rest</div>';}
    else{daySessions.forEach(function(s){var i=sessions.indexOf(s);html+=buildCard(s,i);});}
    html+='</div>';
  }
  var el=document.getElementById('calEl');el.innerHTML=html;el.style.display='block';
}

function logHasRealData(v){
  if(!v||typeof v!=='object') return false;
  return Object.entries(v).some(function(e){
    var k=e[0],val=e[1];
    if(k==='__savedAt') return false;
    if(Array.isArray(val)) return val.length>0; // gym: exercise -> sets[]
    if(val&&typeof val==='object') return Object.keys(val).length>0;
    return val!==''&&val!=null; // run: distance/pace/rpe/...
  });
}
function buildCard(s,i){
  var type=getType(s);
  var logged=logHasRealData(logs[s.id]);
  var done=logged||s.status==='Completed';
  var marked=!done&&!!ticked[s.id];
  var displayName=s.name||'Session';
  var metaLine='';
  if(type==='run'){
    var r=resolveRunDisplay(s);
    metaLine=buildRunSubtitle(s,r.meta||{},r.title||displayName);
    if(!metaLine){var mp=[];if(s.intensity) mp.push(s.intensity);if(s.week) mp.push(s.week);metaLine=mp.join(' · ');}
  }else{
    var meta=[];if(s.intensity) meta.push(s.intensity);if(s.week) meta.push(s.week);
    metaLine=meta.join(' · ');
  }
  var h='<div class="sc'+(done?' done':'')+(marked?' marked':'')+'" id="sc_'+i+'">';
  h+='<div class="sch" onclick="togS('+i+')">';
  h+='<div class="sdot dot-'+type+'"></div>';
  h+='<div class="sinfo"><div class="sname '+type+'">'+esc(displayName)+'</div>';
  if(metaLine) h+='<div class="smeta">'+esc(metaLine)+'</div>';
  h+='</div>';
  h+='<button class="reschedule-btn" title="Reschedule" aria-label="Reschedule '+esc(displayName)+'" onclick="event.stopPropagation();openReschedule('+i+')"><svg class="icon"><use href="#i-calendar"/></svg></button><input class="reschedule-input" id="reschedule_'+i+'" type="date" value="'+esc(s.date||'')+'" onchange="rescheduleSession('+i+',this.value)" />';
  h+='<button class="tick'+(done?' on':'')+(marked?' marked':'')+'" id="tick_'+i+'" onclick="event.stopPropagation();tickS('+i+')">';
  h+='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  h+='</button></div>';
  if(marked) h+='<div class="sc-nudge" id="nudge_'+i+'">Marked — tap to open &amp; log your data</div>';
  h+='<div class="scb" id="scb_'+i+'">'+buildBody(s,i,type)+'</div></div>';
  return h;
}

function resolveRunDisplay(s){
  var related=null;
  if(s.runningLibraryIds&&s.runningLibraryIds.length){
    for(var li=0;li<s.runningLibraryIds.length;li++){
      if(RUNNING_LIBRARY_BY_ID[s.runningLibraryIds[li]]){related=RUNNING_LIBRARY_BY_ID[s.runningLibraryIds[li]];break;}
      if(runLibraryById[s.runningLibraryIds[li]]){related=runLibraryById[s.runningLibraryIds[li]];break;}
    }
  }
  if(!related&&s.runningSessionIds&&s.runningSessionIds.length){
    for(var ri=0;ri<s.runningSessionIds.length;ri++){
      if(runLibraryById[s.runningSessionIds[ri]]){related=runLibraryById[s.runningSessionIds[ri]];break;}
      if(RUNNING_LIBRARY_BY_ID[s.runningSessionIds[ri]]){related=RUNNING_LIBRARY_BY_ID[s.runningSessionIds[ri]];break;}
    }
  }

  var rsTitle=(related&&related.name)||s.runningSession||s.name||'';
  var rsDetail=(related&&related.description)||s.runDetails||'';
  var rs=null;
  var lookupKey=(rsTitle||(related&&related.name)||s.name||'').toLowerCase();

  if(related){
    rs={
      type:related.type||'',
      phase:related.phase||'',
      distance:related.distance||'',
      intensity:related.intensity||'',
      surface:related.surface||'',
      difficulty:related.difficulty||'',
      tags:related.tags||'',
      rpe:related.rpe||'',
      target:related.target||related.goal||'',
      targetPace:related.targetPace||'',
      duration:related.duration||'',
      warmUp:related.warmUp||related.warmup||'',
      coolDown:related.coolDown||related.cooldown||'',
      sessionGoal:related.sessionGoal||related.goal||'',
      recoveryType:related.recoveryType||related.recovery||'',
      description:related.description||'',
      alternative:related.alternative||''
    };
  }
  if(!rs&&lookupKey){rs=RUN[rsTitle]||runLibraryByName[lookupKey]||null;}
  if(!rs&&lookupKey){for(var k in RUN){if(lookupKey.indexOf(k.toLowerCase())>=0||k.toLowerCase().indexOf(lookupKey)>=0){rs=RUN[k];break;}}}
  // ── Coach override (Supabase session_overrides) ───────────────────────────
  var ov=_sessionOverrides[s.id]||null;
  if(ov){
    if(ov.name) rsTitle=ov.name;
    var ovParts=[];
    if(ov.intervals) ovParts.push(ov.intervals);
    if(ov.working_pace) ovParts.push('Working pace: '+ov.working_pace);
    if(ov.distance_km) ovParts.push('Distance: '+ov.distance_km+'km');
    if(ovParts.length) rsDetail=ovParts.join(' · ');
    if(!rs) rs={};
    if(ov.warm_up) rs.warmUp=ov.warm_up;
    if(ov.cool_down) rs.coolDown=ov.cool_down;
    if(ov.target_pace) rs.targetPace=ov.target_pace;
    if(ov.rest) rs.rest=ov.rest;
    if(ov.notes) rs.sessionGoal=ov.notes;
    if(ov.distance_km) rs.distance=ov.distance_km+'km';
    if(ovParts.length) rs.description=rsDetail;
  }
  return{related:related,title:rsTitle,detail:rsDetail,meta:rs};
}

// ── RPE + ALTERNATIVE WORKOUT HELPERS ─────────────────────────────────────────
// Provide sensible fallbacks when the Notion running library doesn't supply
// RPE or an alternative workout, so every running session card renders with
// the full layout (effort rating box + alternative workout box).
function inferRpeMeta(meta,sessionTitle){
  meta=meta||{};
  var presets={
    recovery:{value:'3/10 RPE',desc:'Very easy, purely for recovery and circulation'},
    easy:{value:'4/10 RPE',desc:'Conversational pace, easy breathing, recovery focus'},
    long:{value:'5/10 RPE',desc:'Steady sustainable effort for extended distance'},
    steady:{value:'6/10 RPE',desc:'Comfortable aerobic effort, able to talk in short sentences'},
    tempo:{value:'7/10 RPE',desc:'Comfortably hard, controlled breathing, sustainable effort'},
    threshold:{value:'8/10 RPE',desc:'Hard effort, controlled breathing, race pace intensity'},
    interval:{value:'8/10 RPE',desc:'Hard effort, controlled breathing, race pace intensity'},
    track:{value:'8/10 RPE',desc:'Hard effort, controlled breathing, race pace intensity'},
    speed:{value:'9/10 RPE',desc:'Very hard, short bursts near maximum effort'},
    sprint:{value:'9/10 RPE',desc:'Near-maximal effort, heavy breathing, full focus'},
    race:{value:'9/10 RPE',desc:'Race-day effort, sustained hard intensity'},
    hill:{value:'8/10 RPE',desc:'Hard effort on climbs, focus on form and power'},
    fartlek:{value:'7/10 RPE',desc:'Varied hard/easy bursts, play with pace'}
  };
  var title=String(sessionTitle||meta.name||'').toLowerCase();
  var intensity=String(meta.intensity||'').toLowerCase();
  var type=String(meta.type||'').toLowerCase();
  var haystack=title+' '+intensity+' '+type;
  var order=['recovery','interval','track','speed','sprint','threshold','tempo','fartlek','hill','race','long','steady','easy'];
  var pick=null;
  for(var oi=0;oi<order.length;oi++){
    if(haystack.indexOf(order[oi])>=0){pick=presets[order[oi]];break;}
  }
  if(!pick) pick=presets.steady;
  var rpe=String(meta.rpe||'').trim();
  if(rpe){
    var value=rpe;
    if(!/rpe/i.test(value)){
      if(value.indexOf('/')<0){
        var num=parseFloat(value);
        if(!isNaN(num)) value=num+'/10';
      }
      value=value+' RPE';
    }
    return{value:value,desc:pick.desc};
  }
  return{value:pick.value,desc:pick.desc};
}

function parseAlternative(meta,sessionTitle){
  meta=meta||{};
  var alt=String(meta.alternative||'').trim();
  // Derive a default alternative workout based on the session type so the
  // panel always renders — even if Notion doesn't supply one.
  var title=String(sessionTitle||meta.name||'').toLowerCase();
  var intensity=String(meta.intensity||'').toLowerCase();
  var haystack=title+' '+intensity;
  var defaults=[
    {match:['track','interval'],name:'Road Tempo Intervals',desc:'6×3min @ threshold pace with 90sec jog recovery. Use if no track access. Same intensity, different structure.'},
    {match:['speed','sprint'],name:'Hill Sprints',desc:'8×20sec hill sprints with full walk-back recovery. Equivalent power work without the track.'},
    {match:['tempo'],name:'Progression Run',desc:'Start easy, build to tempo pace in the final third. Same aerobic stimulus with smoother structure.'},
    {match:['threshold'],name:'Cruise Intervals',desc:'4×6min @ threshold with 2min jog recovery. Same lactate work, broken up for control.'},
    {match:['hill'],name:'Treadmill Incline Run',desc:'25min @ 4-6% incline, easy pace. Strength stimulus without outdoor hills.'},
    {match:['long'],name:'Split Long Run',desc:'Break into AM + PM runs of equal distance. Use if time is tight or legs feel flat.'},
    {match:['recovery'],name:'Walk + Mobility',desc:'30min brisk walk + 10min full-body mobility. Purely for circulation and recovery.'},
    {match:['easy'],name:'Cross-Train Session',desc:'30-40min easy bike, swim, or elliptical. Same aerobic work, zero impact.'},
    {match:['fartlek'],name:'Structured Fartlek',desc:'5min easy, then 8×(1min on / 1min off), 5min easy. Same stimulus with cleaner timing.'}
  ];
  var fallback=null;
  for(var di=0;di<defaults.length;di++){
    var d=defaults[di];
    for(var mi=0;mi<d.match.length;mi++){
      if(haystack.indexOf(d.match[mi])>=0){fallback=d;break;}
    }
    if(fallback) break;
  }
  if(!fallback) fallback={name:'Easy Substitute Run',desc:'30-40min easy run by feel. Use if the main session isn\'t possible today.'};

  if(!alt){return{title:fallback.name,description:fallback.desc};}

  // If alt text includes an explicit title (first line, or "Title: Description")
  var lineBreak=alt.indexOf('\n');
  if(lineBreak>0&&lineBreak<80){
    var first=alt.substring(0,lineBreak).trim().replace(/[:\-–—]+$/,'').trim();
    var rest=alt.substring(lineBreak+1).trim();
    if(first&&rest){return{title:first,description:rest};}
  }
  var colon=alt.indexOf(':');
  if(colon>0&&colon<50){
    var t=alt.substring(0,colon).trim();
    var r=alt.substring(colon+1).trim();
    if(t&&r&&t.split(/\s+/).length<=6){return{title:t,description:r};}
  }
  return{title:fallback.name,description:alt};
}

// ── INTERVAL REST TIME PARSER ──────────────────────────────────────────────────
// Rest times are coach-decided by this function based on session type/intensity.
// Priority: 1) Notion "Rep Rest" field (coach override), 2) this function's logic.
// Notion's Recovery Type / Recovery Time fields are NEVER used for rep rest.
function getIntervalRestInfo(meta, sessionTitle) {
  var title = String(sessionTitle || meta.name || '').toLowerCase();
  var intensity = String(meta.intensity || '').toLowerCase();
  var type = String(meta.type || '').toLowerCase();
  var description = String(meta.description || meta.target || '').toLowerCase();
  var haystack = title + ' ' + intensity + ' ' + type + ' ' + description;

  // Exclude continuous/easy/recovery sessions — no rep-based rest needed
  var isContinuous = /\beasy run\b|\blong run\b|\brecovery run\b|\brecovery\b|\beasy\b|\bcontinuous\b|\bsteady state\b/.test(type) ||
    /\beasy run\b|\blong run\b|\brecovery run\b/.test(title) ||
    intensity === 'aerobic' || intensity === 'easy';
  if (isContinuous) return null;

  // Exclude tempo/threshold runs that are continuous (no reps)
  var isContinuousTempo = /\btempo run\b|\bthreshold run\b|\bsteady tempo\b/.test(title) && !/[x×]|\brep\b|\brepeat/.test(haystack);
  if (isContinuousTempo) return null;

  // Must look like an interval/rep session
  var isInterval = /interval|track|repeat|\brep\b|speed|fartlek|hill sprint|hill rep|yasso|\d+\s*[x×]\s*\d|\d+\s*x\s*\d/.test(haystack);
  if (!isInterval) return null;

  // ── COACH LOGIC: decide rest time based on session type ──────────────────────
  var restTime, restType, restDesc, recoveryNote;

  if (/200\s*m|200m/.test(haystack)) {
    // 200m reps — near-maximal, full walk rest
    restTime = '60–90 sec'; restType = 'Walk Rest';
    restDesc = 'Walk back to the start line. Full recovery — these are near-maximal speed efforts.';
    recoveryNote = 'Short and sharp. Full rest is non-negotiable — rushing recovery kills quality.';

  } else if (/400\s*m|400m/.test(haystack)) {
    // 400m reps — VO2max, 60 sec walk rest
    restTime = '60 sec'; restType = 'Walk Rest';
    restDesc = 'Walk rest between each rep. Short and structured — this keeps the stimulus race-sharp.';
    recoveryNote = 'If pace drops >3 sec/lap by rep 5, add 15–20 sec to rest and hold pace — don\'t sacrifice quality for speed.';

  } else if (/800\s*m|800m/.test(haystack)) {
    // 800m reps — VO2max, jog/walk rest
    restTime = '2–3 min'; restType = 'Jog / Walk Rest';
    restDesc = 'Easy jog or brisk walk between reps. Aim to feel ~80% recovered before the next 800.';
    recoveryNote = 'Don\'t rush the recovery — these demand real effort and real rest.';

  } else if (/1\.6\s*km|1600\s*m/.test(haystack)) {
    // 1600m / mile reps
    restTime = '2–3 min'; restType = 'Easy Jog Rest';
    restDesc = 'Easy jog between reps. These are threshold-length efforts — you need proper recovery to hold pace.';
    recoveryNote = 'If pace drops >5 sec/km on a rep, the rest wasn\'t long enough.';

  } else if (/1\.5\s*k|1500\s*m/.test(haystack)) {
    restTime = '2–3 min'; restType = 'Easy Jog Rest';
    restDesc = 'Easy jog between reps. You should be breathing comfortably before the next one starts.';
    recoveryNote = 'Keep the jog very easy — legs should feel ready, not fatigued.';

  } else if (/1\s*km|1000\s*m/.test(haystack)) {
    // 1km reps — threshold/VO2max
    restTime = '90 sec – 2 min'; restType = 'Easy Jog Rest';
    restDesc = 'Easy jog recovery between each 1km rep. HR should drop noticeably before restarting.';
    recoveryNote = 'Consistent pacing across all reps is the goal — use the rest to make that happen.';

  } else if (/2\s*km|2000\s*m/.test(haystack)) {
    restTime = '2–3 min'; restType = 'Easy Jog Rest';
    restDesc = 'Easy jog or walk recovery. These are sustained efforts — give yourself enough time to reset.';
    recoveryNote = 'Aim for even splits across all reps.';

  } else if (/3\s*km|3000\s*m/.test(haystack)) {
    restTime = '3–4 min'; restType = 'Easy Jog Rest';
    restDesc = 'Easy jog between reps. Full aerobic recovery before the next effort.';
    recoveryNote = 'Quality over quantity — if pace slips >10 sec/km on a rep, cut it and rest more.';

  } else if (/yasso/.test(haystack)) {
    restTime = 'Equal to rep time'; restType = 'Easy Jog Rest';
    restDesc = 'Jog for the same duration as your 800m rep. Classic Yasso structure.';
    recoveryNote = 'E.g. if your 800m takes 4:00, jog for 4:00 before the next rep.';

  } else if (/hill rep|hill sprint/.test(haystack)) {
    restTime = 'Full walk-back'; restType = 'Walk Down Recovery';
    restDesc = 'Walk back down the hill completely. These are power reps — full recovery between each one.';
    recoveryNote = 'Don\'t jog back. The walk IS the rest. Rushing kills the next rep.';

  } else if (/fartlek/.test(haystack)) {
    restTime = 'Equal to work time'; restType = 'Easy Jog Recovery';
    restDesc = 'Match recovery to effort: 1 min hard = 1 min easy. Keep moving — no standing rest.';
    recoveryNote = 'Fartlek is about flow — never stop, just shift gears.';

  } else if (/cruise|tempo interval/.test(haystack)) {
    // Cruise intervals / tempo reps
    restTime = '60–90 sec'; restType = 'Easy Jog Rest';
    restDesc = 'Short jog recovery — these reps are at threshold, not race pace. The rest keeps lactate in check.';
    recoveryNote = 'You should feel controlled between reps, not destroyed.';

  } else if (/(\d+)\s*[x×]\s*(\d+)\s*min/.test(String(meta.description || sessionTitle || ''))) {
    // Timed reps e.g. 6×3min, 8×2min
    var minMatch = String(meta.description || sessionTitle || '').match(/(\d+)\s*[x×]\s*(\d+)\s*min/i);
    var repMins = minMatch ? parseInt(minMatch[2]) : 2;
    if (repMins <= 1) {
      restTime = '60 sec'; restType = 'Easy Jog Rest';
      restDesc = 'Short jog recovery between each 1min rep. Keep moving — these are aerobic surges.';
      recoveryNote = 'Match the intensity: hard 1min, easy 1min. Don\'t stop.';
    } else if (repMins <= 2) {
      restTime = '90 sec'; restType = 'Easy Jog Rest';
      restDesc = 'Easy jog recovery between each rep. Heart rate should come down before restarting.';
      recoveryNote = 'Aim for even pace across all reps. Slow down if needed — don\'t cut rest.';
    } else {
      restTime = '2 min'; restType = 'Easy Jog Rest';
      restDesc = 'Easy jog between longer reps. Give yourself time to reset — these are sustained efforts.';
      recoveryNote = 'Consistent splits are the goal. Add 30 sec rest if pace is falling off.';
    }

  } else {
    // Generic fallback
    restTime = '90 sec – 2 min'; restType = 'Easy Jog Rest';
    restDesc = 'Easy jog between reps. You should feel mostly recovered — controlled breathing — before each effort.';
    recoveryNote = 'Adjust rest up if needed. Consistent reps beat fast early, slow late.';
  }

  // ── NOTION OVERRIDE: "Rep Rest" field wins if coaches have set it ────────────
  // Add a "Rep Rest" property to the session in Notion to override the above.
  // E.g. "90 sec", "2 min jog", "3 min". Only this field is used — not Recovery Type.
  var notionRepRest = String(meta.repRest || '').trim();
  if (notionRepRest) {
    restTime = notionRepRest;
    restType = 'Coach-specified Rest';
    restDesc = 'Rest period as prescribed by your coaches. Stick to this — it\'s calibrated to your fitness and session load.';
    recoveryNote = 'Don\'t cut it short. Consistent reps across all efforts is the goal.';
  }

  return { restTime: restTime, restType: restType, restDesc: restDesc, recoveryNote: recoveryNote };
}

function buildRunSubtitle(s,meta,resolvedTitle){
  meta=meta||{};
  var parts=[];
  if(meta.distance) parts.push(meta.distance);
  else if(meta.target&&/\d/.test(meta.target)) parts.push(meta.target);
  if(meta.intensity) parts.push(meta.intensity);
  else if(s&&s.intensity) parts.push(s.intensity);
  if(meta.duration){
    var dur=String(meta.duration);
    if(/^\d+$/.test(dur)) dur=dur+'min';
    parts.push(dur);
  }
  // Dedupe while preserving order
  var seen={},out=[];
  parts.forEach(function(p){var k=String(p).toLowerCase();if(p&&!seen[k]){seen[k]=1;out.push(p);}});
  return out.join(' · ');
}

function getHomeInsights(){
  var planned=sessions.filter(function(s){return getType(s)!=='rest';}).length;
  var completed=sessions.filter(function(s){return getType(s)!=='rest'&&isSessionLogged(s.id);}).length;
  var compliance=planned?Math.min(100,Math.round(completed/planned*100)):0;
  var readiness=null,body=null;
  try{body=JSON.parse(localStorage.getItem('dp_daily_body_'+athlete.code+'_'+localISO(new Date()))||'null');}catch(e){}
  var sleep=null,energy=null,soreness=null,stress=null;
  if(body){
    sleep=parseFloat(body.sleep);energy=parseFloat(body.energy);soreness=parseFloat(body.soreness);stress=parseFloat(body.stress);
    var vals=[];
    if(!isNaN(sleep))vals.push(sleep*10);if(!isNaN(energy))vals.push(energy*10);
    if(!isNaN(soreness))vals.push((11-soreness)*10);if(!isNaN(stress))vals.push((11-stress)*10);
    if(vals.length)readiness=Math.round(vals.reduce(function(a,b){return a+b;},0)/vals.length);
  }
  var exerciseNames={};
  Object.keys(logs||{}).forEach(function(id){var entry=logs[id];if(!entry||typeof entry!=='object'||Array.isArray(entry))return;Object.keys(entry).forEach(function(name){if(name.indexOf('__')!==0&&Array.isArray(entry[name]))exerciseNames[pbNormName(name)]=1;});});
  var weights=[];
  try{for(var i=0;i<localStorage.length;i++){var key=localStorage.key(i);if(key&&key.indexOf('dp_daily_body_'+athlete.code+'_')===0){var v=JSON.parse(localStorage.getItem(key)||'null');var w=v&&parseFloat(v.weight);if(!isNaN(w))weights.push({date:key.slice(-10),weight:w});}}}catch(e){}
  weights.sort(function(a,b){return a.date.localeCompare(b.date);});
  var now=localISO(new Date());
  var next=sortSessionsForDisplay(allSessions.filter(function(s){return s.date&&s.date>now&&getType(s)!=='rest';})).sort(function(a,b){return a.date.localeCompare(b.date);})[0]||null;
  var checkinDone=false;try{checkinDone=!!localStorage.getItem(checkinWeekKey());}catch(e){}
  var warning='';
  if(body){
    var pain=parseFloat(body.pain);
    if(!isNaN(pain)&&pain>=5)warning='Pain is '+pain+'/10'+(body.painLocation?' at '+body.painLocation:'')+'. Avoid pushing through it—your coaches have been flagged.';
    else if(!isNaN(soreness)&&soreness>=8)warning='High soreness today—consider reducing load and message your coaches if pain is localised.';
    else if(!isNaN(energy)&&energy<=3)warning='Energy is low today. Keep the session controlled and prioritise recovery.';
    else if(!isNaN(stress)&&stress>=8)warning='Stress is elevated. Use RPE rather than chasing numbers today.';
  }
  var kmTarget=currentWeekKmData&&Number(currentWeekKmData.target),kmDone=currentWeekKmData&&Number(currentWeekKmData.completed||0);
  return {planned:planned,completed:completed,compliance:compliance,readiness:readiness,pbs:Object.keys(exerciseNames).length,weights:weights.slice(-7),body:body,warning:warning,next:next,checkinDone:checkinDone,kmTarget:kmTarget||0,kmDone:kmDone||0};
}
function miniSparkline(points){
  if(!points||points.length<2)return '<span class="insight-empty">Log 2+ weigh-ins</span>';
  var vals=points.map(function(p){return p.weight;}),min=Math.min.apply(null,vals),max=Math.max.apply(null,vals),range=max-min||1;
  var coords=vals.map(function(v,i){return (i*(78/(vals.length-1))).toFixed(1)+','+(24-((v-min)/range)*18).toFixed(1);}).join(' ');
  var delta=vals[vals.length-1]-vals[0];
  return '<svg class="mini-spark" viewBox="0 0 80 28" role="img" aria-label="Recent bodyweight trend"><polyline points="'+coords+'"/></svg><span class="insight-delta">'+(delta>0?'+':'')+delta.toFixed(1)+'kg</span>';
}
function renderInsightRail(data){
  var readiness=data.readiness==null?'—':data.readiness;
  var readinessPct=data.readiness==null?0:data.readiness;
  return '<div class="insight-rail" aria-label="This week at a glance">'+
    '<button type="button" class="insight-card insight-card-button" onclick="openWeeklySummary()" aria-label="View weekly compliance summary"><div class="insight-ring" style="--value:'+data.compliance+'"><strong>'+data.compliance+'%</strong></div><div><span>Compliance</span><small>View weekly summary</small></div></button>'+
    '<button type="button" class="insight-card insight-card-button" onclick="openQuickLog(\'body\')" aria-label="'+(data.readiness==null?'Log today’s readiness':'Review today’s readiness')+'"><div class="insight-ring readiness" style="--value:'+readinessPct+'"><strong>'+readiness+'</strong></div><div><span>Readiness</span><small>'+(data.readiness==null?'Log today':'Review body log')+'</small></div></button>'+
    '<button type="button" class="insight-card insight-card-button bodyweight" onclick="switchTab(\'progress\')" aria-label="View bodyweight progress"><div class="insight-viz">'+miniSparkline(data.weights)+'</div><div><span>Bodyweight</span><small>View progress</small></div></button>'+
    '<button type="button" class="insight-card insight-card-button" onclick="openPbHistory()" aria-label="View personal best history"><div class="insight-pb"><svg class="icon"><use href="#i-trophy"/></svg><strong>'+data.pbs+'</strong></div><div><span>PB tracking</span><small>View exercise history</small></div></button>'+
  '</div>';
}
function renderCommandStatus(data){
  var kmPct=data.kmTarget?Math.min(100,Math.round(data.kmDone/data.kmTarget*100)):0;
  var nextText='No upcoming session';
  if(data.next){var nd=localDateFromISO(data.next.date);nextText=nd.toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'})+' · '+(data.next.name||'Session');}
  var html='<div class="command-status-grid">';
  html+='<button class="command-status" onclick="switchTab(\'checkin\')"><span class="command-status-icon '+(data.checkinDone?'done':'')+'"><svg class="icon"><use href="#i-clipboard"/></svg></span><span><small>Weekly check-in</small><strong>'+(data.checkinDone?'Complete':'Still to do')+'</strong></span></button>';
  html+='<button class="command-status" onclick="switchTab(\'nutrition\')" aria-label="View weekly kilometre details"><span class="command-status-icon"><svg class="icon"><use href="#i-run"/></svg></span><span><small>Weekly kilometres</small><strong>'+(data.kmTarget?(data.kmDone.toFixed(1).replace(/\.0$/,'')+' / '+data.kmTarget.toFixed(1).replace(/\.0$/,'')+' km'):'Target loading')+'</strong><i><b style="width:'+kmPct+'%"></b></i></span></button>';
  html+='<button class="command-status next-session" onclick="goTrainingPlan()"><span class="command-status-icon"><svg class="icon"><use href="#i-calendar"/></svg></span><span><small>Up next</small><strong>'+esc(nextText)+'</strong></span></button>';
  html+='</div>';
  if(data.warning)html+='<div class="recovery-warning"><svg class="icon"><use href="#i-pulse"/></svg><div><strong>Recovery flag</strong><span>'+esc(data.warning)+'</span></div><button onclick="openQuickLog(\'body\')">Review</button></div>';
  return html;
}
function sessionWhy(type,meta,title){
  var text=((meta&&((meta.intensity||'')+' '+(meta.type||'')+' '+(meta.description||'')))+' '+(title||'')).toLowerCase();
  if(/recovery|easy/.test(text))return 'Absorb the harder work, build aerobic volume and arrive fresher for the next key session.';
  if(/threshold|tempo/.test(text))return 'Raise the pace you can sustain comfortably so race effort feels more controlled.';
  if(/interval|vo2|hill|speed|fartlek/.test(text))return 'Develop speed, running economy and confidence when the pace starts to bite.';
  if(/long/.test(text))return 'Build endurance, fuelling confidence and the durability you need late in your goal event.';
  return 'Build the specific fitness your current programme phase needs while keeping the week balanced.';
}
function renderCoachMoment(todaySessions){
  var note='Keep today simple: hit the intended effort and leave enough in the tank to train well again.';
  for(var i=0;i<todaySessions.length;i++){var ov=_sessionOverrides[todaySessions[i].id];if(ov&&ov.notes){note=ov.notes;break;}}
  return '<div class="coach-moment"><div class="coach-avatars"><span>K</span><span>A</span></div><div><div class="coach-moment-label">From your coaches</div><p>'+esc(note)+'</p></div><button onclick="switchTab(\'comms\')" aria-label="Contact your coaches"><svg class="icon"><use href="#i-chat"/></svg></button></div>';
}

function renderTodaySection(){
  var el=document.getElementById('todayEl');if(!el) return;
  var todayISO=localISO(new Date());
  var todaySessions=sortSessionsForDisplay(allSessions.filter(function(s){return s.date===todayISO;}));
  var label=new Date().toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'});
  var insights=getHomeInsights();
  var html='<div class="todaypanel"><div class="todayeyebrow">Today</div><div class="todayhead"><div><div class="todaytitle">Your session'+(todaySessions.length>1?'s':'')+'</div><div class="today-subtitle">One clear focus. Log what you complete.</div></div><div class="todaydate">'+esc(label)+'</div></div>';
  html+=renderCoachMoment(todaySessions);
  html+=renderInsightRail(insights);
  html+=renderCommandStatus(insights);
  if(insights.planned>0&&insights.completed>=insights.planned){html+='<div class="milestone-celebration"><svg class="icon"><use href="#i-trophy"/></svg><div><strong>Week complete</strong><span>You showed up for every planned session. That consistency compounds.</span></div></div>';}
  if(!todaySessions.length){
    html+='<div class="todayempty">No session scheduled today. Recover well and check ahead.</div>';
  }else{
    html+='<div class="todaylist">';
    todaySessions.forEach(function(s){
      var type=getType(s),meta=[],resolved=type==='run'?resolveRunDisplay(s):null;
      if(s.intensity) meta.push(s.intensity);
      if(s.week) meta.push(s.week);
      if(s.status) meta.push(s.status);
      var displayName=s.name||'Session';
      html+='<div class="todayitem"><div class="todaytop"><div class="todaydot '+type+'"></div><div class="todaymain">';
      html+='<div class="todayname '+type+'">'+esc(displayName)+'</div>';
      if(meta.length) html+='<div class="todaymeta">'+esc(meta.join(' · '))+'</div>';
      var sessionIdx=-1;sessions.forEach(function(ws,wi){if(ws.id===s.id) sessionIdx=wi;});
      if(type==='run'){
        var runMeta=(resolved&&resolved.meta)||{};
        var sessionTitle=(resolved&&resolved.title)||s.name||'Run';
        var sessionDetail=(resolved&&resolved.detail)||runMeta.description||'';
        var _todayOv=_sessionOverrides[s.id]||null;
        if(_todayOv&&(_todayOv.warm_up||_todayOv.intervals||_todayOv.working_pace||_todayOv.cool_down)){
          // Override: render structured breakdown
          html+='<div class="todaytarget">';
          if(_todayOv.notes){
            html+='<div class="label">Coach note</div><div class="value">'+esc(_todayOv.notes)+'</div>';
          }
          // Structured rows
          html+='<div style="display:flex;flex-direction:column;gap:0;border:1px solid rgba(255,255,255,.1);border-radius:7px;overflow:hidden;margin-top:10px">';
          var _tRows=[];
          if(_todayOv.distance_km) _tRows.push({label:'Total',val:_todayOv.distance_km+'km',accent:false});
          if(_todayOv.warm_up) _tRows.push({label:'Warm up',val:_todayOv.warm_up,accent:false});
          var _tMain=(_todayOv.intervals||'')+(_todayOv.working_pace?' @ '+_todayOv.working_pace+'/km':'');
          if(_tMain) _tRows.push({label:'Main set',val:_tMain,accent:true});
          if(_todayOv.rest) _tRows.push({label:'Rest',val:_todayOv.rest,accent:false});
          if(_todayOv.cool_down) _tRows.push({label:'Cool down',val:_todayOv.cool_down,accent:false});
          _tRows.forEach(function(row,ri){
            var bb=ri<_tRows.length-1?'border-bottom:1px solid rgba(255,255,255,.08);':'';
            html+='<div style="display:grid;grid-template-columns:72px 1fr;gap:8px;padding:8px 10px;'+bb+'">';
            html+='<span style="font-family:var(--mono);font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:'+(row.accent?'var(--run)':'rgba(255,255,255,.4)')+';font-weight:'+(row.accent?'700':'400')+'">'+row.label+'</span>';
            html+='<span style="font-size:13px;font-weight:'+(row.accent?'700':'500')+';color:#fff;line-height:1.3">'+esc(row.val)+'</span>';
            html+='</div>';
          });
          html+='</div>';
          html+='</div>';
        } else {
          var targetValue=runMeta.target||runMeta.sessionGoal||runMeta.type||runMeta.intensity||sessionTitle;
          html+='<div class="todaytarget"><div class="label">Today focus</div><div class="value">'+esc(targetValue)+'</div>';
          if(sessionDetail){ html+='<div class="desc">'+esc(sessionDetail)+'</div>'; }
          html+='<div class="session-why"><svg class="icon"><use href="#i-bulb"/></svg><div><span>Why it matters</span>'+esc(sessionWhy(type,runMeta,sessionTitle))+'</div></div>';
          var chips=[];
          if(runMeta.rpe) chips.push('RPE '+runMeta.rpe);
          if(runMeta.surface) chips.push(runMeta.surface);
          if(runMeta.duration) chips.push(runMeta.duration);
          if(runMeta.distance) chips.push(runMeta.distance);
          if(chips.length){
            html+='<div class="todaychips">';
            chips.forEach(function(c){ html+='<div class="todaychip">'+esc(c)+'</div>'; });
            html+='</div>';
          }
          html+='</div>';
        }
      }else if(type==='strength'){
        html+='<div class="todaytarget"><div class="label">Today focus</div><div class="value">'+esc(displayName)+'</div><div class="desc">Use your previous efforts as a guide, then log what you actually complete today.</div><div class="session-why"><svg class="icon"><use href="#i-bulb"/></svg><div><span>Why it matters</span>Build durable strength that supports running economy, resilience and confident progression.</div></div></div>';
      }else if(type==='note'){
        var _noteInstr=s.runDetails||(_sessionOverrides[s.id]&&_sessionOverrides[s.id].notes)||'Train as you normally would and log what you did.';
        html+='<div class="todaytarget"><div class="label">Discovery week</div><div class="value">'+esc(displayName)+'</div><div class="desc">'+esc(_noteInstr)+'</div></div>';
      }else{
        html+='<div class="todaytarget"><div class="label">Recovery</div><div class="value">Rest day</div><div class="desc">Recovery is part of the programme. Use today to reset and be ready for the next session.</div></div>';
      }
      if(type!=='rest'&&sessionIdx>=0){
        html+='<button class="today-action primary" onclick="startFocusedSession('+sessionIdx+')" style="width:100%;margin-top:12px">Start session <svg class="icon"><use href="#i-arrow-right"/></svg></button>';
      }
      html+='</div></div></div>';
    });
    html+='</div>';
  }
  html+='</div>';
  el.innerHTML=html;
  el.style.display='block';
}

function scrollToSession(idx){
  var card=document.getElementById('sc_'+idx);
  if(!card) return;
  var body=document.getElementById('scb_'+idx);
  if(body&&!body.classList.contains('open')) togS(idx);
  setTimeout(function(){card.scrollIntoView({behavior:'smooth',block:'start'});},60);
}

function getExercisePreviousEffort(sessionId,exerciseName){
  var prevEffort=null;var allSessIds=Object.keys(logs||{});
  for(var li=allSessIds.length-1;li>=0;li--){var lid=allSessIds[li];if(lid===sessionId) continue;var ldata=logs[lid];if(ldata&&ldata[exerciseName]&&ldata[exerciseName].length){var lsets=ldata[exerciseName].filter(function(ls){return ls&&((ls.weight&&String(ls.weight).trim()!=='')||(ls.reps&&String(ls.reps).trim()!==''));});if(lsets.length){prevEffort=lsets;break;}}}
  return prevEffort;
}
function getWorkingSlice(ex,arr){arr=(arr||[]).filter(function(x){return x&&((x.weight&&String(x.weight).trim()!=='')||(x.reps&&String(x.reps).trim()!==''));});var workingSets=parseInt(ex.workingSets||ex.sets||arr.length||0)||0;if(!workingSets||arr.length<=workingSets) return arr;return arr.slice(arr.length-workingSets);}
function formatSetSummary(arr){arr=(arr||[]).filter(function(x){return x&&((x.weight&&String(x.weight).trim()!=='')||(x.reps&&String(x.reps).trim()!=='')||(x.repsLeft&&String(x.repsLeft).trim()!=='')||(x.repsRight&&String(x.repsRight).trim()!==''));});if(!arr.length) return '';return arr.map(function(ps){var reps=ps.reps?(' × '+ps.reps):(ps.repsLeft||ps.repsRight?(' × L '+(ps.repsLeft||'—')+' / R '+(ps.repsRight||'—')):'');return(ps.weight?ps.weight+'kg':'—')+reps;}).join(' | ');}
function setVal(v){return String(v==null?'':v).trim();}
function sameStrengthEffort(a,b){
  a=(a||[]).filter(Boolean);b=(b||[]).filter(Boolean);
  if(!a.length||a.length!==b.length) return false;
  for(var si=0;si<a.length;si++){
    var av=a[si]||{},bv=b[si]||{};
    if(setVal(av.weight)!==setVal(bv.weight)) return false;
    if(setVal(av.reps)!==setVal(bv.reps)) return false;
    if(setVal(av.repsLeft)!==setVal(bv.repsLeft)) return false;
    if(setVal(av.repsRight)!==setVal(bv.repsRight)) return false;
    if(setVal(av.rpe)!==setVal(bv.rpe)) return false;
  }
  return true;
}
function displaySavedStrengthSets(sessionId,savedSets,prevSets){
  if(isSessionLogged(sessionId)) return savedSets||[];
  if(sameStrengthEffort(savedSets,prevSets)) return [];
  return savedSets||[];
}
function getTopRep(ex){var range=String(ex.repRange||ex.reps||'').split('-');var top=parseInt(range[range.length-1],10);return isNaN(top)?parseInt(ex.reps,10)||0:top;}
function getNumeric(v){var n=parseFloat(v);return isNaN(n)?null:n;}
function getProgressionFeedback(ex,prevEffort,currentEffort){
  var prevWorking=getWorkingSlice(ex,prevEffort||[]);var currentWorking=getWorkingSlice(ex,currentEffort||[]);
  if(!currentWorking.length) return{tone:'dim',text:(ex.repRange?'Target '+ex.repRange:'Build this session')};
  var topRep=getTopRep(ex);
  var currentWeights=currentWorking.map(function(s){return getNumeric(s.weight);}).filter(function(v){return v!=null;});
  var prevWeights=prevWorking.map(function(s){return getNumeric(s.weight);}).filter(function(v){return v!=null;});
  var currentLoad=currentWeights.length?Math.max.apply(null,currentWeights):null;
  var prevLoad=prevWeights.length?Math.max.apply(null,prevWeights):null;
  var currentTotal=currentWorking.reduce(function(a,s){return a+(parseInt(s.reps,10)||0);},0);
  var prevTotal=prevWorking.reduce(function(a,s){return a+(parseInt(s.reps,10)||0);},0);
  var allAtTop=currentWorking.length&&currentWorking.every(function(s){return(parseInt(s.reps,10)||0)>=topRep;});
  if(allAtTop) return{tone:'ok',text:'Increase load next time'};
  if(prevLoad!=null&&currentLoad!=null&&currentLoad>prevLoad&&currentTotal>0) return{tone:'ok',text:'Load PB'};
  if(prevWorking.length){
    if(currentLoad===prevLoad&&currentTotal>prevTotal) return{tone:'ok',text:'Rep PB +'+(currentTotal-prevTotal)};
    if(currentLoad===prevLoad&&currentTotal===prevTotal) return{tone:'dim',text:'Matched last effort'};
    if(currentLoad!=null&&prevLoad!=null&&currentLoad<prevLoad) return{tone:'dim',text:'Build reps before load'};
    if(currentTotal>prevTotal) return{tone:'ok',text:'Progressed this session'};
  }
  return{tone:'dim',text:'Progress reps to '+topRep};
}
function getFeedbackStyle(tone){if(tone==='ok') return 'color:var(--ok);background:var(--ok-bg);border:1px solid var(--ok-border);';if(tone==='warn') return 'color:var(--run);background:rgba(180,83,9,.06);border:1px solid rgba(180,83,9,.18);';return 'color:var(--dim);background:var(--surface);border:1px solid var(--border);';}
function collectExerciseSets(i,ei){var c=document.getElementById('sets_'+i+'_'+ei),arr=[];if(!c) return arr;c.querySelectorAll('.setrow,.setrow-single').forEach(function(row){var wEl=row.querySelector('input[id^="w_"]');var rLEl=row.querySelector('input[id^="rL_"]');var rREl=row.querySelector('input[id^="rR_"]');var doneEl=row.querySelector('button[id^="st_"]');var w=wEl?wEl.value||'':'';var done=doneEl?doneEl.classList.contains('on'):false;if(rLEl&&rREl){var rL=rLEl.value||'';var rR=rREl.value||'';if(w||rL||rR||done) arr.push({weight:w,repsLeft:rL,repsRight:rR,done:done});}else{var rEl=row.querySelector('input[id^="r_"]');var rpeEl=row.querySelector('input[id^="rpe_"]');var r=rEl?rEl.value||'':'';var rpe=rpeEl?rpeEl.value||'':'';if(w||r||rpe||done) arr.push({weight:w,reps:r,rpe:rpe,done:done});}});return arr;}
function refreshStrengthFeedback(i,splitKey){
  var exercises=getSplit(splitKey);var s=sessions[i];
  exercises.forEach(function(ex,ei){
    var resolvedEx=exPicks[ex.exercise]||ex.exercise;
    var currentEffort=collectExerciseSets(i,ei);
    var prevEffort=getExercisePreviousEffort(s.id,resolvedEx);
    if(!currentEffort.length&&logs[s.id]&&logs[s.id][resolvedEx]) currentEffort=displaySavedStrengthSets(s.id,logs[s.id][resolvedEx],prevEffort);
    var lastEl=document.getElementById('prev_'+i+'_'+ei);var nowEl=document.getElementById('curr_'+i+'_'+ei);var progEl=document.getElementById('prog_'+i+'_'+ei);
    if(lastEl){lastEl.className='prev-effort'+(prevEffort?' has-last':'');lastEl.innerHTML=prevEffort?('LAST: '+esc(formatSetSummary(getWorkingSlice(ex,prevEffort)))):('TARGET: '+esc(ex.repRange||ex.reps));}
    if(nowEl){var currSummary=formatSetSummary(getWorkingSlice(ex,currentEffort));nowEl.style.display=currSummary?'inline-block':'none';nowEl.innerHTML=currSummary?('TODAY: '+esc(currSummary)):'';}
    if(progEl){var feedback=getProgressionFeedback(ex,prevEffort,currentEffort);progEl.setAttribute('style','font-family:var(--mono);font-size:9px;border-radius:4px;padding:3px 8px;margin-top:4px;display:inline-block;'+getFeedbackStyle(feedback.tone));progEl.textContent=feedback.text;}
  });
}

function buildBody(s,i,type){
  var h='';
  if(type==='run'){
    var resolved=resolveRunDisplay(s),related=resolved.related||null,meta=resolved.meta||{};
    var sessionTitle=resolved.title||s.name||'Run';
    var sessionDetail=resolved.detail||meta.description||'';
    var warmUp=meta.warmUp||'2km easy jog or 10 min easy jog (RPE 4).';
    var coolDown=meta.coolDown||'10min easy jog (RPE 3–4).';
    var workoutText=sessionDetail||sessionTitle;
    var extras=[];
    if(meta.target) extras.push(meta.target);
    if(meta.recoveryType) extras.push('Recovery: '+meta.recoveryType);
    if(meta.sessionGoal) extras.push('Goal: '+meta.sessionGoal);
    var chips=[];
    if(meta.intensity) chips.push(meta.intensity);
    if(meta.surface) chips.push(meta.surface);
    if(meta.difficulty) chips.push(meta.difficulty);
    var sl=logs[s.id]||{};
    var hasSaved=!!(sl.distance||sl.duration||sl.pace||sl.rpe||sl.feel||sl.notes);
    var rpeInfo=inferRpeMeta(meta,sessionTitle);
    var altInfo=parseAlternative(meta,sessionTitle);

    // ── Training zone badge ───────────────────────────────────────────────────
    var zoneMap={
      recovery:{label:'Recovery',color:'#059669',bg:'#d1fae5'},
      easy:{label:'Easy Run',color:'#16a34a',bg:'#dcfce7'},
      long:{label:'Long Run',color:'#0891b2',bg:'#cffafe'},
      steady:{label:'Steady State',color:'#0284c7',bg:'#e0f2fe'},
      tempo:{label:'Tempo',color:'#d97706',bg:'#fef3c7'},
      threshold:{label:'Lactate Threshold',color:'#ea580c',bg:'#ffedd5'},
      interval:{label:'VO2 Max / Intervals',color:'#dc2626',bg:'#fee2e2'},
      track:{label:'VO2 Max / Intervals',color:'#dc2626',bg:'#fee2e2'},
      speed:{label:'Speed Work',color:'#9333ea',bg:'#f3e8ff'},
      sprint:{label:'Sprint',color:'#7c3aed',bg:'#ede9fe'},
      race:{label:'Race Pace',color:'#dc2626',bg:'#fee2e2'},
      hill:{label:'Hill Training',color:'#b45309',bg:'#fef3c7'},
      fartlek:{label:'Fartlek',color:'#d97706',bg:'#fef3c7'}
    };
    var zHaystack=(sessionTitle+' '+(meta&&meta.intensity||'')+' '+(meta&&meta.type||'')+' '+(meta&&meta.tags||'')).toLowerCase();
    var zOrder=['recovery','interval','track','speed','sprint','threshold','tempo','fartlek','hill','race','long','steady','easy'];
    var zKey=null;
    for(var zi=0;zi<zOrder.length;zi++){if(zHaystack.indexOf(zOrder[zi])>=0){zKey=zOrder[zi];break;}}
    var zone=zKey?zoneMap[zKey]:{label:'Aerobic',color:'#0284c7',bg:'#e0f2fe'};

    h+='<div class="run-details">';

    // ── Unified session card ──────────────────────────────────────────────────
    h+='<div style="background:linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.015)), var(--surface);border:1px solid var(--border-mid);border-radius:10px;overflow:hidden;box-shadow:inset 0 1px 0 rgba(255,255,255,.03)">';

    // Header — session title + RPE + zone
    h+='<div style="padding:14px 16px;border-bottom:1px solid var(--border);background:rgba(255,255,255,.015)">';
    h+='<div style="font-family:var(--display);font-size:22px;font-weight:800;text-transform:uppercase;letter-spacing:.02em;color:var(--text);line-height:1.1;margin-bottom:8px">'+esc(sessionTitle)+'</div>';
    h+='<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">';
    h+='<div style="font-family:var(--mono);font-size:11px;font-weight:700;color:#fff;background:var(--run);padding:3px 9px;border-radius:5px;letter-spacing:.04em;white-space:nowrap">'+esc(rpeInfo.value)+'</div>';
    h+='<div style="font-family:var(--mono);font-size:11px;font-weight:700;color:'+zone.color+';background:'+zone.bg+';padding:3px 9px;border-radius:5px;letter-spacing:.04em;white-space:nowrap">'+esc(zone.label)+'</div>';
    h+='<div style="font-size:12px;color:var(--muted);line-height:1.4">'+esc(rpeInfo.desc)+'</div>';
    h+='</div></div>';

    // Body
    h+='<div style="padding:14px 16px;display:flex;flex-direction:column;gap:12px;background:rgba(255,255,255,.01)">';

    // ── Workout — main focus ─────────────────────────────────────────────────
    var _ov=_sessionOverrides[s.id]||null;
    var _ovHasStructure=_ov&&(_ov.warm_up||_ov.intervals||_ov.working_pace||_ov.cool_down||_ov.notes||_ov.rest);
    if(_ovHasStructure){
      // Structured override block — clearly labelled rows
      var _ovRows=[];
      if(_ov.distance_km) _ovRows.push({label:'Total',val:_ov.distance_km+'km',accent:false});
      if(_ov.warm_up) _ovRows.push({label:'Warm up',val:_ov.warm_up,accent:false});
      var _mainSet=(_ov.intervals||'')+(_ov.working_pace?' @ '+_ov.working_pace+'/km':'');
      if(_mainSet) _ovRows.push({label:'Main set',val:_mainSet,accent:true});
      if(_ov.rest) _ovRows.push({label:'Rest',val:_ov.rest,accent:false});
      if(_ov.cool_down) _ovRows.push({label:'Cool down',val:_ov.cool_down,accent:false});
      h+='<div style="border:1px solid var(--border-mid);border-radius:8px;overflow:hidden;background:rgba(255,255,255,.02)">';
      _ovRows.forEach(function(row,ri){
        var borderB=ri<_ovRows.length-1?'border-bottom:1px solid var(--border);':'';
        h+='<div style="display:grid;grid-template-columns:80px 1fr;align-items:baseline;gap:8px;padding:9px 12px;'+borderB+'">';
        h+='<span style="font-family:var(--mono);font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:'+(row.accent?'var(--run)':'var(--muted)')+';font-weight:'+(row.accent?'700':'400')+';padding-top:1px">'+row.label+'</span>';
        h+='<span style="font-size:14px;font-weight:'+(row.accent?'700':'500')+';color:var(--text);line-height:1.4">'+esc(row.val)+'</span>';
        h+='</div>';
      });
      h+='</div>';
      if(_ov.notes){
        h+='<div style="background:rgba(146,210,237,.07);border:1px solid rgba(146,210,237,.18);border-radius:7px;padding:10px 13px">';
        h+='<div style="font-family:var(--mono);font-size:9px;color:var(--run);text-transform:uppercase;letter-spacing:.07em;font-weight:700;margin-bottom:5px">Coach Note</div>';
        h+='<div style="font-size:13px;color:var(--text);line-height:1.55">'+esc(_ov.notes)+'</div>';
        h+='</div>';
      }
    } else {
      h+='<div style="font-size:15px;font-weight:600;color:var(--text);line-height:1.55">'+esc(workoutText)+'</div>';
    }

    // Rest pill + optional chips — subtle, secondary
    var intervalRest=getIntervalRestInfo(meta,sessionTitle);
    var hasSecondary=intervalRest||chips.length;
    if(hasSecondary&&!_ovHasStructure){
      h+='<div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:-4px">';
      if(intervalRest){
        h+='<div style="display:inline-flex;align-items:center;gap:5px;background:var(--surface2);border-radius:6px;padding:4px 10px">';
        h+='<span style="font-family:var(--mono);font-size:11px;font-weight:700;color:var(--run);letter-spacing:.04em">'+esc(intervalRest.restTime)+'</span>';
        h+='<span style="font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:.05em;text-transform:uppercase">'+esc(intervalRest.restType)+'</span>';
        h+='</div>';
      }
      chips.forEach(function(x){ h+='<div class="chip">'+esc(x)+'</div>'; });
      h+='</div>';
    }

    // Coaching note — own row, breathing room
    if(intervalRest&&intervalRest.recoveryNote&&!_ovHasStructure){
      h+='<div style="border-left:3px solid var(--run);padding:8px 12px;background:var(--surface2);border-radius:0 6px 6px 0">';
      h+='<div style="font-family:var(--mono);font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:5px">Coach Note</div>';
      h+='<div style="font-size:12px;color:var(--text);line-height:1.6">'+esc(intervalRest.recoveryNote)+'</div>';
      h+='</div>';
    }

    // Warm up + Cool down — skip for easy/recovery/long runs (and overridden sessions which render their own)
    var isLowIntensity=/\beasy\b|\brecovery\b|\blong run\b|\blong\b/.test(zHaystack);
    if(!isLowIntensity&&!_ovHasStructure){
      h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
      h+='<div><div style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:4px">Warm up</div>';
      h+='<div style="font-size:12px;color:var(--text);line-height:1.45">'+esc(warmUp)+'</div></div>';
      h+='<div><div style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:4px">Cool down</div>';
      h+='<div style="font-size:12px;color:var(--text);line-height:1.45">'+esc(coolDown)+'</div></div>';
      h+='</div>';
    }

    // Alternative
    h+='<div style="border-top:1px solid var(--border);padding-top:10px;margin-top:-2px">';
    h+='<div style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:4px">Alternative</div>';
    h+='<div style="font-size:13px;font-weight:700;color:var(--run);margin-bottom:3px">'+esc(altInfo.title)+'</div>';
    h+='<div style="font-size:12px;color:var(--muted);line-height:1.45">'+esc(altInfo.description)+'</div>';
    h+='</div>';

    h+='</div></div>'; // end body + card
    h+='<div class="run-log">';
    h+='<div id="saved_run_'+i+'" class="saved-data" style="display:'+(hasSaved?'block':'none')+';">';
    h+='<div class="saved-label">✓ Session Logged</div>';
    h+='<div class="saved-grid">';
    h+='<div class="saved-item"><div class="saved-item-label">Distance</div><div class="saved-item-value" id="saved_run_'+i+'_distance">'+esc(sl.distance?sl.distance+'km':'-')+'</div></div>';
    h+='<div class="saved-item"><div class="saved-item-label">Duration</div><div class="saved-item-value" id="saved_run_'+i+'_duration">'+esc(sl.duration?sl.duration+'min':'-')+'</div></div>';
    h+='<div class="saved-item"><div class="saved-item-label">Avg Pace</div><div class="saved-item-value" id="saved_run_'+i+'_pace">'+esc(sl.pace||'-')+'</div></div>';
    h+='<div class="saved-item"><div class="saved-item-label">RPE</div><div class="saved-item-value" id="saved_run_'+i+'_rpe">'+esc(sl.rpe?sl.rpe+'/10':'-')+'</div></div>';
    h+='</div>';
    h+='<div class="saved-feeling" id="saved_run_'+i+'_feel" style="display:'+(sl.feel?'block':'none')+';">'+esc(sl.feel||'')+'</div>';
    h+='<div class="saved-notes" id="saved_run_'+i+'_notes" style="display:'+(sl.notes?'block':'none')+';">'+esc(sl.notes||'')+'</div>';
    h+='<button class="savebtn" style="margin-top:10px" onclick="editRun('+i+')">Edit Session</button>';
    h+='</div>';
    h+='<div id="run_form_'+i+'" style="display:'+(hasSaved?'none':'block')+';">';
    h+='<div style="background:rgba(255,170,0,.07);border:1px solid rgba(255,170,0,.35);border-radius:8px;padding:10px 12px;margin-bottom:12px"><label style="color:#ffaa00;font-weight:600;font-size:12px;display:flex;align-items:center;gap:6px;margin-bottom:6px"><span><svg class="icon icon-sm icon-dim"><use href="#i-calendar"/></svg></span> Session Date <span style="font-size:10px;font-weight:400;color:rgba(255,170,0,.6);font-family:var(--mono)">— change if you did this on a different day</span></label><input type="date" class="li" id="run_date_'+i+'" value="'+esc(s.date||'')+'" style="border-color:rgba(255,170,0,.4);width:100%;box-sizing:border-box" /></div>';
    h+='<div class="run-log-title">Log your session</div><div class="run-inputs">';
    h+='<div class="run-field"><label>Distance (km)</label><input type="number" step="0.1" id="rd_'+i+'" placeholder="0.0" value="'+esc(sl.distance||'')+'" oninput="draftRun('+i+')" /></div>';
    h+='<div class="run-field"><label>Duration (min)</label><input type="number" step="1" id="rdur_'+i+'" placeholder="30" value="'+esc(sl.duration||'')+'" oninput="draftRun('+i+')" /></div>';
    h+='<div class="run-field"><label>Avg Pace (min/km)</label><input type="text" id="rp_'+i+'" placeholder="6:00" value="'+esc(sl.pace||'')+'" oninput="draftRun('+i+')" /></div>';
    h+='<div class="run-field"><label>RPE /10</label><input type="number" min="1" max="10" id="rr_'+i+'" placeholder="..." value="'+esc(sl.rpe||'')+'" oninput="draftRun('+i+')" /></div>';
    h+='</div>';
    h+='<div class="run-field run-input-full" style="margin-bottom:8px"><label>How did it feel?</label><select id="rf_'+i+'" class="li" onchange="draftRun('+i+')"><option value="">Select feeling...</option>';
    ['💀 Awful','😮‍💨 Struggling','😐 Average','💪 Feeling Strong','🔥 Crushing It'].forEach(function(f){h+='<option'+(sl.feel===f?' selected':'')+'>'+esc(f)+'</option>';});
    h+='</select></div>';
    h+='<div class="run-field run-input-full" style="margin-bottom:8px"><label>Notes (Optional)</label><textarea id="rn_'+i+'" class="li" placeholder="Any additional thoughts..." oninput="draftRun('+i+')">'+esc(sl.notes||'')+'</textarea></div>';
    h+='<button class="savebtn" id="sb_'+i+'" onclick="saveRun('+i+')">Save Session</button>';
    if(isSessionLogged(s.id)){setTimeout(function(idx){showRunSaved(idx);}(i),0);}
    h+='</div>';
    h+='</div>';
    h+='</div>';
  }else if(type==='strength'){

    var splitKey=GYM_KEYS.find(function(k){return(s.name||'').indexOf(k)>=0;})||'Upper A';
    var exercises=getSplit(splitKey),sl2=logs[s.id]||{};
    h+='<div style="background:rgba(255,170,0,.07);border:1px solid rgba(255,170,0,.35);border-radius:8px;padding:10px 12px;margin-bottom:12px"><label style="color:#ffaa00;font-weight:600;font-size:12px;display:flex;align-items:center;gap:6px;margin-bottom:6px"><span><svg class="icon icon-sm icon-dim"><use href="#i-calendar"/></svg></span> Session Date <span style="font-size:10px;font-weight:400;color:rgba(255,170,0,.6);font-family:var(--mono)">— change if you did this on a different day</span></label><input type="date" class="li" id="gym_date_'+i+'" value="'+esc(s.date||'')+'" style="border-color:rgba(255,170,0,.4);width:100%;box-sizing:border-box" /></div>';
    if(exercises.length){
      h+='<div class="ltitle">Log your sets</div><div class="exlist">';
      exercises.forEach(function(ex,ei){
        var resolvedEx=exPicks[ex.exercise]||ex.exercise;
        var safeKey=ex.exercise.replace(/[^a-z0-9]/gi,'_');
        var savedEx=sl2[resolvedEx]||sl2[ex.exercise]||[],sets=parseInt(ex.sets)||2;
        var prevEffort=getExercisePreviousEffort(s.id,resolvedEx);
        savedEx=displaySavedStrengthSets(s.id,savedEx,prevEffort);
        var stored=pbComputeStored(resolvedEx,s.id);
        var isSingleLeg=resolvedEx.toLowerCase().indexOf('single leg')>=0;
        var initVol=0;(savedEx||[]).forEach(function(sv){var w=parseFloat(sv.weight),r=parseInt(sv.reps,10);if(!isNaN(w)&&w>0&&!isNaN(r)&&r>0&&r<=PB_REP_CAP) initVol+=w*r;});
        var isVolPB=!!(stored.volume&&initVol>stored.volume.value);
        var isBarbell=/\bsquat\b|deadlift|\brdl\b|romanian|bench press|barbell|overhead press|\bohp\b|hip thrust/i.test(resolvedEx)&&!/machine|cable|smith|dumbbell|\bdb\b|goblet|kettlebell|band|bodyweight|leg press/i.test(resolvedEx);
        h+='<div class="exc"><div class="exh">';
        h+='<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">';
        h+='<div style="min-width:0;flex:1"><div class="exn" id="exn_'+safeKey+'">'+esc(resolvedEx)+'</div>';
        h+='<div class="exm">'+esc(ex.sets)+' sets'+(ex.rest?' · '+formatRest(ex.rest)+' rest':'')+'</div>';
        if(ex.notes) h+='<div class="exnotes">'+esc(ex.notes)+'</div>';
        h+='</div>';
        h+='<div id="exstat_'+i+'_'+ei+'" style="text-align:right;flex-shrink:0">';
          if(stored.load) h+='<div class="ex-stat ex-stat-pb"><svg class="icon"><use href="#i-trophy"/></svg> PB '+esc(pbRound1(pbNum(stored.load.weight)))+'kg</div>';
          if(!isSingleLeg&&stored.volume) h+='<div class="ex-stat ex-stat-vol-pb"><svg class="icon"><use href="#i-trophy"/></svg> Vol PB '+esc(Math.round(stored.volume.value).toLocaleString())+'kg</div>';
          if(stored.e1rm) h+='<div class="ex-stat ex-stat-e1rm">e1RM '+esc(pbRound1(stored.e1rm.value))+'kg</div>';
          if(!isSingleLeg) h+='<div id="vol_'+i+'_'+ei+'" class="ex-stat ex-stat-vol'+(isVolPB?' pb':'')+'">'+(isVolPB?'<svg class="icon"><use href="#i-trophy"/></svg> ':'')+'Vol '+Math.round(initVol).toLocaleString()+'kg</div>';
          h+='</div>';
        h+='</div>';
        h+='<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;align-items:center">';
        if(prevEffort){var prevStr=formatSetSummary(prevEffort);h+='<div id="prev_'+i+'_'+ei+'" class="prev-effort has-last">LAST: '+esc(prevStr)+'</div>';}
        else{h+='<div id="prev_'+i+'_'+ei+'" class="prev-effort">TARGET: '+esc(ex.repRange||ex.reps)+'</div>';}
        if(prevEffort){var prevLoads=prevEffort.map(function(p){return parseFloat(p.weight);}).filter(function(n){return !isNaN(n)&&n>0;});if(prevLoads.length){var suggested=Math.round((Math.max.apply(null,prevLoads)*1.025)*2)/2;h+='<div class="suggested-load">SUGGESTED: '+suggested+'kg</div>';}}
        h+='<div id="curr_'+i+'_'+ei+'" class="today-effort"></div>';
        h+='<div id="prog_'+i+'_'+ei+'" style="font-family:var(--mono);font-size:9px;color:var(--dim);background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:3px 8px;display:inline-block">'+esc(ex.repRange?'Target '+ex.repRange:'Build this session')+'</div>';
        h+='</div></div>';
        if(ex.alts&&ex.alts.length){
          var allOpts=[ex.exercise].concat(ex.alts);
          h+='<div class="ex-picker">';
          allOpts.forEach(function(opt){
            var safeOpt=opt.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
            var exNameSafe=ex.exercise.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
            h+='<button class="ex-pill'+(opt===resolvedEx?' active':'')+'" onclick="pickEx(\''+exNameSafe+'\',\''+safeOpt+'\')" data-pg="'+safeKey+'" data-pv="'+esc(opt)+'">'+esc(opt)+'</button>';
          });
          h+='</div>';
        }
        var isSingleLeg=resolvedEx.toLowerCase().indexOf('single leg')>=0;
        if(isSingleLeg){
          h+='<div class="slbls-single"><div class="slbl"></div><div class="slbl">kg</div><div class="slbl">Left</div><div class="slbl">Right</div><div class="slbl">✓</div></div>';
          h+='<div class="exsets" id="sets_'+i+'_'+ei+'">';
          for(var si=0;si<sets;si++){var sv=savedEx[si]||{};var prevSet=prevEffort&&prevEffort[si]?prevEffort[si]:null;
            h+='<div class="setrow-single" id="sr_'+i+'_'+ei+'_'+si+'"><div class="snum">'+(si+1)+'</div>';
            h+='<input type="number" class="sin" id="w_'+i+'_'+ei+'_'+si+'" placeholder="'+esc(prevSet&&prevSet.weight?prevSet.weight:'—')+'" min="0" step="0.5" value="'+esc(sv.weight||'')+'" oninput="draftGym('+i+',\''+esc(splitKey)+'\')" />';
            h+='<input type="number" class="sin" id="rL_'+i+'_'+ei+'_'+si+'" placeholder="'+esc(prevSet&&prevSet.repsLeft?prevSet.repsLeft:'L')+'" min="0" value="'+esc(sv.repsLeft||'')+'" oninput="draftGym('+i+',\''+esc(splitKey)+'\')" />';
            h+='<input type="number" class="sin" id="rR_'+i+'_'+ei+'_'+si+'" placeholder="'+esc(prevSet&&prevSet.repsRight?prevSet.repsRight:'R')+'" min="0" value="'+esc(sv.repsRight||'')+'" oninput="draftGym('+i+',\''+esc(splitKey)+'\')" />';
            h+='<button class="st'+(sv.done?' on':'')+' " id="st_'+i+'_'+ei+'_'+si+'" onclick="togSet('+i+','+ei+','+si+')">';
            h+='<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></button></div>';
          }
        }else{
          h+='<div class="slbls"><div class="slbl"></div><div class="slbl">kg</div><div class="slbl">reps</div><div class="slbl">RPE</div><div class="slbl">✓</div></div>';
          h+='<div class="exsets" id="sets_'+i+'_'+ei+'">';
          for(var si=0;si<sets;si++){var sv=savedEx[si]||{};var prevSet=prevEffort&&prevEffort[si]?prevEffort[si]:null;
            h+='<div class="setrow" id="sr_'+i+'_'+ei+'_'+si+'"><div class="snum">'+(si+1)+'</div>';
            h+='<input type="number" class="sin" id="w_'+i+'_'+ei+'_'+si+'" placeholder="'+(prevSet&&prevSet.weight?prevSet.weight:'—')+'" min="0" step="0.5" value="'+esc(sv.weight||'')+'" oninput="draftGym('+i+',\''+esc(splitKey)+'\')" />';
            h+='<input type="number" class="sin" id="r_'+i+'_'+ei+'_'+si+'" placeholder="'+esc((prevSet&&prevSet.reps)?prevSet.reps:'—')+'" min="0" value="'+esc(sv.reps||'')+'" oninput="draftGym('+i+',\''+esc(splitKey)+'\')" />';
            h+='<input type="number" class="rpe-in'+(sv.rpe?' filled':'')+'" id="rpe_'+i+'_'+ei+'_'+si+'" placeholder="—" min="1" max="10" step="0.5" value="'+esc(sv.rpe||'')+'" oninput="draftGym('+i+',\''+esc(splitKey)+'\')" />';
            h+='<button class="st'+(sv.done?' on':'')+' " id="st_'+i+'_'+ei+'_'+si+'" onclick="togSet('+i+','+ei+','+si+')">';
            h+='<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></button></div>';
          }
        }
        h+='</div>';
        var _restSec=parseInt(ex.rest,10);
        if(!isNaN(_restSec)&&_restSec>0) h+='<div class="rest-timer" id="rest_'+i+'_'+ei+'" data-rest="'+_restSec+'" style="display:none"><div><div class="rt-label">Rest</div><div class="rt-count" id="rtc_'+i+'_'+ei+'">0:00</div></div><div class="rt-wrap"><div class="rt-fill" id="rtf_'+i+'_'+ei+'"></div></div><button class="rt-skip" onclick="skipRest('+i+','+ei+')">Skip</button></div>';
        h+='<button class="addset" onclick="addSet('+i+','+ei+',\'—\',\''+esc(splitKey)+'\')">+ Add set</button>';
        if(isBarbell){var topW=0;(savedEx||[]).forEach(function(sv){var w=parseFloat(sv.weight);if(!isNaN(w)&&w>topW)topW=w;});if(!topW&&prevEffort){prevEffort.forEach(function(p){var w=parseFloat(p.weight);if(!isNaN(w)&&w>topW)topW=w;});}h+='<div class="plate-calc" id="plate_'+i+'_'+ei+'">'+platesHtml(topW)+'</div>';}
        h+='</div>';
      });
      h+='</div>';
    }
    var sl2notes=(logs[s.id]&&logs[s.id].__notes)||'';
    h+='<div class="run-field run-input-full" style="margin-top:12px;margin-bottom:8px"><label>Session notes <span style="font-family:var(--mono);font-size:10px;font-weight:400;color:var(--dim)">(PRs, wins, niggles, anything worth logging)</span></label><textarea id="gn_'+i+'" class="li" placeholder="e.g. Hit a new squat PR, left knee felt a bit off on lunges..." oninput="draftGym('+i+',\''+esc(splitKey)+'\')" style="min-height:70px;resize:vertical;font-size:13px">'+esc(sl2notes)+'</textarea></div>';
    h+='<div id="gym_saved_'+i+'" class="saved-data" style="display:'+(isSessionLogged(s.id)?'block':'none')+';"><div class="saved-label">✓ Session Logged — your data above has been saved</div></div>';
    h+='<button class="savebtn" id="sb_'+i+'" onclick="saveGym('+i+',\''+esc(splitKey)+'\')">Save session</button>';
    if(isSessionLogged(s.id)){setTimeout(function(idx){lockSaveButton(idx,'Save session');}(i),0);}
  }else if(type==='note'){
    var sl3=logs[s.id]||{};
    var noteVal=(typeof sl3.__notes==='string')?sl3.__notes:(sl3.notes||'');
    var instruction=s.runDetails||(_sessionOverrides[s.id]&&_sessionOverrides[s.id].notes)||'';
    h+='<div style="background:rgba(255,255,255,.03);border:1px solid var(--border-mid);border-radius:8px;padding:12px 14px">';
    if(instruction) h+='<div style="font-size:13px;color:var(--text);line-height:1.55;margin-bottom:12px">'+esc(instruction)+'</div>';
    h+='<div class="run-field run-input-full" style="margin-bottom:10px"><label>What did you do? <span style="font-family:var(--mono);font-size:10px;font-weight:400;color:var(--dim)">(training + how it felt, anything worth logging)</span></label><textarea id="nt_'+i+'" class="li" placeholder="e.g. 45min easy run + mobility, legs felt good. Hit chest at the gym, normal week..." oninput="draftNote('+i+')" style="min-height:90px;resize:vertical;font-size:13px">'+esc(noteVal)+'</textarea></div>';
    h+='<div id="note_saved_'+i+'" class="saved-data" style="display:'+(isSessionLogged(s.id)?'block':'none')+';"><div class="saved-label">✓ Logged — saved to your coach</div></div>';
    h+='<button class="savebtn" id="sb_'+i+'" onclick="saveNote('+i+')">Save</button>';
    if(isSessionLogged(s.id)){setTimeout(function(idx){lockSaveButton(idx,'Save');}(i),0);}
    h+='</div>';
  }else{h+='<div style="font-family:var(--mono);font-size:12px;color:var(--dim);padding:8px 0">Rest up. Recovery is training too.</div>';}
  return h;
}

var focusedSessionIndex=null;
function ensureFocusOverlay(){
  var ov=document.getElementById('focusOverlay');
  if(ov)return ov;
  ov=document.createElement('div');ov.id='focusOverlay';ov.className='focus-overlay';
  ov.innerHTML='<div class="focus-overlay-bar"><button class="focus-close" onclick="closeFocusedSession()" aria-label="Close session">&times;</button><div class="focus-overlay-title"><small>Session</small><strong id="focusOverlayName">Workout</strong></div><span id="focusOverlayMeta"></span></div><div class="focus-overlay-scroll" id="focusOverlayScroll"></div><div class="focus-overlay-foot"><button class="focus-done-btn" onclick="closeFocusedSession()">Done — back to plan</button></div>';
  document.body.appendChild(ov);
  return ov;
}
function startFocusedSession(i){
  var card=document.getElementById('sc_'+i),body=document.getElementById('scb_'+i);if(!card||!body)return;
  if(focusedSessionIndex!=null&&focusedSessionIndex!==i)closeFocusedSession();
  if(!body.classList.contains('open'))body.classList.add('open');
  focusedSessionIndex=i;
  var ov=ensureFocusOverlay(),scroll=document.getElementById('focusOverlayScroll');
  if(!scroll.contains(card)){
    var ph=document.getElementById('focusCardPlaceholder');
    if(!ph){ph=document.createElement('div');ph.id='focusCardPlaceholder';ph.style.display='none';}
    card.parentNode.insertBefore(ph,card);
    scroll.appendChild(card);
  }
  card.classList.add('in-focus-overlay');
  var nameEl=document.getElementById('focusOverlayName');if(nameEl)nameEl.textContent=(sessions[i]&&sessions[i].name)||'Workout';
  var exCount=card.querySelectorAll('.exc').length,metaEl=document.getElementById('focusOverlayMeta');
  if(metaEl)metaEl.textContent=exCount?exCount+(exCount===1?' exercise':' exercises'):'';
  document.body.classList.add('focus-session-open');
  void ov.offsetHeight;ov.classList.add('open');scroll.scrollTop=0;
}
function closeFocusedSession(){
  if(focusedSessionIndex!=null){
    var card=document.getElementById('sc_'+focusedSessionIndex),ph=document.getElementById('focusCardPlaceholder');
    if(card){card.classList.remove('in-focus-overlay');if(ph&&ph.parentNode){ph.parentNode.insertBefore(card,ph);ph.parentNode.removeChild(ph);}}
  }
  var ov=document.getElementById('focusOverlay');if(ov)ov.classList.remove('open');
  document.body.classList.remove('focus-session-open');focusedSessionIndex=null;
}
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&focusedSessionIndex!=null)closeFocusedSession();});
function togS(i){var el=document.getElementById('scb_'+i);if(el) el.classList.toggle('open');}
async function tickS(i){
  var s=sessions[i],on=!ticked[s.id];
  ticked[s.id]=on;localStorage.setItem('dp_ticked_'+athlete.code,JSON.stringify(ticked));
  if(sbClient){try{sbClient.from('athlete_data').upsert({athlete_code:athlete.code,key:'ticked',value:ticked,updated_at:new Date().toISOString()},{onConflict:'athlete_code,key'}).then(function(){}).catch(function(){});}catch(e){}}
  var hasData=logHasRealData(logs[s.id]);
  var card=document.getElementById('sc_'+i),btn=document.getElementById('tick_'+i);
  if(card){card.classList.toggle('done',on&&hasData);card.classList.toggle('marked',on&&!hasData);}
  if(btn){btn.classList.toggle('on',on&&hasData);btn.classList.toggle('marked',on&&!hasData);btn.querySelector('svg').style.opacity=on?1:0;}
  // Toggle the inline "tap to log" nudge for the marked (ticked-but-unlogged) state
  var nudge=document.getElementById('nudge_'+i);
  if(on&&!hasData){
    if(!nudge&&card){nudge=document.createElement('div');nudge.id='nudge_'+i;nudge.className='sc-nudge';nudge.innerHTML='Marked — tap to open &amp; log your data';var scb=document.getElementById('scb_'+i);card.insertBefore(nudge,scb);}
  }else if(nudge){nudge.remove();}
  updateSessionCounter();
  // NOTE: a bare tick must NOT set Notion Status='Completed' — the coaches dashboard
  // treats Completed as Done. Only saveRun/saveGym mark a session Completed in Notion.
}
async function markSessionDone(i){
  var s=sessions[i];if(!s) return;
  ticked[s.id]=true;localStorage.setItem('dp_ticked_'+athlete.code,JSON.stringify(ticked));
  if(sbClient){try{await sbClient.from('athlete_data').upsert({athlete_code:athlete.code,key:'ticked',value:ticked,updated_at:new Date().toISOString()},{onConflict:'athlete_code,key'});}catch(e){}}
  var card=document.getElementById('sc_'+i),btn=document.getElementById('tick_'+i);
  if(card){card.classList.remove('marked');card.classList.add('done');}
  if(btn){btn.classList.remove('marked');btn.classList.add('on');var sv=btn.querySelector('svg');if(sv) sv.style.opacity=1;}
  var nudge=document.getElementById('nudge_'+i);if(nudge) nudge.remove();
  updateSessionCounter();
  // A saved log with real data = Done → mirror to Notion so the coaches dashboard agrees
  return coachWrite('/api/notion',{endpoint:'pages/'+s.id,body:{properties:{Status:{select:{name:'Completed'}}}}});
}
function togSet(i,ei,si){var btn=document.getElementById('st_'+i+'_'+ei+'_'+si),on=!btn.classList.contains('on');btn.classList.toggle('on',on);btn.style.background=on?'var(--ok)':'transparent';btn.style.borderColor=on?'var(--ok)':'var(--border-mid)';if(on) startRest(i,ei);}
// ── REST TIMER ────────────────────────────────────────────────────────────────
// Single global countdown, fired when a set is ticked. Reads programmed rest (sec)
// from the exercise's hidden bar. Only one runs at a time across all exercises.
var _rest={iv:null,key:null};
function skipRest(i,ei){if(_rest.iv){clearInterval(_rest.iv);_rest.iv=null;}var el=document.getElementById('rest_'+i+'_'+ei);if(el){el.style.display='none';el.style.opacity='1';}_rest.key=null;}
function startRest(i,ei){
  var el=document.getElementById('rest_'+i+'_'+ei);if(!el) return;
  var total=parseInt(el.getAttribute('data-rest'),10)||0;if(total<=0) return;
  if(_rest.iv){clearInterval(_rest.iv);_rest.iv=null;}
  if(_rest.key&&_rest.key!==i+'_'+ei){var prev=document.getElementById('rest_'+_rest.key);if(prev){prev.style.display='none';prev.style.opacity='1';}}
  _rest.key=i+'_'+ei;
  el.style.display='flex';el.style.opacity='1';
  var left=total;
  function tick(){
    var c=document.getElementById('rtc_'+i+'_'+ei);if(!c){clearInterval(_rest.iv);_rest.iv=null;return;}
    var m=Math.floor(left/60),x=left%60;c.textContent=m+':'+(x<10?'0':'')+x;
    var f=document.getElementById('rtf_'+i+'_'+ei);if(f) f.style.width=Math.round(left/total*100)+'%';
    if(left<=0){clearInterval(_rest.iv);_rest.iv=null;var e=document.getElementById('rest_'+i+'_'+ei);if(e){e.style.transition='opacity .4s';e.style.opacity='0';setTimeout(function(){if(e){e.style.display='none';e.style.opacity='1';e.style.transition='';}},450);}_rest.key=null;return;}
    left--;
  }
  tick();_rest.iv=setInterval(tick,1000);
}
function addSet(i,ei,rep,splitKey){var c=document.getElementById('sets_'+i+'_'+ei);var isSL=!!document.getElementById('rL_'+i+'_'+ei+'_0');var si=c.querySelectorAll('.setrow,.setrow-single').length;var row=document.createElement('div');var delBtn='<button class="del-set" onclick="deleteSet(this,'+i+','+ei+',\''+splitKey+'\')" title="Remove set">×</button>';if(isSL){row.className='setrow-single extra';row.id='sr_'+i+'_'+ei+'_'+si;row.innerHTML='<div class="snum">'+(si+1)+'</div>'+'<input type="number" class="sin" id="w_'+i+'_'+ei+'_'+si+'" placeholder="—" min="0" step="0.5" oninput="draftGym('+i+',\''+splitKey+'\')" />'+'<input type="number" class="sin" id="rL_'+i+'_'+ei+'_'+si+'" placeholder="L" min="0" oninput="draftGym('+i+',\''+splitKey+'\')" />'+'<input type="number" class="sin" id="rR_'+i+'_'+ei+'_'+si+'" placeholder="R" min="0" oninput="draftGym('+i+',\''+splitKey+'\')" />'+'<button class="st" id="st_'+i+'_'+ei+'_'+si+'" onclick="togSet('+i+','+ei+','+si+')">'+'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></button>'+delBtn;}else{row.className='setrow extra';row.id='sr_'+i+'_'+ei+'_'+si;row.innerHTML='<div class="snum">'+(si+1)+'</div>'+'<input type="number" class="sin" id="w_'+i+'_'+ei+'_'+si+'" placeholder="—" min="0" step="0.5" oninput="draftGym('+i+',\''+splitKey+'\')" />'+'<input type="number" class="sin" id="r_'+i+'_'+ei+'_'+si+'" placeholder="'+rep+'" min="0" oninput="draftGym('+i+',\''+splitKey+'\')" />'+'<input type="number" class="rpe-in" id="rpe_'+i+'_'+ei+'_'+si+'" placeholder="—" min="1" max="10" step="0.5" oninput="draftGym('+i+',\''+splitKey+'\')" />'+'<button class="st" id="st_'+i+'_'+ei+'_'+si+'" onclick="togSet('+i+','+ei+','+si+')">'+'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></button>'+delBtn;}c.appendChild(row);}
function deleteSet(btn,i,ei,splitKey){var row=btn.closest('.setrow,.setrow-single');var c=row.parentElement;row.remove();c.querySelectorAll('.setrow,.setrow-single').forEach(function(r,idx){var sn=r.querySelector('.snum');if(sn) sn.textContent=idx+1;});draftGym(i,splitKey);}
function formatRest(r){if(!r) return '';var s=parseInt(r);if(isNaN(s)) return r;if(s>=60){var m=Math.floor(s/60),rem=s%60;return rem?m+'min '+rem+'s rest':m+' min rest';}return s+'s rest';}
function draftRun(i){var s=sessions[i];if(!s) return;var d={distance:document.getElementById('rd_'+i).value||'',duration:document.getElementById('rdur_'+i).value||'',pace:document.getElementById('rp_'+i).value||'',rpe:document.getElementById('rr_'+i).value||'',feel:document.getElementById('rf_'+i).value||'',notes:document.getElementById('rn_'+i).value||''};logs[s.id]=d;(logs.__savedAt=Date.now(),localStorage.setItem('dp_logs_'+athlete.code,JSON.stringify(logs)));}
function editRun(i){var form=document.getElementById('run_form_'+i),saved=document.getElementById('saved_run_'+i);if(form) form.style.display='block';if(saved) saved.style.display='none';}
function showRunSaved(i,d){
  var s=sessions[i];if(!d){d=logs[s?s.id:null]||{};}
  var distEl=document.getElementById('saved_run_'+i+'_distance');
  var durEl=document.getElementById('saved_run_'+i+'_duration');
  var paceEl=document.getElementById('saved_run_'+i+'_pace');
  var rpeEl=document.getElementById('saved_run_'+i+'_rpe');
  var feelEl=document.getElementById('saved_run_'+i+'_feel');
  var notesEl=document.getElementById('saved_run_'+i+'_notes');
  if(distEl) distEl.textContent=d.distance?d.distance+'km':'-';
  if(durEl) durEl.textContent=d.duration?d.duration+'min':'-';
  if(paceEl) paceEl.textContent=d.pace||'-';
  if(rpeEl) rpeEl.textContent=d.rpe?d.rpe+'/10':'-';
  if(feelEl){feelEl.textContent=d.feel||'';feelEl.style.display=d.feel?'block':'none';}
  if(notesEl){notesEl.textContent=d.notes||'';notesEl.style.display=d.notes?'block':'none';}
  var saved=document.getElementById('saved_run_'+i);
  if(saved) saved.style.display='block';
  // Keep the form visible so athletes can see their saved data for reassurance
  lockSaveButton(i,'Save session');
}
var _draftGymTimer=null;
function draftGym(i,splitKey){
  if(_draftGymTimer) clearTimeout(_draftGymTimer);
  _draftGymTimer=setTimeout(function(){persistGymDraft(i,splitKey);},250);
}
function persistGymDraft(i,splitKey){var s=sessions[i];if(!s) return;var exercises=getSplit(splitKey);var log={};exercises.forEach(function(ex,ei){var arr=collectExerciseSets(i,ei);var useName=exPicks[ex.exercise]||ex.exercise;log[useName]=arr;});var gnEl=document.getElementById('gn_'+i);if(gnEl) log.__notes=gnEl.value;logs[s.id]=log;(logs.__savedAt=Date.now(),localStorage.setItem('dp_logs_'+athlete.code,JSON.stringify(logs)));refreshStrengthFeedback(i,splitKey);try{markInlinePbs(i,splitKey);}catch(e){}}

// ── NOTE-ONLY SESSION (discovery week "train as normal" + log notes) ──────────
function draftNote(i){
  var s=sessions[i];if(!s) return;
  var el=document.getElementById('nt_'+i);
  logs[s.id]={__notes:el?el.value:''};logs.__savedAt=Date.now();
  localStorage.setItem('dp_logs_'+athlete.code,JSON.stringify(logs));
}
async function saveNote(i){
  var btn=document.getElementById('sb_'+i);if(btn){if(btn.disabled) return;btn.disabled=true;btn.textContent='Saving...';}
  var s=sessions[i];
  var el=document.getElementById('nt_'+i);var noteText=el?el.value.trim():'';
  logs[s.id]={__notes:noteText};logs.__savedAt=Date.now();
  localStorage.setItem('dp_logs_'+athlete.code,JSON.stringify(logs));
  if(sbClient){try{await sbClient.from('athlete_data').upsert({athlete_code:athlete.code,key:'logs',value:logs,updated_at:new Date().toISOString()},{onConflict:'athlete_code,key'});}catch(e){}}
  var noteDate=s.date||new Date().toISOString().slice(0,10);
  var noteResult=await coachWrite(WEBHOOK,{
    name:athlete.name+' — '+(s.name||'Notes')+' — '+noteDate,
    session:s.name||'Notes',
    type:'training_log',          // routes to training_session_logs + Notion, same path as run/gym
    sessionCategory:'Discovery',  // friendly Session Category label (see write.js / ingest.js)
    exerciseLog:noteText,         // lands in exercise_log — coaches dashboard already reads this
    notes:noteText,
    athleteCode:athlete.code,athleteId:athlete.notionPageId,athleteName:athlete.name,
    date:noteDate,submittedAt:new Date().toISOString()
  });
  await markSessionLogged(s.id);
  var statusResult=await markSessionDone(i);
  var queued=(noteResult&&noteResult.queued)||(statusResult&&statusResult.queued);
  showToast(queued?'Saved - coach dashboard sync pending':'Saved ✓');
  var banner=document.getElementById('note_saved_'+i);if(banner) banner.style.display='block';
  lockSaveButton(i,'Save');
}
// ── SESSION LOG STATE (Supabase-backed) ───────────────────────────────────────
var sessionLoggedCache={};
async function markSessionLogged(sessionId){
  var key='session_'+athlete.code+'_'+sessionId;
  sessionLoggedCache[key]=true;
  if(sbClient){try{await sbClient.from('session_logs').upsert({athlete_code:athlete.code,session_key:key,logged_at:new Date().toISOString()},{onConflict:'athlete_code,session_key'});}catch(e){console.warn('session_logs upsert failed:',e);}}
}
async function loadSessionLogs(){
  if(!sbClient) return;
  try{
    var res=await sbClient.from('session_logs').select('session_key').eq('athlete_code',athlete.code);
    if(res.data){res.data.forEach(function(r){sessionLoggedCache[r.session_key]=true;});}
  }catch(e){console.warn('session_logs load failed:',e);}
}
function isSessionLogged(sessionId){
  // Primary: in-memory cache (set at save time, or loaded from session_logs on login)
  if(sessionLoggedCache['session_'+athlete.code+'_'+sessionId]) return true;
  // Fallback: check logs object — reliably synced via athlete_data table in Supabase
  var l=logs[sessionId];
  if(l&&typeof l==='object'&&Object.keys(l).length>0) return true;
  return false;
}
function lockSaveButton(i,label){
  var btn=document.getElementById('sb_'+i);
  if(!btn) return;
  btn.classList.add('saved');
  btn.textContent='Session Saved ✓';
  btn.disabled=true;
  btn.style.opacity='0.7';
  btn.style.cursor='default';
}
async function saveRun(i){
  var btn=document.getElementById('sb_'+i);if(btn){if(btn.disabled) return;btn.disabled=true;btn.textContent='Saving...';}
  var s=sessions[i],d={distance:document.getElementById('rd_'+i).value||'',duration:document.getElementById('rdur_'+i).value||'',pace:document.getElementById('rp_'+i).value||'',rpe:document.getElementById('rr_'+i).value||'',feel:document.getElementById('rf_'+i).value||'',notes:document.getElementById('rn_'+i).value||''};
  logs[s.id]=d;(logs.__savedAt=Date.now(),localStorage.setItem('dp_logs_'+athlete.code,JSON.stringify(logs)));
  if(sbClient){try{await sbClient.from('athlete_data').upsert({athlete_code:athlete.code,key:'logs',value:logs,updated_at:new Date().toISOString()},{onConflict:'athlete_code,key'});}catch(e){}}
  var runDateEl=document.getElementById('run_date_'+i);var runDate=runDateEl&&runDateEl.value?runDateEl.value:(s.date||new Date().toISOString().slice(0,10));
  var runCoachResult=await coachWrite(WEBHOOK,{name:athlete.name+' — '+s.name+' — '+runDate,session:s.name,type:'Run',distanceKm:d.distance,durationMin:d.duration,pace:d.pace,rpe:d.rpe,feel:d.feel,exerciseLog:'Distance: '+d.distance+'km | Duration: '+d.duration+'min | Pace: '+d.pace+' | RPE: '+d.rpe+'/10 | Feel: '+d.feel,notes:d.notes,athleteId:athlete.notionPageId,athleteName:athlete.name,athleteCode:athlete.code,date:runDate,submittedAt:new Date().toISOString()});
  await markSessionLogged(s.id);
  var runStatusResult=await markSessionDone(i);
  showToast((runCoachResult&&runCoachResult.queued)||(runStatusResult&&runStatusResult.queued)?'Run saved - coach dashboard sync pending':'Run saved ✓');
  showRunSaved(i,d);
  await loadNutrition();
}
// ── PERSONAL BEST DETECTION ───────────────────────────────────────────────────
// Stored PBs are derived on the fly from `logs` history (the Supabase-synced source
// of truth) — no separate table. Rules per Dual Performance spec:
//  1 Load PB   — any single set weight > stored load weight
//  2 Rep PB    — more reps at the same or greater weight than the stored rep record
//  3 Strength  — Brzycki e1RM (w*36/(37-r)) beats stored e1RM; valid for reps 1–10 only
//  4 Volume PB — session total (Σ w*r) beats stored volume
// Guards: Load/Rep/Volume flag up to PB_REP_CAP reps (hypertrophy range); e1RM stays
// capped at 10 (Brzycki invalid beyond that). Never flag a set below 60% of stored load
// PB (the portal captures no RPE, so the "no RPE" branch of the guard always applies).
var PB_REP_CAP=12;
// ── PLATE CALCULATOR ──────────────────────────────────────────────────────────
// Greedy plate breakdown per side for a 20kg Olympic bar.
function platesPerSide(total,bar){bar=bar||20;var per=(total-bar)/2;if(!(per>0)) return null;var sizes=[25,20,15,10,5,2.5,1.25],out=[],rem=Math.round(per*100)/100;sizes.forEach(function(p){var n=Math.floor((rem+1e-9)/p);if(n>0){out.push({p:p,n:n});rem=Math.round((rem-n*p)*100)/100;}});return {plates:out,leftover:rem};}
function platesHtml(total){
  var label='<div class="plate-calc-label">Plates each side · 20kg bar</div>';
  total=parseFloat(total)||0;
  if(total<=20) return label+'<div class="plate-pills"><div class="plate-pill">Just the bar</div></div>';
  var res=platesPerSide(total,20);
  if(!res||!res.plates.length) return label+'<div class="plate-pills"><div class="plate-pill">—</div></div>';
  var pills=res.plates.map(function(o){return '<div class="plate-pill">'+o.n+' × '+o.p+'kg</div>';}).join('');
  if(res.leftover>0.01) pills+='<div class="plate-pill" style="color:var(--dim)">+'+res.leftover+'kg ea</div>';
  return label+'<div class="plate-pills">'+pills+'</div>';
}
function pbNum(v){var n=parseFloat(v);return isNaN(n)?null:n;}
// Normalise an exercise name for history matching: lowercase, collapse internal
// whitespace, trim. Keeps each exercise's PB history bound to the same exercise even
// if the name is logged with different casing or stray spaces ("Bench Press" /
// "bench  press " all fold together). Does NOT merge genuinely different exercises.
function pbNormName(n){return String(n==null?'':n).toLowerCase().replace(/\s+/g,' ').trim();}
function pbRound1(n){return Math.round(n*10)/10;}
function pbE1rm(w,r){if(r<1||r>10) return null;return w*36/(37-r);}
function pbCleanSets(sets){
  return (sets||[]).map(function(s,idx){
    return {set:idx+1,weight:pbNum(s.weight),reps:parseInt(s.reps,10),rpe:pbNum(s.rpe)};
  }).filter(function(s){return s.weight!=null&&s.weight>0&&!isNaN(s.reps)&&s.reps>0;});
}
// Fold one session's sets into a stored-pbs object (history seeding, no flagging)
function pbFold(stored,sets){
  var clean=pbCleanSets(sets);if(!clean.length) return;
  clean.forEach(function(s){
    if(stored.load==null||s.weight>pbNum(stored.load.weight)) stored.load={weight:s.weight,reps:s.reps};
    if(stored.reps==null||s.reps>stored.reps.reps) stored.reps={weight:s.weight,reps:s.reps};
    var e=pbE1rm(s.weight,s.reps);
    if(e!=null&&(stored.e1rm==null||e>stored.e1rm.value)) stored.e1rm={value:pbRound1(e)};
  });
  var vol=clean.reduce(function(a,s){return a+(s.reps<=PB_REP_CAP?s.weight*s.reps:0);},0);
  if(stored.volume==null||vol>stored.volume.value) stored.volume={value:pbRound1(vol)};
}
function pbSessionDate(sid){try{for(var k=0;k<sessions.length;k++){if(sessions[k].id===sid) return sessions[k].date||'';}}catch(e){}return '';}
// Build stored PBs for an exercise from all history EXCLUDING the current session
function pbComputeStored(exName,excludeId){
  var stored={load:null,reps:null,e1rm:null,volume:null};
  var target=pbNormName(exName);
  Object.keys(logs).forEach(function(sid){
    if(sid===excludeId||sid.indexOf('__')===0) return;
    var sess=logs[sid];if(!sess||typeof sess!=='object'||Array.isArray(sess)) return;
    // Match on normalised name so casing/whitespace variants of the SAME exercise
    // still share one PB history, while different exercises stay fully independent.
    Object.keys(sess).forEach(function(k){
      if(k.indexOf('__')===0||pbNormName(k)!==target) return;
      var sets=sess[k];if(!Array.isArray(sets)||!sets.length) return;
      pbFold(stored,sets);
    });
  });
  return stored;
}
// Detect new PBs for one exercise's sets against stored pbs
function detectExercisePBs(exName,sets,stored){
  stored=stored||{load:null,reps:null,e1rm:null,volume:null};
  var clean=pbCleanSets(sets),hits=[];
  if(!clean.length) return hits;
  var firstEver=stored.load==null&&stored.reps==null&&stored.e1rm==null&&stored.volume==null;
  if(firstEver) return hits; // first-ever log seeds history silently
  var loadW=stored.load?pbNum(stored.load.weight):null;
  var minLoad=loadW!=null?loadW*0.6:0;
  // LOAD
  if(loadW!=null){var best=null;
    clean.forEach(function(s){if(s.reps>PB_REP_CAP) return;if(s.weight<minLoad&&s.rpe==null) return;if(s.weight>loadW){if(!best||s.weight>best.weight) best=s;}});
    if(best) hits.push({type:'load',badge:'LOAD PB',exercise:exName,set:best.set,value:best.weight,unit:'kg',previous:loadW,delta:'+'+pbRound1(best.weight-loadW)+'kg'});
  }
  // REP
  if(stored.reps){var rW=pbNum(stored.reps.weight),rR=stored.reps.reps,bestR=null;
    clean.forEach(function(s){if(s.reps>PB_REP_CAP) return;if(loadW!=null&&s.weight<minLoad&&s.rpe==null) return;if(s.weight>=rW&&s.reps>rR){if(!bestR||s.reps>bestR.reps) bestR=s;}});
    if(bestR) hits.push({type:'reps',badge:'REP PB',exercise:exName,set:bestR.set,value:bestR.reps,unit:'reps',previous:rR,delta:'+'+(bestR.reps-rR)+' reps'});
  }
  // STRENGTH (e1RM)
  if(stored.e1rm){var bestE=null,bestEval=null;
    clean.forEach(function(s){if(s.reps>10) return;if(loadW!=null&&s.weight<minLoad&&s.rpe==null) return;var e=pbE1rm(s.weight,s.reps);if(e!=null&&e>stored.e1rm.value){if(bestEval==null||e>bestEval){bestEval=e;bestE=s;}}});
    if(bestE) hits.push({type:'e1rm',badge:'STRENGTH PB',exercise:exName,set:bestE.set,value:pbRound1(bestEval),unit:'kg e1RM',previous:stored.e1rm.value,delta:'+'+pbRound1(bestEval-stored.e1rm.value)+'kg'});
  }
  // VOLUME (sets above PB_REP_CAP reps excluded per the global rule)
  if(stored.volume){var vol=clean.reduce(function(a,s){return a+(s.reps<=PB_REP_CAP?s.weight*s.reps:0);},0);
    if(vol>stored.volume.value) hits.push({type:'volume',badge:'VOLUME PB',exercise:exName,value:pbRound1(vol),unit:'kg',previous:stored.volume.value,delta:'+'+pbRound1(vol-stored.volume.value)+'kg'});
  }
  return hits;
}
// Run detection across a whole saved session
function detectSessionPBs(sessionId,log){
  var all=[];
  Object.keys(log).forEach(function(exName){
    if(exName.indexOf('__')===0) return;
    var sets=log[exName];if(!Array.isArray(sets)||!sets.length) return;
    all=all.concat(detectExercisePBs(exName,sets,pbComputeStored(exName,sessionId)));
  });
  return all;
}
// Mark PB sets inline — purple highlight + "NEW PB" badge on the exact set row that
// achieved it (live, no button press). Evaluates each DOM row in place so the badge
// always lands on the right set regardless of empty/edited rows.
function markInlinePbs(i,splitKey){
  var s=sessions[i];if(!s) return 0;
  var exercises=getSplit(splitKey),total=0;
  exercises.forEach(function(ex,ei){
    var container=document.getElementById('sets_'+i+'_'+ei);
    if(!container) return;
    // Clear any previous marks (so PBs disappear live when a value drops below)
    container.querySelectorAll('.setrow,.setrow-single').forEach(function(row){
      row.classList.remove('has-pb');
      var b=row.querySelector('.pb-badge');if(b) b.remove();
      var t=row.querySelector('button[id^="st_"]');
      if(t){t.classList.remove('pb-on');
        if(t.classList.contains('on')){t.style.background='var(--ok)';t.style.borderColor='var(--ok)';}
        else{t.style.background='transparent';t.style.borderColor='var(--border-mid)';}
      }
    });
    var resolvedEx=exPicks[ex.exercise]||ex.exercise;
    var stored=pbComputeStored(resolvedEx,s.id);
    var hasHistory=!(stored.load==null&&stored.reps==null&&stored.e1rm==null&&stored.volume==null);
    var loadW=stored.load?pbNum(stored.load.weight):null;
    var minLoad=loadW!=null?loadW*0.6:0;
    var rW=stored.reps?pbNum(stored.reps.weight):null,rR=stored.reps?stored.reps.reps:null;
    var bestLoad=null,bestRep=null,bestE=null,vol=0,maxW=0;
    container.querySelectorAll('.setrow').forEach(function(row){ // single-leg rows have no r_ input → skipped, matching detection
      var wEl=row.querySelector('input[id^="w_"]'),rEl=row.querySelector('input[id^="r_"]'),rpeEl=row.querySelector('input[id^="rpe_"]');
      if(rpeEl) rpeEl.classList.toggle('filled',rpeEl.value!=='');
      if(!wEl||!rEl) return;
      var w=pbNum(wEl.value),r=parseInt(rEl.value,10),rpe=rpeEl?pbNum(rpeEl.value):null;
      if(w==null||w<=0||isNaN(r)||r<=0) return;
      if(w>maxW) maxW=w;
      if(r<=PB_REP_CAP) vol+=w*r; // volume counts every set ≤ cap (no min-load guard, matches stored)
      if(!hasHistory) return;
      if(w<minLoad&&rpe==null) return; // below 60% of stored load (and no RPE logged) → ineligible
      if(loadW!=null&&r<=PB_REP_CAP&&w>loadW){if(!bestLoad||w>bestLoad.w) bestLoad={row:row,w:w};}
      if(rW!=null&&r<=PB_REP_CAP&&w>=rW&&r>rR){if(!bestRep||r>bestRep.r) bestRep={row:row,r:r};}
      if(stored.e1rm&&r<=10){var e=pbE1rm(w,r);if(e!=null&&e>stored.e1rm.value){if(!bestE||e>bestE.e) bestE={row:row,e:e};}}
    });
    var volEl=document.getElementById('vol_'+i+'_'+ei);
    if(volEl){var isVolPB=hasHistory&&stored.volume&&vol>stored.volume.value;volEl.className='ex-stat ex-stat-vol'+(isVolPB?' pb':'');volEl.innerHTML=(isVolPB?'<svg class="icon"><use href="#i-trophy"/></svg> ':'')+'Vol '+Math.round(vol).toLocaleString()+'kg';if(isVolPB) total++;}
    var plateEl=document.getElementById('plate_'+i+'_'+ei);
    if(plateEl&&maxW>0) plateEl.innerHTML=platesHtml(maxW);
    var rowsToMark=[];
    [bestLoad,bestRep,bestE].forEach(function(b){if(b){total++;if(rowsToMark.indexOf(b.row)<0) rowsToMark.push(b.row);}});
    rowsToMark.forEach(function(row){
      row.classList.add('has-pb');
      var t=row.querySelector('button[id^="st_"]');
      if(t){t.classList.add('pb-on');t.style.background='var(--pb)';t.style.borderColor='var(--pb)';}
      var badge=document.createElement('div');badge.className='pb-badge';badge.innerHTML='<svg class="icon"><use href="#i-trophy"/></svg> NEW PB';
      row.appendChild(badge);
    });
  });
  return total;
}

async function saveGym(i,splitKey){
  var btn=document.getElementById('sb_'+i);if(btn){if(btn.disabled) return;btn.disabled=true;btn.textContent='Saving...';}
  var s=sessions[i],exercises=getSplit(splitKey),log={};
  exercises.forEach(function(ex,ei){var sets=collectExerciseSets(i,ei);var useName=exPicks[ex.exercise]||ex.exercise;if(sets.length) log[useName]=sets;});
  logs[s.id]=log;(logs.__savedAt=Date.now(),localStorage.setItem('dp_logs_'+athlete.code,JSON.stringify(logs)));
  if(sbClient){try{await sbClient.from('athlete_data').upsert({athlete_code:athlete.code,key:'logs',value:logs,updated_at:new Date().toISOString()},{onConflict:'athlete_code,key'});}catch(e){}}
  var gymDateEl=document.getElementById('gym_date_'+i);var gymDate=gymDateEl&&gymDateEl.value?gymDateEl.value:(s.date||new Date().toISOString().slice(0,10));
  var gnEl=document.getElementById('gn_'+i);var gymNotes=gnEl?gnEl.value:'';
  var pbHits=[];try{pbHits=detectSessionPBs(s.id,log);}catch(e){console.warn('PB detection failed:',e);}
  function setSummary(st,si){
    var reps=(st.reps!==undefined&&st.reps!==null&&st.reps!=='')?(st.reps+'reps'):'';
    if(!reps&&(st.repsLeft||st.repsRight)) reps='L '+(st.repsLeft||'—')+' / R '+(st.repsRight||'—')+' reps';
    if(!reps) reps='— reps';
    return 'Set '+(si+1)+': '+(st.weight||'—')+'kg × '+reps+(st.rpe?' @ RPE '+st.rpe:'');
  }
  var fetches=Object.keys(log).filter(function(k){return k!=='__notes';}).map(function(exName){var sets=log[exName];return coachWrite(WEBHOOK,{name:athlete.name+' — '+exName+' — '+gymDate,session:s.name,type:'Strength',exerciseLog:exName+': '+sets.map(setSummary).join(' | '),rawSets:sets,notes:gymNotes,athleteCode:athlete.code,athleteId:athlete.notionPageId,athleteName:athlete.name,date:gymDate,submittedAt:new Date().toISOString()});});
  var gymCoachResults=await Promise.all(fetches);
  await markSessionLogged(s.id);
  var gymStatusResult=await markSessionDone(i);
  refreshStrengthFeedback(i,splitKey);
  try{markInlinePbs(i,splitKey);}catch(e){}
  var gymQueued=gymCoachResults.some(function(r){return r&&r.queued;})||(gymStatusResult&&gymStatusResult.queued);
  showToast(gymQueued?'Session saved - coach dashboard sync pending':(pbHits.length?(pbHits.length+' new PB'+(pbHits.length>1?'s':'')+'!'):'Session saved ✓'));
  var gymSavedBanner=document.getElementById('gym_saved_'+i);
  if(!gymSavedBanner){
    var sbBtn=document.getElementById('sb_'+i);
    if(sbBtn){gymSavedBanner=document.createElement('div');gymSavedBanner.id='gym_saved_'+i;gymSavedBanner.className='saved-data';gymSavedBanner.style.marginBottom='10px';gymSavedBanner.innerHTML='<div class="saved-label">✓ Session Logged — your data above has been saved<\/div>';sbBtn.parentNode.insertBefore(gymSavedBanner,sbBtn);}
  }
  if(gymSavedBanner) gymSavedBanner.style.display='block';
  lockSaveButton(i,'Save session');
}
function flashSave(i,label){var btn=document.getElementById('sb_'+i);if(btn){btn.classList.add('saved');btn.textContent='Saved ✓';btn.disabled=true;setTimeout(function(){btn.classList.remove('saved');btn.textContent=label;btn.disabled=false;},2500);}}
function showToast(msg){var t=document.getElementById('toast');t.textContent=msg;t.style.display='block';setTimeout(function(){t.style.display='none';},2500);}

// ── INIT ──────────────────────────────────────────────────────────────────────
var urlCode=new URLSearchParams(location.search).get('code');
// Sign-out is coach-only: the dashboard opens the portal with ?code=, athletes launch the installed app without it.
if(urlCode){var _lb=document.getElementById('logoutBtn');if(_lb)_lb.style.display='';}
if(urlCode) doLogin(urlCode);
else { var savedCode=localStorage.getItem('dp_auth_code'); if(savedCode) doLogin(savedCode); else document.getElementById('loginScreen').style.display='block'; }

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

function processRunLibraryResults(results) {
  results.forEach(function(page) {
    const pr = page.properties || {};
    const mapped = {
      name: getPropText(pr['Session Name']) || getPropText(pr['Running Session']) || getPropText(pr['Workout']) || getNotionTitle(pr),
      type: getPropText(pr['Workout Type']) || getPropText(pr['Type']) || getPropText(pr['Session Type']),
      description: getPropText(pr['Description']) || getPropText(pr['Run Details']) || getPropText(pr['Workout Details']) || getPropText(pr['Session Details']) || getPropText(pr['Details']) || getPropText(pr['Notes']) || getPropText(pr['Coach Notes']),
      difficulty: getPropText(pr['Difficulty']),
      distance: getPropText(pr['Distance Focus']) || getPropText(pr['Distance']) || getPropText(pr['Distance / Volume']),
      duration: getPropText(pr['Duration (mins)']) || getPropText(pr['Duration']) || getPropText(pr['Time']) || getPropText(pr['Time Cap']),
      rpe: getPropText(pr['RPE']) || getPropText(pr['Effort']),
      intensity: getPropText(pr['Intensity Zone']) || getPropText(pr['Intensity']) || getPropText(pr['Zone']),
      phase: getPropText(pr['Training Phase']) || getPropText(pr['Phase']),
      surface: getPropText(pr['Surface']),
      fatigue: getPropText(pr['Fatigue Cost']),
      recovery: getPropText(pr['Recovery Time (hrs)']) || getPropText(pr['Recovery']) || getPropText(pr['Recovery Type']),
      goal: getPropText(pr['Session Goal']) || getPropText(pr['Goal']) || getPropText(pr['Target']) || getPropText(pr['Focus']),
      warmup: getPropText(pr['Warm Up']) || getPropText(pr['Warmup']) || getPropText(pr['Warm-up']),
      cooldown: getPropText(pr['Cool Down']) || getPropText(pr['Cooldown']) || getPropText(pr['Cool-down']),
      prereqs: getPropText(pr['Prerequisites']),
      slot: getPropText(pr['Weekly Slot']),
      targetPace: getPropText(pr['Target Pace']) || getPropText(pr['Pace Target']) || getPropText(pr['Pace']) || '',
      tags: getPropText(pr['Tags']) || getPropText(pr['Tag']),
      alternative: getPropText(pr['Alternative']) || getPropText(pr['Alternative Workout']) || getPropText(pr['Alternate Workout']) || getPropText(pr['Option B']) || getPropText(pr['Alternative Session']) || getPropText(pr['Regression']) || ''
    };
    RUNNING_LIBRARY_BY_ID[page.id] = mapped;
    runLibraryById[page.id] = Object.assign({}, runLibraryById[page.id] || {}, mapped, {
      warmUp: mapped.warmup || '',
      coolDown: mapped.cooldown || '',
      sessionGoal: mapped.goal || '',
      recoveryType: mapped.recovery || '',
      alternative: mapped.alternative || ''
    });
    if (mapped.name) runLibraryByName[mapped.name.toLowerCase()] = runLibraryById[page.id];
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
