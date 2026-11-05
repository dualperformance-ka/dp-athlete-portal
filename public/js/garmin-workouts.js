// Coach-programmed workouts sent only after the athlete reviews and taps Send.
(function(){
  var pending = Object.create(null);
  function escape(value){return String(value==null?'':value).replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];});}
  function session(i){return typeof sessions!=='undefined'&&sessions[i];}
  function container(button){return button&&button.closest('.garmin-workout');}
  function message(el,value){var status=el&&el.querySelector('[role="status"]');if(status)status.textContent=value;}
  function statusReady(){return Promise.resolve(window._garminLoadPromise).catch(function(){return null;});}
  window.garminWorkoutHtml=function(s,i){
    if(!s||getType(s)!=='run'||!window._garminWorkoutState||!window._garminWorkoutState.connected||!window._garminWorkoutState.workoutsAvailable)return '';
    return '<section class="garmin-workout" data-garmin-session="'+escape(s.id)+'" aria-label="Send running workout to Garmin Connect"><strong>Garmin Connect</strong><p>Review this session, then send it to your Garmin Connect calendar and sync your watch.</p><button type="button" class="savebtn" onclick="previewGarminWorkout('+i+',this)">Review for Garmin</button><div class="garmin-workout-preview"></div><p role="status" aria-live="polite"></p></section>';
  };
  function describe(step){
    if(step.type==='WorkoutRepeatStep')return '<li><strong>Repeat '+Number(step.repeatValue)+' times</strong><ol>'+step.steps.map(describe).join('')+'</ol></li>';
    var duration=step.durationType==='DISTANCE'?(Number(step.durationValue)/1000)+' km':step.durationType==='TIME'?Math.round(Number(step.durationValue)/6)/10+' min':'Until lap press';
    var target='';
    function pace(speed){var sec=Math.round(1000/Number(speed));return Math.floor(sec/60)+':'+('0'+sec%60).slice(-2);}
    if(step.targetType==='PACE')target=' · '+pace(step.targetValueHigh)+'–'+pace(step.targetValueLow)+' /km';
    if(step.targetType==='HEART_RATE')target=' · HR zone '+Number(step.targetValue);
    return '<li><strong>'+escape(String(step.intensity||'Run').toLowerCase())+'</strong> · '+escape(duration+target)+(step.description?'<small>'+escape(step.description)+'</small>':'')+'</li>';
  }
  window.previewGarminWorkout=async function(i,button){
    var s=session(i),el=container(button),code=athlete&&athlete.code;if(!s||!el||pending[s.id])return;
    pending[s.id]=true;button.disabled=true;message(el,'Loading your coach’s prescription…');
    try{
      var connection=await statusReady();
      if(!connection||!connection.connected){message(el,'Connect Garmin in Preferences first.');return;}
      if(!connection.workoutsAvailable){message(el,'Garmin workout sending is not enabled yet.');return;}
      var result=await portalFetchJson('/api/garmin?mode=workout&sessionId='+encodeURIComponent(s.id),{headers:authHeaders({}),cache:'no-store'},{timeoutMs:15000});
      if(!athlete||athlete.code!==code)return;
      var data=result.data||{};
      if(!result.response.ok)throw new Error(data.error||'Could not load the workout.');
      var preview=el.querySelector('.garmin-workout-preview');
      preview.innerHTML='<p><strong>'+escape(data.workout.workoutName)+'</strong><br>Scheduled for '+escape(data.date)+'</p><ol>'+data.workout.segments[0].steps.map(describe).join('')+'</ol>';
      if(!data.canSend){
        var reconnect=document.createElement('a');reconnect.className='savebtn';reconnect.textContent='Reconnect Garmin';
        var url=new URL(data.reconnectUrl,location.origin);
        if(url.protocol!=='https:'||url.hostname!=='connect.garmin.com')throw new Error('Reconnect Garmin from Preferences.');
        reconnect.href=url.href;preview.appendChild(reconnect);message(el,'Allow workout import when reconnecting Garmin.');return;
      }
      if(data.receipt&&['creating','scheduling'].indexOf(data.receipt.state)>=0){message(el,'Delivery is uncertain. Check Garmin Connect and contact your coach before sending again.');return;}
      var send=document.createElement('button');send.type='button';send.className='savebtn';send.textContent=data.receipt&&data.receipt.state==='sent'?'Update in Garmin Connect':'Send to Garmin';
      send.addEventListener('click',function(){window.sendGarminWorkout(i,send);});preview.appendChild(send);
      message(el,data.receipt&&data.receipt.state==='sent'?'Previously sent for '+data.receipt.date+'. You can resend to apply coach changes.':'Ready to send. Garmin Connect will sync it to a compatible watch.');
    }catch(error){message(el,error.message||'Could not load the workout. Try again.');}
    finally{pending[s.id]=false;button.disabled=false;}
  };
  window.sendGarminWorkout=async function(i,button){
    var s=session(i),el=container(button),code=athlete&&athlete.code;if(!s||!el||pending[s.id])return;
    pending[s.id]=true;button.disabled=true;message(el,'Sending to Garmin Connect…');
    try{
      var result=await portalFetchJson('/api/garmin?mode=workout',{method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:JSON.stringify({sessionId:s.id}),cache:'no-store'},{timeoutMs:55000});
      if(!athlete||athlete.code!==code)return;
      var data=result.data||{};
      if(!result.response.ok||!data.sent)throw new Error(data.error||'Delivery was not confirmed. Check Garmin Connect before trying again.');
      button.textContent='Sent to Garmin Connect';message(el,'Scheduled for '+data.date+'. Sync Garmin Connect with your watch to receive the workout.');
    }catch(error){message(el,error.message||'Delivery was not confirmed. Check Garmin Connect before trying again.');button.disabled=false;}
    finally{pending[s.id]=false;}
  };
})();
