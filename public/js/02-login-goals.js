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

