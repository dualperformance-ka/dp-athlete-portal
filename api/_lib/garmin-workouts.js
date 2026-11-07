// Garmin Training API V2 2.0 (Garmin, 15 October 2026). Coach prescriptions only.
//
// Contract used here (Training API V2 2.0 §3-4):
//   create workout    POST /workoutportal/workout/v2
//   update workout    PUT  /training-api/workout/v2/{workoutId}   full object + ownerId
//   retrieve workout  GET  /training-api/workout/v2/{workoutId}
//   create schedule   POST /training-api/schedule/                {workoutId,date}
//   update schedule   PUT  /training-api/schedule/{scheduleId}    full object
//   retrieve schedule GET  /training-api/schedule/{scheduleId}
//   schedules by date GET  /training-api/schedule?startDate=&endDate=
// Single-sport workouts hold at most 100 steps. PACE targets are speeds in m/s,
// so the SLOWER pace is targetValueLow. HEART_RATE targetValue is zone 1-5.
// Step descriptions hold 512 characters; workoutProvider/workoutSourceId 20.
import { createHash } from 'node:crypto';
export function workoutError(message, status = 422, code = 'invalid_prescription') { return Object.assign(new Error(message), { status, publicMessage: message, code }); }
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const text = value => String(value == null ? '' : value).trim();
const LABELS = {warmup:'Warm-up',run:'Run',interval:'Interval',recovery:'Recovery',rest:'Rest',cooldown:'Cool-down',repeat:'Repeat'};
function paceSeconds(value, where) {
  const match = /^(\d{1,2}):([0-5]\d)(?:\s*(?:\/km|min\/km))?$/.exec(text(value));
  if (!match) throw workoutError(where+'pace “'+text(value)+'” must be minutes:seconds per km, e.g. 4:30.');
  const seconds = Number(match[1]) * 60 + Number(match[2]);
  if (seconds < 90 || seconds > 1800) throw workoutError(where+'pace is outside the 1:30–30:00 /km range Garmin supports.');
  return seconds;
}
export function validWorkoutDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) || new Date(value+'T12:00:00Z').toISOString().slice(0,10) !== value) throw workoutError('The session needs a valid calendar date.');
  return value;
}
// Running session types the coaches dashboard programmes. The planner stores
// the run's purpose as its type (Easy Effort, Tempo, Long Run...), so an exact
// "run" match refused almost every real run. Mixed or admin rows (Brick,
// Run + Strength, Optional, Weekly KM Total) are not one running workout and
// stay out. Keep in step with GARMIN_RUN_SESSION_TYPES in the dashboard's
// public/run-workout.js and in public/js/garmin-workouts.js.
export const GARMIN_RUN_SESSION_TYPES = new Set(['run','running','easy','easy effort','recovery','long','long run','tempo','threshold','speed','interval','intervals','vo2','fartlek','hills','mp','race','time trial']);
export function buildRunningWorkout(session, rows) {
  if (!session || !GARMIN_RUN_SESSION_TYPES.has(text(session.session_type).toLowerCase())) throw workoutError('Only running sessions can be sent to Garmin. Ask your coach to programme this as a run.');
  if (session.prescription_mode !== 'structured' || !Array.isArray(rows) || !rows.length) throw workoutError('This session is written as text, so it can’t become a watch workout yet. Ask your coach to add structured run steps (warm-up, reps, recoveries) in the session builder.');
  if (rows.length > 100) throw workoutError('Garmin supports at most 100 workout steps. Ask your coach to shorten this session.');
  const ids = new Set(rows.map(row=>String(row.id)));
  if (ids.size !== rows.length || rows.some(row=>!row.id || (row.parent_step_id && !ids.has(String(row.parent_step_id))))) throw workoutError('The run steps contain missing or duplicate references. Ask your coach to re-save this session.');
  const seen = new Set(); let order = 0; let expanded = 0;
  function convert(parent, depth = 0, multiplier = 1) {
    if (depth > 2) throw workoutError('Repeats are nested too deeply for Garmin. Ask your coach to simplify this session.');
    return rows.filter(row=>String(row.parent_step_id || '') === parent).sort((a,b)=>Number(a.step_order || 0)-Number(b.step_order || 0)).map(row=>{
      if (seen.has(row.id)) throw workoutError('The run steps contain a repeated reference. Ask your coach to re-save this session.');
      seen.add(row.id); const stepOrder = ++order;
      const where = 'Step '+stepOrder+' ('+(LABELS[row.step_type] || 'unknown')+'): ';
      if (row.step_type === 'repeat') {
        const count = Number(row.repeat_count);
        if (!Number.isInteger(count) || count < 1 || count > 100) throw workoutError(where+'repeat count must be between 1 and 100.');
        const steps = convert(String(row.id), depth+1, multiplier*count);
        if (!steps.length) throw workoutError(where+'a repeat needs at least one step inside it.');
        return {type:'WorkoutRepeatStep',stepOrder,repeatType:'REPEAT_UNTIL_STEPS_CMPLT',repeatValue:count,steps};
      }
      expanded += multiplier;
      if (expanded > 100) throw workoutError('This workout is more than 100 steps once repeats are counted. Ask your coach to shorten it.');
      const intensities = {warmup:'WARMUP',run:'ACTIVE',interval:'INTERVAL',recovery:'RECOVERY',rest:'REST',cooldown:'COOLDOWN'};
      if (!intensities[row.step_type]) throw workoutError(where+'this step type can’t be sent to Garmin.');
      const hasDistance = row.distance_km != null && text(row.distance_km) !== '', hasDuration = row.duration_sec != null && text(row.duration_sec) !== '';
      if (hasDistance && hasDuration) throw workoutError(where+'choose either a distance or a time, not both.');
      if ((hasDistance && !positive(row.distance_km)) || (hasDuration && !positive(row.duration_sec))) throw workoutError(where+'distance and time must be greater than zero.');
      const instructions = text(row.instructions);
      // Metres rounded to the centimetre so 0.3 km is 300, never 300.00000000000006.
      const step = {type:'WorkoutStep',stepOrder,intensity:intensities[row.step_type],description:instructions.slice(0,512),durationType:hasDistance?'DISTANCE':hasDuration?'TIME':'OPEN',durationValue:hasDistance?Math.round(Number(row.distance_km)*100000)/100:hasDuration?Number(row.duration_sec):null,targetType:'OPEN'};
      const target = text(row.intensity_type).toLowerCase();
      if (target === 'pace' || target === 'pace_range') {
        const a=paceSeconds(row.pace_min,where),b=text(row.pace_max)?paceSeconds(row.pace_max,where):a;
        // Speed in m/s: the slower pace (more seconds) is the LOW speed.
        step.targetType='PACE';step.targetValueLow=1000/Math.max(a,b);step.targetValueHigh=1000/Math.min(a,b);
      } else if (target === 'hr' || target === 'hr_zone') {
        const zone = /^(?:z(?:one)?\s*)?([1-5])$/i.exec(text(row.hr_zone));
        if (!zone) throw workoutError(where+'heart-rate targets must be a Garmin zone from 1 to 5.');
        step.targetType='HEART_RATE';step.targetValue=Number(zone[1]);
      } else if (target === 'rpe') {
        if (!positive(row.rpe) || Number(row.rpe)>10) throw workoutError(where+'RPE must be between 1 and 10.');
        step.description=('RPE '+Number(row.rpe)+'/10. '+instructions).trim().slice(0,512);
      } else if (target === 'effort' || target === 'text') {
        step.description=(text(row.effort)+(text(row.effort)&&instructions?'. ':'')+instructions).trim().slice(0,512);
      } else if (target) throw workoutError(where+'this intensity target can’t be sent to Garmin.');
      return step;
    });
  }
  const steps = convert('');
  if (!steps.length || seen.size !== rows.length) throw workoutError('The run steps contain disconnected or looping blocks. Ask your coach to re-save this session.');
  return {workoutName:text(session.title || 'DP Run').slice(0,100),description:'Running session programmed by Dual Performance.',sport:'RUNNING',workoutProvider:'Dual Performance',workoutSourceId:'Dual Performance',segments:[{segmentOrder:1,sport:'RUNNING',steps}]};
}

/** What the athlete reviewed: the converted workout and its effective date. */
export function workoutFingerprint(workout, date) {
  return createHash('sha256').update(JSON.stringify({workout,date})).digest('hex');
}

const shiftDate = (day, days) => { const d=new Date(day+'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); };
const notFound = error => Number(error && error.status) === 404;
const definitive = error => { const status=Number(error && error.status); return status>=400 && status<500; };
function scheduleList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') { const list=Object.values(value).find(Array.isArray); if (list) return list; }
  return [];
}

/**
 * Create or update the Garmin workout, then its single calendar entry.
 *
 * Receipt states, persisted before the next remote call:
 *   creating    POST workout in flight. A lost response is UNCERTAIN: the
 *               Training API has no list-workouts call to find an orphan, so
 *               nothing is created again until a coach reconciles it.
 *   retryable   Garmin definitively refused the create; safe to create again.
 *   ready       workout_id saved, no confirmed calendar entry.
 *   scheduling  POST schedule in flight for scheduled_date. Safe to retry:
 *               the next attempt first lists that day's schedules and adopts
 *               an entry for this workout before posting another.
 *   sent        workout_id + schedule_id confirmed for scheduled_date.
 * Updates are PUTs to known ids and are idempotent. A 404 on a known id
 * means the athlete deleted it in Garmin Connect, so it is recreated.
 */
export async function deliverWorkout({session,steps,date,athleteCode,workout:built,fingerprint:given}, {read,save,request}) {
  validWorkoutDate(date);
  const workout=built || buildRunningWorkout(session,steps);
  const fingerprint=given || workoutFingerprint(workout,date);
  let receipt=await read();
  if (receipt && receipt.state==='creating') throw workoutError('Delivery is uncertain: Garmin didn’t confirm the last attempt. Check your Garmin Connect calendar and ask your coach to clear it before sending again.',409,'delivery_uncertain');
  const persist=async changes=>{await save(changes);receipt={...receipt,...changes};};
  let workoutChanged=true;
  if (receipt && receipt.state==='sent' && receipt.fingerprint===fingerprint && receipt.workout_id && receipt.schedule_id) {
    // Explicit re-send of an unchanged workout: confirm it is still on the
    // calendar instead of posting another copy.
    try { await request('/training-api/schedule/'+encodeURIComponent(receipt.schedule_id),'GET'); return {...receipt,unchanged:true}; }
    catch (error) { if (!notFound(error)) throw error; await persist({schedule_id:null,state:'ready'}); }
    workoutChanged=false;
  }
  if (receipt?.workout_id && workoutChanged) {
    try {
      // Full object, with ownerId required by Garmin's update contract.
      await request('/training-api/workout/v2/'+encodeURIComponent(receipt.workout_id),'PUT',{...workout,workoutId:Number(receipt.workout_id),ownerId:Number(receipt.owner_id)});
    } catch (error) {
      if (!notFound(error)) throw error;
      await persist({workout_id:null,owner_id:null,schedule_id:null,state:'retryable'});
    }
  } else if (receipt?.workout_id) {
    try { await request('/training-api/workout/v2/'+encodeURIComponent(receipt.workout_id),'GET'); }
    catch (error) { if (!notFound(error)) throw error; await persist({workout_id:null,owner_id:null,schedule_id:null,state:'retryable'}); }
  }
  if (!receipt?.workout_id) {
    await persist({athlete_code:athleteCode,planned_session_id:session.id,state:'creating',workout_id:null,owner_id:null,schedule_id:null,scheduled_date:null,fingerprint:null,sent_at:null});
    let created;
    try { created=await request('/workoutportal/workout/v2','POST',workout); }
    catch(error){if(definitive(error))await persist({state:'retryable'});throw error;}
    if (!created?.workoutId || !created?.ownerId) throw workoutError('Garmin didn’t confirm the workout. Check your Garmin Connect calendar and ask your coach before sending again.',409,'delivery_uncertain');
    await persist({workout_id:String(created.workoutId),owner_id:String(created.ownerId),state:'ready'});
  }
  const workoutId=Number(receipt.workout_id);
  // A previous calendar POST lost its answer: find it before posting again.
  // Receipts written before 6 Nov 2026 did not record the date tried, so for
  // those look a month either side of today's date. The workout id belongs to
  // this receipt alone, so any calendar entry for it is the one we made.
  if (!receipt.schedule_id && receipt.state==='scheduling') {
    const from=receipt.scheduled_date || shiftDate(date,-31);
    const to=receipt.scheduled_date || shiftDate(date,31);
    const found=scheduleList(await request('/training-api/schedule?startDate='+from+'&endDate='+to,'GET')).find(item=>Number(item && item.workoutId)===workoutId && item.scheduleId);
    if (found) await persist({schedule_id:String(found.scheduleId),state:'ready'});
  }
  if (receipt.schedule_id) {
    try { await request('/training-api/schedule/'+encodeURIComponent(receipt.schedule_id),'PUT',{scheduleId:Number(receipt.schedule_id),workoutId,date}); }
    catch (error) { if (!notFound(error)) throw error; await persist({schedule_id:null,state:'ready'}); }
  }
  if (!receipt.schedule_id) {
    await persist({state:'scheduling',scheduled_date:date});
    let created;
    try {created=await request('/training-api/schedule/','POST',{workoutId,date});}
    catch(error){
      if(definitive(error))await persist({state:'ready'});
      else error.code='schedule_unconfirmed';
      throw error;
    }
    // No id back: leave it 'scheduling' so the next attempt checks the day first.
    if (!created?.scheduleId) throw workoutError('Your workout is in Garmin Connect, but the calendar entry wasn’t confirmed. Try again: DP checks your Garmin calendar before adding it.',502,'schedule_unconfirmed');
    await persist({schedule_id:String(created.scheduleId)});
  }
  await persist({state:'sent',scheduled_date:date,fingerprint,sent_at:new Date().toISOString()});
  return receipt;
}
