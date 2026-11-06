import test from 'node:test';
import assert from 'node:assert/strict';
process.env.PORTAL_SESSION_SECRET='workout-test-secret-at-least-thirty-two-characters';
process.env.SUPABASE_URL='https://db.test';process.env.SUPABASE_SERVICE_KEY='test-service-key';
process.env.GARMIN_CLIENT_ID='test-client';process.env.GARMIN_CLIENT_SECRET='test-secret';process.env.GARMIN_WORKOUTS_ENABLED='true';process.env.PORTAL_URL='https://portal.dualperformance.au';
const {default:handler}=await import('../api/garmin.js');
const {createPortalSession}=await import('../api/_lib/legacy-session.js');
const {refreshIdleGarminConnections}=await import('../api/_lib/garmin-workout-service.js');
const id='11111111-1111-4111-8111-111111111111';
const alias='0123456789abcdef0123456789abcdef';
function response(){const r={code:200,body:null,headers:{}};r.setHeader=(k,v)=>r.headers[k]=v;r.status=n=>(r.code=n,r);r.json=b=>(r.body=b,r);r.end=()=>r;return r;}

// The acceptance fixture as the coaches dashboard stores it: 10 min warm-up,
// 6 × (1 km at 4:30–4:45/km + 90 s recovery), 10 min cool-down. Private coach
// notes sit on the rows and must never leave the server.
export const fixtureSteps=()=>[
 {id:'w',parent_step_id:null,step_order:0,step_type:'warmup',duration_sec:600,intensity_type:null,instructions:'Easy jog, build to steady',coach_notes:'PRIVATE: watch his left calf'},
 {id:'r',parent_step_id:null,step_order:1,step_type:'repeat',repeat_count:6},
 {id:'i',parent_step_id:'r',step_order:0,step_type:'interval',distance_km:1,intensity_type:'pace_range',pace_min:'4:30',pace_max:'4:45',coach_notes:'PRIVATE: he always goes out too fast'},
 {id:'j',parent_step_id:'r',step_order:1,step_type:'recovery',duration_sec:90,intensity_type:'effort',effort:'Walk or jog'},
 {id:'c',parent_step_id:null,step_order:2,step_type:'cooldown',duration_sec:600,intensity_type:null},
];

/** Fake Supabase + fake Garmin. Garmin keeps real state so duplicates show. */
function fixture({permission=true,found=true,sessionDate='2026-11-10',reschedule=null,steps=fixtureSteps(),title='6 × 1 km'}={}){
 const original=globalThis.fetch,calls=[],leases=new Set();
 const connection={athlete_code:'KARL',garmin_user_id:'g1',access_token:'acc',refresh_token:'ref',access_expires_at:new Date(Date.now()+86400000).toISOString(),permissions:permission?['WORKOUT_IMPORT']:[]};
 const db={receipt:null,session:{id,notion_page_id:alias,title,session_type:'Intervals',planned_date:sessionDate,prescription_mode:'structured'},steps,reschedule};
 const garmin={workouts:new Map(),schedules:new Map(),next:100,fail:{},hold:null};
 const failNext=(key,status)=>{garmin.fail[key]=status;};
 globalThis.fetch=async(input,init={})=>{
  const url=new URL(String(input)),method=init.method||'GET',body=init.body&&JSON.parse(init.body);calls.push({url,method,body});let value=[];
  if(url.hostname==='apis.garmin.com'){
   const key=method+' '+url.pathname.replace(/\/\d+$/,'/:id');
   if(garmin.hold&&garmin.hold.key===key){const hold=garmin.hold;garmin.hold=null;await hold.wait;}
   if(garmin.fail[key]){const status=garmin.fail[key];delete garmin.fail[key];
    if(status==='lost'){ // Garmin did it, the answer never arrived
     if(key==='POST /workoutportal/workout/v2'){const w=++garmin.next;garmin.workouts.set(w,body);}
     if(key==='POST /training-api/schedule/'){const s=++garmin.next;garmin.schedules.set(s,{scheduleId:s,...body});}
     throw new TypeError('fetch failed');
    }
    return new Response('{}',{status});
   }
   const tail=Number(url.pathname.split('/').pop());
   if(url.pathname.endsWith('/permissions'))value=connection.permissions;
   else if(key==='POST /workoutportal/workout/v2'){const w=++garmin.next;garmin.workouts.set(w,body);value={...body,workoutId:w,ownerId:22};}
   else if(key==='PUT /training-api/workout/v2/:id'){if(!garmin.workouts.has(tail))return new Response('',{status:404});garmin.workouts.set(tail,body);value=body;}
   else if(key==='GET /training-api/workout/v2/:id'){if(!garmin.workouts.has(tail))return new Response('',{status:404});value=garmin.workouts.get(tail);}
   else if(key==='POST /training-api/schedule/'){const s=++garmin.next;garmin.schedules.set(s,{scheduleId:s,...body});value={scheduleId:s};}
   else if(key==='PUT /training-api/schedule/:id'){if(!garmin.schedules.has(tail))return new Response('',{status:404});garmin.schedules.set(tail,body);value=body;}
   else if(key==='GET /training-api/schedule/:id'){if(!garmin.schedules.has(tail))return new Response('',{status:404});value=garmin.schedules.get(tail);}
   else if(key==='GET /training-api/schedule'){const day=url.searchParams.get('startDate');value=[...garmin.schedules.values()].filter(s=>s.date===day);}
   else throw new Error('Unexpected Garmin request '+method+' '+url);
  }else if(url.pathname.endsWith('/rpc/acquire_job_lease')){if(leases.has(body.p_job))value=false;else{leases.add(body.p_job);value=true;}}
  else if(url.pathname.endsWith('/rpc/release_job_lease')){leases.delete(body.p_job);value=true;}
  else if(url.pathname.endsWith('/athletes'))value=[{code:'KARL',name:'Karl',active:true,auth_mode:'legacy'}];
  else if(url.pathname.endsWith('/garmin_connections'))value=method==='PATCH'?[Object.assign(connection,body)]:[connection];
  else if(url.pathname.endsWith('/planned_sessions')){
   assert.equal(url.searchParams.get('athlete_code'),'eq.KARL');assert.equal(url.searchParams.get('publish_state'),'eq.published');
   assert.doesNotMatch(url.searchParams.get('select'),/coach_notes|notes/);
   const or=url.searchParams.get('or')||'';value=found&&(or.includes(db.session.id)||or.includes(alias))?[db.session]:[];
  }else if(url.pathname.endsWith('/run_steps')){
   assert.equal(url.searchParams.get('planned_session_id'),'eq.'+id);assert.doesNotMatch(url.searchParams.get('select'),/coach_notes/);
   const columns=url.searchParams.get('select').split(',');value=db.steps.map(row=>Object.fromEntries(columns.map(c=>[c,row[c]??null])));
  }else if(url.pathname.endsWith('/athlete_data'))value=db.reschedule?[{value:db.reschedule}]:[];
  else if(/\/garmin_(activities|dailies)$/.test(url.pathname))value=[];
  else if(url.pathname.endsWith('/garmin_workout_deliveries')){
   if(method==='POST'){assert.equal(new URL(url).searchParams.get('on_conflict'),'athlete_code,planned_session_id');db.receipt={...db.receipt,...body[0]};value=[db.receipt];}
   else value=db.receipt?[db.receipt]:[];
  }else throw new Error('Unexpected database request '+url);
  return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
 };
 const auth={authorization:'Bearer '+createPortalSession('KARL')};
 const preview=async(sessionId=id)=>{const r=response();await handler({method:'GET',headers:auth,query:{mode:'workout',sessionId}},r);return r;};
 const send=async(fingerprint,sessionId=id,extra={})=>{const r=response();await handler({method:'POST',headers:auth,query:{mode:'workout'},body:{sessionId,fingerprint,workout:{sport:'CYCLING'},athleteCode:'OTHER',date:'1999-01-01',...extra}},r);return r;};
 const review=async(sessionId=id)=>(await preview(sessionId)).body.fingerprint;
 const garminCalls=pattern=>calls.filter(c=>c.url.hostname==='apis.garmin.com'&&pattern.test(c.method+' '+c.url.pathname));
 const onCalendar=()=>[...garmin.schedules.values()];
 return {calls,db,garmin,connection,leases,auth,failNext,preview,send,review,garminCalls,onCalendar,restore:()=>{globalThis.fetch=original;}};
}

test('acceptance fixture: preview and outbound payload match the coach prescription exactly',async()=>{
 const f=fixture();try{
  const p=await f.preview();assert.equal(p.code,200,JSON.stringify(p.body));
  assert.equal(p.body.date,'2026-11-10');assert.equal(p.body.sessionId,id);assert.match(p.body.fingerprint,/^[a-f0-9]{64}$/);
  const steps=p.body.workout.segments[0].steps;
  assert.deepEqual(steps.map(s=>s.type),['WorkoutStep','WorkoutRepeatStep','WorkoutStep']);
  assert.deepEqual([steps[0].intensity,steps[0].durationType,steps[0].durationValue],['WARMUP','TIME',600]);
  assert.equal(steps[1].repeatType,'REPEAT_UNTIL_STEPS_CMPLT');assert.equal(steps[1].repeatValue,6);
  const [rep,rec]=steps[1].steps;
  assert.deepEqual([rep.intensity,rep.durationType,rep.durationValue,rep.targetType],['INTERVAL','DISTANCE',1000,'PACE']);
  // m/s: 4:45/km (slower) is the LOW speed, 4:30/km (faster) the HIGH speed.
  assert.equal(rep.targetValueLow,1000/285);assert.equal(rep.targetValueHigh,1000/270);assert.ok(rep.targetValueLow<rep.targetValueHigh);
  assert.deepEqual([rec.intensity,rec.durationType,rec.durationValue,rec.targetType,rec.description],['RECOVERY','TIME',90,'OPEN','Walk or jog']);
  assert.deepEqual([steps[2].intensity,steps[2].durationType,steps[2].durationValue],['COOLDOWN','TIME',600]);
  assert.doesNotMatch(JSON.stringify(p.body),/PRIVATE|coach_notes/);
  const s=await f.send(p.body.fingerprint);assert.equal(s.code,200,JSON.stringify(s.body));assert.equal(s.body.state,'saved');assert.equal(s.body.date,'2026-11-10');
  const [create]=f.garminCalls(/^POST \/workoutportal/);assert.deepEqual(create.body,p.body.workout);
  assert.doesNotMatch(JSON.stringify(create.body),/PRIVATE|CYCLING/);
  assert.deepEqual(f.onCalendar().map(e=>e.date),['2026-11-10']);
  // Workout id persisted before the calendar POST was made.
  const order=f.calls.map(c=>c.url.hostname==='apis.garmin.com'?c.method+' '+c.url.pathname:(c.method==='POST'&&c.url.pathname.endsWith('/garmin_workout_deliveries')?'save '+(c.body[0].workout_id?'id':c.body[0].state):null)).filter(Boolean);
  assert.ok(order.indexOf('save id')<order.indexOf('POST /training-api/schedule/'),order.join(' > '));
  assert.equal(f.db.receipt.state,'sent');assert.equal(f.db.receipt.planned_session_id,id);assert.equal(f.db.receipt.athlete_code,'KARL');
 }finally{f.restore();}
});
test('an explicit re-send leaves one calendar entry and makes no new workout',async()=>{
 const f=fixture();try{const fp=await f.review();await f.send(fp);const again=await f.send(await f.review());assert.equal(again.code,200);assert.equal(again.body.unchanged,true);
  assert.equal(f.garminCalls(/^POST /).length,2);assert.equal(f.onCalendar().length,1);assert.equal(f.garmin.workouts.size,1);
  const p=await f.preview();assert.equal(p.body.receipt.upToDate,true);assert.equal(p.body.receipt.date,'2026-11-10');
 }finally{f.restore();}
});
test('a session opened through its alias uses the canonical id for the lease and receipt',async()=>{
 const f=fixture();try{const p=await f.preview(alias);assert.equal(p.body.sessionId,id);const s=await f.send(p.body.fingerprint,alias);assert.equal(s.code,200);assert.equal(f.db.receipt.planned_session_id,id);
  const leases=f.calls.filter(c=>c.url.pathname.endsWith('/rpc/acquire_job_lease')).map(c=>c.body.p_job);assert.ok(leases.includes('garmin-workout:KARL:'+id),leases.join());
  const again=await f.send(await f.review(id),id);assert.equal(again.body.unchanged,true);assert.equal(f.onCalendar().length,1);
 }finally{f.restore();}
});
test('a saved reschedule is the date previewed and scheduled',async()=>{
 const f=fixture({reschedule:{[alias]:'2026-11-12'}});try{const p=await f.preview();assert.equal(p.body.date,'2026-11-12');await f.send(p.body.fingerprint);assert.deepEqual(f.onCalendar().map(e=>e.date),['2026-11-12']);}finally{f.restore();}
});
test('a stale preview is refused with the new version to review, and nothing is sent',async()=>{
 const f=fixture();try{const fp=await f.review();f.db.steps=f.db.steps.map(s=>s.id==='r'?{...s,repeat_count:5}:s);
  const s=await f.send(fp);assert.equal(s.code,409);assert.equal(s.body.code,'stale_preview');assert.equal(s.body.preview.workout.segments[0].steps[1].repeatValue,5);assert.notEqual(s.body.preview.fingerprint,fp);
  assert.equal(f.garminCalls(/./).length,0);assert.equal(f.db.receipt,null);
  const ok=await f.send(s.body.preview.fingerprint);assert.equal(ok.code,200);
  // A date change after review is stale too.
  f.db.reschedule={[alias]:'2026-11-13'};const moved=await f.send(s.body.preview.fingerprint);assert.equal(moved.body.code,'stale_preview');assert.equal(moved.body.preview.date,'2026-11-13');
  assert.equal(f.onCalendar()[0].date,'2026-11-10');
 }finally{f.restore();}
});
test('a send without a reviewed preview is refused',async()=>{
 const f=fixture();try{const s=await f.send(undefined);assert.equal(s.code,409);assert.equal(s.body.code,'stale_preview');assert.equal(f.garminCalls(/./).length,0);}finally{f.restore();}
});
test('a coach change or reschedule updates the same Garmin workout and calendar entry',async()=>{
 const f=fixture();try{await f.send(await f.review());const [workoutId]=f.garmin.workouts.keys();
  f.db.session={...f.db.session,title:'5 × 1 km'};f.db.steps=f.db.steps.map(s=>s.id==='r'?{...s,repeat_count:5}:s);f.db.reschedule={[alias]:'2026-11-11'};
  const p=await f.preview();assert.equal(p.body.receipt.upToDate,false);
  const s=await f.send(p.body.fingerprint);assert.equal(s.code,200);assert.equal(s.body.date,'2026-11-11');
  assert.equal(f.garmin.workouts.size,1);assert.equal(f.garmin.workouts.get(workoutId).workoutName,'5 × 1 km');assert.equal(f.garmin.workouts.get(workoutId).ownerId,22);
  assert.deepEqual(f.onCalendar().map(e=>[e.workoutId,e.date]),[[workoutId,'2026-11-11']]);
 }finally{f.restore();}
});
test('concurrent sends (double tap, two devices) create one workout and one calendar entry',async()=>{
 const f=fixture();try{const fp=await f.review();let release;f.garmin.hold={key:'POST /workoutportal/workout/v2',wait:new Promise(r=>release=r)};
  const first=f.send(fp);await new Promise(r=>setTimeout(r,20));const second=await f.send(fp);release();const done=await first;
  assert.equal(done.code,200);assert.equal(second.code,409);assert.equal(second.body.code,'busy');
  assert.equal(f.garmin.workouts.size,1);assert.equal(f.onCalendar().length,1);
 }finally{f.restore();}
});
test('partial failure: workout created, calendar refused, retry schedules with the saved workout id',async()=>{
 const f=fixture();try{const fp=await f.review();f.failNext('POST /training-api/schedule/',503);
  const failed=await f.send(fp);assert.equal(failed.code,502);assert.equal(failed.body.code,'schedule_unconfirmed');assert.match(failed.body.error,/calendar entry wasn’t confirmed/);
  assert.equal(f.db.receipt.state,'scheduling');assert.ok(f.db.receipt.workout_id);
  const retry=await f.send(fp);assert.equal(retry.code,200);assert.equal(f.garminCalls(/^POST \/workoutportal/).length,1);assert.equal(f.onCalendar().length,1);
  assert.equal(f.onCalendar()[0].workoutId,Number(f.db.receipt.workout_id));
 }finally{f.restore();}
});
test('ambiguous calendar timeout: the retry finds the entry Garmin made instead of adding a second',async()=>{
 const f=fixture();try{const fp=await f.review();f.failNext('POST /training-api/schedule/','lost');
  const failed=await f.send(fp);assert.equal(failed.code,502);assert.equal(f.onCalendar().length,1);
  const retry=await f.send(fp);assert.equal(retry.code,200);assert.equal(f.onCalendar().length,1);assert.equal(f.garminCalls(/^POST \/training-api\/schedule/).length,1);
  assert.equal(f.db.receipt.schedule_id,String(f.onCalendar()[0].scheduleId));
 }finally{f.restore();}
});
test('ambiguous workout timeout blocks a blind re-create and never claims success',async()=>{
 const f=fixture();try{const fp=await f.review();f.failNext('POST /workoutportal/workout/v2','lost');
  const failed=await f.send(fp);assert.equal(failed.code,502);assert.equal(failed.body.code,'unconfirmed');assert.equal(failed.body.sent,undefined);
  const again=await f.send(fp);assert.equal(again.code,409);assert.equal(again.body.code,'delivery_uncertain');
  assert.equal(f.garminCalls(/^POST \/workoutportal/).length,1);assert.equal(f.onCalendar().length,0);
  const p=await f.preview();assert.equal(p.body.receipt.state,'creating');
 }finally{f.restore();}
});
test('a definitive Garmin refusal is retryable and creates exactly one workout later',async()=>{
 const f=fixture();try{const fp=await f.review();f.failNext('POST /workoutportal/workout/v2',429);
  const limited=await f.send(fp);assert.equal(limited.code,429);assert.equal(f.db.receipt.state,'retryable');
  const ok=await f.send(fp);assert.equal(ok.code,200);assert.equal(f.garmin.workouts.size,1);assert.equal(f.onCalendar().length,1);
 }finally{f.restore();}
});
test('an entry the athlete deleted in Garmin Connect is restored once on an explicit re-send',async()=>{
 const f=fixture();try{await f.send(await f.review());f.garmin.schedules.clear();
  const s=await f.send(await f.review());assert.equal(s.code,200);assert.equal(s.body.unchanged,false);assert.equal(f.onCalendar().length,1);assert.equal(f.garmin.workouts.size,1);
  f.garmin.workouts.clear();f.garmin.schedules.clear();const again=await f.send(await f.review());assert.equal(again.code,200);assert.equal(f.garmin.workouts.size,1);assert.equal(f.onCalendar().length,1);
 }finally{f.restore();}
});
test('missing WORKOUT_IMPORT permission prevents a Training API write and offers reconnect',async()=>{
 const f=fixture({permission:false});try{const p=await f.preview();assert.equal(p.body.canSend,false);assert.match(p.body.reconnectUrl,/^https:\/\/connect\.garmin\.com\/oauth2Confirm\?/);
  const r=await f.send(p.body.fingerprint);assert.equal(r.code,412);assert.equal(r.body.code,'reconnect');assert.match(r.body.reconnectUrl,/^https:\/\/connect\.garmin\.com\//);assert.equal(f.garminCalls(/workoutportal|training-api/).length,0);}finally{f.restore();}
});
test('a revoked token (Garmin 401) on create reads as reconnect, not a delivery failure',async()=>{
 const f=fixture();try{const fp=await f.review();f.failNext('POST /workoutportal/workout/v2',401);const r=await f.send(fp);assert.equal(r.code,412);assert.equal(r.body.code,'reconnect');assert.ok(r.body.reconnectUrl);assert.equal(f.db.receipt.state,'retryable');}finally{f.restore();}
});
test('an expired refresh token asks the athlete to reconnect',async()=>{
 const f=fixture();const base=globalThis.fetch;try{const fp=await f.review();f.connection.access_expires_at='2020-01-01T00:00:00Z';
  globalThis.fetch=async(input,init)=>String(input).startsWith('https://connectapi.garmin.com/')?new Response('{"error":"invalid_grant"}',{status:400}):base(input,init);
  const r=await f.send(fp);assert.equal(r.code,412);assert.equal(r.body.code,'reconnect');assert.equal(f.garminCalls(/workoutportal|training-api/).length,0);
 }finally{f.restore();}
});
test('another athlete’s, draft or deleted session cannot be previewed or sent',async()=>{
 const f=fixture({found:false});try{const p=await f.preview();assert.equal(p.code,404);const r=await f.send('a'.repeat(64));assert.equal(r.code,404);assert.equal(f.garminCalls(/./).length,0);}finally{f.restore();}
});
test('a text-only session explains that the coach must add structured steps',async()=>{
 const f=fixture();f.db.session={...f.db.session,prescription_mode:'legacy'};f.db.steps=[];try{const p=await f.preview();assert.equal(p.code,422);assert.match(p.body.error,/coach to add structured run steps/);}finally{f.restore();}
});
test('a disconnected athlete cannot send',async()=>{
 const f=fixture();try{const fp=await f.review();f.calls.length=0;const base=globalThis.fetch;
  globalThis.fetch=async(input,init)=>new URL(String(input)).pathname.endsWith('/garmin_connections')?new Response('[]',{status:200}):base(input,init);
  const r=await f.send(fp);assert.equal(r.code,409);assert.equal(r.body.code,'not_connected');assert.equal(f.garminCalls(/./).length,0);
 }finally{f.restore();}
});
test('invalid session IDs cannot inject database filters',async()=>{
 const f=fixture();try{const r=await f.send('x','x),athlete_code.neq.KARL');assert.equal(r.code,404);assert.equal(f.calls.some(c=>c.url.pathname.endsWith('/planned_sessions')),false);}finally{f.restore();}
});
test('token maintenance refreshes allowed idle connections without starvation on failure',async()=>{
 const failures=[],seen=[];const counts=await refreshIdleGarminConnections({load:async(table,query)=>{assert.equal(query.order,'updated_at.asc');return [{athlete_code:'A'},{athlete_code:'B'},{athlete_code:'C'}];},available:code=>code!=='C',refresh:async row=>{seen.push(row.athlete_code);if(row.athlete_code==='A')throw new Error('revoked');},markFailure:async code=>failures.push(code)});assert.deepEqual(seen,['A','B']);assert.deepEqual(failures,['A']);assert.deepEqual(counts,{refreshed:1,failed:1,skipped:1});
});
test('scheduled refresh requires the configured cron secret',async()=>{
 const before=process.env.CRON_SECRET;process.env.CRON_SECRET='cron-test';try{const r=response();await handler({method:'GET',query:{mode:'refresh'},headers:{authorization:'Bearer wrong'}},r);assert.equal(r.code,401);}finally{if(before===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=before;}
});
test('a competing token refresh re-reads the saved winner under its lease',async()=>{
 const {getAccessToken}=await import('../api/garmin.js');const f=fixture();
 try{const token=await getAccessToken({athlete_code:'KARL',access_token:'stale',refresh_token:'old-rotation',access_expires_at:'2020-01-01T00:00:00Z'});assert.equal(token,'acc');assert.equal(f.calls.filter(c=>c.url.pathname.endsWith('/rpc/acquire_job_lease')).length,1);assert.equal(f.calls.filter(c=>c.url.hostname==='connectapi.garmin.com').length,0);}finally{f.restore();}
});
test('a send and a scheduled refresh racing on an expired token rotate it once and keep the newest refresh token',async()=>{
 const f=fixture();const base=globalThis.fetch;let rotations=0;
 try{const fp=await f.review();f.connection.access_expires_at='2020-01-01T00:00:00Z';
  globalThis.fetch=async(input,init)=>{if(String(input).startsWith('https://connectapi.garmin.com/')){rotations++;await new Promise(r=>setTimeout(r,15));return new Response(JSON.stringify({access_token:'acc2',refresh_token:'ref2',expires_in:86400}),{status:200});}return base(input,init);};
  const {refreshIdleGarminConnections:refreshAll}=await import('../api/_lib/garmin-workout-service.js');
  const stale={...f.connection};
  const [sent,cron]=await Promise.all([f.send(fp),refreshAll({load:async()=>[stale]})]);
  assert.equal(rotations,1);assert.equal(f.connection.refresh_token,'ref2');assert.equal(f.connection.access_token,'acc2');
  // The loser either waited on the lease (busy) or reused the winner's token; it never refreshed with the stale token.
  assert.ok(sent.code===200||sent.body.code==='busy',JSON.stringify(sent.body));assert.equal(cron.refreshed+cron.failed,1);
 }finally{f.restore();}
});
test('a portal load while another request holds the token lease still shows the Garmin card',async()=>{
 const f=fixture();try{f.connection.access_expires_at='2020-01-01T00:00:00Z';f.leases.add('garmin-token:KARL');
  const r=response();await handler({method:'GET',headers:f.auth,query:{}},r);
  assert.equal(r.code,200,JSON.stringify(r.body));assert.equal(r.body.connected,true);assert.equal(r.body.reconnectRecommended,undefined);
  assert.equal(f.calls.filter(c=>c.url.hostname==='connectapi.garmin.com').length,0);
 }finally{f.restore();}
});
test('the webhook log names summary types it does not store, never their contents',async()=>{
 const f=fixture();const lines=[];const log=console.info;console.info=(...a)=>{lines.push(a.join(' '));};
 try{const r=response();await handler({method:'POST',headers:{'garmin-client-id':'test-client'},query:{mode:'webhook'},body:{activityDetails:[{userId:'g1',summaryId:'secret-summary',samples:[{heartRate:150}]}],epochs:[{userId:'g1'}]}},r);
  assert.equal(r.code,200);const line=lines.find(l=>l.includes('Garmin notification applied'));assert.ok(line,lines.join('\n'));
  assert.deepEqual(JSON.parse(line).ignoredKeys,['activityDetails','epochs']);assert.doesNotMatch(line,/secret-summary|heartRate/);
 }finally{console.info=log;f.restore();}
});
