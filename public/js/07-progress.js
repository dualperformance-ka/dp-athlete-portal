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
    else{showToast('Upload failed — try again','error');}
  }catch(e){showToast('Upload failed — check your connection and try again','error');}
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
  var myLogsPromise=(athlete&&athlete.code)?fetch('/api/my-logs?code='+encodeURIComponent(athlete.code),{headers:authHeaders({})}).then(function(r){return r.ok?r.json():null;}).catch(function(){return null;}):Promise.resolve(null);
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

