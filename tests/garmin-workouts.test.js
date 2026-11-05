import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunningWorkout, deliverWorkout } from '../api/_lib/garmin-workouts.js';
const session={id:'s1',title:'Intervals',session_type:'Run',prescription_mode:'structured'};
const steps=[{id:'w',step_order:1,step_type:'warmup',duration_sec:600},{id:'r',step_order:2,step_type:'repeat',repeat_count:6},{id:'i',parent_step_id:'r',step_order:3,step_type:'interval',distance_km:1,intensity_type:'pace_range',pace_min:'4:30',pace_max:'4:45'},{id:'j',parent_step_id:'r',step_order:4,step_type:'recovery',duration_sec:90},{id:'c',step_order:5,step_type:'cooldown',duration_sec:600}];
test('convert warmup, repeat intervals, recovery and cooldown in coach order',()=>{
 const w=buildRunningWorkout(session,steps);assert.equal(w.sport,'RUNNING');assert.equal(w.segments[0].steps[1].type,'WorkoutRepeatStep');assert.equal(w.segments[0].steps[1].repeatValue,6);const interval=w.segments[0].steps[1].steps[0];assert.equal(interval.durationValue,1000);assert.equal(interval.targetType,'PACE');assert.equal(interval.targetValueLow,1000/285);assert.equal(interval.targetValueHigh,1000/270);
});
test('reject text-only prescriptions rather than guessing workout steps',()=>assert.throws(()=>buildRunningWorkout({...session,prescription_mode:'legacy'},[]),/structured/i));
test('reject malformed, cyclic, orphaned or overlong step trees',()=>{
 for(const invalid of [[...steps,{id:'orphan',parent_step_id:'missing',step_type:'run',duration_sec:60}],steps.map(s=>s.id==='r'?{...s,repeat_count:1000}:s),[{id:'x',parent_step_id:'x',step_type:'repeat',repeat_count:2}],steps.map(s=>s.id==='i'?{...s,pace_min:'bad'}:s)])assert.throws(()=>buildRunningWorkout(session,invalid));
});
test('HR zones and RPE instructions preserve coach targets',()=>{
 const w=buildRunningWorkout(session,[{id:'a',step_type:'run',distance_km:5,intensity_type:'hr_zone',hr_zone:'Z2'},{id:'b',step_type:'run',duration_sec:120,intensity_type:'rpe',rpe:7}]);
 assert.equal(w.segments[0].steps[0].targetValue,2);assert.match(w.segments[0].steps[1].description,/RPE 7/);
});
function fixture(receipt=null){
 const state={receipt,calls:[],writes:[]};
 return {state,deps:{read:async()=>state.receipt,save:async(value)=>{state.receipt={...state.receipt,...value};state.writes.push(value);},request:async(path,method,body)=>{state.calls.push({path,method,body});return path.includes('schedule')?{scheduleId:44,workoutId:33}:{workoutId:33,ownerId:22};}}};
}
const args={session,steps,date:'2026-11-06',athleteCode:'KARL'};
test('create workout once, persist its id before scheduling, then retry without duplicates',async()=>{
 const {state,deps}=fixture();await deliverWorkout(args,deps);assert.equal(state.calls.length,2);assert.equal(state.calls[0].path,'/workoutportal/workout/v2');assert.equal(state.calls[1].body.date,args.date);assert.equal(state.receipt.state,'sent');await deliverWorkout(args,deps);assert.equal(state.calls.length,2);
});
test('changed prescription or date updates existing Garmin ids',async()=>{
 const {state,deps}=fixture();await deliverWorkout(args,deps);await deliverWorkout({...args,date:'2026-11-07',session:{...session,title:'Updated'}},deps);assert.equal(state.calls[2].method,'PUT');assert.equal(state.calls[2].body.ownerId,22);assert.equal(state.calls[3].path,'/training-api/schedule/44');
});
test('a failed schedule retries the schedule using the saved workout id',async()=>{
 const {state,deps}=fixture();const request=deps.request;let once=true;deps.request=async(...a)=>{if(a[0].includes('schedule')&&once){once=false;throw Object.assign(new Error('rate limit'),{status:429});}return request(...a);};await assert.rejects(deliverWorkout(args,deps));assert.equal(state.receipt.workout_id,'33');await deliverWorkout(args,deps);assert.equal(state.calls.filter(c=>c.path==='/workoutportal/workout/v2').length,1);
});
test('uncertain create or schedule responses never cause a blind second create',async()=>{
 const {state,deps}=fixture();deps.request=async()=>{throw new Error('network lost');};await assert.rejects(deliverWorkout(args,deps));assert.equal(state.receipt.state,'creating');await assert.rejects(deliverWorkout(args,deps),/uncertain/i);
});
test('invalid dates are rejected before a remote write',async()=>{
 const {state,deps}=fixture();await assert.rejects(deliverWorkout({...args,date:'2026-02-30'},deps));assert.equal(state.calls.length,0);
});
