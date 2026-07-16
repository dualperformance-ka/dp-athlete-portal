// ── DP INSTRUMENT GAUGES ─────────────────────────────────────────────────────
// Open arc: 264° sweep, gap at the bottom. SVG y-down: 90° points down.
var GAUGE_START=138, GAUGE_SWEEP=264, GAUGE_CX=36, GAUGE_CY=36;
function gaugePt(deg,r){var a=deg*Math.PI/180;return[GAUGE_CX+r*Math.cos(a),GAUGE_CY+r*Math.sin(a)];}
// KM: ticked tachometer arc. Ticks light up in a sweep; last tick = target notch.
function buildKmGauge(pct){
  var svg=document.getElementById('kmGauge');
  if(!svg) return;
  var N=36, lit=Math.round(Math.min(100,Math.max(0,pct))/100*N), html='';
  for(var i=0;i<N;i++){
    var a=GAUGE_START+(i/(N-1))*GAUGE_SWEEP;
    var isTgt=(i===N-1);
    var r1=isTgt?24.5:26, r2=isTgt?33:31.5;
    var p1=gaugePt(a,r1), p2=gaugePt(a,r2);
    html+='<line class="gauge-tick'+(isTgt?' tgt':'')+'" x1="'+p1[0].toFixed(2)+'" y1="'+p1[1].toFixed(2)+'" x2="'+p2[0].toFixed(2)+'" y2="'+p2[1].toFixed(2)+'" style="transition-delay:'+(i*16)+'ms"/>';
  }
  svg.innerHTML=html;
  var ticks=svg.querySelectorAll('.gauge-tick');
  requestAnimationFrame(function(){requestAnimationFrame(function(){
    for(var i=0;i<lit;i++) ticks[i].classList.add('lit');
  });});
}
// GYM: one arc segment per session; completed sessions fill in.
function buildGymGauge(done,total){
  var svg=document.getElementById('gymGauge');
  if(!svg) return;
  total=Math.max(1,total);
  var gap=(total>1)?14:0, segSweep=(GAUGE_SWEEP-gap*(total-1))/total, R=28.5, html='';
  for(var i=0;i<total;i++){
    var a0=GAUGE_START+i*(segSweep+gap), a1=a0+segSweep;
    var p0=gaugePt(a0,R), p1=gaugePt(a1,R);
    var large=(segSweep>180)?1:0;
    html+='<path class="gauge-seg" d="M '+p0[0].toFixed(2)+' '+p0[1].toFixed(2)+' A '+R+' '+R+' 0 '+large+' 1 '+p1[0].toFixed(2)+' '+p1[1].toFixed(2)+'" style="transition-delay:'+(i*90)+'ms"/>';
  }
  svg.innerHTML=html;
  var segs=svg.querySelectorAll('.gauge-seg');
  requestAnimationFrame(function(){requestAnimationFrame(function(){
    for(var i=0;i<Math.min(done,total);i++) segs[i].classList.add('done');
  });});
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
  var progress=document.getElementById('kmProgress');
  var progressFill=document.getElementById('kmProgressFill');
  if(progress){
    progress.setAttribute('aria-valuenow',String(done));
    progress.setAttribute('aria-valuemax',String(target));
  }
  if(progressFill) progressFill.style.width=pct+'%';
  var srcEl=document.getElementById('kmSrcStrava');
  if(srcEl) srcEl.style.display=(kmData.source==='strava')?'':'none';
  bar.classList.toggle('km-hit',done>=target);
  bar.style.display='';
  buildKmGauge(pct);
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
