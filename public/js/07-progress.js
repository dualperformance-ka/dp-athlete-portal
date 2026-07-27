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
    html+='<button type="button" class="photo-cell'+(count?' has-photo':'')+(isCurrent?' current-week':'')+'" onclick="openPhotoModal('+w+')" aria-label="Open '+wLabel+' progress photos">';
    if(isCurrent) html+='<div class="current-week-badge">Now</div>';
    if(firstUrl){html+='<img src="'+firstUrl+'" alt="'+wLabel+'" onerror="pgImgDead(this)" /><div class="photo-count">'+count+'/5</div><div class="photo-overlay">'+wLabel+'</div>';}
    else{html+='<div class="photo-add">+</div><div class="photo-label">'+wLabel+'</div>';}
    html+='</button>';
  }
  grid.innerHTML=html;
  if(window.matchMedia&&window.matchMedia('(max-width:760px)').matches){
    var current=grid.querySelector('.photo-cell.current-week');
    if(current)requestAnimationFrame(function(){grid.scrollLeft=Math.max(0,current.offsetLeft-(grid.clientWidth-current.clientWidth)/2);});
  }
}
// A dead image URL (e.g. asset renamed in Cloudinary) falls back to the empty
// "+" cell instead of a broken-image icon — the athlete can just re-upload.
function pgImgDead(img){
  var cell=img.closest('.photo-cell');if(!cell)return;
  var label=(cell.querySelector('.photo-overlay')||{textContent:''}).textContent;
  cell.classList.remove('has-photo');
  cell.innerHTML='<div class="photo-add">+</div><div class="photo-label">'+esc(label)+'</div>';
}
function angleImgDead(img){
  var slot=img.closest('.angle-slot');if(!slot)return;
  var angle=(slot.querySelector('.aslot-overlay')||{textContent:''}).textContent;
  slot.classList.remove('has-photo');
  slot.innerHTML='<div class="aslot-add">+</div><div class="aslot-label">'+esc(angle)+'</div>';
  slot.onclick=function(){triggerAngleUpload(angle);};
}
function openPhotoModal(week){currentPhotoWeek=week;document.getElementById('photoModalTitle').textContent=(week===0?'Discovery Week':'Week '+week)+' Photos';renderAngleGrid(week);document.getElementById('photoModal').classList.add('open');document.body.style.overflow='hidden';}
function closePhotoModal(e){if(e&&e.target!==document.getElementById('photoModal')&&!e.target.classList.contains('photo-modal-close')) return;document.getElementById('photoModal').classList.remove('open');document.body.style.overflow='';renderPhotoGrid();}
function renderAngleGrid(week){
  var photos=getPhotos(),weekPhotos=photos['week'+week]||{},html='';
  ANGLES.forEach(function(angle){
    var key=angle.toLowerCase().replace(/\s/g,'_');var url=weekPhotos[key]||'';
    html+='<div class="angle-slot'+(url?' has-photo':'')+'" id="aslot_'+key+'"'+(url?'':' onclick="triggerAngleUpload(\''+angle+'\')"')+'>';
    if(url){html+='<img src="'+url+'" alt="'+esc(angle)+' progress photo" onerror="angleImgDead(this)" /><div class="aslot-overlay">'+angle+'</div><button aria-label="Remove '+esc(angle)+' progress photo" onclick="deleteAnglePhoto(\''+angle+'\')" style="position:absolute;top:6px;right:6px;z-index:3;background:rgba(0,0,0,.6);border:none;border-radius:50%;width:26px;height:26px;color:#fff;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1">×</button>';}
    else{html+='<div class="aslot-add">+</div><div class="aslot-label">'+angle+'</div>';}
    html+='</div>';
  });
  document.getElementById('angleGrid').innerHTML=html;
}
async function deleteAnglePhoto(angle){
  if(!confirm('Remove '+angle+' photo for Week '+currentPhotoWeek+'?')) return;
  var key=angle.toLowerCase().replace(/\s/g,'_');var photos=getPhotos();
  try{
    var response=await fetch('/api/progress-photos',{method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:JSON.stringify({action:'delete',week:currentPhotoWeek,slot:key})});
    var result=await response.json().catch(function(){return{};});
    if(!response.ok||result.deleted===false)throw new Error(result.error||'Delete failed');
  }catch(e){showToast('Could not remove the cloud photo — try again','error');return;}
  if(photos['week'+currentPhotoWeek]){delete photos['week'+currentPhotoWeek][key];if(!Object.keys(photos['week'+currentPhotoWeek]).length) delete photos['week'+currentPhotoWeek];savePhotos(photos);renderAngleGrid(currentPhotoWeek);showToast(angle+' photo removed');}
}
function triggerAngleUpload(angle){currentAngle=angle;document.getElementById('angleInput').click();}
function prepareProgressImage(file){
  return new Promise(function(resolve,reject){
    var reader=new FileReader();
    reader.onerror=function(){reject(new Error('Could not read image'));};
    reader.onload=function(){
      var img=new Image();
      img.onerror=function(){reject(new Error('This image format is not supported'));};
      img.onload=function(){
        var max=1800,scale=Math.min(1,max/Math.max(img.width,img.height));
        var canvas=document.createElement('canvas');
        canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));
        var ctx=canvas.getContext('2d');ctx.drawImage(img,0,0,canvas.width,canvas.height);
        var data=canvas.toDataURL('image/jpeg',.84);
        if(data.length>4*1024*1024){reject(new Error('Image is too large after resizing'));return;}
        resolve(data);
      };
      img.src=reader.result;
    };
    reader.readAsDataURL(file);
  });
}
async function handleAngleUpload(input){
  if(!input.files||!input.files[0]) return;
  var file=input.files[0],week=currentPhotoWeek,angle=currentAngle,key=angle.toLowerCase().replace(/\s/g,'_');
  var slot=document.getElementById('aslot_'+key);if(slot) slot.classList.add('uploading');
  try{
    var imageData=await prepareProgressImage(file);
    var res=await fetch('/api/progress-photos',{method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:JSON.stringify({action:'upload',week:week,slot:key,imageData:imageData})});
    var data=await res.json();
    if(res.ok&&data.photo&&data.photo.secureUrl){
      var photos=getPhotos();if(!photos['week'+week]) photos['week'+week]={};photos['week'+week][key]=data.photo.secureUrl;
      savePhotos(photos);
      if(_authToken&&athlete&&athlete.code){
        try{await portalStateWrite('photos',photos);}
        catch(e){console.warn('Photo cloud sync failed:',e);}
      }
      renderAngleGrid(week);showToast(angle+' uploaded ✓');initPhotoNudge();
    }
    else{showToast(data.error||'Upload failed — try again','error');}
  }catch(e){showToast(e.message||'Upload failed — check your connection and try again','error');}
  if(slot) slot.classList.remove('uploading');input.value='';
}

// ── PROGRESS ──────────────────────────────────────────────────────────────────
function formatKgDelta(v){if(v==null||isNaN(v)) return '—';var n=Number(v);var rounded=Math.abs(n)<0.05?0:n;return(rounded>0?'+':'')+rounded.toFixed(1)+'kg';}
function formatKgValue(v){if(v==null||String(v).trim()===''||String(v).trim()==='—')return'—';var s=String(v).trim();return/kg$/i.test(s)?s:s+'kg';}
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
  var yLines=yTicks.map(function(v){var y=padT+((maxW-v)/(maxW-minW))*usableH;return '<line x1="'+padL+'" y1="'+y.toFixed(1)+'" x2="'+(width-padR)+'" y2="'+y.toFixed(1)+'" stroke="var(--border)" stroke-width="1"/><text x="'+(width-padR)+'" y="'+(y-6).toFixed(1)+'" text-anchor="end" fill="var(--dim)" style="font-family:var(--mono);font-size:10px">'+v.toFixed(1)+'kg</text>';}).join('');
  var xLabels='<text x="'+coords[0].x.toFixed(1)+'" y="'+(height-8)+'" text-anchor="start" fill="var(--dim)" style="font-family:var(--mono);font-size:10px">'+new Date(points[0].date).toLocaleDateString('en-AU',{day:'numeric',month:'short'})+'</text><text x="'+coords[coords.length-1].x.toFixed(1)+'" y="'+(height-8)+'" text-anchor="end" fill="var(--dim)" style="font-family:var(--mono);font-size:10px">'+new Date(points[points.length-1].date).toLocaleDateString('en-AU',{day:'numeric',month:'short'})+'</text>';
  var dots=coords.map(function(c,idx){var isLast=idx===coords.length-1;return '<circle cx="'+c.x.toFixed(1)+'" cy="'+c.y.toFixed(1)+'" r="'+(isLast?4.4:3.2)+'" fill="'+(isLast?'var(--text)':'var(--run)')+'"/>';}).join('');
  var targetLine='';var targetNum=targetWeight!=null&&!isNaN(targetWeight)?Number(targetWeight):null;
  if(targetNum!=null&&targetNum>=minW&&targetNum<=maxW){var ty=padT+((maxW-targetNum)/(maxW-minW))*usableH;targetLine='<line x1="'+padL+'" y1="'+ty.toFixed(1)+'" x2="'+(width-padR)+'" y2="'+ty.toFixed(1)+'" stroke="var(--run-border)" stroke-dasharray="4 4" stroke-width="1"/><text x="'+padL+'" y="'+(ty-6).toFixed(1)+'" fill="var(--run)" style="font-family:var(--mono);font-size:10px">Target '+targetNum.toFixed(1)+'kg</text>';}
  chartEl.innerHTML='<svg viewBox="0 0 '+width+' '+height+'" width="100%" height="220" role="img" aria-label="Weight trend chart">'+yLines+targetLine+'<polygon points="'+areaPoly+'" fill="var(--run-bg)"></polygon><polyline points="'+poly+'" fill="none" stroke="var(--run)" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"></polyline>'+dots+xLabels+'</svg>';
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


// ── RUNNING VOLUME CHART ──────────────────────────────────────────────────────
// Same data as the weekly volume strip, drawn full-width: a planned column per
// programme week with actual km filled over it. Built as inline SVG to match
// renderWeightChart() rather than pulling in a chart library.
async function renderVolumeChart(){
  var card=document.getElementById('pgVolumeCard'),el=document.getElementById('pgVolumeChart');
  if(!card||!el) return;
  var data=null;
  try{data=await loadProgrammeVolume();}catch(e){}
  var weeks=(data&&data.weeks)||[];
  var planned=weeks.filter(function(w){return w.planned;});
  if(!planned.length){card.style.display='none';return;}
  var max=0;
  weeks.forEach(function(w){max=Math.max(max,w.planned||0,w.actual||0);});
  if(max<=0){card.style.display='none';return;}
  // Show the card before measuring: a hidden element has no width, and the chart
  // stretches to fill wide cards while staying scrollable on narrow phones.
  card.style.display='';
  var natural=Math.max(320,weeks.length*46);
  var width=Math.max(natural,el.clientWidth||0),height=210,padB=30,padT=14,plot=height-padB-padT;
  var slot=width/weeks.length,barW=Math.min(26,slot*0.56);
  var grid='',bars='',labels='';
  [0,0.5,1].forEach(function(f){
    var y=padT+plot*(1-f);
    grid+='<line x1="0" y1="'+y.toFixed(1)+'" x2="'+width+'" y2="'+y.toFixed(1)+'" stroke="var(--border)" stroke-width="1"/>';
    grid+='<text x="2" y="'+(y-4).toFixed(1)+'" fill="var(--dim)" font-size="9" font-family="var(--body)">'+Math.round(max*f)+'</text>';
  });
  weeks.forEach(function(w,i){
    var cx=slot*i+slot/2,x=cx-barW/2;
    if(w.planned){
      var ph=Math.max(2,w.planned/max*plot),py=padT+plot-ph;
      bars+='<rect x="'+x.toFixed(1)+'" y="'+py.toFixed(1)+'" width="'+barW.toFixed(1)+'" height="'+ph.toFixed(1)+'" rx="3" fill="var(--run-bg-strong,var(--run-bg))" stroke="var(--run-border)" stroke-width="1"/>';
    }
    if(w.actual!=null&&w.actual>0){
      var ah=Math.max(2,Math.min(w.actual,max)/max*plot),ay=padT+plot-ah;
      var hit=w.planned&&w.actual>=w.planned;
      bars+='<rect x="'+(x+barW*0.18).toFixed(1)+'" y="'+ay.toFixed(1)+'" width="'+(barW*0.64).toFixed(1)+'" height="'+ah.toFixed(1)+'" rx="3" fill="'+(hit?'var(--ok)':'var(--run)')+'"/>';
    }
    if(w.isCurrent){
      bars+='<rect x="'+(x-3).toFixed(1)+'" y="'+padT+'" width="'+(barW+6).toFixed(1)+'" height="'+plot+'" rx="5" fill="none" stroke="var(--run)" stroke-width="1" stroke-dasharray="3 3" opacity=".55"/>';
    }
    var show=weeks.length<=14||w.week%2===1||w.isCurrent;
    if(show) labels+='<text x="'+cx.toFixed(1)+'" y="'+(height-12)+'" text-anchor="middle" fill="'+(w.isCurrent?'var(--run-strong)':'var(--dim)')+'" font-size="10" font-weight="'+(w.isCurrent?'700':'500')+'" font-family="var(--body)">'+w.week+'</text>';
  });
  el.innerHTML='<div class="pgvol-scroll"><svg viewBox="0 0 '+width+' '+height+'" width="'+width+'" height="'+height+'" role="img" aria-label="Planned and completed running kilometres by programme week">'
    +grid+bars+labels
    +'<text x="'+(width/2)+'" y="'+(height-1)+'" text-anchor="middle" fill="var(--dim)" font-size="9" font-family="var(--body)">Programme week</text></svg></div>';
  var peak=planned.reduce(function(a,b){return b.planned>a.planned?b:a;});
  var avg=planned.reduce(function(t,w){return t+w.planned;},0)/planned.length;
  var done=weeks.reduce(function(t,w){return t+(w.actual||0);},0);
  var set=function(id,val){var n=document.getElementById(id);if(n)n.textContent=val;};
  set('pgVolPeak','W'+peak.week+' · '+fmtKmVal(peak.planned)+'km');
  set('pgVolAvg',fmtKmVal(avg)+'km');
  set('pgVolDone',data.hasActual?fmtKmVal(done)+'km':'—');
}
// Redraw on resize/rotate so the bars keep filling the card width.
var _volResizeTimer=null;
window.addEventListener('resize',function(){
  var card=document.getElementById('pgVolumeCard');
  if(!card||card.style.display==='none')return;
  clearTimeout(_volResizeTimer);
  _volResizeTimer=setTimeout(function(){renderVolumeChart();},200);
});
async function loadProgress(){
  renderPhotoGrid();
  renderVolumeChart();
  var savedGoals=JSON.parse(localStorage.getItem('dp_goals_'+athlete.code)||'{}');
  var portalStartWeight=savedGoals.startWeight||savedGoals.weight||athlete.startWeight||'';
  var progressWeek=getCurrentProgrammeWeek();
  var progressWeekEl=document.getElementById('pgProgressWeek');if(progressWeekEl)progressWeekEl.textContent='Week '+progressWeek;
  document.getElementById('pgStart').textContent=formatKgValue(portalStartWeight);
  document.getElementById('pgCurrent').textContent='—';
  document.getElementById('pgTarget').textContent=formatKgValue(athlete.targetWeight);
  document.getElementById('pgChange').textContent='—';
  document.getElementById('pgChange').style.color='';
  document.getElementById('pgChangeLbl').textContent='Change';
  var lastUpdatedEl=document.getElementById('pgLastUpdated');if(lastUpdatedEl)lastUpdatedEl.textContent='Loading latest entry…';
  document.getElementById('pgLoadingEl').style.display='block';
  document.getElementById('pgWeightLog').style.display='none';
  document.getElementById('pgNoData').style.display='none';
  // Structured daily_body_logs (server-side via /api/my-logs, service key) is the
  // source of truth; athlete_data fills any local-only gaps. The Notion read was
  // removed on 2026-07-20 — Supabase alone now backs the progress view.
  var sbEntries={};
  var myLogsPromise=(athlete&&athlete.code)?portalRequest('body-logs').then(function(r){return {body:r.rows||[]};}).catch(function(){return null;}):Promise.resolve(null);
  var sbPromise=_authToken?portalRequest('state-read').then(function(r){return {data:(r.rows||[]).filter(function(row){return String(row.key||'').indexOf('daily_body_')===0;})};}).catch(function(){return null;}):Promise.resolve(null);
  var both=await Promise.all([myLogsPromise,sbPromise]);
  var myRes=both[0],sbRes=both[1];
  try{
    if(myRes&&myRes.body){myRes.body.forEach(function(row){var date=String(row.log_date||'').slice(0,10);if(date&&row.weight!=null&&row.weight!==''&&!sbEntries[date]) sbEntries[date]={date:date,weight:String(row.weight),sleep:row.sleep,energy:row.energy,stress:row.stress,soreness:row.soreness,notes:row.notes};});}
  }catch(e){}
  try{
    if(sbRes&&sbRes.data){sbRes.data.forEach(function(row){var date=row.key.replace('daily_body_','');if(row.value&&row.value.weight&&!sbEntries[date]) sbEntries[date]=row.value;});}
  }catch(e){}
  document.getElementById('pgLoadingEl').style.display='none';
  var entries=Object.values(sbEntries).filter(function(e){return e.weight&&!isNaN(parseFloat(e.weight));}).map(function(e){return{date:e.date,weight:parseFloat(e.weight)};}).sort(function(a,b){return b.date.localeCompare(a.date);});
  if(!entries.length){document.getElementById('pgNoData').style.display='block';if(lastUpdatedEl)lastUpdatedEl.textContent='No weigh-ins yet';renderWeightChart([],null);return;}
  // Remap to format expected by rest of function (weight chart etc uses r.properties)
  // We'll handle the Supabase path inline below
  var currentWeight=entries[0].weight;
  var firstLoggedWeight=entries[entries.length-1].weight;
  var targetFromAthlete=athlete.targetWeight&&athlete.targetWeight!=='—'?athlete.targetWeight:null;
  var targetFinal=formatKgValue(savedGoals.targetWeight||targetFromAthlete);
  var startWeight=parseFloat(String(portalStartWeight).replace(/[^0-9.\-]/g,''));
  if(isNaN(startWeight)) startWeight=firstLoggedWeight;
  document.getElementById('pgStart').textContent=portalStartWeight?formatKgValue(portalStartWeight):(startWeight?formatKgValue(startWeight):'—');
  document.getElementById('pgCurrent').textContent=currentWeight?formatKgValue(currentWeight):'—';
  if(lastUpdatedEl)lastUpdatedEl.textContent='Last logged '+new Date(entries[0].date+'T00:00:00').toLocaleDateString('en-AU',{day:'numeric',month:'short'});
  document.getElementById('pgTarget').textContent=targetFinal;
  if(startWeight&&currentWeight&&!isNaN(startWeight)){
    var change=(currentWeight-startWeight).toFixed(1);var positive=change>0;
    var changeEl=document.getElementById('pgChange');changeEl.textContent=(positive?'+':'')+change+'kg';changeEl.style.color=positive?'var(--run)':'var(--ok)';
    document.getElementById('pgChangeLbl').textContent=portalStartWeight?'Since starting weight':'Since first weigh-in';
  }
  var targetNumber=parseFloat(String(targetFinal).replace(/[^0-9.\-]/g,''));
  var syntheticForChart=entries.map(function(e){return{properties:{'Weight':{number:e.weight},'Date':{date:{start:e.date}}}};});
  renderWeightChart(syntheticForChart,isNaN(targetNumber)?null:targetNumber);
  var COLLAPSED_ROWS=5;
  var html='<table class="weight-log-table"><thead><tr><th>Date</th><th>Weight</th><th>Change</th></tr></thead><tbody>';
  entries.forEach(function(e,idx){
    var dateLabel=e.date?formatDateTimeDMY(e.date):'';
    var changeStr='—',changeColor='var(--dim)';
    if(idx<entries.length-1){var prevWeight=entries[idx+1].weight;if(prevWeight!=null){var diff=(e.weight-prevWeight).toFixed(1);changeStr=(diff>0?'+':'')+diff+'kg';changeColor=diff>0?'var(--run)':diff<0?'var(--ok)':'var(--dim)';}}
    var hidden=idx>=COLLAPSED_ROWS?' class="wl-extra" style="display:none"':'';
    html+='<tr'+hidden+'><td>'+dateLabel+'</td><td class="weight-log-value">'+e.weight+'<span>kg</span></td><td class="weight-log-change" style="color:'+changeColor+'">'+changeStr+'</td></tr>';
  });
  html+='</tbody></table>';
  var remaining=entries.length-COLLAPSED_ROWS;
  if(remaining>0){
    html+='<button id="pgWeightToggle" class="weight-log-toggle" onclick="toggleWeightLog()">Show all '+entries.length+' entries</button>';
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
