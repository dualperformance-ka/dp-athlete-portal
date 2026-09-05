// ── TODAY'S FOCUS ─────────────────────────────────────────────────────────────
// Derives the one line the athlete reads first: why today's session exists,
// how it sits in the week, and the coach moment above it. Moved out of
// 08-training.js unchanged — same function names, same signatures, same
// global scope. Loads before 08-training.js, which calls into it.

function sessionWhy(type,meta,title){
  var text=((meta&&((meta.intensity||'')+' '+(meta.type||'')+' '+(meta.description||'')))+' '+(title||'')).toLowerCase();
  if(/recovery|easy/.test(text))return 'Absorb the harder work, build aerobic volume and arrive fresher for the next key session.';
  if(/threshold|tempo/.test(text))return 'Raise the pace you can sustain comfortably so race effort feels more controlled.';
  if(/interval|vo2|hill|speed|fartlek/.test(text))return 'Develop speed, running economy and confidence when the pace starts to bite.';
  if(/long/.test(text))return 'Build endurance, fuelling confidence and the durability you need late in your goal event.';
  return 'Build the specific fitness your current programme phase needs while keeping the week balanced.';
}
// ── TODAY'S FOCUS ────────────────────────────────────────────────────────────
// The card used to print one hardcoded sentence under a pair of coach avatars,
// every day, for every athlete. It read as if a human had written it that
// morning. It had not.
//
// Two states now, and the difference is load-bearing:
//   * a coach override note exists  -> "Coach cue for today", avatars, verbatim
//   * no note                       -> "Today's focus", NO avatars, derived
// The avatars are the signal that a human wrote the line. Generated text never
// borrows that signal, and never speaks in a coach's voice.
//
// deriveTodayFocus is pure on purpose — no DOM, no globals, no clock. The date
// is passed in. That is what makes the priority order testable.
function focusDate(value){
  var m=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(!m)return null;
  var d=new Date(Number(m[1]),Number(m[2])-1,Number(m[3]));
  return isNaN(d.getTime())?null:d;
}
function focusISO(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function focusDayGap(fromISO,toISO){
  var a=focusDate(fromISO),b=focusDate(toISO);
  if(!a||!b)return null;
  return Math.round((b-a)/86400000);
}
// "tomorrow" / "on Friday" / "on 12 Sep" — whichever is the least ambiguous at
// that distance. Weekday names stop being useful past a week out.
function focusWhenLabel(fromISO,toISO){
  var gap=focusDayGap(fromISO,toISO),to=focusDate(toISO);
  if(gap==null||!to)return '';
  if(gap<=0)return 'later today';
  if(gap===1)return 'tomorrow';
  if(gap<7)return 'on '+to.toLocaleDateString('en-AU',{weekday:'long'});
  return 'on '+to.toLocaleDateString('en-AU',{day:'numeric',month:'short'});
}
// Days remaining in the Monday-start week that contains this date, today
// included. Monday = 7, Sunday = 1 — the same week boundary getMon() uses.
function focusDaysLeftInWeek(iso){
  var d=focusDate(iso);
  if(!d)return null;
  var day=d.getDay();
  return day===0?1:8-day;
}
function focusSessionText(session){
  if(!session)return '';
  return String((session.name||'')+' '+(session.type||'')+' '+(session.intensity||'')+' '+(session.description||'')).toLowerCase();
}
// Consecutive training days ending today. Today counts because rule 1 has
// already established there is a session on it.
function focusConsecutiveDays(iso,loggedDates){
  var d=focusDate(iso);
  if(!d||!Array.isArray(loggedDates))return null;
  var seen={};
  loggedDates.forEach(function(value){var key=String(value||'').slice(0,10);if(key)seen[key]=1;});
  var count=1,cursor=new Date(d.getFullYear(),d.getMonth(),d.getDate());
  for(var guard=0;guard<30;guard++){
    cursor.setDate(cursor.getDate()-1);
    if(!seen[focusISO(cursor)])break;
    count++;
  }
  return count;
}
function focusOrdinal(n){
  var names={2:'Second',3:'Third',4:'Fourth',5:'Fifth',6:'Sixth',7:'Seventh',8:'Eighth',9:'Ninth'};
  return names[n]||(n+'th');
}
function focusRound(n){return (Math.round(n*10)/10).toFixed(1).replace(/\.0$/,'');}
function focusNumber(value){
  var n=Number(value);
  return (value===null||value===undefined||value===''||!isFinite(n))?null:n;
}
function focusSessionNames(sessions){
  var names=sessions.map(function(s){return String((s&&s.name)||'').trim();}).filter(Boolean);
  if(!names.length)return '';
  if(names.length===1)return names[0];
  return names.slice(0,-1).join(', ')+' and '+names[names.length-1];
}
// Rules are evaluated in priority order and the first match wins. A rule whose
// data is missing is skipped rather than guessed at — that is why every branch
// tests for the value it needs before it commits to a sentence.
function deriveTodayFocus(ctx){
  ctx=ctx||{};
  var today=String(ctx.date||'');
  var sessions=(Array.isArray(ctx.sessions)?ctx.sessions:[]).filter(Boolean);
  var planned=focusNumber(ctx.planned),completed=focusNumber(ctx.completed);
  var readiness=focusNumber(ctx.readiness);
  var kmDone=focusNumber(ctx.kmDone),kmTarget=focusNumber(ctx.kmTarget);
  var week=focusNumber(ctx.week);

  // 1 — nothing scheduled. Say so, and point at the next thing rather than
  // inventing work to fill the day.
  if(!sessions.length){
    var next=ctx.next;
    var when=next&&next.date?focusWhenLabel(today,next.date):'';
    var nextName=next?String(next.name||'').trim():'';
    if(when&&nextName)return 'No session scheduled today. Next up is '+nextName+' '+when+'.';
    if(when)return 'No session scheduled today. The next session is '+when+'.';
    return 'No session scheduled today. Recovery day.';
  }

  // 2 — readiness is logged and low. The target moves to finishing the session.
  if(readiness!=null&&readiness<40){
    return 'Readiness logged at '+Math.round(readiness)+'. Today is about completing the session, not the intensity of it.';
  }

  // 3 — third or more consecutive training day. Accumulated fatigue is the
  // constraint, so the next key session is what today has to protect.
  var run=focusConsecutiveDays(today,ctx.loggedDates);
  if(run!=null&&run>=3){
    return focusOrdinal(run)+' training day in a row. Quality over volume today so the next key session is not compromised.';
  }

  // 4 — the session type carries its own intent. State it plainly.
  var text=sessions.map(focusSessionText).join(' ');
  if(/interval|vo2|fartlek|speed|hill|rep\b/.test(text)){
    return 'Interval session. The prescribed pace on the reps is the target, and the full recovery between them is part of it.';
  }
  if(/long run|long ride|longrun|\blong\b/.test(text)){
    return 'Long run. Time on feet and fuelling are the point, not the pace — start at the easy end of the range.';
  }
  if(/threshold|tempo/.test(text)){
    return 'Threshold session. Controlled and repeatable, not maximal — the pace should feel sustainable well past the last rep.';
  }
  if(/\bkey\b|benchmark|time trial/.test(text)){
    return 'Key session for the week. The rest of the week is arranged around it, so it takes priority over anything optional.';
  }

  // 5 — behind the weekly running target with the week nearly gone. Show what
  // closing the gap actually costs rather than just flagging the shortfall.
  var daysLeft=focusDaysLeftInWeek(today);
  if(kmTarget!=null&&kmTarget>0&&kmDone!=null&&kmDone<kmTarget&&daysLeft!=null&&daysLeft<=2){
    var remaining=kmTarget-kmDone;
    var perDay=remaining/daysLeft;
    return focusRound(kmDone)+'km of '+focusRound(kmTarget)+'km with '+daysLeft+(daysLeft===1?' day':' days')+
      ' left. Closing that is about '+focusRound(perDay)+'km a day.';
  }

  // 6 — the planned week is already complete. Today adds to it; it is not
  // catch-up, and it should not be treated as if it were.
  if(planned!=null&&planned>0&&completed!=null&&completed>=planned){
    return 'All '+planned+' planned sessions this week are already logged. Today is consolidation, not catch-up.';
  }

  // 7 — first session of the programme week.
  if(completed===0&&planned!=null&&planned>0){
    return week!=null
      ? 'First session of week '+week+'. It sets the reference point the rest of the week gets measured against.'
      : 'First session of the week. It sets the reference point the rest of the week gets measured against.';
  }

  // 8 — nothing distinctive to say. State what today is and stop.
  var names=focusSessionNames(sessions);
  var position=(planned!=null&&planned>0&&completed!=null)?' Session '+Math.min(planned,completed+1)+' of '+planned+' this week.':'';
  if(names)return 'Today: '+names+'.'+position;
  return sessions.length===1?('One session scheduled today.'+position):(sessions.length+' sessions scheduled today.'+position);
}
// Reads the globals so deriveTodayFocus never has to. Kept deliberately thin:
// every value here already exists on the home screen.
function todayFocusContext(todaySessions,insights){
  var todayISO=localISO(new Date());
  var loggedDates=[];
  try{
    (allSessions||[]).forEach(function(s){
      if(!s||!s.date||s.date>=todayISO)return;
      if(trainingSessionIsComplete(s))loggedDates.push(s.date);
    });
  }catch(e){}
  var week=null;try{week=getCurrentProgrammeWeek();}catch(e){}
  return {
    date:todayISO,
    sessions:(todaySessions||[]).map(function(s){return {name:s.name,type:getType(s),intensity:(s.intensity||''),description:(s.description||'')};}),
    planned:insights?insights.planned:null,
    completed:insights?insights.completed:null,
    readiness:insights?insights.readiness:null,
    kmDone:insights?insights.kmDone:null,
    kmTarget:insights?insights.kmTarget:null,
    next:insights&&insights.next?{date:insights.next.date,name:insights.next.name}:null,
    week:week,
    loggedDates:loggedDates
  };
}
function renderCoachMoment(todaySessions,insights){
  todaySessions=todaySessions||[];
  var note='';
  for(var i=0;i<todaySessions.length;i++){var ov=_sessionOverrides[todaySessions[i].id];if(ov&&ov.notes){note=ov.notes;break;}}
  var fromCoach=!!note;
  if(!fromCoach){
    try{note=deriveTodayFocus(todayFocusContext(todaySessions,insights));}catch(e){note='';}
    if(!note)note='Open today’s session for the full brief.';
  }
  track('coach_cue_shown',{source:fromCoach?'coach':'derived'});
  var label=fromCoach?'Coach cue for today':'Today’s focus';
  // No avatars on derived text. The avatars mean a person wrote this.
  var avatars=fromCoach?'<div class="coach-avatars"><span>K</span><span>A</span></div>':'';
  return '<div class="coach-moment'+(fromCoach?'':' is-derived')+'">'+avatars+'<div><div class="coach-moment-topline"><div class="coach-moment-label">'+label+'</div><div class="coach-moment-tag">Dual Performance</div></div><p>'+esc(note)+'</p></div><button onclick="switchTab(\'comms\')" aria-label="Contact your coaches"><svg class="icon"><use href="#i-chat"/></svg></button></div>';
}
