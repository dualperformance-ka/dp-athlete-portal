import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunningWorkout, deliverWorkout, GARMIN_RUN_SESSION_TYPES } from '../api/_lib/garmin-workouts.js';
import { readFileSync } from 'node:fs';
const session={id:'s1',title:'Intervals',session_type:'Run',prescription_mode:'structured'};
const steps=[{id:'w',step_order:1,step_type:'warmup',duration_sec:600},{id:'r',step_order:2,step_type:'repeat',repeat_count:6},{id:'i',parent_step_id:'r',step_order:3,step_type:'interval',distance_km:1,intensity_type:'pace_range',pace_min:'4:30',pace_max:'4:45'},{id:'j',parent_step_id:'r',step_order:4,step_type:'recovery',duration_sec:90},{id:'c',step_order:5,step_type:'cooldown',duration_sec:600}];
test('convert warmup, repeat intervals, recovery and cooldown in coach order',()=>{
 const w=buildRunningWorkout(session,steps);assert.equal(w.sport,'RUNNING');assert.equal(w.segments[0].steps[1].type,'WorkoutRepeatStep');assert.equal(w.segments[0].steps[1].repeatValue,6);const interval=w.segments[0].steps[1].steps[0];assert.equal(interval.durationValue,1000);assert.equal(interval.targetType,'PACE');assert.equal(interval.targetValueLow,1000/285);assert.equal(interval.targetValueHigh,1000/270);
});
test('accept the running types coaches programme and refuse mixed or non-running sessions',()=>{
 for(const type of ['Run','running','Easy Effort','Easy','Tempo','Speed','Long Run','Recovery','race','Threshold','VO2','Intervals','Fartlek','Hills','MP','Time Trial'])assert.equal(buildRunningWorkout({...session,session_type:type},steps).sport,'RUNNING',type);
 for(const type of [null,'','Strength','Run + Strength','Brick','Optional','Weekly KM Total','Swim','Cycling','discovery'])assert.throws(()=>buildRunningWorkout({...session,session_type:type},steps),/Only running sessions/,String(type));
});
test('the portal button and the dashboard builder share the server list of running types',()=>{
 const client=readFileSync(new URL('../public/js/garmin-workouts.js',import.meta.url),'utf8');
 const list=/RUN_TYPES=\[([^\]]+)\]/.exec(client);assert.ok(list,'client list');
 assert.deepEqual(list[1].split(',').map(v=>v.trim().replace(/^'|'$/g,'')).sort(),[...GARMIN_RUN_SESSION_TYPES].sort());
});
test('pace range direction survives conversion to m/s whichever order the coach typed it',()=>{
 for(const [a,b] of [['4:30','4:45'],['4:45','4:30'],['4:45 /km','4:30 min/km']]){
  const step=buildRunningWorkout(session,[{id:'a',step_type:'interval',distance_km:1,intensity_type:'pace_range',pace_min:a,pace_max:b}]).segments[0].steps[0];
  assert.equal(step.targetType,'PACE');assert.equal(step.targetValueLow,1000/285);assert.equal(step.targetValueHigh,1000/270);
  // Converted back to pace: low speed is the slow end, high speed the fast end.
  assert.equal(Math.round(1000/step.targetValueLow),285);assert.equal(Math.round(1000/step.targetValueHigh),270);
 }
 const single=buildRunningWorkout(session,[{id:'a',step_type:'run',distance_km:1,intensity_type:'pace',pace_min:'5:00'}]).segments[0].steps[0];assert.equal(single.targetValueLow,single.targetValueHigh);assert.equal(single.targetValueLow,1000/300);
});
test('distance in metres, time in seconds, no end means lap button, and fractional km stay exact',()=>{
 const w=buildRunningWorkout(session,[{id:'a',step_order:1,step_type:'run',distance_km:0.3},{id:'b',step_order:2,step_type:'run',distance_km:'1.2'},{id:'c',step_order:3,step_type:'rest',duration_sec:45},{id:'d',step_order:4,step_type:'run'}]).segments[0].steps;
 assert.deepEqual(w.map(s=>[s.durationType,s.durationValue]),[['DISTANCE',300],['DISTANCE',1200],['TIME',45],['OPEN',null]]);
});
test('effort and RPE travel as step instructions with the coach’s own words',()=>{
 const w=buildRunningWorkout(session,[{id:'a',step_order:1,step_type:'run',duration_sec:300,intensity_type:'effort',effort:'Conversational',instructions:'Relax shoulders'},{id:'b',step_order:2,step_type:'run',duration_sec:60,intensity_type:'rpe',rpe:8,instructions:'Hills'}]).segments[0].steps;
 assert.equal(w[0].description,'Conversational. Relax shoulders');assert.equal(w[0].targetType,'OPEN');assert.equal(w[1].description,'RPE 8/10. Hills');assert.equal(w[1].targetType,'OPEN');
});
test('an invalid step says which step needs a coach change',()=>{
 assert.throws(()=>buildRunningWorkout(session,steps.map(s=>s.id==='i'?{...s,pace_min:'fast'}:s)),/^Error: Step 3 \(Interval\): pace “fast”/);
 assert.throws(()=>buildRunningWorkout(session,[{id:'a',step_type:'run',distance_km:1,duration_sec:60}]),/Step 1 \(Run\): choose either a distance or a time/);
 assert.throws(()=>buildRunningWorkout(session,[{id:'a',step_type:'run',intensity_type:'hr',hr_zone:'threshold'}]),/Step 1 \(Run\): heart-rate targets must be a Garmin zone/);
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
 const {state,deps}=fixture();await deliverWorkout(args,deps);assert.equal(state.calls.length,2);assert.equal(state.calls[0].path,'/workoutportal/workout/v2');assert.equal(state.calls[1].body.date,args.date);assert.equal(state.receipt.state,'sent');const again=await deliverWorkout(args,deps);assert.equal(again.unchanged,true);assert.deepEqual(state.calls.slice(2).map(c=>c.method+' '+c.path),['GET /training-api/schedule/44']);
});
test('changed prescription or date updates existing Garmin ids',async()=>{
 const {state,deps}=fixture();await deliverWorkout(args,deps);await deliverWorkout({...args,date:'2026-11-07',session:{...session,title:'Updated'}},deps);assert.equal(state.calls[2].method,'PUT');assert.equal(state.calls[2].body.ownerId,22);assert.equal(state.calls[3].path,'/training-api/schedule/44');
});
test('a failed schedule retries the schedule using the saved workout id',async()=>{
 const {state,deps}=fixture();const request=deps.request;let once=true;deps.request=async(...a)=>{if(a[0].includes('schedule')&&once){once=false;throw Object.assign(new Error('rate limit'),{status:429});}return request(...a);};await assert.rejects(deliverWorkout(args,deps));assert.equal(state.receipt.workout_id,'33');await deliverWorkout(args,deps);assert.equal(state.calls.filter(c=>c.path==='/workoutportal/workout/v2').length,1);
});
test('uncertain create or schedule responses never cause a blind second create',async()=>{
 const {state,deps}=fixture();deps.request=async()=>{throw new Error('network lost');};await assert.rejects(deliverWorkout(args,deps));assert.equal(state.receipt.state,'creating');await assert.rejects(deliverWorkout(args,deps),/uncertain/i);assert.equal(state.calls.length,0);
});
test('invalid dates are rejected before a remote write',async()=>{
 const {state,deps}=fixture();await assert.rejects(deliverWorkout({...args,date:'2026-02-30'},deps));assert.equal(state.calls.length,0);
});
