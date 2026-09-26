// ── RUN SESSION SCREEN ─────────────────────────────────────────────────────────
// A run session opens as swipeable pages instead of one long scroll. The watch
// is the tracker and Strava delivers the run, so after a run the Strava result
// leads, with the two-tap check-in (RPE, pain) on the same first page. Before a
// run the plan leads and logging sits on the second page.
//
// Inside the session overlay the pages scroll sideways (CSS scroll-snap) with
// tabs above them for anyone who does not swipe. Anywhere else (the Training
// list accordion) the same pages simply stack, so nothing depends on swiping.
//
// Strava data shown here is the athlete's own and stays on this screen: the
// coach dashboard keeps reading the confirmed portal log, never the feed.

// ── Text helpers ──────────────────────────────────────────────────────────────

// The main-set line joins the coach's interval text with the working pace.
// Coaches write the pace as a bare range ("5:00-5:15"), with a unit
// ("4:35-4:45/km") or as a phrase ("RPE 3", "Easy running; relaxed strides."),
// and the interval text sometimes already carries it ("4 x 3 min @ 5:00-5:15/km").
// So: never repeat a pace the intervals already hold, only a bare mm:ss range
// gets "/km", and prose joins with a dot rather than an "@".
function runMainSetText(intervals,pace){
  var reps=String(intervals==null?'':intervals).trim(),p=String(pace==null?'':pace).trim();
  if(!p)return reps;
  var norm=function(v){return String(v).toLowerCase().replace(/[–—]/g,'-').replace(/\s+/g,'');};
  if(reps&&norm(reps).indexOf(norm(p).replace(/\/km$/,''))>=0)return reps;
  if(/^\d{1,2}:\d{2}(\s*[-–]\s*\d{1,2}:\d{2})?$/.test(p))p+='/km';
  if(!reps)return p;
  return reps+(/^(about\s+)?\d/i.test(p)?' @ ':' · ')+p;
}

function runClock(totalSeconds){
  var s=Math.round(Number(totalSeconds));
  if(!Number.isFinite(s)||s<=0)return '';
  var h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60,pad=function(n){return (n<10?'0':'')+n;};
  return h?h+':'+pad(m)+':'+pad(sec):m+':'+pad(sec);
}
function runPace(secondsPerKm){
  var s=Math.round(Number(secondsPerKm));
  if(!Number.isFinite(s)||s<=0)return '';
  return Math.floor(s/60)+':'+(s%60<10?'0':'')+(s%60);
}

// ── Strava activity → display numbers ─────────────────────────────────────────

function runStravaStats(activity){
  var a=activity&&typeof activity==='object'?activity:{};
  var num=function(v){var n=Number(v);return v==null||v===''||!Number.isFinite(n)?null:n;};
  var metres=num(a.distance),moving=num(a.moving_time)||num(a.elapsed_time);
  var km=metres&&metres>0?metres/1000:null;
  var splits=(Array.isArray(a.splits_metric)?a.splits_metric:[]).map(function(sp,ix){
    var d=num(sp&&sp.distance),t=num(sp&&(sp.moving_time!=null?sp.moving_time:sp.elapsed_time));
    if(!d||!t||d<50)return null;
    return {n:(sp&&sp.split)||ix+1,metres:d,seconds:t,secPerKm:t/(d/1000)};
  }).filter(Boolean);
  var cadence=num(a.average_cadence);
  return {
    km:km,
    distanceLabel:km?(Math.round(km*10)/10).toFixed(1)+' km':'',
    movingSeconds:moving,
    timeLabel:runClock(moving),
    paceLabel:km&&moving?runPace(moving/km):'',
    avgHr:num(a.average_heartrate)?Math.round(num(a.average_heartrate)):null,
    maxHr:num(a.max_heartrate)?Math.round(num(a.max_heartrate)):null,
    elevation:num(a.total_elevation_gain)!=null?Math.round(num(a.total_elevation_gain)):null,
    // Strava reports running cadence per leg; steps per minute is double.
    cadence:cadence?Math.round(cadence*2):null,
    splits:splits,
    polyline:(a.map&&(a.map.summary_polyline||a.map.polyline))||'',
    id:a.id||null
  };
}

// Google encoded polyline → [[lat,lng],…]. Malformed input returns [].
function decodeRunPolyline(encoded){
  var str=String(encoded||''),points=[],index=0,lat=0,lng=0;
  try{
    while(index<str.length){
      var shift=0,result=0,b;
      do{b=str.charCodeAt(index++)-63;if(isNaN(b))return [];result|=(b&0x1f)<<shift;shift+=5;}while(b>=0x20&&index<=str.length);
      lat+=(result&1)?~(result>>1):(result>>1);
      shift=0;result=0;
      do{b=str.charCodeAt(index++)-63;if(isNaN(b))return [];result|=(b&0x1f)<<shift;shift+=5;}while(b>=0x20&&index<=str.length);
      lng+=(result&1)?~(result>>1):(result>>1);
      points.push([lat/1e5,lng/1e5]);
    }
  }catch(e){return [];}
  return points;
}
// Fits a route into a w×h box (equirectangular, longitude scaled by latitude).
function runRoutePath(points,w,h,pad){
  if(!points||points.length<2)return '';
  pad=pad==null?10:pad;
  var midLat=points.reduce(function(t,p){return t+p[0];},0)/points.length,k=Math.cos(midLat*Math.PI/180)||1;
  var xs=points.map(function(p){return p[1]*k;}),ys=points.map(function(p){return -p[0];});
  var minX=Math.min.apply(null,xs),maxX=Math.max.apply(null,xs),minY=Math.min.apply(null,ys),maxY=Math.max.apply(null,ys);
  var span=Math.max(maxX-minX,maxY-minY)||1,scale=Math.min((w-2*pad)/((maxX-minX)||span),(h-2*pad)/((maxY-minY)||span));
  var ox=(w-(maxX-minX)*scale)/2,oy=(h-(maxY-minY)*scale)/2;
  return points.map(function(p,ix){
    var x=(p[1]*k-minX)*scale+ox,y=(-p[0]-minY)*scale+oy;
    return (ix?'L':'M')+x.toFixed(1)+' '+y.toFixed(1);
  }).join('');
}

// ── Markup ────────────────────────────────────────────────────────────────────

function _runEsc(v){return typeof esc==='function'?esc(v):String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}

// pages: [{key,label,html}]. The first page is the one that opens.
function runPagerHtml(i,pages){
  var tabs='<div class="run-tabs" role="group" aria-label="Session pages">'+pages.map(function(p,ix){
    return '<button type="button" class="run-tab'+(ix===0?' is-current':'')+'" id="rpt_'+i+'_'+ix+'" aria-controls="rpp_'+i+'_'+ix+'" aria-current="'+(ix===0?'true':'false')+'" onclick="runPagerGo('+i+','+ix+')"><span class="run-tab-n" aria-hidden="true">'+(ix+1)+'</span>'+_runEsc(p.label)+'</button>';
  }).join('')+'</div>';
  var body='<div class="run-pages" id="rpg_'+i+'" onscroll="runPagerSync('+i+')">'+pages.map(function(p,ix){
    return '<section class="run-page" id="rpp_'+i+'_'+ix+'" data-page="'+_runEsc(p.key)+'" aria-label="'+_runEsc(p.label)+'">'+p.html+
      (ix<pages.length-1&&p.hint?'<div class="run-page-hint" aria-hidden="true">'+_runEsc(p.hint)+' ›</div>':'')+'</section>';
  }).join('')+'</div>';
  return '<div class="run-pager" id="rpr_'+i+'" data-pages="'+pages.length+'">'+tabs+body+'</div>';
}
function runPagerGo(i,ix){
  var track=document.getElementById('rpg_'+i),page=document.getElementById('rpp_'+i+'_'+ix);
  if(!track||!page)return;
  track.scrollTo({left:ix*track.clientWidth,behavior:'smooth'});
  _runPagerMark(i,ix);
}
function runPagerSync(i){
  var track=document.getElementById('rpg_'+i);if(!track||!track.clientWidth)return;
  _runPagerMark(i,Math.round(track.scrollLeft/track.clientWidth));
}
function _runPagerMark(i,ix){
  var pager=document.getElementById('rpr_'+i);if(!pager)return;
  pager.querySelectorAll('.run-tab').forEach(function(tab,t){
    var on=t===ix;tab.classList.toggle('is-current',on);tab.setAttribute('aria-current',on?'true':'false');
  });
}

function runStravaHeroHtml(s,i,activity){
  var st=runStravaStats(activity),stat=function(label,value){
    return value?'<div class="run-hero-stat"><span>'+_runEsc(label)+'</span><strong>'+_runEsc(value)+'</strong></div>':'';
  };
  var headline=st.timeLabel||st.distanceLabel||'Run synced';
  var runCount=activity&&activity.source_activity_count>1?activity.source_activity_count:1;
  return '<section class="run-hero" aria-label="Your run from Strava">'+
    '<div class="run-hero-top"><span class="run-hero-source">'+(typeof stravaLogoSvg==='function'?stravaLogoSvg():'')+(runCount>1?runCount+' runs synced from Strava':'Synced from Strava')+'</span>'+
    '<button type="button" class="run-hero-reject" onclick="event.stopPropagation();rejectStravaMatch('+i+')">Not '+(runCount>1?'these runs':'this run')+'</button></div>'+
    '<div class="run-hero-main"><span class="run-hero-label">'+(st.timeLabel?'Time':'Distance')+'</span><strong class="run-hero-number">'+_runEsc(headline)+'</strong></div>'+
    '<div class="run-hero-stats">'+stat('Distance',st.distanceLabel)+stat('Avg pace',st.paceLabel?st.paceLabel+' /km':'')+stat('Avg HR',st.avgHr?st.avgHr+' bpm':'')+'</div>'+
    (st.id?'<a class="run-hero-link" href="https://www.strava.com/activities/'+encodeURIComponent(String(st.id))+'" target="_blank" rel="noopener">View on Strava ↗</a>':'')+
  '</section>';
}

// The check-in the coaches act on: RPE and pain, two taps. The hidden inputs
// keep the ids saveStravaFeedback() already reads, so saving is unchanged.
function runCheckinHtml(s,i){
  var entry=(typeof logs!=='undefined'&&logs[s.id])||{},saved=!!entry.__stravaFeedbackAt,queued=!!entry.__stravaFeedbackQueued;
  var rpe=String(entry.rpe||''),pain=entry.pain==='yes'||entry.pain==='no'?entry.pain:'';
  var chips='';for(var n=1;n<=10;n++){var on=rpe===String(n);chips+='<button type="button" class="run-chip'+(on?' is-on':'')+'" aria-pressed="'+(on?'true':'false')+'" data-rpe="'+n+'" onclick="pickRunRpe('+i+','+n+')">'+n+'</button>';}
  var painBtn=function(v,label){var on=pain===v;return '<button type="button" class="run-pain'+(on?' is-on':'')+'" aria-pressed="'+(on?'true':'false')+'" data-pain="'+v+'" onclick="pickRunPain('+i+',\''+v+'\')">'+label+'</button>';};
  return '<section class="run-checkin strava-feedback" id="rci_'+i+'" aria-label="Check in">'+
    '<div class="run-checkin-head"><strong>How did it feel?</strong><span id="rcis_'+i+'">'+_runEsc(runCheckinSummary(rpe,pain))+'</span></div>'+
    '<input type="hidden" id="srpe_'+i+'" value="'+_runEsc(rpe)+'" /><input type="hidden" id="spain_'+i+'" value="'+_runEsc(pain)+'" />'+
    '<div class="run-chips" role="group" aria-label="RPE out of 10" id="srpeg_'+i+'">'+chips+'</div>'+
    '<div class="run-pains" role="group" aria-label="Any pain or niggles?" id="spaing_'+i+'">'+painBtn('no','No pain')+painBtn('yes','Pain or niggle')+'</div>'+
    '<details class="run-note"'+(entry.notes?' open':'')+'><summary>Add a note for your coaches</summary><textarea id="snotes_'+i+'" class="li" rows="3" aria-label="Note for your coaches" placeholder="Anything your coaches should know">'+_runEsc(entry.notes||'')+'</textarea></details>'+
    '<button type="button" class="savebtn run-checkin-send'+(saved?' saved':(queued?' is-sending':''))+'" id="sfb_'+i+'" onclick="saveStravaFeedback('+i+')">'+(saved?'Feedback saved ✓':(queued?'Retry feedback sync':'Send to coaches'))+'</button>'+
  '</section>';
}
var RUN_RPE_WORDS={1:'Very easy',2:'Easy',3:'Easy',4:'Comfortable',5:'Steady',6:'Moderate',7:'Hard',8:'Hard',9:'Very hard',10:'All out'};
function runCheckinSummary(rpe,pain){
  var parts=[];
  if(rpe)parts.push('RPE '+rpe+(RUN_RPE_WORDS[rpe]?' · '+RUN_RPE_WORDS[rpe]:''));
  if(pain==='no')parts.push('No pain');else if(pain==='yes')parts.push('Pain flagged');
  return parts.join(' · ');
}
function runCheckinMissing(i){
  var rpe=(document.getElementById('srpe_'+i)||{}).value||'',pain=(document.getElementById('spain_'+i)||{}).value||'';
  return (rpe?0:1)+(pain?0:1);
}
function _runCheckinPaint(i){
  var rpe=(document.getElementById('srpe_'+i)||{}).value||'',pain=(document.getElementById('spain_'+i)||{}).value||'';
  var label=document.getElementById('rcis_'+i);if(label)label.textContent=runCheckinSummary(rpe,pain);
  if(typeof refreshFocusedSessionChrome==='function')refreshFocusedSessionChrome(i);
}
function pickRunRpe(i,n){
  var input=document.getElementById('srpe_'+i);if(!input)return;input.value=String(n);
  var group=document.getElementById('srpeg_'+i);
  if(group){group.removeAttribute('aria-invalid');group.querySelectorAll('.run-chip').forEach(function(b){var on=b.getAttribute('data-rpe')===String(n);b.classList.toggle('is-on',on);b.setAttribute('aria-pressed',on?'true':'false');});}
  _runCheckinPaint(i);
}
function pickRunPain(i,v){
  var input=document.getElementById('spain_'+i);if(!input||(v!=='no'&&v!=='yes'))return;input.value=v;
  var group=document.getElementById('spaing_'+i);
  if(group){group.removeAttribute('aria-invalid');group.querySelectorAll('.run-pain').forEach(function(b){var on=b.getAttribute('data-pain')===v;b.classList.toggle('is-on',on);b.setAttribute('aria-pressed',on?'true':'false');});}
  _runCheckinPaint(i);
}

function runSplitsHtml(activity){
  var st=runStravaStats(activity);
  var extra=[st.maxHr?'Max HR '+st.maxHr:'',st.cadence?st.cadence+' spm':'',st.elevation!=null?st.elevation+' m climb':''].filter(Boolean);
  var rows='';
  if(st.splits.length){
    var paces=st.splits.map(function(sp){return sp.secPerKm;}),fast=Math.min.apply(null,paces),slow=Math.max.apply(null,paces),range=Math.max(slow-fast,1);
    rows=st.splits.map(function(sp){
      var width=Math.round(55+45*(slow-sp.secPerKm)/range),partial=sp.metres<950;
      return '<li class="run-split"><span class="run-split-n">'+(partial?(Math.round(sp.metres/10)/100)+' km':'Km '+sp.n)+'</span><strong>'+runPace(sp.secPerKm)+'</strong><span class="run-split-bar" aria-hidden="true"><i style="width:'+width+'%"></i></span></li>';
    }).join('');
  }
  var points=decodeRunPolyline(st.polyline),path=runRoutePath(points,320,120,12);
  return '<section class="run-splits" aria-label="Your splits">'+
    '<div class="run-section-label"><b>Km splits</b>'+(extra.length?'<span>'+_runEsc(extra.join(' · '))+'</span>':'')+'</div>'+
    (rows?'<ol class="run-split-list">'+rows+'</ol>':'<p class="run-empty">Strava did not send km splits for this run.</p>')+
    (path?'<svg class="run-route" viewBox="0 0 320 120" role="img" aria-label="Route map"><path d="'+path+'" /></svg>':'')+
  '</section>';
}

// Before a run: Strava does the logging, the manual form is the fallback.
function runLogPageHtml(s,i,formHtml){
  var connected=!!window._stravaConnectedNow;
  if(!connected)return '<div class="run-log-intro">Log your run once it’s done.</div>'+formHtml;
  return '<section class="run-waiting" aria-label="Waiting for Strava"><strong>Waiting for Strava</strong>'+
    '<p>Save the run on your watch. It lands here with your time, splits and heart rate, then you add how it felt.</p>'+
    '<button type="button" class="run-waiting-check" onclick="runCheckStravaNow(this)">Check now</button></section>'+
    '<details class="run-manual"><summary>No watch? Log it by hand</summary>'+formHtml+'</details>';
}
async function runCheckStravaNow(button){
  if(button){button.disabled=true;button.textContent='Checking…';}
  try{if(typeof refreshStravaSessionMatches==='function')await refreshStravaSessionMatches();}
  finally{
    if(button){button.disabled=false;button.textContent='Check now';}
    if(typeof focusedSessionIndex!=='undefined'&&focusedSessionIndex!=null&&typeof rebuildFocusedRun==='function')rebuildFocusedRun(focusedSessionIndex);
  }
}

// Footer state for a run in the session overlay.
function runFocusState(s,i){
  var entry=(typeof logs!=='undefined'&&logs[s.id])||{},logged=typeof isSessionLogged==='function'&&isSessionLogged(s.id);
  if(entry.__stravaMatch&&logged&&!entry.__stravaFeedbackAt){
    var missing=runCheckinMissing(i);
    return {title:'Run received from Strava',detail:missing?(missing===1?'1 answer left':'2 answers left'):'Ready to send',action:'Send to coaches',submit:true,run:'feedback'};
  }
  if(entry.__stravaFeedbackAt||logged)return {title:'Sent to your coaches',detail:'Your coaches have this run.',action:'Back to plan',submit:false};
  return {title:'Not run yet',detail:window._stravaConnectedNow?'Your run syncs from Strava.':'Log it once it’s done.',action:'Back to plan',submit:false};
}
