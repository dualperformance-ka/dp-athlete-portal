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
function getCallBookedState(){
  var raw=localStorage.getItem(callNudgeWeekKey());
  if(!raw) return {booked:false,displayTime:''};
  var t='';
  try{var p=JSON.parse(raw);if(p&&p!=='1'&&p!==1)t=p;}catch(e){if(raw&&raw!=='1')t=raw;}
  return {booked:true,displayTime:t||''};
}
// SINGLE source of truth for every booking prompt in the app: the home nudge,
// the confirmed strip, the check-in Step 1 card and the tab dot all render
// from the same state, so they can never disagree.
function renderBookingPrompts(){
  var st=getCallBookedState();
  var nudge=document.getElementById('callNudge');
  var confirmed=document.getElementById('callConfirmedNudge');
  var dot=document.getElementById('tabDotCheckin');
  if(nudge) nudge.style.display=st.booked?'none':'';
  if(confirmed) confirmed.style.display=st.booked?'':'none';
  var titleEl=document.getElementById('callConfirmedTitle');
  if(titleEl) titleEl.textContent=st.displayTime?'Call booked · '+st.displayTime:'Call booked this week';
  if(dot) dot.classList.toggle('visible',!st.booked);
  var card=document.getElementById('ciBookCard');
  if(card){
    card.classList.toggle('booked',st.booked);
    card.style.borderColor=st.booked?'rgba(34,197,94,.35)':'rgba(245,158,11,.22)';
    var k=document.getElementById('ciBookKicker'),t=document.getElementById('ciBookTitle'),s=document.getElementById('ciBookSub'),a=document.getElementById('ciBookArrow');
    if(k) k.textContent=st.booked?'Step 1 — Done':'Step 1 — Do this first';
    if(t) t.textContent=st.booked?'Call booked':'Book your coaching call';
    if(s) s.textContent=st.booked?((st.displayTime?st.displayTime+' · ':'')+'Tap to view or rebook'):'30 min with Karl & Alex · Tap to open booking';
    if(a) a.style.color=st.booked?'#22c55e':'#f59e0b';
  }
}
function initCallNudge(){renderBookingPrompts();}
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
  renderBookingPrompts();
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
      // Fallback: GHL's embed often omits a structured startTime — scan the
      // raw payload for any ISO datetime before giving up on showing a time.
      // (The authoritative time still arrives via the GHL webhook -> /api/call-booked.)
      if(!st){var m=payloadStr.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/);if(m)st=m[0];}
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
  document.querySelectorAll('[data-portal-dest]').forEach(function(item){item.classList.toggle('active',item.dataset.portalDest===tab);});
  var sectionLabel=document.getElementById('portalSectionLabel');
  if(sectionLabel){
    var labels={training:'Today\'s Plan',weekly:'Weekly Plan',nutrition:'Nutrition',checkin:'Weekly Check-in',progress:'Progress',goals:'Goals',handbook:'Athlete Guide',comms:'Contact'};
    sectionLabel.textContent=labels[tab]||'Athlete Portal';
  }
  toggleMoreMenu(false);
  var isDesktop=window.matchMedia&&window.matchMedia('(min-width:900px)').matches;
  var secondaryTabs=['nutrition','goals','handbook','comms'];
  var isMobileSecondary=!isDesktop&&secondaryTabs.indexOf(tab)>=0;
  setMobileNav(tab==='weekly'?'training':(tab==='training'?'home':(isMobileSecondary?'more':tab)));
  var showWeekBar=(tab==='weekly')||(!isDesktop&&tab==='training'&&trainingView==='plan');
  document.body.classList.toggle('mobile-training-calendar',!isDesktop&&tab==='training'&&trainingView==='plan');
  document.body.classList.toggle('mobile-portal-home',!isDesktop&&tab==='training'&&trainingView==='home');
  document.body.classList.toggle('mobile-checkin-tab',!isDesktop&&tab==='checkin');
  document.body.classList.toggle('mobile-progress-tab',!isDesktop&&tab==='progress');
  document.body.classList.toggle('mobile-secondary-tab',isMobileSecondary);
  syncMobileHomePlacement();
  document.getElementById('wbar').style.display=showWeekBar?'':'none';
  if(tab==='nutrition'&&Date.now()-_nutLastLoad>60000) loadNutrition(); // skip refetch if loaded <60s ago (week shifts & post-save always reload directly)
  if(tab==='checkin'){
    initCheckin();
    if(!isDesktop) window.scrollTo({top:0,behavior:'smooth'});
  }
  if(isMobileSecondary) window.scrollTo({top:0,behavior:'smooth'});
  if(tab==='progress') loadProgress();
  if(tab==='training'||tab==='weekly') applyTrainingView();
}

function setMobileNav(tab){
  document.querySelectorAll('.mobile-nav-item').forEach(function(item){
    var active=item.dataset.mobileTab===tab;
    item.classList.toggle('active',active);
    if(active) item.setAttribute('aria-current','page');else item.removeAttribute('aria-current');
  });
}
// Mobile keeps the home/training split inside one tab. Desktop now has
// separate tabs: Today's Plan and Weekly Plan.
var trainingView='home';
function syncMobileHomePlacement(){
  var today=document.getElementById('todayEl');
  var anchor=document.getElementById('todayHomeAnchor');
  var topShell=document.querySelector('.top-shell');
  var priority=document.querySelector('.top-shell-priority');
  if(!today||!anchor||!topShell||!priority)return;
  if(document.body.classList.contains('mobile-portal-home')){
    if(today.parentNode!==topShell)topShell.insertBefore(today,priority);
  }else if(anchor.parentNode&&today.parentNode!==anchor.parentNode){
    anchor.parentNode.insertBefore(today,anchor.nextSibling);
  }
}
function applyTrainingView(){
  var t=document.getElementById('todayEl');
  var c=document.getElementById('calEl');
  var wc=document.getElementById('weeklyCalEl');
  var wb=document.getElementById('wbar');
  var trainingTab=document.getElementById('tab-training');
  var weeklyTab=document.getElementById('tab-weekly');
  var isDesktop=window.matchMedia&&window.matchMedia('(min-width:900px)').matches;
  var trainingActive=!!(trainingTab&&trainingTab.classList.contains('active'));
  document.body.classList.toggle('mobile-portal-home',!isDesktop&&trainingActive&&trainingView==='home');
  syncMobileHomePlacement();
  if(isDesktop){
    var weeklyActive=!!(weeklyTab&&weeklyTab.classList.contains('active'));
    if(t&&t.innerHTML)t.style.display=trainingActive?'block':'none';
    if(c&&c.innerHTML)c.style.display='none';
    if(wc&&wc.innerHTML)wc.style.display=weeklyActive?'block':'none';
    if(wb)wb.style.display=weeklyActive?'':'none';
    return;
  }
  if(!trainingTab||!trainingTab.classList.contains('active'))return;
  if(t&&t.innerHTML)t.style.display=(trainingView==='plan')?'none':'block';
  if(c&&c.innerHTML)c.style.display=(trainingView==='home')?'none':'block';
  if(wc&&wc.innerHTML)wc.style.display='none';
  if(wb)wb.style.display=(trainingView==='home')?'none':'';
}
if(window.matchMedia){
  var portalDesktopQuery=window.matchMedia('(min-width:900px)');
  if(portalDesktopQuery.addEventListener)portalDesktopQuery.addEventListener('change',applyTrainingView);
  else if(portalDesktopQuery.addListener)portalDesktopQuery.addListener(applyTrainingView);
}
function goPortalHome(){
  // Home = TODAY: current week, today panel, nothing else.
  trainingView='home';
  switchTab('training');setMobileNav('home');
  if(weekOffset!==0){weekOffset=0;loadWeek();}
  applyTrainingView();
  window.scrollTo({top:0,behavior:'smooth'});
}
function goTrainingPlan(){
  // Desktop jumps to the dedicated Weekly Plan tab. Mobile keeps the original
  // single-tab split and opens the plan view inside Training.
  trainingView='plan';
  var isDesktop=window.matchMedia&&window.matchMedia('(min-width:900px)').matches;
  switchTab(isDesktop?'weekly':'training');setMobileNav('training');
  applyTrainingView();
  window.scrollTo({top:0,behavior:'smooth'});
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
  {key:'sessions',icon:'calendar',label:'Training sessions',sub:'Before planned training'},
  {key:'checkins',icon:'clipboard',label:'Weekly check-ins',sub:'When your review is due'},
  {key:'photos',icon:'camera',label:'Progress photos',sub:'On your scheduled photo week'},
  {key:'coach',icon:'chat',label:'Coach replies',sub:'When coaching feedback arrives'}
];
function getReminderPreferences(){try{return JSON.parse(localStorage.getItem('dp_reminders_'+((athlete&&athlete.code)||'default'))||'{}');}catch(e){return{};}}
function openPreferences(){
  toggleMoreMenu(false);var prefs=getReminderPreferences(),list=document.getElementById('notificationPreferences');
  list.innerHTML=REMINDER_OPTIONS.map(function(o){return '<label class="preference-row"><span class="preference-icon"><svg class="icon"><use href="#i-'+o.icon+'"/></svg></span><span><strong>'+o.label+'</strong><small>'+o.sub+'</small></span><input type="checkbox" '+(prefs[o.key]?'checked':'')+' onchange="setReminderPreference(\''+o.key+'\',this.checked)"><i></i></label>';}).join('')
    +'<div id="pushStatus" class="push-status">Notifications · '+(localStorage.getItem('dp_push_status')||'not set up yet')+'</div>';
  syncPushSubscription();
  setMobileNav('more');document.getElementById('preferencesModal').classList.add('open');document.body.style.overflow='hidden';
}
function closePreferences(){document.getElementById('preferencesModal').classList.remove('open');document.body.style.overflow='';restoreMobileNavContext();}
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
    showToast('Notifications are blocked — allow them in your browser or phone settings','error');
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
  body.innerHTML='<div class="summary-week-label">Programme · Week '+getCurrentProgrammeWeek()+'</div><div class="summary-hero"><div class="summary-ring" style="--value:'+i.compliance+'"><strong>'+i.compliance+'%</strong></div><div><strong>Week completion</strong><small>'+i.completed+' of '+i.planned+' planned sessions complete'+(i.completed<i.planned?' · still underway':' · week complete')+'</small></div></div><div class="summary-grid"><div><span class="summary-metric-icon"><svg class="icon"><use href="#i-barbell"/></svg></span><small>Training volume</small><strong>'+s.volume.toLocaleString()+'kg</strong></div><div><span class="summary-metric-icon"><svg class="icon"><use href="#i-pulse"/></svg></span><small>Readiness</small><strong>'+(i.readiness==null?'Not logged':i.readiness+'/100')+'</strong></div><div><span class="summary-metric-icon"><svg class="icon"><use href="#i-run"/></svg></span><small>Running</small><strong>'+(i.kmTarget?i.kmDone.toFixed(1)+' / '+i.kmTarget.toFixed(1)+'km':'No target')+'</strong></div><div><span class="summary-metric-icon"><svg class="icon"><use href="#i-trophy"/></svg></span><small>PB history</small><strong>'+i.pbs+' exercises</strong></div></div><div class="summary-wins"><span class="summary-metric-icon"><svg class="icon"><use href="#i-trophy"/></svg></span><div><strong>Wins this week</strong><p>'+(s.wins.length?s.wins.map(esc).join(' · '):'Log your first completed session to start building the week.')+'</p></div></div>'+renderCoachMoment([]);
  setMobileNav('more');document.getElementById('weeklySummaryModal').classList.add('open');document.body.style.overflow='hidden';
}
function closeWeeklySummary(){document.getElementById('weeklySummaryModal').classList.remove('open');document.body.style.overflow='';restoreMobileNavContext();}
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
  if(shouldOpen)setMobileNav('more');else restoreMobileNavContext();
}
function restoreMobileNavContext(){
  var active=document.querySelector('.tab-content.active');if(!active)return;
  var tab=active.id.replace('tab-','');
  if(tab==='training'){setMobileNav(trainingView==='home'?'home':'training');return;}
  if(tab==='weekly'){setMobileNav('training');return;}
  if(['nutrition','goals','handbook','comms'].indexOf(tab)>=0){setMobileNav('more');return;}
  setMobileNav(tab);
}
function applyOutdoorMode(enabled){
  document.documentElement.classList.toggle('outdoor-mode',!!enabled);
  var button=document.getElementById('themeToggle');
  if(button){
    button.setAttribute('aria-pressed',enabled?'true':'false');
    var label=button.querySelector('.theme-toggle-label');if(label)label.textContent=enabled?'Indoor':'Outdoor';
    var hint=enabled?'Switch to indoor mode':'Switch to outdoor mode';
    button.title=hint;button.setAttribute('aria-label',hint);
  }
  var moreLabel=document.querySelector('.more-outdoor strong');if(moreLabel)moreLabel.textContent=enabled?'Indoor mode':'Outdoor mode';
  var moreSub=document.querySelector('.more-outdoor small');if(moreSub)moreSub.textContent=enabled?'Return to the dark indoor theme':'Use the light theme in bright conditions';
  try{localStorage.setItem('dp_outdoor_mode',enabled?'1':'0');}catch(e){}
}
function toggleOutdoorMode(){applyOutdoorMode(!document.documentElement.classList.contains('outdoor-mode'));}
try{applyOutdoorMode(localStorage.getItem('dp_outdoor_mode')==='1');}catch(e){applyOutdoorMode(false);}
