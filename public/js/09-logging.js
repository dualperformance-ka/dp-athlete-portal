// ── REST TIMER ────────────────────────────────────────────────────────────────
// Single global countdown, fired when a set is completed. The absolute deadline
// keeps the timer accurate when the browser throttles intervals in another app.
var _rest={iv:null,key:null,deadline:0,total:0,notified:false};
var _restPermissionAsked=false;
function restTimerStorageKey(){return 'dp_rest_timer_'+((athlete&&athlete.code)||'default');}
function restTimerEnabled(){try{return localStorage.getItem('dp_rest_timer_enabled')!=='false';}catch(e){return true;}}
function updateRestTimerControls(){
  var enabled=restTimerEnabled();
  document.querySelectorAll('[data-rest-timer-toggle]').forEach(function(btn){
    btn.classList.toggle('is-on',enabled);btn.setAttribute('aria-pressed',enabled?'true':'false');
    var state=btn.querySelector('.rest-pref-state');if(state)state.textContent=enabled?'On':'Off';
  });
}
async function requestRestAlertPermission(){
  if(_restPermissionAsked||!('Notification'in window)||Notification.permission!=='default') return;
  _restPermissionAsked=true;
  try{await Notification.requestPermission();}catch(e){}
}
function toggleRestTimerPreference(){
  var enabled=!restTimerEnabled();
  try{localStorage.setItem('dp_rest_timer_enabled',enabled?'true':'false');}catch(e){}
  if(!enabled&&_rest.key){var parts=_rest.key.split('_');skipRest(parseInt(parts[0],10),parseInt(parts[1],10));}
  updateRestTimerControls();
  if(enabled)requestRestAlertPermission();
  showToast(enabled?'Rest timer on':'Rest timer off');
}
function clearRestTimerStorage(){try{localStorage.removeItem(restTimerStorageKey());}catch(e){}}
function hideRestTimer(i,ei){
  var el=document.getElementById('rest_'+i+'_'+ei);
  if(el){el.style.display='none';el.style.opacity='1';el.style.transition='';}
}
function skipRest(i,ei){
  if(_rest.iv){clearInterval(_rest.iv);_rest.iv=null;}
  if(_rest.key&&_rest.key!==i+'_'+ei){var active=document.getElementById('rest_'+_rest.key);if(active){active.style.display='none';active.style.opacity='1';}}
  hideRestTimer(i,ei);clearRestTimerStorage();
  _rest.key=null;_rest.deadline=0;_rest.total=0;_rest.notified=false;
}
function restExerciseName(i,ei){
  var card=document.querySelector('.exc[data-session-index="'+i+'"][data-exercise-index="'+ei+'"]');
  var name=card&&card.querySelector('.exn');return name?name.textContent.trim():'your next set';
}
function notifyRestComplete(i,ei){
  if(_rest.notified)return;_rest.notified=true;
  var name=restExerciseName(i,ei),body='Rest finished — time for '+name+'.';
  showToast('Rest complete · '+name);
  try{if(navigator.vibrate)navigator.vibrate([180,90,180]);}catch(e){}
  if(!('Notification'in window)||Notification.permission!=='granted')return;
  var options={body:body,icon:'/dp_baby_blue_transparent_512x512.png',badge:'/dp_baby_blue_transparent_512x512.png',tag:'dp-rest-complete',renotify:true,data:{url:location.pathname+location.search}};
  if('serviceWorker'in navigator){
    navigator.serviceWorker.getRegistration().then(function(reg){
      if(reg)return reg.showNotification('Rest complete',options);
      try{new Notification('Rest complete',options);}catch(e){}
    }).catch(function(){try{new Notification('Rest complete',options);}catch(e){}});
  }else{try{new Notification('Rest complete',options);}catch(e){}}
}
function finishRest(i,ei){
  if(_rest.iv){clearInterval(_rest.iv);_rest.iv=null;}
  clearRestTimerStorage();notifyRestComplete(i,ei);
  var el=document.getElementById('rest_'+i+'_'+ei);
  if(el){el.style.transition='opacity .4s';el.style.opacity='0';setTimeout(function(){hideRestTimer(i,ei);},450);}
  _rest.key=null;_rest.deadline=0;_rest.total=0;
}
function renderRestTimer(i,ei){
  if(!_rest.deadline)return;
  var c=document.getElementById('rtc_'+i+'_'+ei);
  if(!c){if(_rest.iv){clearInterval(_rest.iv);_rest.iv=null;}return;}
  var left=Math.max(0,Math.ceil((_rest.deadline-Date.now())/1000));
  var m=Math.floor(left/60),x=left%60;c.textContent=m+':'+(x<10?'0':'')+x;
  var f=document.getElementById('rtf_'+i+'_'+ei);if(f)f.style.width=Math.round(left/_rest.total*100)+'%';
  if(left<=0)finishRest(i,ei);
}
function runRestTimer(i,ei){
  if(_rest.iv){clearInterval(_rest.iv);_rest.iv=null;}
  renderRestTimer(i,ei);
  if(_rest.deadline)_rest.iv=setInterval(function(){renderRestTimer(i,ei);},500);
}
function startRest(i,ei){
  if(!restTimerEnabled())return;
  var el=document.getElementById('rest_'+i+'_'+ei);if(!el) return;
  var total=parseInt(el.getAttribute('data-rest'),10)||0;if(total<=0) return;
  if(_rest.iv){clearInterval(_rest.iv);_rest.iv=null;}
  if(_rest.key&&_rest.key!==i+'_'+ei){var prev=document.getElementById('rest_'+_rest.key);if(prev){prev.style.display='none';prev.style.opacity='1';}}
  _rest.key=i+'_'+ei;
  _rest.total=total;_rest.deadline=Date.now()+total*1000;_rest.notified=false;
  el.style.display='flex';el.style.opacity='1';
  try{localStorage.setItem(restTimerStorageKey(),JSON.stringify({key:_rest.key,deadline:_rest.deadline,total:total,i:i,ei:ei}));}catch(e){}
  requestRestAlertPermission();runRestTimer(i,ei);
}
function restoreRestTimer(){
  updateRestTimerControls();
  if(!restTimerEnabled()){clearRestTimerStorage();return;}
  var saved=null;try{saved=JSON.parse(localStorage.getItem(restTimerStorageKey())||'null');}catch(e){}
  if(!saved||!saved.deadline||saved.i==null||saved.ei==null)return;
  var el=document.getElementById('rest_'+saved.i+'_'+saved.ei);if(!el)return;
  _rest.key=saved.key||saved.i+'_'+saved.ei;_rest.deadline=Number(saved.deadline);_rest.total=Number(saved.total)||1;_rest.notified=false;
  if(_rest.deadline<=Date.now()){
    clearRestTimerStorage();
    if(Date.now()-_rest.deadline<5*60*1000)notifyRestComplete(saved.i,saved.ei);
    _rest.key=null;_rest.deadline=0;_rest.total=0;return;
  }
  el.style.display='flex';el.style.opacity='1';runRestTimer(saved.i,saved.ei);
}
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')restoreRestTimer();});
window.addEventListener('focus',restoreRestTimer);
function addSet(i,ei,rep,splitKey){
  var c=document.getElementById('sets_'+i+'_'+ei),isSL=!!document.getElementById('rL_'+i+'_'+ei+'_0'),si=0;
  c.querySelectorAll('.setrow,.setrow-single').forEach(function(existing){var parts=String(existing.id||'').split('_'),n=parseInt(parts[parts.length-1],10);if(!isNaN(n)&&n>=si)si=n+1;});
  var bonus=c.querySelectorAll('.setrow.extra,.setrow-single.extra').length+1,row=document.createElement('div');
  var draft='draftGym('+i+',\''+splitKey+'\')',complete='autoCompleteStrengthSet('+i+','+ei+','+si+')';
  var delBtn='<button class="del-set" onclick="deleteSet(this,'+i+','+ei+',\''+splitKey+'\')" title="Remove bonus set">×</button>';
  if(isSL){
    row.className='setrow-single extra';row.id='sr_'+i+'_'+ei+'_'+si;
    row.innerHTML='<div class="snum" aria-label="Bonus set '+bonus+'">B'+bonus+'</div>'
      +'<input type="number" class="sin" id="w_'+i+'_'+ei+'_'+si+'" placeholder="—" min="0" step="0.5" oninput="'+draft+'" onchange="'+complete+'" />'
      +'<input type="number" class="sin" id="rL_'+i+'_'+ei+'_'+si+'" placeholder="L" min="0" oninput="'+draft+'" onchange="'+complete+'" />'
      +'<input type="number" class="sin" id="rR_'+i+'_'+ei+'_'+si+'" placeholder="R" min="0" oninput="'+draft+'" onchange="'+complete+'" />'
      +'<button class="st" id="st_'+i+'_'+ei+'_'+si+'" aria-label="Mark bonus set '+bonus+' complete" aria-pressed="false" onclick="togSet('+i+','+ei+','+si+')"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></button>'+delBtn;
  }else{
    row.className='setrow extra';row.id='sr_'+i+'_'+ei+'_'+si;
    row.innerHTML='<div class="snum" aria-label="Bonus set '+bonus+'">B'+bonus+'</div>'
      +'<input type="number" class="sin" id="w_'+i+'_'+ei+'_'+si+'" placeholder="—" min="0" step="0.5" oninput="'+draft+'" onchange="'+complete+'" />'
      +'<input type="number" class="sin" id="r_'+i+'_'+ei+'_'+si+'" placeholder="'+rep+'" min="0" oninput="'+draft+'" onchange="'+complete+'" />'
      +'<input type="number" class="rpe-in" id="rpe_'+i+'_'+ei+'_'+si+'" placeholder="—" min="1" max="10" step="0.5" oninput="'+draft+'" />'
      +'<button class="st" id="st_'+i+'_'+ei+'_'+si+'" aria-label="Mark bonus set '+bonus+' complete" aria-pressed="false" onclick="togSet('+i+','+ei+','+si+')"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></button>'+delBtn;
  }
  c.appendChild(row);
}
function deleteSet(btn,i,ei,splitKey){var row=btn.closest('.setrow,.setrow-single');var c=row.parentElement;row.remove();c.querySelectorAll('.setrow.extra,.setrow-single.extra').forEach(function(r,idx){var sn=r.querySelector('.snum');if(sn){sn.textContent='B'+(idx+1);sn.setAttribute('aria-label','Bonus set '+(idx+1));}});draftGym(i,splitKey);}
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
  if(feelEl){feelEl.textContent=stripFeelGlyph(d.feel)||'';feelEl.style.display=d.feel?'block':'none';}
  if(notesEl){notesEl.textContent=d.notes||'';notesEl.style.display=d.notes?'block':'none';}
  var saved=document.getElementById('saved_run_'+i);
  if(saved) saved.style.display='block';
  // Keep the form visible so athletes can see their saved data for reassurance
  lockSaveButton(i,'Save session');
}
var _draftGymTimer=null;
function strengthSessionDate(i,s){
  var el=document.getElementById('gym_date_'+i);
  return (el&&el.value)||(s&&s.date)||new Date().toISOString().slice(0,10);
}
function mergeStrengthLog(previous,current,meta){
  var merged={};
  Object.keys(previous||{}).forEach(function(key){
    if(key.indexOf('__')!==0&&Array.isArray(previous[key])) merged[key]=previous[key];
  });
  Object.keys(current||{}).forEach(function(key){
    if(key.indexOf('__')===0||!Array.isArray(current[key])) return;
    var target=exerciseHistoryKey(key);
    Object.keys(merged).forEach(function(oldKey){
      if(exerciseHistoryKey(oldKey)===target&&oldKey!==key) delete merged[oldKey];
    });
    merged[key]=current[key];
  });
  Object.keys(meta||{}).forEach(function(key){
    if(meta[key]!==undefined&&meta[key]!==null&&meta[key]!=='') merged[key]=meta[key];
  });
  return merged;
}
function draftGym(i,splitKey){
  // Instant coaching feedback: recompute the recommendation, milestone, PBs,
  // volume and e1RM straight from the DOM on every keystroke (no wait for save).
  try{refreshStrengthFeedback(i,splitKey);}catch(e){}
  try{markInlinePbs(i,splitKey);}catch(e){}
  refreshStrengthExerciseStates(i);
  setGymSubmissionStatus(i,'draft');
  // Persisting to storage stays debounced so we are not writing on every keypress.
  if(_draftGymTimer) clearTimeout(_draftGymTimer);
  _draftGymTimer=setTimeout(function(){persistGymDraft(i,splitKey);},250);
}
function persistGymDraft(i,splitKey){var s=sessions[i];if(!s) return;var previous=logs[s.id]||{};var exercises=getSplit(splitKey);var current={};exercises.forEach(function(ex,ei){var arr=collectExerciseSets(i,ei,true);var useName=exPicks[ex.exercise]||ex.exercise;current[useName]=arr;});var gnEl=document.getElementById('gn_'+i);var meta={__sessionDate:strengthSessionDate(i,s),__updatedAt:new Date().toISOString()};if(gnEl)meta.__notes=gnEl.value;if(previous.__submittedAt)meta.__submittedAt=previous.__submittedAt;var log=mergeStrengthLog(previous,current,meta);logs[s.id]=log;(logs.__savedAt=Date.now(),localStorage.setItem('dp_logs_'+athlete.code,JSON.stringify(logs)));refreshStrengthFeedback(i,splitKey);refreshStrengthExerciseStates(i);setGymSubmissionStatus(i,gymDraftHasData(log)?'draft':'hidden');try{markInlinePbs(i,splitKey);}catch(e){}}

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
  try{await portalStateWrite('logs',logs);}catch(e){}
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
  stampSessionSubmitted(s.id);
  var statusResult=await markSessionDone(i);
  var queued=(noteResult&&noteResult.queued)||(statusResult&&statusResult.queued);
  showToast(queued?'Submitted - coach dashboard sync pending':'Submitted ✓');
  var banner=document.getElementById('note_saved_'+i);if(banner) banner.style.display='block';
  lockSaveButton(i,'Save');
}
// ── SESSION LOG STATE (Supabase-backed) ───────────────────────────────────────
var sessionLoggedCache={};
async function markSessionLogged(sessionId){
  var key='session_'+athlete.code+'_'+sessionId;
  sessionLoggedCache[key]=true;
  try{await portalRequest('session-log-write',{sessionKey:key});}catch(e){console.warn('session log sync failed:',e);}
}
async function loadSessionLogs(preloaded){
  try{
    var res=preloaded||await portalRequest('session-logs-read');
    if(res.rows){res.rows.forEach(function(r){sessionLoggedCache[r.session_key]=true;});}
  }catch(e){console.warn('session_logs load failed:',e);}
}
function isSessionLogged(sessionId){
  // Primary: in-memory cache (set at save time, or loaded from session_logs on login)
  if(sessionLoggedCache['session_'+athlete.code+'_'+sessionId]) return true;
  // Local fallback is an explicit submission marker. Draft autosaves must never
  // masquerade as a session that has been sent to the coaches.
  var l=logs[sessionId];
  return !!(l&&typeof l==='object'&&l.__submittedAt);
}
function stampSessionSubmitted(sessionId){
  if(!logs[sessionId]||typeof logs[sessionId]!=='object') logs[sessionId]={};
  logs[sessionId].__submittedAt=new Date().toISOString();
  logs.__savedAt=Date.now();
  localStorage.setItem('dp_logs_'+athlete.code,JSON.stringify(logs));
}
function lockSaveButton(i,label){
  var btn=document.getElementById('sb_'+i);
  if(!btn) return;
  btn.classList.add('saved');
  btn.textContent='Session Submitted ✓';
  btn.disabled=true;
  btn.style.opacity='0.7';
  btn.style.cursor='default';
}
async function saveRun(i){
  var btn=document.getElementById('sb_'+i);if(btn){if(btn.disabled) return;btn.disabled=true;btn.textContent='Saving...';}
  var s=sessions[i],d={distance:document.getElementById('rd_'+i).value||'',duration:document.getElementById('rdur_'+i).value||'',pace:document.getElementById('rp_'+i).value||'',rpe:document.getElementById('rr_'+i).value||'',feel:document.getElementById('rf_'+i).value||'',notes:document.getElementById('rn_'+i).value||''};
  logs[s.id]=d;(logs.__savedAt=Date.now(),localStorage.setItem('dp_logs_'+athlete.code,JSON.stringify(logs)));
  try{await portalStateWrite('logs',logs);}catch(e){}
  var runDateEl=document.getElementById('run_date_'+i);var runDate=runDateEl&&runDateEl.value?runDateEl.value:(s.date||new Date().toISOString().slice(0,10));
  var runCoachResult=await coachWrite(WEBHOOK,{name:athlete.name+' — '+s.name+' — '+runDate,session:s.name,type:'Run',distanceKm:d.distance,durationMin:d.duration,pace:d.pace,rpe:d.rpe,feel:d.feel,exerciseLog:'Distance: '+d.distance+'km | Duration: '+d.duration+'min | Pace: '+d.pace+' | RPE: '+d.rpe+'/10 | Feel: '+d.feel,notes:d.notes,athleteId:athlete.notionPageId,athleteName:athlete.name,athleteCode:athlete.code,date:runDate,submittedAt:new Date().toISOString()});
  await markSessionLogged(s.id);
  stampSessionSubmitted(s.id);
  var runStatusResult=await markSessionDone(i);
  showToast((runCoachResult&&runCoachResult.queued)||(runStatusResult&&runStatusResult.queued)?'Run submitted - coach dashboard sync pending':'Run submitted ✓');
  showRunSaved(i,d);
  if(runDate!==s.date)setSessionDateOverride(s.id,runDate,{silent:true});
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
function pbNormName(n){return exerciseHistoryKey(n);}
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
  // LOAD — a heavier weight is a PB at ANY rep count. Rep cap does NOT apply here:
  // lifting more than the old best load is unambiguously a load PB even for 13+ reps.
  if(loadW!=null){var best=null;
    clean.forEach(function(s){if(s.weight<minLoad&&s.rpe==null) return;if(s.weight>loadW){if(!best||s.weight>best.weight) best=s;}});
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
      row.classList.remove('has-pb');row.classList.remove('has-pb-vol');
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
      if(loadW!=null&&w>loadW){if(!bestLoad||w>bestLoad.w) bestLoad={row:row,w:w};}
      if(rW!=null&&r<=PB_REP_CAP&&w>=rW&&r>rR){if(!bestRep||r>bestRep.r) bestRep={row:row,r:r};}
      if(stored.e1rm&&r<=10){var e=pbE1rm(w,r);if(e!=null&&e>stored.e1rm.value){if(!bestE||e>bestE.e) bestE={row:row,e:e};}}
    });
    var volEl=document.getElementById('vol_'+i+'_'+ei);
    if(volEl){var isVolPB=hasHistory&&stored.volume&&vol>stored.volume.value;volEl.className='ex-stat ex-stat-vol'+(isVolPB?' pb':'');volEl.innerHTML=(isVolPB?'<svg class="icon"><use href="#i-trophy"/></svg> ':'')+'Vol '+Math.round(vol).toLocaleString()+'kg';if(isVolPB) total++;}
    // Live header PB / e1RM: when a heavier set (or stronger e1RM) is entered, the
    // header record updates instantly so the athlete SEES the new PB. Falls back to
    // the stored value the moment the entry drops below it again.
    var _trophy='<svg class="icon"><use href="#i-trophy"/></svg> ';
    var pbHeadEl=document.querySelector('#exstat_'+i+'_'+ei+' .ex-stat-pb');
    if(pbHeadEl&&loadW!=null){
      if(bestLoad){pbHeadEl.innerHTML=_trophy+'PB '+pbRound1(bestLoad.w)+'kg';pbHeadEl.classList.add('is-live-pb');}
      else{pbHeadEl.innerHTML=_trophy+'PB '+pbRound1(loadW)+'kg';pbHeadEl.classList.remove('is-live-pb');}
    }
    var e1HeadEl=document.querySelector('#exstat_'+i+'_'+ei+' .ex-stat-e1rm');
    if(e1HeadEl&&stored.e1rm){
      if(bestE){e1HeadEl.innerHTML='e1RM '+pbRound1(bestE.e)+'kg';e1HeadEl.classList.add('is-live-pb');}
      else{e1HeadEl.innerHTML='e1RM '+pbRound1(stored.e1rm.value)+'kg';e1HeadEl.classList.remove('is-live-pb');}
    }
    var plateEl=document.getElementById('plate_'+i+'_'+ei);
    if(plateEl&&maxW>0) plateEl.innerHTML=platesHtml(maxW);
    var rowsToMark=[];
    [bestLoad,bestRep,bestE].forEach(function(b){if(b){total++;if(rowsToMark.indexOf(b.row)<0) rowsToMark.push(b.row);}});
    rowsToMark.forEach(function(row){
      // Colour by PB type so weight PBs never read the same as volume/rep PBs.
      // Weight/strength family (heaviest load, or a new estimated 1RM) = purple.
      // Volume family (more reps at the same weight = more total work) = green.
      var isWeight=(bestLoad&&bestLoad.row===row)||(bestE&&bestE.row===row);
      var col=isWeight?'var(--pb)':'var(--vpb)';
      row.classList.add(isWeight?'has-pb':'has-pb-vol');
      var t=row.querySelector('button[id^="st_"]');
      if(t){t.classList.add('pb-on');t.style.background=col;t.style.borderColor=col;}
      var badge=document.createElement('div');
      badge.className='pb-badge'+(isWeight?'':' pb-badge-vol');
      badge.innerHTML='<svg class="icon"><use href="#i-trophy"/></svg> '+(isWeight?'WEIGHT PB':'VOL PB');
      row.appendChild(badge);
    });
  });
  return total;
}

async function saveGym(i,splitKey){
  var btn=document.getElementById('sb_'+i);if(btn){if(btn.disabled) return;btn.disabled=true;btn.textContent='Saving...';}
  var s=sessions[i],exercises=getSplit(splitKey),previous=logs[s.id]||{},log={};
  exercises.forEach(function(ex,ei){var sets=collectExerciseSets(i,ei,true);var useName=exPicks[ex.exercise]||ex.exercise;if(sets.length) log[useName]=sets;});
  var gnEl=document.getElementById('gn_'+i);var gymNotes=gnEl?gnEl.value:'';
  if(gymNotes) log.__notes=gymNotes;
  var gymDateEl=document.getElementById('gym_date_'+i);var gymDate=gymDateEl&&gymDateEl.value?gymDateEl.value:(s.date||new Date().toISOString().slice(0,10));
  var storedLog=mergeStrengthLog(previous,log,{__notes:gymNotes,__sessionDate:gymDate,__updatedAt:new Date().toISOString()});
  logs[s.id]=storedLog;(logs.__savedAt=Date.now(),localStorage.setItem('dp_logs_'+athlete.code,JSON.stringify(logs)));
  try{await portalStateWrite('logs',logs);}catch(e){}
  var pbHits=[];try{pbHits=detectSessionPBs(s.id,log);}catch(e){console.warn('PB detection failed:',e);}
  function setSummary(st,si){
    var reps=(st.reps!==undefined&&st.reps!==null&&st.reps!=='')?(st.reps+'reps'):'';
    if(!reps&&(st.repsLeft||st.repsRight)) reps='L '+(st.repsLeft||'—')+' / R '+(st.repsRight||'—')+' reps';
    if(!reps) reps='— reps';
    return 'Set '+(si+1)+': '+(st.weight||'—')+'kg × '+reps+(st.rpe?' @ RPE '+st.rpe:'');
  }
  var fetches=Object.keys(log).filter(function(k){return k.indexOf('__')!==0;}).map(function(exName){
    var sets=log[exName];
    var prescription=exercises.find(function(ex){return (exPicks[ex.exercise]||ex.exercise)===exName;})||null;
    var repMode=usesLeftRightReps(exName,prescription)?'left_right':'reps';
    return coachWrite(WEBHOOK,{
      name:athlete.name+' — '+exName+' — '+gymDate,session:s.name,type:'Strength',
      exerciseName:exName,repMode:repMode,
      exerciseLog:exName+': '+sets.map(setSummary).join(' | '),rawSets:sets,
      notes:gymNotes,athleteCode:athlete.code,athleteId:athlete.notionPageId,
      athleteName:athlete.name,date:gymDate,submittedAt:new Date().toISOString()
    });
  });
  var gymCoachResults=await Promise.all(fetches);
  await markSessionLogged(s.id);
  stampSessionSubmitted(s.id);
  var gymStatusResult=await markSessionDone(i);
  refreshStrengthFeedback(i,splitKey);
  refreshStrengthExerciseStates(i);
  try{markInlinePbs(i,splitKey);}catch(e){}
  var gymQueued=gymCoachResults.some(function(r){return r&&r.queued;})||(gymStatusResult&&gymStatusResult.queued);
  showToast(gymQueued?'Session submitted - coach dashboard sync pending':(pbHits.length?(pbHits.length+' new PB'+(pbHits.length>1?'s':'')+'!'):'Session submitted ✓'));
  var gymSavedBanner=document.getElementById('gym_saved_'+i);
  if(!gymSavedBanner){
    var sbBtn=document.getElementById('sb_'+i);
    if(sbBtn){gymSavedBanner=document.createElement('div');gymSavedBanner.id='gym_saved_'+i;sbBtn.parentNode.insertBefore(gymSavedBanner,sbBtn);}
  }
  setGymSubmissionStatus(i,'submitted');
  lockSaveButton(i,'Save session');
  if(gymDate!==s.date)setSessionDateOverride(s.id,gymDate,{silent:true});
}
function flashSave(i,label){var btn=document.getElementById('sb_'+i);if(btn){btn.classList.add('saved');btn.textContent='Saved ✓';btn.disabled=true;setTimeout(function(){btn.classList.remove('saved');btn.textContent=label;btn.disabled=false;},2500);}}
function showToast(msg,type){
  // type==='error': persistent until dismissed — a failed submission must
  // never vanish after 2.5s while the athlete is looking at their phone.
  var t=document.getElementById('toast');
  if(t._timer){clearTimeout(t._timer);t._timer=null;}
  var isErr=type==='error';
  t.classList.toggle('toast-error',isErr);
  if(isErr){
    t.textContent='';
    var span=document.createElement('span');span.textContent=msg;t.appendChild(span);
    var btn=document.createElement('button');btn.className='toast-dismiss';btn.textContent='Dismiss';btn.onclick=hideToast;t.appendChild(btn);
    t.style.display='flex';
  }else{
    t.textContent=msg;t.style.display='block';
    t._timer=setTimeout(hideToast,2500);
  }
}
function hideToast(){var t=document.getElementById('toast');t.style.display='none';t.classList.remove('toast-error');}

// Sliders start visually "untouched" (dimmed) and light up on first input —
// nudges athletes to actually set them instead of submitting a wall of 5s.
document.addEventListener('DOMContentLoaded',function(){
  document.querySelectorAll('input[type=range]').forEach(function(r){r.classList.add('sl-untouched');});
});
document.addEventListener('input',function(e){
  if(e.target&&e.target.type==='range')e.target.classList.remove('sl-untouched');
},true);

// ── QUICK LOG DOCK STATE ──────────────────────────────────────────────────────
// Body and nutrition are daily actions, so the dock stays pinned. To keep the
// home screen down to a single accent, only the next unlogged segment is
// filled — anything already logged today drops to a quiet done state.
function quickLogDoneToday(kind){
  try{
    if(!window.athlete||!athlete.code) return false;
    var key='dp_daily_'+(kind==='body'?'body':'nut')+'_'+athlete.code+'_'+todayISO2();
    return !!localStorage.getItem(key);
  }catch(e){return false;}
}
function syncQuickLogDock(){
  var body=document.getElementById('qlDockBody');
  var nut=document.getElementById('qlDockNut');
  if(!body||!nut) return;
  var bodyDone=quickLogDoneToday('body');
  var nutDone=quickLogDoneToday('nut');
  body.classList.toggle('is-done',bodyDone);
  nut.classList.toggle('is-done',nutDone);
  // Exactly one segment may be filled. Body leads because readiness shapes
  // how the session should be executed.
  var nextUp=bodyDone?(nutDone?null:'nut'):'body';
  body.classList.toggle('is-next',nextUp==='body');
  nut.classList.toggle('is-next',nextUp==='nut');
  var strip=document.getElementById('quicklogStrip');
  if(strip) strip.classList.toggle('all-logged',bodyDone&&nutDone);
  body.setAttribute('aria-label',bodyDone?'Daily body log, already logged today':'Daily body log, not logged yet today');
  nut.setAttribute('aria-label',nutDone?'Daily nutrition log, already logged today':'Daily nutrition log, not logged yet today');
}
document.addEventListener('DOMContentLoaded',function(){try{syncQuickLogDock();}catch(e){}});
