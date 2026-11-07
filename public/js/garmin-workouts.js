// Coach-programmed runs saved to Garmin Connect only after the athlete reviews
// the exact workout and taps Send. The server re-reads the published
// prescription and refuses a send whose preview is out of date, so what the
// athlete saw is what Garmin receives. Status wording never claims more than
// the server confirmed: "saved to Garmin Connect" once the calendar entry
// exists, and the watch only after the athlete syncs it.
(function(){
  var pending = Object.create(null);
  var reviewed = Object.create(null);
  // Same list as GARMIN_RUN_SESSION_TYPES in api/_lib/garmin-workouts.js and
  // the coaches dashboard's run-workout.js. Mixed sessions (Brick) stay out.
  var RUN_TYPES=['run','running','easy','easy effort','recovery','long','long run','tempo','threshold','speed','interval','intervals','vo2','fartlek','hills','mp','race','time trial'];
  var LABELS = {WARMUP:'Warm-up',ACTIVE:'Run',INTERVAL:'Interval',RECOVERY:'Recovery',REST:'Rest',COOLDOWN:'Cool-down'};
  function escape(value){return String(value==null?'':value).replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];});}
  function session(i){return typeof sessions!=='undefined'&&sessions[i];}
  function container(button){return button&&button.closest('.garmin-workout');}
  function message(el,value,tone){var status=el&&el.querySelector('[role="status"]');if(!status)return;status.textContent=value;if(tone)status.setAttribute('data-tone',tone);else status.removeAttribute('data-tone');}
  function statusReady(){return Promise.resolve(window._garminLoadPromise).catch(function(){return null;});}
  function sendsToGarmin(s){return RUN_TYPES.indexOf(String((s&&s.sessionType)||'').trim().toLowerCase())>=0;}
  function day(iso){
    var d=new Date(String(iso)+'T12:00:00');
    if(isNaN(d.getTime()))return String(iso||'');
    try{return d.toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'});}catch(e){return String(iso);}
  }
  function pace(speed){var sec=Math.round(1000/Number(speed));return Math.floor(sec/60)+':'+('0'+sec%60).slice(-2);}
  function time(seconds){
    var s=Math.round(Number(seconds));if(!(s>0))return '';
    if(s<60||(s<=120&&s%60))return s+' s';
    var h=Math.floor(s/3600),m=Math.floor(s%3600/60),r=s%60;
    return [h?h+' h':'',m?m+' min':'',r?r+' s':''].filter(Boolean).join(' ');
  }
  function distance(metres){var m=Number(metres);return m>=1000?(Math.round(m/10)/100)+' km':Math.round(m)+' m';}
  // Only shown to an athlete Garmin is offered to (the allowlist), and only
  // when workout sending is switched on. Not connected, or connected without
  // workout import, gets a one-tap way to fix it instead of the Review button.
  function setupHtml(title,body,label){
    return '<section class="garmin-workout" aria-label="Get this run on your Garmin"><strong>'+escape(title)+'</strong><p>'+escape(body)+'</p><button type="button" class="savebtn" onclick="if(window.garminConnect)window.garminConnect()">'+escape(label)+'</button></section>';
  }
  window.garminWorkoutHtml=function(s,i){
    var state=window._garminWorkoutState;
    if(!s||getType(s)!=='run'||!sendsToGarmin(s)||!state||!state.available||!state.workoutsAvailable)return '';
    if(!state.connected)return setupHtml('Garmin Connect','Connect Garmin to save your coach’s runs to your Garmin calendar and watch.','Connect Garmin');
    if(state.workoutImportMissing)return setupHtml('Garmin Connect','Garmin isn’t allowing DP to add workouts. Reconnect Garmin and tick workout import.','Reconnect Garmin');
    return '<section class="garmin-workout" data-garmin-session="'+escape(s.id)+'" aria-label="Save this run to Garmin Connect"><strong>Garmin Connect</strong><p>Review this run, then save it to your Garmin Connect calendar. Sync a compatible watch afterwards to load it.</p><button type="button" class="savebtn" onclick="previewGarminWorkout('+i+',this)">Review for Garmin</button><div class="garmin-workout-preview"></div><p role="status" aria-live="polite"></p></section>';
  };
  function describe(step){
    if(step.type==='WorkoutRepeatStep')return '<li><strong>Repeat '+Number(step.repeatValue)+' times</strong><ol>'+(step.steps||[]).map(describe).join('')+'</ol></li>';
    var end=step.durationType==='DISTANCE'?distance(step.durationValue):step.durationType==='TIME'?time(step.durationValue):'Until you press lap';
    var target='';
    if(step.targetType==='PACE')target=' · '+pace(step.targetValueHigh)+'–'+pace(step.targetValueLow)+' /km';
    if(step.targetType==='HEART_RATE')target=' · Heart-rate zone '+Number(step.targetValue);
    return '<li><strong>'+escape(LABELS[step.intensity]||'Run')+'</strong> · '+escape(end+target)+(step.description?'<small>'+escape(step.description)+'</small>':'')+'</li>';
  }
  function reconnectLink(el,href){
    var url;try{url=new URL(href,location.origin);}catch(e){url=null;}
    if(!url||url.protocol!=='https:'||url.hostname!=='connect.garmin.com'){message(el,'Reconnect Garmin from Preferences, and allow workout import.','error');return;}
    var link=document.createElement('a');link.className='savebtn';link.textContent='Reconnect Garmin';link.href=url.href;
    el.querySelector('.garmin-workout-preview').appendChild(link);
  }
  // Renders a server preview. Returns the send button, if sending is allowed.
  function renderPreview(el,s,i,data){
    var preview=el.querySelector('.garmin-workout-preview');
    reviewed[s.id]=data.fingerprint;
    var steps=(data.workout&&data.workout.segments&&data.workout.segments[0]&&data.workout.segments[0].steps)||[];
    preview.innerHTML='<p><strong>'+escape(data.workout.workoutName)+'</strong><br>Garmin calendar date: '+escape(day(data.date))+'</p><ol>'+steps.map(describe).join('')+'</ol>';
    if(!data.canSend){reconnectLink(el,data.reconnectUrl);message(el,'Garmin hasn’t allowed DP to add workouts. Reconnect Garmin and tick workout import.','error');return null;}
    if(s.date&&data.date&&s.date!==data.date){message(el,'This session shows '+day(s.date)+' here, but '+day(data.date)+' is saved. Wait for your change to save, then review again.','error');return null;}
    var receipt=data.receipt;
    if(receipt&&receipt.state==='creating'){message(el,'Not confirmed: Garmin didn’t answer the last attempt. Check your Garmin Connect calendar and ask your coach to clear it before sending again.','error');return null;}
    var send=document.createElement('button');send.type='button';send.className='savebtn';
    var sent=receipt&&receipt.state==='sent';
    send.textContent=sent&&receipt.upToDate?'Send again':sent?'Update in Garmin Connect':receipt&&receipt.state==='scheduling'?'Finish saving to Garmin':'Send to Garmin';
    send.addEventListener('click',function(){window.sendGarminWorkout(i,send);});preview.appendChild(send);
    if(sent&&receipt.upToDate)message(el,'Already in your Garmin Connect calendar for '+day(receipt.date)+'. Sending again checks it is still there without adding a copy.');
    else if(sent)message(el,'Your coach changed this session or its date since you sent it ('+day(receipt.date)+'). Send the update to replace it in Garmin Connect.');
    else if(receipt&&receipt.state==='scheduling')message(el,'The workout reached Garmin Connect, but its calendar entry wasn’t confirmed. Send again: DP checks your Garmin calendar first.','error');
    else message(el,'Ready to send. This adds one workout to your Garmin Connect calendar.');
    return send;
  }
  window.previewGarminWorkout=async function(i,button){
    var s=session(i),el=container(button),code=athlete&&athlete.code;if(!s||!el||pending[s.id])return;
    pending[s.id]=true;button.disabled=true;message(el,'Loading your coach’s prescription…');
    el.querySelector('.garmin-workout-preview').innerHTML='';
    try{
      var connection=await statusReady();
      if(!connection||!connection.connected){message(el,'Connect Garmin in Preferences first.','error');return;}
      if(!connection.workoutsAvailable){message(el,'Sending workouts to Garmin isn’t switched on for your account yet.','error');return;}
      var result=await portalFetchJson('/api/garmin?mode=workout&sessionId='+encodeURIComponent(s.id),{headers:authHeaders({}),cache:'no-store'},{timeoutMs:15000});
      if(!athlete||athlete.code!==code)return;
      var data=result.data||{};
      if(!result.response.ok)throw new Error(data.error||'Could not load the workout. Try again.');
      renderPreview(el,s,i,data);
    }catch(error){message(el,error.message||'Could not load the workout. Try again.','error');}
    finally{pending[s.id]=false;button.disabled=false;}
  };
  window.sendGarminWorkout=async function(i,button){
    var s=session(i),el=container(button),code=athlete&&athlete.code;if(!s||!el||pending[s.id])return;
    pending[s.id]=true;button.disabled=true;button.textContent='Sending…';message(el,'Saving to your Garmin Connect calendar…');
    var keepDisabled=false;
    try{
      var result=await portalFetchJson('/api/garmin?mode=workout',{method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:JSON.stringify({sessionId:s.id,fingerprint:reviewed[s.id]||''}),cache:'no-store'},{timeoutMs:55000});
      if(!athlete||athlete.code!==code)return;
      var data=result.data||{};
      if(result.response.ok&&data.sent){
        keepDisabled=true;button.textContent='Saved to Garmin Connect';
        message(el,(data.unchanged?'Still in':'Saved to')+' your Garmin Connect calendar for '+day(data.date)+'. Sync your watch with Garmin Connect to load the workout. If your coach later moves or cancels this run, your Garmin calendar won’t change by itself: send it again here, or delete it in Garmin Connect.','done');
        return;
      }
      button.textContent='Send to Garmin';
      if(data.code==='stale_preview'&&data.preview){
        button.remove();renderPreview(el,s,i,data.preview);
        message(el,'Your coach updated this session or its date changed. Review the new version above, then send it.','error');return;
      }
      if(data.code==='reconnect'){button.remove();reconnectLink(el,data.reconnectUrl);message(el,data.error||'Reconnect Garmin and allow workout import.','error');return;}
      if(data.code==='delivery_uncertain'){keepDisabled=true;message(el,'Not confirmed: '+(data.error||'check your Garmin Connect calendar before trying again.'),'error');return;}
      var uncertain=data.code==='unconfirmed'||data.code==='schedule_unconfirmed';
      message(el,(uncertain?'Not confirmed: ':'Not sent: ')+(data.error||'Garmin didn’t confirm the workout.'),'error');
    }catch(error){
      // The request may have reached the server: do not guess, re-check.
      button.textContent='Send to Garmin';keepDisabled=true;
      message(el,'Not confirmed: the connection dropped. Tap Review for Garmin to check whether it reached your Garmin calendar.','error');
    }
    finally{pending[s.id]=false;if(!keepDisabled)button.disabled=false;}
  };
})();
