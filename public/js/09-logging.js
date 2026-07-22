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
function persistGymDraft(i,splitKey){var s=sessions[i];if(!s) return;var previous=logs[s.id]||{};var exercises=getSplit(splitKey);var log={};exercises.forEach(function(ex,ei){var arr=collectExerciseSets(i,ei);var useName=exPicks[ex.exercise]||ex.exercise;log[useName]=arr;});var gnEl=document.getElementById('gn_'+i);if(gnEl) log.__notes=gnEl.value;if(previous.__submittedAt) log.__submittedAt=previous.__submittedAt;logs[s.id]=log;(logs.__savedAt=Date.now(),localStorage.setItem('dp_logs_'+athlete.code,JSON.stringify(logs)));refreshStrengthFeedback(i,splitKey);refreshStrengthExerciseStates(i);setGymSubmissionStatus(i,gymDraftHasData(log)?'draft':'hidden');try{markInlinePbs(i,splitKey);}catch(e){}}

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
  if(sbClient){try{await sbClient.from('athlete_data').upsert({athlete_code:athlete.code,key:'logs',value:logs,updated_at:new Date().toISOString()},{onConflict:'athlete_code,key'});}catch(e){}}
  var runDateEl=document.getElementById('run_date_'+i);var runDate=runDateEl&&runDateEl.value?runDateEl.value:(s.date||new Date().toISOString().slice(0,10));
  var runCoachResult=await coachWrite(WEBHOOK,{name:athlete.name+' — '+s.name+' — '+runDate,session:s.name,type:'Run',distanceKm:d.distance,durationMin:d.duration,pace:d.pace,rpe:d.rpe,feel:d.feel,exerciseLog:'Distance: '+d.distance+'km | Duration: '+d.duration+'min | Pace: '+d.pace+' | RPE: '+d.rpe+'/10 | Feel: '+d.feel,notes:d.notes,athleteId:athlete.notionPageId,athleteName:athlete.name,athleteCode:athlete.code,date:runDate,submittedAt:new Date().toISOString()});
  await markSessionLogged(s.id);
  stampSessionSubmitted(s.id);
  var runStatusResult=await markSessionDone(i);
  showToast((runCoachResult&&runCoachResult.queued)||(runStatusResult&&runStatusResult.queued)?'Run submitted - coach dashboard sync pending':'Run submitted ✓');
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
  var s=sessions[i],exercises=getSplit(splitKey),log={};
  exercises.forEach(function(ex,ei){var sets=collectExerciseSets(i,ei);var useName=exPicks[ex.exercise]||ex.exercise;if(sets.length) log[useName]=sets;});
  var gnEl=document.getElementById('gn_'+i);var gymNotes=gnEl?gnEl.value:'';
  if(gymNotes) log.__notes=gymNotes;
  logs[s.id]=log;(logs.__savedAt=Date.now(),localStorage.setItem('dp_logs_'+athlete.code,JSON.stringify(logs)));
  if(sbClient){try{await sbClient.from('athlete_data').upsert({athlete_code:athlete.code,key:'logs',value:logs,updated_at:new Date().toISOString()},{onConflict:'athlete_code,key'});}catch(e){}}
  var gymDateEl=document.getElementById('gym_date_'+i);var gymDate=gymDateEl&&gymDateEl.value?gymDateEl.value:(s.date||new Date().toISOString().slice(0,10));
  var pbHits=[];try{pbHits=detectSessionPBs(s.id,log);}catch(e){console.warn('PB detection failed:',e);}
  function setSummary(st,si){
    var reps=(st.reps!==undefined&&st.reps!==null&&st.reps!=='')?(st.reps+'reps'):'';
    if(!reps&&(st.repsLeft||st.repsRight)) reps='L '+(st.repsLeft||'—')+' / R '+(st.repsRight||'—')+' reps';
    if(!reps) reps='— reps';
    return 'Set '+(si+1)+': '+(st.weight||'—')+'kg × '+reps+(st.rpe?' @ RPE '+st.rpe:'');
  }
  var fetches=Object.keys(log).filter(function(k){return k.indexOf('__')!==0;}).map(function(exName){var sets=log[exName];return coachWrite(WEBHOOK,{name:athlete.name+' — '+exName+' — '+gymDate,session:s.name,type:'Strength',exerciseLog:exName+': '+sets.map(setSummary).join(' | '),rawSets:sets,notes:gymNotes,athleteCode:athlete.code,athleteId:athlete.notionPageId,athleteName:athlete.name,date:gymDate,submittedAt:new Date().toISOString()});});
  var gymCoachResults=await Promise.all(fetches);
  await markSessionLogged(s.id);
  stampSessionSubmitted(s.id);
  var gymStatusResult=await markSessionDone(i);
  refreshStrengthFeedback(i,splitKey);
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
