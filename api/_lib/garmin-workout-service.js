import { select, upsert } from './supabase-rest.js';
import { acquireLease, releaseLease, newLeaseOwner } from './job-lease.js';
import { buildRunningWorkout, deliverWorkout, validWorkoutDate, workoutError } from './garmin-workouts.js';
import { getConnection, patchConnection } from './garmin-store.js';
import { fetchPermissions, accessTokenFresh, refreshGarminToken, tokenFields } from './garmin-client.js';

export async function withGarminLease(job, action) {
  const owner=newLeaseOwner();
  const result=await acquireLease(job,owner,120);
  if (!result.acquired || result.degraded) throw workoutError('Garmin is busy. Wait a moment and try again.',409);
  try { return await action(); } finally { await releaseLease(job,owner,'complete'); }
}

// Every caller refreshes under the same cross-instance connection lease, then
// re-reads the winning token. A cron and an athlete cannot rotate it twice.
export async function lockedAccessToken(connection) {
  if (!connection) return null;
  if (accessTokenFresh(connection)) return connection.access_token;
  return withGarminLease('garmin-token:'+connection.athlete_code,async()=>{
    const fresh=await getConnection(connection.athlete_code);
    if (!fresh) throw workoutError('Reconnect Garmin before sending workouts.',409);
    if (accessTokenFresh(fresh)) { Object.assign(connection,fresh); return fresh.access_token; }
    const refreshed=await refreshGarminToken(fresh.refresh_token);
    const fields=tokenFields(refreshed);
    if (!fields.refresh_token) fields.refresh_token=fresh.refresh_token;
    await patchConnection(connection.athlete_code,fields);
    Object.assign(connection,fields);
    return fields.access_token;
  });
}

export async function trainingRequest(path, token, method='GET', body, fetchImpl=fetch) {
  // Paths are generated exclusively by the service, never supplied by a client.
  if (!/^\/(?:workoutportal\/workout\/v2|training-api\/(?:workout\/v2\/\d+|schedule\/(?:\d+)?))$/.test(path)) throw new Error('Invalid Garmin Training API path');
  const response=await fetchImpl('https://apis.garmin.com'+path,{method,headers:{Authorization:'Bearer '+token,Accept:'application/json','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
  const value=await response.text();
  if (!response.ok) { const error=new Error('Garmin Training API request failed');error.status=response.status;throw error; }
  if (!value) return null;
  try{return JSON.parse(value);}catch{throw new Error('Garmin Training API returned invalid JSON');}
}

export async function loadWorkoutPrescription(code,key) {
  if (!/^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.test(String(key||''))) throw workoutError('This session needs a published coach prescription.',404);
  const rows=await select('planned_sessions',{athlete_code:'eq.'+code,publish_state:'eq.published',or:`(id.eq.${key},notion_page_id.eq.${key})`,select:'id,notion_page_id,title,session_type,planned_date,prescription_mode',limit:'1'});
  const session=rows && rows[0];
  if(!session)throw workoutError('This published running session was not found.',404);
  const steps=await select('run_steps',{planned_session_id:'eq.'+session.id,select:'id,parent_step_id,step_order,step_type,repeat_count,distance_km,duration_sec,intensity_type,pace_min,pace_max,hr_zone,rpe,effort,instructions',order:'step_order.asc',limit:'101'});
  const state=await select('athlete_data',{athlete_code:'eq.'+code,key:'eq.reschedules',select:'value',limit:'1'});
  const moved=state?.[0]?.value?.[session.notion_page_id || session.id];
  const date=validWorkoutDate(moved || session.planned_date);
  const workout=buildRunningWorkout(session,steps);
  return {session,steps,date,workout};
}

export async function workoutReceipt(code,sessionId,userId) {
  const rows=await select('garmin_workout_deliveries',{athlete_code:'eq.'+code,planned_session_id:'eq.'+sessionId,garmin_user_id:'eq.'+userId,select:'workout_id,owner_id,schedule_id,scheduled_date,fingerprint,state,sent_at',limit:'1'});
  return rows?.[0] || null;
}

export async function sendPrescribedWorkout(code,key,connection) {
  const prescription=await loadWorkoutPrescription(code,key);
  return withGarminLease('garmin-workout:'+code+':'+prescription.session.id,async()=>{
    const token=await lockedAccessToken(connection);
    const permissions=await fetchPermissions(token);
    await patchConnection(code,{permissions});
    if (!permissions.includes('WORKOUT_IMPORT')) throw workoutError('Reconnect Garmin and allow workout import before sending this session.',412);
    return deliverWorkout({...prescription,athleteCode:code},{
      read:()=>workoutReceipt(code,prescription.session.id,connection.garmin_user_id),
      save:changes=>upsert('garmin_workout_deliveries',{
        ...(changes.state==='creating'?{workout_id:null,owner_id:null,schedule_id:null,scheduled_date:null,fingerprint:null,sent_at:null}:{}),
        ...changes,athlete_code:code,planned_session_id:prescription.session.id,garmin_user_id:connection.garmin_user_id,updated_at:new Date().toISOString(),
      },'athlete_code,planned_session_id'),
      request:(path,method,body)=>trainingRequest(path,token,method,body),
    });
  });
}

export async function refreshIdleGarminConnections({available=()=>true,now=Date.now,load=select,refresh=lockedAccessToken,markFailure=(code)=>patchConnection(code,{})}={}) {
  const start=now(); let refreshed=0,failed=0,skipped=0;
  const rows=await load('garmin_connections',{access_expires_at:'lte.'+new Date(start+10*60*1000).toISOString(),select:'athlete_code,access_token,refresh_token,access_expires_at,refresh_expires_at',order:'updated_at.asc',limit:'25'});
  for (const row of rows || []) {
    if (now()-start>40000) break;
    if (!available(row.athlete_code)) {skipped++;continue;}
    try{await refresh(row);refreshed++;}catch{failed++;try{await markFailure(row.athlete_code);}catch{/* next cron retries */}}
  }
  return {refreshed,failed,skipped};
}
