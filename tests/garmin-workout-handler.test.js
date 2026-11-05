import test from 'node:test';
import assert from 'node:assert/strict';
process.env.PORTAL_SESSION_SECRET='workout-test-secret-at-least-thirty-two-characters';
process.env.SUPABASE_URL='https://db.test';process.env.SUPABASE_SERVICE_KEY='test-service-key';
process.env.GARMIN_CLIENT_ID='test-client';process.env.GARMIN_CLIENT_SECRET='test-secret';process.env.GARMIN_WORKOUTS_ENABLED='true';process.env.PORTAL_URL='https://portal.dualperformance.au';
const {default:handler}=await import('../api/garmin.js');
const {createPortalSession}=await import('../api/_lib/legacy-session.js');
const {refreshIdleGarminConnections}=await import('../api/_lib/garmin-workout-service.js');
const id='11111111-1111-4111-8111-111111111111';
function response(){const r={code:200,body:null,headers:{}};r.setHeader=(k,v)=>r.headers[k]=v;r.status=n=>(r.code=n,r);r.json=b=>(r.body=b,r);r.end=()=>r;return r;}
function fixture({permission=true,found=true}={}){
 const original=globalThis.fetch,calls=[],connection={athlete_code:'KARL',garmin_user_id:'g1',access_token:'acc',refresh_token:'ref',access_expires_at:new Date(Date.now()+86400000).toISOString(),permissions:permission?['WORKOUT_IMPORT']:[]};let receipt=null;
 globalThis.fetch=async(input,init={})=>{
 const url=new URL(String(input)),method=init.method||'GET',body=init.body&&JSON.parse(init.body);calls.push({url,method,body});let value=[];
 if(url.hostname==='apis.garmin.com'){
  if(url.pathname.endsWith('/permissions'))value=connection.permissions;
  else if(url.pathname==='/workoutportal/workout/v2')value={workoutId:33,ownerId:22};
  else if(url.pathname==='/training-api/schedule/')value={scheduleId:44};
  else throw new Error('Unexpected Garmin request '+url);
 }else if(url.pathname.endsWith('/rpc/acquire_job_lease'))value=true;
 else if(url.pathname.endsWith('/rpc/release_job_lease'))value=true;
 else if(url.pathname.endsWith('/athletes'))value=[{code:'KARL',name:'Karl',active:true,auth_mode:'legacy'}];
 else if(url.pathname.endsWith('/garmin_connections'))value=method==='PATCH'?[Object.assign(connection,body)]:[connection];
 else if(url.pathname.endsWith('/planned_sessions')){
  assert.equal(url.searchParams.get('athlete_code'),'eq.KARL');assert.equal(url.searchParams.get('publish_state'),'eq.published');
  value=found?[{id,title:'Easy Run',session_type:'Run',planned_date:'2026-11-06',prescription_mode:'structured'}]:[];
 }else if(url.pathname.endsWith('/run_steps')){assert.equal(url.searchParams.get('planned_session_id'),'eq.'+id);value=[{id:'a',step_type:'run',distance_km:5}];}
 else if(url.pathname.endsWith('/athlete_data'))value=[];
 else if(url.pathname.endsWith('/garmin_workout_deliveries')){if(method==='POST'){receipt={...receipt,...body[0]};value=[receipt];}else value=receipt?[receipt]:[];}
 else throw new Error('Unexpected database request '+url);
 return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
 };
 const req=(method='POST',sessionId=id)=>({method,headers:{authorization:'Bearer '+createPortalSession('KARL')},query:{mode:'workout',sessionId},body:{sessionId,workout:{sport:'CYCLING'},athleteCode:'OTHER'}});
 return {calls,req,restore:()=>{globalThis.fetch=original;}};
}
test('handler sends the authenticated athlete’s published prescription, saves IDs, and deduplicates retries',async()=>{
 const f=fixture();try{const r=response();await handler(f.req(),r);assert.equal(r.code,200,JSON.stringify(r.body));assert.equal(r.body.sent,true);await handler(f.req(),response());const remote=f.calls.filter(c=>c.url.pathname==='/workoutportal/workout/v2');assert.equal(remote.length,1);assert.equal(remote[0].body.sport,'RUNNING');const writes=f.calls.filter(c=>c.url.pathname.endsWith('/garmin_workout_deliveries')&&c.method==='POST');assert.equal(writes.at(-1).body[0].state,'sent');assert.equal(writes.at(-1).body[0].athlete_code,'KARL');}finally{f.restore();}
});
test('preview does not send to Garmin or write a delivery receipt',async()=>{
 const f=fixture();try{const r=response();await handler(f.req('GET'),r);assert.equal(r.code,200);assert.equal(r.body.workout.sport,'RUNNING');assert.equal(f.calls.filter(c=>c.url.hostname==='apis.garmin.com'||c.method==='POST').length,0);}finally{f.restore();}
});
test('missing workout permission prevents a Training API write',async()=>{
 const f=fixture({permission:false});try{const r=response();await handler(f.req(),r);assert.equal(r.code,412);assert.equal(f.calls.filter(c=>c.url.pathname.includes('workoutportal')).length,0);}finally{f.restore();}
});
test('another athlete’s session cannot be sent',async()=>{
 const f=fixture({found:false});try{const r=response();await handler(f.req(),r);assert.equal(r.code,404);assert.equal(f.calls.filter(c=>c.url.hostname==='apis.garmin.com').length,0);}finally{f.restore();}
});
test('invalid session IDs cannot inject database filters',async()=>{
 const f=fixture();try{const r=response();await handler(f.req('POST','x),athlete_code.neq.KARL'),r);assert.equal(r.code,404);assert.equal(f.calls.some(c=>c.url.pathname.endsWith('/planned_sessions')),false);}finally{f.restore();}
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
