// ── LOAD WEEK ─────────────────────────────────────────────────────────────────
function setDisplay(id,value){var el=document.getElementById(id);if(el)el.style.display=value;}
var trainingMonthGridStart=null,trainingMonthGridEnd=null;
function isMobileTrainingCalendar(){return !!(window.matchMedia&&window.matchMedia('(max-width:760px)').matches);}
function trainingWeekDisplayLabel(){
  var wkS=sessions.find(function(s){return s.week;});
  var raw=wkS&&wkS.week;
  if(isDiscoveryWeek(raw)) return 'Discovery Week';
  var match=String(raw||'').match(/\d+/);
  if(match) return 'Week '+parseInt(match[0],10);
  var fallback=getCurrentProgrammeWeek()+weekOffset;
  fallback=Math.max(0,Math.min(programmeWeeks,fallback));
  return isDiscoveryWeek(fallback)?'Discovery Week':'Week '+fallback;
}
async function loadWeek(){
  var ws=getWS(),we=new Date(ws.getFullYear(),ws.getMonth(),ws.getDate()+6);
  var wsISO=localISO(ws),weISO=localISO(we);
  var mobileCalendar=isMobileTrainingCalendar(),fetchStart=ws,fetchEnd=we;
  var label=ws.toLocaleDateString('en-AU',{day:'numeric',month:'short'})+' – '+we.toLocaleDateString('en-AU',{day:'numeric',month:'short'});
  document.getElementById('wlabel').textContent=label;
  setDisplay('loadingEl','block');
  setDisplay('weeklyLoadingEl','block');
  setDisplay('calEl','none');setDisplay('weeklyCalEl','none');setDisplay('noplanEl','none');setDisplay('weeklyNoplanEl','none');
  var _errEl=document.getElementById('loadErrEl');if(_errEl)_errEl.style.display='none';
  var _weeklyErrEl=document.getElementById('weeklyLoadErrEl');if(_weeklyErrEl)_weeklyErrEl.style.display='none';
  if(typeof applyTrainingView==='function')applyTrainingView();
  // Run library + workout splits + plan fetch in parallel — all from Supabase
  var results;
  try{
    results=await Promise.all([
      loadRunningLibrary(),
      loadWorkoutSplits(),
      loadPlannedSessions(localISO(fetchStart),localISO(fetchEnd))
    ]);
  }catch(e){console.warn('Week load failed',e);results=[null,null,null];}
  var mapped=results[2];
  setDisplay('loadingEl','none');
  setDisplay('weeklyLoadingEl','none');
  // null = the fetch FAILED (network/Supabase error) — very different from an
  // empty week ([]). Show a retryable error, never "No sessions this week".
  if(!mapped){showLoadError();return;}
  var reschedules={};try{reschedules=JSON.parse(localStorage.getItem('dp_reschedules_'+athlete.code)||'{}');}catch(e){}
  mapped.forEach(function(s){if(reschedules[s.id]){s.date=reschedules[s.id];s.rescheduled=true;}});
  allSessions=mapped;
  sessions=allSessions.filter(function(s){return s.date&&s.date>=wsISO&&s.date<=weISO;});
  if(weekOffset===0) initPhotoNudge();
  renderTodaySection();
  var wkS=sessions.find(function(s){return s.week;});
  var outputWeek=document.getElementById('heroOutputWeek');
  if(outputWeek) outputWeek.textContent=trainingWeekDisplayLabel();
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
  if(!sessions.length&&!mobileCalendar){showNoplan();return;}
  setDisplay('noplanEl','none');setDisplay('weeklyNoplanEl','none');
  renderCal(ws);
}
function showNoplan(){
  setDisplay('noplanEl','block');setDisplay('weeklyNoplanEl','block');
  var tEl=document.getElementById('todayEl');if(tEl) tEl.style.display='none';
  setDisplay('calEl','none');setDisplay('weeklyCalEl','none');
}
function showLoadError(){
  var el=document.getElementById('loadErrEl');if(el)el.style.display='block';
  var wel=document.getElementById('weeklyLoadErrEl');if(wel)wel.style.display='block';
  var tEl=document.getElementById('todayEl');if(tEl)tEl.style.display='none';
  setDisplay('noplanEl','none');setDisplay('weeklyNoplanEl','none');setDisplay('calEl','none');setDisplay('weeklyCalEl','none');
}

// ── RENDER CALENDAR ───────────────────────────────────────────────────────────
function renderCal(ws){
  var todayISO=localISO(new Date()),we=new Date(ws.getFullYear(),ws.getMonth(),ws.getDate()+6);
  var mobileCalendar=isMobileTrainingCalendar();
  var runsThisWeek=sessions.filter(function(s){return getType(s)==='run';}).length;
  var strengthThisWeek=sessions.filter(function(s){return getType(s)==='strength';}).length;
  var weekLabel=ws.toLocaleDateString('en-AU',{day:'numeric',month:'short'})+' – '+we.toLocaleDateString('en-AU',{day:'numeric',month:'short'});
  var weekTitle=ws.toLocaleDateString('en-AU',{day:'numeric',month:'short'})+' – '+we.toLocaleDateString('en-AU',{day:'numeric',month:'short'});
  var programmeWeekLabel=trainingWeekDisplayLabel();
  var weekSummary=sessions.length+' session'+(sessions.length===1?'':'s');
  if(runsThisWeek)weekSummary+=' · '+runsThisWeek+' run'+(runsThisWeek===1?'':'s');
  if(strengthThisWeek)weekSummary+=' · '+strengthThisWeek+' gym';
  var html='<div class="week-plan-shell"><div class="week-plan-heading-copy"><div class="week-plan-kicker">Training week <span class="week-plan-number">'+esc(programmeWeekLabel)+'</span></div><div class="week-plan-title"><span class="week-plan-title-desktop">Built for the week ahead</span><span class="week-plan-title-mobile">'+esc(weekTitle)+'</span></div><div class="week-plan-subtitle"><span class="week-plan-subtitle-desktop">'+esc(weekLabel)+' · '+sessions.length+' session'+(sessions.length===1?'':'s')+' loaded</span><span class="week-plan-subtitle-mobile">'+esc(weekSummary)+'</span></div></div><div class="month-calendar-actions"><button type="button" onclick="shiftWeek(-1)" aria-label="Previous week"><svg class="icon"><use href="#i-chevron-left"/></svg></button><button type="button" class="month-today-btn" onclick="goToday()">Today</button><button type="button" onclick="shiftWeek(1)" aria-label="Next week"><svg class="icon"><use href="#i-chevron-right"/></svg></button></div><div class="week-plan-meta"><span>'+runsThisWeek+' run'+(runsThisWeek===1?'':'s')+'</span><span>'+strengthThisWeek+' strength</span></div></div>';
  // WEEK AT A GLANCE — bird's-eye strip: one tile per day, dots per session
  // type, tick when the day is fully logged. Tapping a tile jumps to that day.
  var sessionDone=function(s){return logHasRealData(logs[s.id])||s.status==='Completed'||ticked[s.id];};
  if(mobileCalendar){
    trainingMonthGridStart=ws;trainingMonthGridEnd=we;
    html+='<div class="mobile-week-agenda" role="grid" aria-label="'+esc(weekTitle)+' training week">';
    for(var mdi=0;mdi<7;mdi++){
      var cellDate=new Date(ws.getFullYear(),ws.getMonth(),ws.getDate()+mdi),miso=localISO(cellDate),isToday=miso===todayISO;
      var rawDaySessions=allSessions.filter(function(s){return s.date===miso;}),hasRecoveryOnly=rawDaySessions.length>0&&rawDaySessions.every(isCalendarPlaceholder);
      var daySessions=sortSessionsForDisplay(rawDaySessions.filter(function(s){return !isCalendarPlaceholder(s);}));
      var dayDone=daySessions.length>0&&daySessions.every(sessionDone),dayMissed=daySessions.length>0&&miso<todayISO&&!dayDone,labels='';
      daySessions.slice(0,2).forEach(function(s,si){
        var timing=daySessions.length>1?(si===0?'AM':'PM'):'';
        labels+='<span class="mobile-week-session '+getType(s)+(s.rescheduled?' rescheduled':'')+'">'+(timing?'<b class="mobile-week-time">'+timing+'</b>':'')+'<span><strong>'+esc(s.name||monthSessionLabel(s))+'</strong><small>'+esc(monthSessionDetail(s))+'</small></span>'+(calendarSessionIsKey(s)?'<i class="mobile-week-key" aria-label="Key session">★</i>':'')+'</span>';
      });
      if(daySessions.length>2)labels+='<span class="mobile-week-more">+'+(daySessions.length-2)+' more</span>';
      if(!daySessions.length)labels='<span class="mobile-week-rest">'+(hasRecoveryOnly?'Recovery day':'No session planned')+'</span>';
      var aria=cellDate.toLocaleDateString('en-AU',{weekday:'long',day:'numeric',month:'long'})+', '+(daySessions.length?(daySessions.length+' session'+(daySessions.length===1?'':'s')+': '+daySessions.map(function(s){return s.name||wgShortLabel(s);}).join(', ')):'no sessions');
      html+='<button type="button" role="gridcell" class="mobile-week-day'+(isToday?' today':'')+(daySessions.length?' has-sessions':'')+(dayDone?' done':'')+(dayMissed?' missed':'')+'" data-date="'+miso+'"'+(isToday?' aria-current="date"':'')+' onclick="openDayPlanDate(\''+miso+'\',this)" aria-label="'+esc(aria)+'"><span class="mobile-week-date"><small>'+cellDate.toLocaleDateString('en-AU',{weekday:'short'})+'</small><strong>'+cellDate.getDate()+'</strong>'+(isToday?'<em>Today</em>':'')+'</span><span class="mobile-week-sessions">'+labels+'</span><span class="mobile-week-status">'+(dayDone?'✓':dayMissed?'!':'›')+'</span></button>';
    }
    html+='</div>';
  }else{
    html+='<div class="week-glance">';
    for(var gi=0;gi<7;gi++){
      var gd=new Date(ws.getFullYear(),ws.getMonth(),ws.getDate()+gi);
      var giso=localISO(gd),gToday=giso===todayISO;
      var gs=sortSessionsForDisplay(sessions.filter(function(s){return s.date===giso;}));
      var real=gs.filter(function(s){return getType(s)!=='rest';});
      var allDone=real.length>0&&real.every(sessionDone);
      var labs='';
      if(!real.length){labs='<span class="wg-lab rest">Rest</span>';}
      else{
        real.slice(0,2).forEach(function(s){labs+='<span class="wg-lab '+getType(s)+'">'+esc(wgShortLabel(s))+'</span>';});
        if(real.length>2)labs+='<span class="wg-lab more">+'+(real.length-2)+'</span>';
      }
      html+='<button type="button" class="wg-day'+(gToday?' today':'')+(allDone?' done':'')+(real.length?' has-events':'')+'" data-day-index="'+gi+'" onclick="selectWeekDay('+gi+',this)" aria-label="'+DAYS[gi]+' '+gd.getDate()+', '+(real.length?(real.length+' session'+(real.length===1?'':'s')):'rest day')+'"><span class="wg-name">'+DAYS[gi]+'</span><span class="wg-date">'+gd.getDate()+'</span><span class="wg-labs">'+labs+'</span><span class="wg-done">'+(allDone?'✓':'')+'</span></button>';
    }
    html+='</div>';
    for(var di=0;di<7;di++){
      var d=new Date(ws.getFullYear(),ws.getMonth(),ws.getDate()+di);
      var iso=localISO(d),isToday=iso===todayISO;
      var dayLabel=d.toLocaleDateString('en-AU',{day:'numeric',month:'short'});
      var daySessions=sortSessionsForDisplay(sessions.filter(function(s){return s.date===iso;}));
      html+='<div class="dg" id="dg_'+di+'"><div class="dgh'+(isToday?' today':'')+'"><span class="dgname">'+DAYS[di]+'</span><span class="dgdate">'+dayLabel+'</span>'+(isToday?'<span class="todaybadge">Today</span>':'')+'</div>';
      if(!daySessions.length){html+='<div class="restday">Rest</div>';}
      else{daySessions.forEach(function(s){var i=sessions.indexOf(s);html+=buildCard(s,i);});}
      html+='</div>';
    }
  }
  var el=document.getElementById('calEl');if(el){el.innerHTML=html;el.style.display='block';}
  var wel=document.getElementById('weeklyCalEl');if(wel){wel.innerHTML=html;wel.style.display='block';}
  if(typeof applyTrainingView==='function')applyTrainingView();
}
function selectWeekDay(di,trigger){
  if(isMobileTrainingCalendar()){
    var ws=getWS(),d=new Date(ws.getFullYear(),ws.getMonth(),ws.getDate()+di);openDayPlanDate(localISO(d),trigger);return;
  }
  scrollToDay(di);
}
function scrollToDay(di){
  var el=document.getElementById('dg_'+di);
  if(el)el.scrollIntoView({behavior:'smooth',block:'start'});
}
var dayPlanDateISO=null,dayPlanReturnFocus=null;
function ensureDayPlanOverlay(){
  var ov=document.getElementById('dayPlanOverlay');
  if(ov)return ov;
  ov=document.createElement('section');ov.id='dayPlanOverlay';ov.className='day-plan-overlay';ov.setAttribute('aria-hidden','true');ov.setAttribute('aria-labelledby','dayPlanTitle');
  ov.setAttribute('onclick','dayPlanBackdropClick(event)');
  ov.innerHTML='<div class="day-plan-dialog" role="dialog" aria-modal="true" aria-labelledby="dayPlanTitle"><div class="day-plan-topbar"><div class="day-plan-pager"><button type="button" id="dayPlanPrev" onclick="shiftDayPlan(-1)" aria-label="Previous day"><svg class="icon"><use href="#i-chevron-left"/></svg></button><button type="button" id="dayPlanNext" onclick="shiftDayPlan(1)" aria-label="Next day"><svg class="icon"><use href="#i-chevron-right"/></svg></button></div><button type="button" class="day-plan-close" onclick="closeDayPlan()" aria-label="Close day plan">&times;</button></div><div class="day-plan-heading"><div class="day-plan-kicker" id="dayPlanDate"></div><h2 id="dayPlanTitle">Day plan</h2><div class="day-plan-meta" id="dayPlanMeta"></div></div><div class="day-plan-scroll" id="dayPlanContent"></div></div>';
  document.body.appendChild(ov);return ov;
}
function dayPlanBackdropClick(event){if(event&&event.target===event.currentTarget)closeDayPlan();}
function interactiveSessionIndex(s){
  var existing=sessions.findIndex(function(item){return item.id===s.id;});if(existing>-1)return existing;
  var allIndex=allSessions.findIndex(function(item){return item.id===s.id;}),index=-(allIndex+1||1);sessions[index]=s;return index;
}
function renderDayPlanDate(iso){
  var ov=ensureDayPlanOverlay(),d=localDateFromISO(iso);
  var daySessions=sortSessionsForDisplay(allSessions.filter(function(s){return s.date===iso&&!isCalendarPlaceholder(s);}));
  dayPlanDateISO=iso;
  document.getElementById('dayPlanDate').textContent=d.toLocaleDateString('en-AU',{day:'numeric',month:'long',year:'numeric'});
  document.getElementById('dayPlanTitle').textContent=d.toLocaleDateString('en-AU',{weekday:'long'});
  document.getElementById('dayPlanMeta').textContent=daySessions.length?(daySessions.length+' session'+(daySessions.length===1?'':'s')+' planned'):'Recovery day';
  var content=document.getElementById('dayPlanContent'),html='';
  if(daySessions.length){
    daySessions.forEach(function(s){html+=buildCard(s,interactiveSessionIndex(s));});
  }else{
    html='<div class="day-plan-rest"><span class="day-plan-rest-mark">Rest</span><h3>Recovery is part of the plan.</h3><p>Keep the day easy, stay on top of nutrition and arrive ready for the next session.</p></div>';
  }
  content.innerHTML=html;
  daySessions.forEach(function(s){var body=document.getElementById('scb_'+interactiveSessionIndex(s));if(body)body.classList.add('open');});
  var prev=document.getElementById('dayPlanPrev'),next=document.getElementById('dayPlanNext');if(prev)prev.disabled=!!(trainingMonthGridStart&&d<=trainingMonthGridStart);if(next)next.disabled=!!(trainingMonthGridEnd&&d>=trainingMonthGridEnd);
  document.querySelectorAll('.month-day,.mobile-week-day').forEach(function(day){var selected=day.dataset.date===iso;day.classList.toggle('selected',selected);day.setAttribute('aria-pressed',selected?'true':'false');});
  content.scrollTop=0;return ov;
}
function openDayPlanDate(iso,trigger){
  dayPlanReturnFocus=trigger||document.activeElement;var ov=renderDayPlanDate(iso);
  document.body.classList.add('day-plan-open');ov.setAttribute('aria-hidden','false');void ov.offsetHeight;ov.classList.add('open');
  var close=ov.querySelector('.day-plan-close');if(close)setTimeout(function(){close.focus();},80);
}
function shiftDayPlan(delta){if(!dayPlanDateISO)return;var d=localDateFromISO(dayPlanDateISO);d.setDate(d.getDate()+(Number(delta)||0));renderDayPlanDate(localISO(d));}
function closeDayPlan(){
  var ov=document.getElementById('dayPlanOverlay');if(!ov)return;if(focusedSessionIndex!=null)closeFocusedSession();
  ov.classList.remove('open');ov.setAttribute('aria-hidden','true');document.body.classList.remove('day-plan-open');dayPlanDateISO=null;
  var content=document.getElementById('dayPlanContent');if(content)setTimeout(function(){if(!ov.classList.contains('open'))content.innerHTML='';},240);
  if(dayPlanReturnFocus&&typeof dayPlanReturnFocus.focus==='function')dayPlanReturnFocus.focus();dayPlanReturnFocus=null;
}
// Short label for the glance tiles: "Upper"/"Lower" for gym, the run flavour
// ("Tempo", "Long Run") for runs. Falls back to the generic type.
function monthSessionLabel(s){
  var type=getType(s),name=String(s.name||'').trim(),match;
  if(type==='strength'){
    match=name.match(/\b(upper|lower)\s*([a-z0-9]+)?/i);
    if(match)return match[1].charAt(0).toUpperCase()+match[1].slice(1).toLowerCase()+(match[2]?' '+match[2].toUpperCase():'');
  }
  return wgShortLabel(s)||name||'Session';
}
function isCalendarPlaceholder(s){
  var name=String((s&&s.name)||'').trim().toLowerCase(),type=getType(s||{});
  return type==='rest'||/^(free|free day|rest|rest day|open|open day|recovery day)$/.test(name);
}
function calendarRunDistance(s){
  if(getType(s)!=='run')return 0;
  var resolved=resolveRunDisplay(s),meta=resolved.meta||{},raw=meta.distance||((_sessionOverrides[s.id]||{}).distance_km)||'';
  var value=parseFloat(String(raw).replace(',','.'));return isNaN(value)?0:value;
}
function monthSessionDetail(s){
  var type=getType(s);
  if(type==='run'){
    var resolved=resolveRunDisplay(s),meta=resolved.meta||{},distance=meta.distance||'',duration=meta.duration||'',intensity=meta.intensity||s.intensity||'';
    if(distance)return String(distance).replace(/\s+/g,'');
    if(duration){var dur=String(duration);return /^\d+$/.test(dur)?dur+' min':dur;}
    if(intensity)return intensity;
    return 'Run session';
  }
  if(type==='strength'){
    var splitKey=GYM_KEYS.find(function(k){return String(s.name||'').toLowerCase().indexOf(String(k).toLowerCase())>=0;});
    var exercises=splitKey?getSplit(splitKey):[];
    return exercises.length?exercises.length+' exercises':(s.intensity||'Strength');
  }
  return s.intensity||'Optional';
}
function calendarSessionIsKey(s){
  if(getType(s)!=='run')return /\bkey\b/i.test(String(s.name||''));
  var text=(String(s.name||'')+' '+String(s.intensity||'')).toLowerCase();
  return /\bkey\b|tempo|threshold|interval|speed|track|race|long run|hill/.test(text)&&!/easy|recovery/.test(text);
}
function wgShortLabel(s){
  var t=getType(s),n=String(s.name||'').toLowerCase();
  if(t==='strength'){
    if(n.indexOf('upper')>-1)return 'Upper';
    if(n.indexOf('lower')>-1)return 'Lower';
    if(n.indexOf('full')>-1)return 'Full Body';
    if(n.indexOf('push')>-1)return 'Push';
    if(n.indexOf('pull')>-1)return 'Pull';
    if(n.indexOf('leg')>-1)return 'Legs';
    return 'Gym';
  }
  if(t==='run'){
    if(n.indexOf('long')>-1)return 'Long Run';
    if(n.indexOf('tempo')>-1)return 'Tempo';
    if(n.indexOf('interval')>-1||n.indexOf('speed')>-1||n.indexOf('track')>-1||n.indexOf('rep')>-1)return 'Speed';
    if(n.indexOf('hill')>-1)return 'Hills';
    if(n.indexOf('easy')>-1)return 'Easy Run';
    if(n.indexOf('recovery')>-1)return 'Recovery';
    if(n.indexOf('race')>-1||n.indexOf('parkrun')>-1)return 'Race';
    return 'Run';
  }
  if(t==='note')return 'Free';
  return '';
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
  var weightLabel='Open progress';
  if(data.weights&&data.weights.length>=2){
    var delta=data.weights[data.weights.length-1].weight-data.weights[0].weight;
    weightLabel=(delta>0?'+':'')+delta.toFixed(1)+'kg across recent logs';
  }
  return '<div class="insight-rail" aria-label="This week at a glance">'+
    '<button type="button" class="insight-card insight-card-button" onclick="openWeeklySummary()" aria-label="View weekly compliance summary"><div class="insight-ring" style="--value:'+data.compliance+'"><strong>'+data.compliance+'%</strong></div><div><span>Session completion</span><small>'+data.completed+' of '+data.planned+' planned done</small></div></button>'+
    '<button type="button" class="insight-card insight-card-button" onclick="openQuickLog(\'body\')" aria-label="'+(data.readiness==null?'Log today’s readiness':'Review today’s readiness')+'"><div class="insight-ring readiness" style="--value:'+readinessPct+'"><strong>'+readiness+'</strong></div><div><span>Readiness</span><small>'+(data.readiness==null?'Log your body check':'Body log already captured')+'</small></div></button>'+
    '<button type="button" class="insight-card insight-card-button bodyweight" onclick="switchTab(\'progress\')" aria-label="View bodyweight progress"><div class="insight-viz">'+miniSparkline(data.weights)+'</div><div><span>Bodyweight trend</span><small>'+esc(weightLabel)+'</small></div></button>'+
    '<button type="button" class="insight-card insight-card-button" onclick="openPbHistory()" aria-label="View personal best history"><div class="insight-pb"><svg class="icon"><use href="#i-trophy"/></svg><strong>'+data.pbs+'</strong></div><div><span>Personal bests</span><small>Review your strength history</small></div></button>'+
  '</div>';
}
function renderCommandStatus(data){
  var kmPct=data.kmTarget?Math.min(100,Math.round(data.kmDone/data.kmTarget*100)):0;
  var nextText='No upcoming session';
  if(data.next){var nd=localDateFromISO(data.next.date);nextText=nd.toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'})+' · '+(data.next.name||'Session');}
  var html='<div class="command-status-grid">';
  html+='<button class="command-status" onclick="switchTab(\'checkin\')"><span class="command-status-icon '+(data.checkinDone?'done':'')+'"><svg class="icon"><use href="#i-clipboard"/></svg></span><span><small>Check-in status</small><strong>'+(data.checkinDone?'Locked in for the week':'Still waiting on your check-in')+'</strong></span></button>';
  html+='<button class="command-status" onclick="switchTab(\'nutrition\')" aria-label="View weekly kilometre details"><span class="command-status-icon"><svg class="icon"><use href="#i-run"/></svg></span><span><small>Run volume</small><strong>'+(data.kmTarget?(data.kmDone.toFixed(1).replace(/\.0$/,'')+' / '+data.kmTarget.toFixed(1).replace(/\.0$/,'')+' km'):'Target loading')+'</strong><i><b style="width:'+kmPct+'%"></b></i></span></button>';
  html+='<button class="command-status next-session" onclick="goTrainingPlan()"><span class="command-status-icon"><svg class="icon"><use href="#i-calendar"/></svg></span><span><small>Next key session</small><strong>'+esc(nextText)+'</strong></span></button>';
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
  var label=todaySessions.length?'Coach cue for today':'Coach cue';
  return '<div class="coach-moment"><div class="coach-avatars"><span>K</span><span>A</span></div><div><div class="coach-moment-topline"><div class="coach-moment-label">'+label+'</div><div class="coach-moment-tag">Dual Performance</div></div><p>'+esc(note)+'</p></div><button onclick="switchTab(\'comms\')" aria-label="Contact your coaches"><svg class="icon"><use href="#i-chat"/></svg></button></div>';
}

function syncHeroShell(insights,todaySessions){
  var support=document.getElementById('heroSupport');
  if(support){
    if(todaySessions.length){
      var primary=(todaySessions[0]&&todaySessions[0].name)||'today\'s session';
      support.textContent='Today centers on '+primary+'. Open the brief, execute cleanly, and let the week build around it.';
    }else{
      support.textContent='Recovery day. Stay ahead of the week, lock in the admin that matters, and be ready for the next key session.';
    }
  }
  var compliance=document.getElementById('heroStatCompliance');
  if(compliance) compliance.textContent=(insights&&insights.compliance!=null)?(insights.compliance+'%'):'—';
  var complianceBar=document.getElementById('heroStatComplianceBar');
  if(complianceBar)complianceBar.style.width=((insights&&insights.compliance)||0)+'%';
  var complianceNote=document.getElementById('heroStatComplianceNote');
  if(complianceNote){
    complianceNote.textContent=insights&&insights.planned?(insights.completed+'/'+insights.planned+' complete · '+(insights.completed>=insights.planned?'week done':'underway')):'No sessions planned';
  }
  var complianceCard=document.getElementById('heroComplianceCard');
  if(complianceCard&&insights)complianceCard.setAttribute('aria-label','Open weekly completion summary. '+insights.completed+' of '+insights.planned+' planned sessions complete.');
  var readiness=document.getElementById('heroStatReadiness');
  if(readiness) readiness.textContent=(insights&&insights.readiness!=null)?String(insights.readiness):'—';
  var readinessPct=(insights&&insights.readiness!=null)?Math.max(0,Math.min(100,insights.readiness)):0;
  var readinessRing=document.getElementById('heroReadinessRing');
  if(readinessRing)readinessRing.style.setProperty('--value',readinessPct);
  var readinessNote=document.getElementById('heroStatReadinessNote');
  var readinessText=readinessPct>=80?'Ready to go':readinessPct>=65?'Good to train':readinessPct>=50?'Train with awareness':readinessPct>0?'Recovery first':'Log body check';
  if(readinessNote)readinessNote.textContent=readinessText;
  var readinessCard=document.getElementById('heroReadinessCard');
  if(readinessCard)readinessCard.setAttribute('aria-label',(readinessPct?'Review readiness '+readinessPct+' out of 100. ':'Log today’s readiness. ')+readinessText+'.');
  var pbs=document.getElementById('heroStatPbs');
  if(pbs) pbs.textContent=(insights&&insights.pbs!=null)?String(insights.pbs):'—';
  var pbsCard=document.getElementById('heroPbsCard');
  if(pbsCard&&insights)pbsCard.setAttribute('aria-label','Open all personal bests. '+insights.pbs+' exercises tracked.');
}

function renderTodaySection(){
  var el=document.getElementById('todayEl');if(!el) return;
  var todayISO=localISO(new Date());
  var todaySessions=sortSessionsForDisplay(allSessions.filter(function(s){return s.date===todayISO;}));
  var label=new Date().toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'});
  var insights=getHomeInsights();
  syncHeroShell(insights,todaySessions);
  var title=todaySessions.length?'Today\'s command center':'Recovery command center';
  var subtitle=todaySessions.length?'See the brief, execute cleanly, and log what you actually complete.':'No session scheduled today. Use the space to recover well and stay ahead of the week.';
  var html='<div class="todaypanel"><div class="today-mobile-heading"><span>Today&rsquo;s session</span><small>'+esc(label)+'</small></div><div class="todayeyebrow">Today plan</div><div class="todayhead"><div><div class="todaytitle">'+title+'</div><div class="today-subtitle">'+subtitle+'</div></div><div class="todaydate">'+esc(label)+'</div></div>';
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
          html+='<div class="todaytarget"><div class="label">Primary target</div><div class="value">'+esc(targetValue)+'</div>';
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
        html+='<div class="todaytarget"><div class="label">Primary target</div><div class="value">'+esc(displayName)+'</div><div class="desc">Use your previous efforts as a guide, then log what you actually complete today.</div><div class="session-why"><svg class="icon"><use href="#i-bulb"/></svg><div><span>Why it matters</span>Build durable strength that supports running economy, resilience and confident progression.</div></div></div>';
      }else if(type==='note'){
        var _noteInstr=s.runDetails||(_sessionOverrides[s.id]&&_sessionOverrides[s.id].notes)||'Train as you normally would and log what you did.';
        html+='<div class="todaytarget"><div class="label">Discovery week</div><div class="value">'+esc(displayName)+'</div><div class="desc">'+esc(_noteInstr)+'</div></div>';
      }else{
        html+='<div class="todaytarget"><div class="label">Recovery</div><div class="value">Rest day</div><div class="desc">Recovery is part of the programme. Use today to reset and be ready for the next session.</div></div>';
      }
      if(type!=='rest'&&sessionIdx>=0){
        html+='<button type="button" class="today-action primary" onclick="startFocusedSession('+sessionIdx+')" style="width:100%;margin-top:12px">Open session <svg class="icon"><use href="#i-arrow-right"/></svg></button>';
      }
      html+='</div></div></div>';
    });
    html+='</div>';
  }
  html+='</div>';
  el.innerHTML=html;
  el.style.display='block';
  if(typeof applyTrainingView==='function')applyTrainingView();
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
// Effective reps for a set: bilateral uses `reps`, unilateral (single-leg/arm)
// stores `repsLeft`/`repsRight` — use the weaker side so both sides must earn the
// progression. Without this, single-leg sets read as 0 reps and never progress load.
function _effReps(s){if(!s) return 0;var l=parseInt(s.repsLeft,10),r=parseInt(s.repsRight,10);if(!isNaN(l)||!isNaN(r)) return Math.min(isNaN(l)?Infinity:l,isNaN(r)?Infinity:r);return parseInt(s.reps,10)||0;}
// Equipment-aware load increment (kg to add). Keeps bumps sane per equipment
// instead of a flat percentage that adds trivial amounts on light/machine lifts.
function _ovStep(name,load){var n=String(name||'').toLowerCase();
  if(/bodyweight|push[- ]?up|pull[- ]?up|chin[- ]?up|\bdip\b|plank/.test(n)) return 0;
  if(/lateral raise|face pull|rear delt|reverse fly|\bfly\b|\bcurl\b|tricep|pushdown|calf|cuff|rotator/.test(n)) return 1;
  var barbell=/\bsquat\b|deadlift|\brdl\b|romanian|bench press|barbell|overhead press|\bohp\b|hip thrust|\bpress\b/.test(n);
  var notBar=/machine|cable|smith|dumbbell|\bdb\b|goblet|kettlebell|band|bodyweight|leg press/.test(n);
  if(barbell&&!notBar) return 2.5;
  if(/dumbbell|\bdb\b|goblet|kettlebell/.test(n)) return 2;
  if(/machine|cable|smith|leg press|pulldown|pec deck|extension|hamstring curl|leg curl/.test(n)) return 2.5;
  return Math.max(1,Math.round(load*0.025*2)/2);}
function getProgressionFeedback(ex,prevEffort,currentEffort){
  var prevWorking=getWorkingSlice(ex,prevEffort||[]);var currentWorking=getWorkingSlice(ex,currentEffort||[]);
  if(!currentWorking.length) return{tone:'dim',text:(ex.repRange?'Target '+ex.repRange:'Build this session')};
  var topRep=getTopRep(ex);
  var currentWeights=currentWorking.map(function(s){return getNumeric(s.weight);}).filter(function(v){return v!=null;});
  var prevWeights=prevWorking.map(function(s){return getNumeric(s.weight);}).filter(function(v){return v!=null;});
  var currentLoad=currentWeights.length?Math.max.apply(null,currentWeights):null;
  var prevLoad=prevWeights.length?Math.max.apply(null,prevWeights):null;
  var currentTotal=currentWorking.reduce(function(a,s){return a+_effReps(s);},0);
  var prevTotal=prevWorking.reduce(function(a,s){return a+_effReps(s);},0);
  var allAtTop=currentWorking.length&&currentWorking.every(function(s){return _effReps(s)>=topRep;});
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

function computeOverload(ex,prevEffort,resolvedName){
  var name=resolvedName||ex.exercise||'';
  var low=parseInt(String(ex.repRange||ex.reps||'').split('-')[0],10)||0;
  var top=getTopRep(ex);
  var r={stateCls:'',whyCls:'',chipCls:'hold',arrow:'',chipText:'',why:'',ladder:'',tip:''};
  if(!prevEffort||!prevEffort.length){
    r.chipText='Set base';
    r.why='First time. Find your weight.';
    r.tip=_ovTip('Pick a weight you control for '+(low||8)+' clean reps with 2 to 3 tough ones left. Form first, numbers after.');
    return r;
  }
  var working=getWorkingSlice(ex,prevEffort);
  var loads=working.map(function(s){return parseFloat(s.weight);}).filter(function(n){return !isNaN(n)&&n>0;});
  var maxLoad=loads.length?Math.max.apply(null,loads):null;
  var reps=working.map(_effReps);
  var allTop=working.length&&reps.every(function(v){return v>=top;});
  if(maxLoad!=null&&allTop){
    var step=_ovStep(name,maxLoad);
    var sug=step>0?Math.round((maxLoad+step)*2)/2:maxLoad; if(step>0&&sug<=maxLoad) sug=maxLoad+step;
    r.stateCls=' exc-go'; r.chipCls='go'; r.arrow='↗';
    r.chipText=sug+'kg'; r.whyCls='go';
    r.why='Maxed reps at '+maxLoad+'kg. Level up.';
    r.ladder=_ovLadder([['Own reps','done'],['Add load','active'],['New base','upcoming']]);
    r.tip=_ovTip('New weight, so reps reset to '+(low||8)+'. Build back to '+top+', then go up again.');
    return r;
  }
  r.chipCls='hold'; r.arrow='→';
  r.chipText=(maxLoad!=null?maxLoad+'kg':'Log it');
  r.why='Hold '+(maxLoad!=null?maxLoad+'kg':'weight')+', add a rep.';
  r.ladder=_ovLadder([['Own reps','active'],['Add load','upcoming'],['New base','upcoming']]);
  r.tip=_ovTip('Same weight today. Squeeze one more rep per set. Hit '+top+' on every set to earn a load bump.');
  return r;
}
function _ovLadder(steps){var h='<div class="exc-ladder">';steps.forEach(function(s){h+='<div class="exc-rung '+s[1]+'">'+(s[1].indexOf('done')>-1?'<span class="exc-rk">✓</span>':'')+'<span class="exc-rt">'+s[0]+'</span></div>';});return h+'</div>';}
function _ovTip(t){return '<div class="exc-tip"><span class="exc-tip-i">☀</span><span>'+t+'</span></div>';}
function strengthExerciseHasData(card){
  if(!card) return false;
  var inputs=card.querySelectorAll('.exsets input');
  for(var x=0;x<inputs.length;x++){if(String(inputs[x].value||'').trim()!=='') return true;}
  return !!card.querySelector('.st.on,.st.pb-on');
}
function strengthExerciseIsComplete(card){
  if(!card) return false;
  var rows=card.querySelectorAll('.setrow,.setrow-single');
  if(!rows.length) return false;
  for(var x=0;x<rows.length;x++){
    var row=rows[x],tick=row.querySelector('.st'),weight=row.querySelector('input[id^="w_"]');
    var left=row.querySelector('input[id^="rL_"]'),right=row.querySelector('input[id^="rR_"]'),reps=row.querySelector('input[id^="r_"]');
    var hasWork=weight&&String(weight.value||'').trim()!==''&&(
      (left&&right&&String(left.value||'').trim()!==''&&String(right.value||'').trim()!=='')||
      (reps&&String(reps.value||'').trim()!=='')
    );
    if(!hasWork||!tick||!tick.classList.contains('on')) return false;
  }
  return true;
}
function refreshStrengthExerciseState(card){
  if(!card) return;
  var hasData=strengthExerciseHasData(card),complete=strengthExerciseIsComplete(card);
  card.classList.toggle('has-entry',hasData);
  card.classList.toggle('exercise-complete',complete);
  var pill=card.querySelector('.exc-entry-pill');
  if(pill){pill.textContent=complete?'✓ Done':'In progress';pill.setAttribute('aria-label',complete?'Exercise complete':'Exercise has unsaved entries');}
}
function refreshStrengthExerciseStates(i){
  document.querySelectorAll('.exc[data-session-index="'+i+'"]').forEach(refreshStrengthExerciseState);
}
function toggleExc(el){
  var c=el&&el.closest?el.closest('.exc'):null;
  if(!c) return;
  c.classList.toggle('open');
  refreshStrengthExerciseState(c);
}
function gymDraftHasData(log){
  if(!log||typeof log!=='object') return false;
  if(String(log.__notes||'').trim()) return true;
  return Object.keys(log).some(function(k){return k.indexOf('__')!==0&&Array.isArray(log[k])&&log[k].length;});
}
function setGymSubmissionStatus(i,state){
  var status=document.getElementById('gym_saved_'+i);if(!status) return;
  if(state==='hidden'){status.style.display='none';return;}
  status.style.display='flex';
  status.className='session-submit-status '+(state==='submitted'?'is-submitted':'is-draft');
  status.innerHTML=state==='submitted'
    ?'<span class="submit-status-icon">✓</span><span><strong>Session submitted</strong><small>Your coaches can now review this data.</small></span>'
    :'<span class="submit-status-icon">•••</span><span><strong>Draft saved on this device</strong><small>Press Save session below to submit it to your coaches.</small></span>';
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
    var hasSaved=isSessionLogged(s.id);
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
    h+='<div class="run-prescription-card" style="background:linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.015)), var(--surface);border:1px solid var(--border-mid);border-radius:10px;overflow:hidden;box-shadow:inset 0 1px 0 rgba(255,255,255,.03)">';

    // Header — session title + RPE + zone
    h+='<div class="run-prescription-head" style="padding:14px 16px;border-bottom:1px solid var(--border);background:rgba(255,255,255,.015)">';
    h+='<div class="run-prescription-title" style="font-family:var(--display);font-size:22px;font-weight:800;text-transform:uppercase;letter-spacing:.02em;color:var(--text);line-height:1.1;margin-bottom:8px">'+esc(sessionTitle)+'</div>';
    h+='<div class="run-prescription-badges" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">';
    h+='<div style="font-family:var(--mono);font-size:11px;font-weight:700;color:#fff;background:var(--run);padding:3px 9px;border-radius:5px;letter-spacing:.04em;white-space:nowrap">'+esc(rpeInfo.value)+'</div>';
    h+='<div style="font-family:var(--mono);font-size:11px;font-weight:700;color:'+zone.color+';background:'+zone.bg+';padding:3px 9px;border-radius:5px;letter-spacing:.04em;white-space:nowrap">'+esc(zone.label)+'</div>';
    h+='<div style="font-size:12px;color:var(--muted);line-height:1.4">'+esc(rpeInfo.desc)+'</div>';
    h+='</div></div>';

    // Body
    h+='<div class="run-prescription-body" style="padding:14px 16px;display:flex;flex-direction:column;gap:12px;background:rgba(255,255,255,.01)">';

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
      h+='<div class="run-prescription-table" style="border:1px solid var(--border-mid);border-radius:8px;overflow:hidden;background:rgba(255,255,255,.02)">';
      _ovRows.forEach(function(row,ri){
        var borderB=ri<_ovRows.length-1?'border-bottom:1px solid var(--border);':'';
        h+='<div class="run-prescription-row" style="display:grid;grid-template-columns:80px 1fr;align-items:baseline;gap:8px;padding:9px 12px;'+borderB+'">';
        h+='<span style="font-family:var(--mono);font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:'+(row.accent?'var(--run)':'var(--muted)')+';font-weight:'+(row.accent?'700':'400')+';padding-top:1px">'+row.label+'</span>';
        h+='<span style="font-size:14px;font-weight:'+(row.accent?'700':'500')+';color:var(--text);line-height:1.4">'+esc(row.val)+'</span>';
        h+='</div>';
      });
      h+='</div>';
      if(_ov.notes){
        h+='<div class="run-coach-note" style="background:rgba(146,210,237,.07);border:1px solid rgba(146,210,237,.18);border-radius:7px;padding:10px 13px">';
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
    h+='<div class="run-alternative" style="border-top:1px solid var(--border);padding-top:10px;margin-top:-2px">';
    h+='<div style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:4px">Alternative</div>';
    h+='<div style="font-size:13px;font-weight:700;color:var(--run);margin-bottom:3px">'+esc(altInfo.title)+'</div>';
    h+='<div style="font-size:12px;color:var(--muted);line-height:1.45">'+esc(altInfo.description)+'</div>';
    h+='</div>';

    h+='</div></div>'; // end body + card
    h+='<div class="run-log">';
    h+='<div id="saved_run_'+i+'" class="saved-data" style="display:'+(hasSaved?'block':'none')+';">';
    h+='<div class="saved-label">✓ Session submitted to your coaches</div>';
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
        var _ov=computeOverload(ex,prevEffort,resolvedEx);
        var hasExerciseData=!!savedEx.length;
        var exerciseIsComplete=hasExerciseData&&savedEx.length>=sets&&savedEx.slice(0,sets).every(function(set){return !!set.done;});
        h+='<div class="exc'+_ov.stateCls+(ei===0?' open':'')+(hasExerciseData?' has-entry':'')+(exerciseIsComplete?' exercise-complete':'')+'" data-session-index="'+i+'" data-exercise-index="'+ei+'" data-split-key="'+esc(splitKey)+'">';
        h+='<div class="exc-summary" onclick="toggleExc(this)"><div class="exc-sum-main"><div class="exn" id="exn_'+safeKey+'">'+esc(resolvedEx)+'</div><div class="exc-why '+_ov.whyCls+'">'+esc(_ov.why)+'</div></div><div class="exc-entry-pill">'+(exerciseIsComplete?'✓ Done':'In progress')+'</div><div class="exc-chip '+_ov.chipCls+'">'+(_ov.arrow?'<span class="exc-ar">'+_ov.arrow+'</span> ':'')+esc(_ov.chipText)+'</div><div class="exc-chev">▾</div></div>';
        h+='<div class="exc-body">'+_ov.ladder;
        h+='<div class="exh">';
        h+='<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">';
        h+='<div style="min-width:0;flex:1">';
        h+='<div class="exm">'+esc(ex.sets)+' sets'+(ex.rest?' · '+formatRest(ex.rest):'')+'</div>';
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
        h+=_ov.tip;
        h+='</div>';
        h+='</div>';
      });
      h+='</div>';
    }
    var sl2notes=(logs[s.id]&&logs[s.id].__notes)||'';
    h+='<div class="run-field run-input-full" style="margin-top:12px;margin-bottom:8px"><label>Session notes <span style="font-family:var(--mono);font-size:10px;font-weight:400;color:var(--dim)">(PRs, wins, niggles, anything worth logging)</span></label><textarea id="gn_'+i+'" class="li" placeholder="e.g. Hit a new squat PR, left knee felt a bit off on lunges..." oninput="draftGym('+i+',\''+esc(splitKey)+'\')" style="min-height:70px;resize:vertical;font-size:13px">'+esc(sl2notes)+'</textarea></div>';
    var gymSubmitted=isSessionLogged(s.id),gymHasDraft=gymDraftHasData(sl2);
    h+='<div id="gym_saved_'+i+'" class="session-submit-status '+(gymSubmitted?'is-submitted':'is-draft')+'" style="display:'+(gymSubmitted||gymHasDraft?'flex':'none')+';">';
    if(gymSubmitted) h+='<span class="submit-status-icon">✓</span><span><strong>Session submitted</strong><small>Your coaches can now review this data.</small></span>';
    else h+='<span class="submit-status-icon">•••</span><span><strong>Draft saved on this device</strong><small>Press Save session below to submit it to your coaches.</small></span>';
    h+='</div>';
    h+='<button class="savebtn" id="sb_'+i+'" onclick="saveGym('+i+',\''+esc(splitKey)+'\')">Save session</button>';
    if(isSessionLogged(s.id)){setTimeout(function(idx){lockSaveButton(idx,'Save session');}(i),0);}
  }else if(type==='note'){
    var sl3=logs[s.id]||{};
    var noteVal=(typeof sl3.__notes==='string')?sl3.__notes:(sl3.notes||'');
    var instruction=s.runDetails||(_sessionOverrides[s.id]&&_sessionOverrides[s.id].notes)||'';
    h+='<div style="background:rgba(255,255,255,.03);border:1px solid var(--border-mid);border-radius:8px;padding:12px 14px">';
    if(instruction) h+='<div style="font-size:13px;color:var(--text);line-height:1.55;margin-bottom:12px">'+esc(instruction)+'</div>';
    h+='<div class="run-field run-input-full" style="margin-bottom:10px"><label>What did you do? <span style="font-family:var(--mono);font-size:10px;font-weight:400;color:var(--dim)">(training + how it felt, anything worth logging)</span></label><textarea id="nt_'+i+'" class="li" placeholder="e.g. 45min easy run + mobility, legs felt good. Hit chest at the gym, normal week..." oninput="draftNote('+i+')" style="min-height:90px;resize:vertical;font-size:13px">'+esc(noteVal)+'</textarea></div>';
    h+='<div id="note_saved_'+i+'" class="saved-data" style="display:'+(isSessionLogged(s.id)?'block':'none')+';"><div class="saved-label">✓ Submitted to your coaches</div></div>';
    h+='<button class="savebtn" id="sb_'+i+'" onclick="saveNote('+i+')">Save</button>';
    if(isSessionLogged(s.id)){setTimeout(function(idx){lockSaveButton(idx,'Save');}(i),0);}
    h+='</div>';
  }else{h+='<div style="font-family:var(--mono);font-size:12px;color:var(--dim);padding:8px 0">Rest up. Recovery is training too.</div>';}
  return h;
}

var focusedSessionIndex=null,focusedSessionGenerated=false;
function ensureFocusOverlay(){
  var ov=document.getElementById('focusOverlay');
  if(ov)return ov;
  ov=document.createElement('div');ov.id='focusOverlay';ov.className='focus-overlay';
  ov.innerHTML='<div class="focus-overlay-bar"><button class="focus-close" onclick="closeFocusedSession()" aria-label="Close session">&times;</button><div class="focus-overlay-title"><small>Session</small><strong id="focusOverlayName">Workout</strong></div><span id="focusOverlayMeta"></span></div><div class="focus-overlay-scroll" id="focusOverlayScroll"></div><div class="focus-overlay-foot"><button class="focus-done-btn" onclick="closeFocusedSession()">Done — back to plan</button></div>';
  document.body.appendChild(ov);
  return ov;
}
function startFocusedSession(i){
  var card=document.getElementById('sc_'+i),body=document.getElementById('scb_'+i),generated=false;
  // The mobile month calendar intentionally renders compact day cells rather
  // than every full workout card. Build the selected card on demand so the
  // Home "Open session" action does not depend on hidden calendar markup.
  if((!card||!body)&&sessions[i]){
    var staging=document.createElement('div');
    staging.innerHTML=buildCard(sessions[i],i);
    card=staging.querySelector('#sc_'+i);
    body=staging.querySelector('#scb_'+i);
    generated=!!(card&&body);
  }
  if(!card||!body)return;
  if(focusedSessionIndex!=null&&focusedSessionIndex!==i)closeFocusedSession();
  if(!body.classList.contains('open'))body.classList.add('open');
  focusedSessionIndex=i;focusedSessionGenerated=generated;
  var ov=ensureFocusOverlay(),scroll=document.getElementById('focusOverlayScroll');
  if(!scroll.contains(card)){
    if(!generated){
      var ph=document.getElementById('focusCardPlaceholder');
      if(!ph){ph=document.createElement('div');ph.id='focusCardPlaceholder';ph.style.display='none';}
      card.parentNode.insertBefore(ph,card);
    }
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
    if(card){
      card.classList.remove('in-focus-overlay');
      if(focusedSessionGenerated)card.remove();
      else if(ph&&ph.parentNode){ph.parentNode.insertBefore(card,ph);ph.parentNode.removeChild(ph);}
    }
  }
  var ov=document.getElementById('focusOverlay');if(ov)ov.classList.remove('open');
  document.body.classList.remove('focus-session-open');focusedSessionIndex=null;focusedSessionGenerated=false;
}
document.addEventListener('keydown',function(e){if(e.key!=='Escape')return;if(focusedSessionIndex!=null)closeFocusedSession();else if(dayPlanDateISO)closeDayPlan();});
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
function togSet(i,ei,si){
  var btn=document.getElementById('st_'+i+'_'+ei+'_'+si);if(!btn) return;
  var on=!btn.classList.contains('on');btn.classList.toggle('on',on);btn.style.background=on?'var(--ok)':'transparent';btn.style.borderColor=on?'var(--ok)':'var(--border-mid)';
  var card=btn.closest('.exc');
  if(card){
    var splitKey=card.getAttribute('data-split-key')||'Upper A';
    draftGym(i,splitKey);
    refreshStrengthExerciseState(card);
    if(on&&strengthExerciseIsComplete(card)){
      setTimeout(function(){
        if(!card||!strengthExerciseIsComplete(card)) return;
        card.classList.remove('open');refreshStrengthExerciseState(card);
        var next=card.nextElementSibling;
        while(next&&(!next.classList||!next.classList.contains('exc'))) next=next.nextElementSibling;
        if(next&&!next.classList.contains('exercise-complete')){next.classList.add('open');refreshStrengthExerciseState(next);}
      },320);
    }
  }
  if(on) startRest(i,ei);
}
