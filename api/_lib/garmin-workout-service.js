import { select, upsert } from './supabase-rest.js';
import { acquireLease, releaseLease, newLeaseOwner } from './job-lease.js';
import { buildRunningWorkout, deliverWorkout, validWorkoutDate, workoutError, workoutFingerprint } from './garmin-workouts.js';
import { getConnection, patchConnection } from './garmin-store.js';
import { fetchPermissions, accessTokenFresh, refreshGarminToken, tokenFields } from './garmin-client.js';

export async function withGarminLease(job, action) {
  const owner=newLeaseOwner();
  const result=await acquireLease(job,owner,120);
  if (!result.acquired || result.degraded) throw workoutError('This workout is already being sent. Wait a moment, then review it again.',409,'busy');
  try { return await action(); } finally { await releaseLease(job,owner,'complete'); }
}

// Every caller refreshes under the same cross-instance connection lease, then
// re-reads the winning token. A cron and an athlete cannot rotate it twice.
export async function lockedAccessToken(connection) {
  if (!connection) return null;
  if (accessTokenFresh(connection)) return connection.access_token;
  return withGarminLease('garmin-token:'+connection.athlete_code,async()=>{
    const fresh=await getConnection(connection.athlete_code);
    if (!fresh) throw workoutError('Connect Garmin in Preferences before sending workouts.',409,'not_connected');
    if (accessTokenFresh(fresh)) { Object.assign(connection,fresh); return fresh.access_token; }
    let refreshed;
    try { refreshed=await refreshGarminToken(fresh.refresh_token); }
    catch (error) { error.garminRefresh=true; throw error; }
    const fields=tokenFields(refreshed);
    if (!fields.refresh_token) fields.refresh_token=fresh.refresh_token;
    await patchConnection(connection.athlete_code,fields);
    Object.assign(connection,fields);
    return fields.access_token;
  });
}

export async function trainingRequest(path, token, method='GET', body, fetchImpl=fetch) {
  // Paths are generated exclusively by the service, never supplied by a client.
  if (!/^\/(?:workoutportal\/workout\/v2|training-api\/(?:workout\/v2\/\d+|schedule\/(?:\d+)?|schedule\?startDate=\d{4}-\d{2}-\d{2}&endDate=\d{4}-\d{2}-\d{2}))$/.test(path)) throw new Error('Invalid Garmin Training API path');
  const response=await fetchImpl('https://apis.garmin.com'+path,{method,headers:{Authorization:'Bearer '+token,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
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
  // coach_notes are never selected above, so private notes cannot reach the
  // preview or Garmin. The fingerprint is what the athlete reviewed.
  return {session,steps,date,workout,fingerprint:workoutFingerprint(workout,date)};
}

export async function workoutReceipt(code,sessionId,userId) {
  const rows=await select('garmin_workout_deliveries',{athlete_code:'eq.'+code,planned_session_id:'eq.'+sessionId,garmin_user_id:'eq.'+userId,select:'workout_id,owner_id,schedule_id,scheduled_date,fingerprint,state,sent_at,updated_at',limit:'1'});
  return rows?.[0] || null;
}

export async function sendPrescribedWorkout(code,key,connection,reviewed) {
  // Resolve the alias to the canonical session id first: the lease and the
  // receipt are keyed by it, so an alias and an id cannot race each other.
  const first=await loadWorkoutPrescription(code,key);
  return withGarminLease('garmin-workout:'+code+':'+first.session.id,async()=>{
    // Re-read inside the lease: what is sent is the current prescription and
    // date, and only if it is exactly what the athlete reviewed.
    const prescription=await loadWorkoutPrescription(code,first.session.id);
    if (!reviewed || reviewed!==prescription.fingerprint) throw Object.assign(workoutError('This session changed since you reviewed it. Check the updated workout, then send it.',409,'stale_preview'),{preview:prescription});
    const token=await lockedAccessToken(connection);
    const permissions=await fetchPermissions(token);
    await patchConnection(code,{permissions});
    if (!permissions.includes('WORKOUT_IMPORT')) throw workoutError('Garmin hasn’t allowed DP to add workouts. Reconnect Garmin and tick workout import.',412,'reconnect');
    return deliverWorkout({...prescription,athleteCode:code},{
      read:()=>workoutReceipt(code,prescription.session.id,connection.garmin_user_id),
      save:changes=>upsert('garmin_workout_deliveries',{
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
