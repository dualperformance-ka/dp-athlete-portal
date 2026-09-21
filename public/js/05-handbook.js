// ── HANDBOOK ──────────────────────────────────────────────────────────────────
var HB_CONTENT=[
  {title:'How This Works',body:'<div class="nutrnote">You have two coaches — Karl owns your running, Alex owns your strength. Every week follows a structure: train, log, check in, review. The more honest you are with your data, the better we can coach you.</div>'},
  {title:'Weekly Rhythm',body:'<div class="priority-list"><div class="priority-item"><div class="priority-text"><span class="chip">MON–SAT</span> Execute your sessions. Log weights and runs in the portal as you go.</div></div><div class="priority-item"><div class="priority-text"><span class="chip">SUNDAY</span> Submit your weekly check-in. Be honest about what happened and what didn\'t.</div></div><div class="priority-item"><div class="priority-text"><span class="chip">WEEKLY</span> Coaching call with Karl &amp; Alex. We review your week and set the focus for the next one.</div></div></div>'},
  {title:'Training Rules',body:'<div class="priority-list"><div class="priority-item"><div class="priority-num">01</div><div class="priority-text">Never skip the session marked <strong>KEY</strong>. Miss an easy run before you miss a key session.</div></div><div class="priority-item"><div class="priority-num">02</div><div class="priority-text">Easy means easy. If you can\'t hold a conversation, you\'re going too hard.</div></div><div class="priority-item"><div class="priority-num">03</div><div class="priority-text">Log every session — even the bad ones. Especially the bad ones.</div></div><div class="priority-item"><div class="priority-num">04</div><div class="priority-text">Pain is not the same as discomfort. Flag anything sharp, sudden or swollen.</div></div><div class="priority-item"><div class="priority-num">05</div><div class="priority-text">Rest days are training days. Sleep, eat, recover — this is where adaptation happens.</div></div></div>'},
  {title:'Fuelling',body:'<div class="card card--flat"><div class="card-title">Priority Order</div><div class="priority-list"><div class="priority-item"><div class="priority-num">1</div><div class="priority-text"><strong>Hit protein every day.</strong> Non-negotiable — protects muscle and keeps you full. Spread protein across 4–5 meals, aiming for 35–55g per main meal.</div></div><div class="priority-item"><div class="priority-num">2</div><div class="priority-text"><strong>Stay within your calorie target.</strong> Ceiling on rest days, floor on hard training days.</div></div><div class="priority-item"><div class="priority-num">3</div><div class="priority-text"><strong>Hit your fibre target.</strong> 31–40g daily from vegetables, fruit, oats and legumes.</div></div><div class="priority-item"><div class="priority-num">4</div><div class="priority-text"><strong>Carbs and fat fill around protein.</strong> Use carbs around training, fat fills the rest.</div></div><div class="priority-item"><div class="priority-num">5</div><div class="priority-text"><strong>Consistency beats perfection.</strong> An 80% week every week beats a perfect week once a month.</div></div></div></div><div class="card card--flat"><div class="card-title">Carb Timing by Session</div><table class="timing-table"><thead><tr><th>Session</th><th>Timing</th><th>Amount</th><th>Examples</th></tr></thead><tbody><tr><td>Long Run</td><td>30–60 min before</td><td>20–30g</td><td>White rice crackers, banana</td></tr><tr><td>Long Run</td><td>During (&gt;75 min)</td><td>30–60g/hr</td><td>Gels, sports drink, dates</td></tr><tr><td>Long Run</td><td>30 min after</td><td>60–80g</td><td>Rice + juice / banana + rice cakes</td></tr><tr><td>Easy Run</td><td>1–2 hrs before</td><td>30–50g</td><td>Small oats or toast + banana</td></tr><tr><td>Speed Session</td><td>2 hrs before</td><td>50–70g</td><td>White rice or pasta + light protein</td></tr><tr><td>Speed Session</td><td>During (if &gt;60 min)</td><td>20–30g</td><td>Gel or sports drink</td></tr><tr><td>Gym</td><td>1–2 hrs before</td><td>50–70g</td><td>Rice + protein source or shake + banana</td></tr></tbody></table></div><div class="card card--flat"><div class="card-title">Key Principles</div><div class="nutrnote">Never train fasted during speed or long runs — don\'t train hard on an empty tank. Saturday night is your most important meal — eat 80–100g carbs (pasta, rice, noodles) to top off glycogen for Sunday\'s long run.</div></div>'},
  {title:'Progressive Overload',body:'<div class="nutrnote">The foundation of getting stronger. Gradually increase the challenge so your body has a reason to adapt.</div><div class="card card--flat u-text-center"><span class="chip">8 reps</span> → <span class="chip">10 reps</span> → <span class="chip">12 reps</span> → <span class="chip">increase weight</span> → <span class="chip">repeat</span></div><div class="priority-list"><div class="priority-item"><div class="priority-num">1</div><div class="priority-text"><strong>Start at 8 reps</strong><br>Choose a weight that\'s challenging but controlled for all sets.</div></div><div class="priority-item"><div class="priority-num">2</div><div class="priority-text"><strong>Build the reps</strong><br>Each session aim for one more rep than last time.</div></div><div class="priority-item"><div class="priority-num">3</div><div class="priority-text"><strong>Hit 12 reps — increase weight</strong><br>Once all sets at 12 reps with good form — add weight and return to 8.</div></div></div>'},
  {title:'Getting the Most',body:'<div class="nutrnote">Show up to calls prepared. Know what went well, what didn\'t, and what questions you have. The more you put in, the more we can give back. Log your sessions, submit your check-ins, and be honest.</div>'},
  {title:'Glossary',body:'<div class="priority-list"><div class="priority-item"><div class="priority-text"><span class="card-title">Easy Run</span>Conversational pace. Should feel comfortable. Zone 2.</div></div><div class="priority-item"><div class="priority-text"><span class="card-title">Tempo</span>Comfortably hard. You can speak in short sentences.</div></div><div class="priority-item"><div class="priority-text"><span class="card-title">Intervals</span>Hard efforts with recovery. Pace is prescribed in your session.</div></div><div class="priority-item"><div class="priority-text"><span class="card-title">Long Run</span>Your weekly base builder. Easy effort, big aerobic stimulus.</div></div><div class="priority-item"><div class="priority-text"><span class="card-title">RPE</span>Rate of Perceived Exertion. 1–10 scale of how hard something felt.</div></div></div>'}
];
function openHB(i){var c=HB_CONTENT[i];document.getElementById('hbModalTitle').textContent=c.title;document.getElementById('hbModalBody').innerHTML=c.body;document.getElementById('hbModal').classList.add('open');document.body.style.overflow='hidden';}
function closeHB(){document.getElementById('hbModal').classList.remove('open');document.body.style.overflow='';}
function toggleAcc(id){var content=document.getElementById(id+'Content');var arrow=document.getElementById(id+'Arrow');var open=content.style.display==='none';content.style.display=open?'block':'none';arrow.classList.toggle('open',open);}
function shiftWeek(d){weekOffset+=d;loadWeek();}
function goToday(){weekOffset=0;loadWeek();}


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
// ── PROGRAMME VOLUME (km per week, whole programme) ───────────────────────────
// The week the athlete is actually in, captured on the first load at offset 0 so
// paging through weeks can't shift what "this week" means.
var _baseProgrammeWeek=null;
function baseProgrammeWeek(){
  return _baseProgrammeWeek!=null?_baseProgrammeWeek:getCurrentProgrammeWeek();
}
// Distance written into a session title, e.g. "Easy Run — 12km". Interval names
// like "5x1km Threshold" or "3km pace" are NOT weekly distance, so skip those.
function titleKmFromName(name){
  var m=String(name||'').match(/(?:^|[^0-9xX×])(\d+(?:\.\d+)?)\s*km\b(?!\s*(?:pace|reps?|repeats?))/i);
  return m?parseFloat(m[1]):0;
}
// Sanity filter shared by every distance parse: no durations, no absurd values.
function safeKm(raw){
  var str=String(raw==null?'':raw).replace(',','.').trim();
  if(!str||/min|hour|hr\b|sec/i.test(str)) return 0;
  var m=str.match(/(\d+(?:\.\d+)?)/);
  var v=m?parseFloat(m[1]):0;
  return (isNaN(v)||v<=0||v>200)?0:v;
}
// Planned km for one raw planned_sessions row: explicit distance, then the
// library entry it points at, then the title.
function plannedKmFromRow(r){
  var d=safeKm(r&&r.distance_km);
  if(d) return d;
  var lib=r&&r.library_id&&((typeof runLibraryById!=='undefined'&&runLibraryById[r.library_id])||(typeof RUNNING_LIBRARY_BY_ID!=='undefined'&&RUNNING_LIBRARY_BY_ID[r.library_id]));
  d=safeKm(lib&&lib.distance);
  if(d) return d;
  return titleKmFromName(r&&r.title);
}
var _programmeVolume=null,_programmeVolumePromise=null;
function invalidateProgrammeVolume(){_programmeVolume=null;_programmeVolumePromise=null;}
function coachTargetKey(weekIdentifier,sport){return String(weekIdentifier||'')+'|'+String(sport||'').toLowerCase();}
function targetForProgrammeWeek(targets,weekIdentifier,sport){
  var key=coachTargetKey(weekIdentifier,sport);
  return (targets||[]).find(function(target){return coachTargetKey(target.weekIdentifier,target.sport)===key;})||null;
}
function sportForStravaActivity(activity){
  var type=String(activity&&((activity.sport_type||activity.type))||'').toLowerCase();
  if(type.indexOf('swim')>=0) return 'swimming';
  if(type.indexOf('ride')>=0||type.indexOf('cycl')>=0||type.indexOf('bike')>=0) return 'cycling';
  if(type.indexOf('run')>=0) return 'running';
  return null;
}
function completedSportMetrics(activities,sport,startISO,endISO){
  var metrics={distanceMetres:0,sessions:0,durationMinutes:0};
  (activities||[]).forEach(function(activity){
    if(sportForStravaActivity(activity)!==sport) return;
    var activityDate=String(activity.start_date_local||activity.start_date||'').slice(0,10);
    if(!activityDate||activityDate<startISO||activityDate>endISO) return;
    var metres=Number(activity.distance);
    var seconds=Number(activity.moving_time!=null?activity.moving_time:activity.elapsed_time);
    metrics.distanceMetres+=isNaN(metres)||metres<0?0:metres;
    metrics.durationMinutes+=isNaN(seconds)||seconds<0?0:seconds/60;
    metrics.sessions++;
  });
  metrics.distanceMetres=Math.round(metrics.distanceMetres);
  metrics.durationMinutes=Math.round(metrics.durationMinutes);
  return metrics;
}
function rangeFromProgrammeWeek(programmeWeek,offset){
  var start=programmeWeek&&String(programmeWeek.startDate||'').slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(start)) return getWeekDateRangeFromOffset(offset);
  var bits=start.split('-'),dateObj=new Date(Number(bits[0]),Number(bits[1])-1,Number(bits[2]));
  var end=new Date(dateObj.getFullYear(),dateObj.getMonth(),dateObj.getDate()+6);
  return {start:dateObj,end:end,startISO:start,endISO:localISO(end)};
}
// One pass over the whole programme. Canonical programme-week UUIDs join the
// read-only coach targets to the athlete's calendar; a row's presence is the
// lock, including an explicit zero. Legacy running targets remain a display
// fallback only when the dashboard returned a successful empty result.
async function loadProgrammeVolume(force){
  if(force) invalidateProgrammeVolume();
  if(_programmeVolume) return _programmeVolume;
  if(_programmeVolumePromise) return _programmeVolumePromise;
  _programmeVolumePromise=(async function(){
    var code=(athlete&&athlete.code||'').toUpperCase().trim();
    var planned={},manual={},programmeWeekRows=[],coachTargets=[],targetState='empty',targetError='';
    if(_authToken&&code){
      var programmeResult=null,targetResult=null;
      try{programmeResult=await portalRequest('programme-data');}
      catch(e){console.warn('Programme volume load failed',e);}
      try{
        targetResult=await portalRequest('weekly-sport-targets');
        coachTargets=Array.isArray(targetResult.targets)?targetResult.targets:[];
        targetState=coachTargets.length?'ready':'empty';
      }catch(e){
        targetState='error';targetError='Coach targets are temporarily unavailable';
        console.warn('Coach target load failed',e);
      }
      try{
        var res=programmeResult||{};
        programmeWeekRows=Array.isArray(res.programmeWeeks)?res.programmeWeeks:[];
        (res.planned||[]).forEach(function(r){
          var m=String(r.week_label||'').match(/\d+/);
          if(!m) return;
          var wk=parseInt(m[0],10);
          planned[wk]=planned[wk]||{sum:0,declared:0};
          var title=String(r.title||'');
          if(String(r.session_type||'')==='Weekly KM Total'||/km total/i.test(title)){
            var dm=title.match(/(\d+(?:\.\d+)?)\s*km/i);
            if(dm) planned[wk].declared=Math.max(planned[wk].declared,parseFloat(dm[1]));
            return;
          }
          planned[wk].sum+=plannedKmFromRow(r);
        });
        (res.nutrition||[]).forEach(function(r){
          var m=String(r.week_label||'').match(/\d+/);
          if(m&&r.weekly_km_target!=null) manual[parseInt(m[0],10)]=Number(r.weekly_km_target);
        });
      }catch(e){console.warn('Programme volume mapping failed',e);}
    }
    var strava=null;
    try{strava=window._stravaLoadPromise?await window._stravaLoadPromise:null;}catch(e){}
    var hasStrava=!!(strava&&strava.connected&&strava.activitiesAvailable!==false),activities=(strava&&strava.activities)||[];
    var firstStravaBySport={running:null,cycling:null,swimming:null};
    if(hasStrava){
      activities.forEach(function(a){
        var sport=sportForStravaActivity(a);if(!sport)return;
        var d=String(a.start_date_local||a.start_date||'').slice(0,10);
        if(d&&(!firstStravaBySport[sport]||d<firstStravaBySport[sport])) firstStravaBySport[sport]=d;
      });
    }
    var base=baseProgrammeWeek(),total=Math.max(programmeWeeks||12,base),weeks=[];
    var canonicalByNumber={};
    programmeWeekRows.forEach(function(row){canonicalByNumber[Number(row.weekNumber)]=row;});
    if(programmeWeekRows.length){
      total=Math.max(total,programmeWeekRows.reduce(function(max,row){return Math.max(max,Number(row.weekNumber)||0);},0));
    }
    var firstWeek=(canonicalByNumber[0]||base===0)?0:1;
    for(var wk=firstWeek;wk<=total;wk++){
      var p=planned[wk]||{sum:0,declared:0};
      var auto=Math.round(Math.max(p.sum,p.declared)*10)/10;
      var canonical=canonicalByNumber[wk]||null;
      var weekIdentifier=canonical&&canonical.id||null;
      if(!weekIdentifier){
        var plannedRow=(programmeResult&&programmeResult.planned||[]).find(function(row){
          var m=String(row.week_label||'').match(/\d+/);return m&&Number(m[0])===wk&&row.programme_week_id;
        });
        weekIdentifier=plannedRow&&plannedRow.programme_week_id||null;
      }
      var sportOrder={running:0,cycling:1,swimming:2};
      var weekCoachTargets=weekIdentifier?coachTargets.filter(function(target){return target.weekIdentifier===weekIdentifier;})
        .sort(function(a,b){return sportOrder[a.sport]-sportOrder[b.sport];}):[];
      var coachRun=targetForProgrammeWeek(weekCoachTargets,weekIdentifier,'running');
      var target=targetState==='error'?null:(coachRun?coachRun.distanceTargetMetres/1000:(manual[wk]!=null?manual[wk]:(auto>0?auto:null)));
      var range=rangeFromProgrammeWeek(canonical,wk-base);
      var actual=null;
      var actualBySport={running:null,cycling:null,swimming:null};
      ['running','cycling','swimming'].forEach(function(sport){
        var first=firstStravaBySport[sport];
        if(hasStrava&&range.startISO<=localISO(new Date())&&(!first||range.endISO>=first)){
          actualBySport[sport]=completedSportMetrics(activities,sport,range.startISO,range.endISO);
        }
      });
      if(actualBySport.running) actual=Math.round(actualBySport.running.distanceMetres/100)/10;
      else if(hasStrava&&firstStravaBySport.running&&range.endISO>=firstStravaBySport.running&&range.startISO<=localISO(new Date())) actual=0;
      var hasTarget=target!=null&&!isNaN(Number(target));
      var plannedTarget=hasTarget?Math.round(Number(target)*10)/10:null;
      var isCurrent=wk===base,isPast=wk<base,isFuture=wk>base;
      if(canonical&&canonical.startDate){
        var today=localISO(new Date());isPast=range.endISO<today;isFuture=range.startISO>today;isCurrent=!isPast&&!isFuture;
      }
      weeks.push({week:wk,label:canonical&&canonical.weekLabel||'Week '+wk,weekIdentifier:weekIdentifier,
        planned:plannedTarget,actual:actual,actualBySport:actualBySport,coachTargets:weekCoachTargets,
        isCurrent:isCurrent,isPast:isPast,isFuture:isFuture,startISO:range.startISO,endISO:range.endISO});
    }
    _programmeVolume={weeks:weeks,base:base,source:hasStrava?'strava':'plan',hasActual:hasStrava,
      targets:coachTargets,targetState:targetState,targetError:targetError};
    return _programmeVolume;
  })();
  try{return await _programmeVolumePromise;}
  finally{_programmeVolumePromise=null;}
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
  return Math.round(completedSportMetrics(activities,'running',range.startISO,range.endISO).distanceMetres/100)/10;
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
// Weekly-KM tracking previously read two Notion databases. Both were retired on
// 2026-07-20 (the source DBs were never wired up — the IDs were placeholders).
// Completed km is derived locally from logged sessions / Strava instead.
async function getWeeklyCompletedKmFromTracker(offset){
  return null;
}
async function loadWeeklyKmData(offset){
  currentWeekKmData=null;
  return null;
}
