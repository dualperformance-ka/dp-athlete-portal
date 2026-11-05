import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { garminActivity, mergeConnectedActivities, sameRecording } from '../public/js/connected-activities.js';
const row = {id:'123',type:'RUNNING',startTime:'2026-11-05T00:00:00Z',localDate:'2026-11-05',distanceM:10000,durationS:3600};
const g = garminActivity(row);
const s = {...g,id:123,provider:undefined,type:'Run',sport_type:'TrailRun'};
const merge=(ss,gg)=>mergeConnectedActivities({connected:true,activities:ss},{connected:true,activities:gg});
test('the same recording prefers Garmin, once, with provider-scoped ids',()=>{
 const result=merge([s],[row]);assert.equal(result.activities.length,1);assert.equal(result.activities[0].provider,'Garmin');assert.equal(g.id,'garmin:123');
});
test('separate same-day runs remain separate',()=>{
 assert.equal(merge([{...s,start_date:'2026-11-05T08:00:00Z'}],[row]).activities.length,2);
});
test('missing metrics do not hide an activity',()=>assert.equal(sameRecording(g,{...s,distance:0}),false));
test('different distances, duration, or sports remain separate',()=>{
 for(const extra of [{distance:5000},{elapsed_time:7200},{sport_type:'Ride',type:'Ride'}])assert.equal(merge([{...s,...extra}],[row]).activities.length,2);
});
test('only one Strava recording is paired to each Garmin recording',()=>assert.equal(merge([s,{...s,id:124}],[row]).activities.length,2));
test('Strava duplicates are never silently collapsed with each other',()=>assert.equal(merge([s,{...s,id:124}],[]).activities.length,2));
test('disconnected and failed providers cannot supply stale records',()=>{
 assert.equal(mergeConnectedActivities(null,{connected:false,activities:[row]}).activities.length,0);
 assert.equal(mergeConnectedActivities({connected:true,activitiesAvailable:false,activities:[s]},null).activities.length,0);
});
test('malformed Garmin records are dropped',()=>assert.equal(garminActivity({...row,startTime:'bad'}),null));
test('display code never writes provider data to logs or coach/AI endpoints',()=>{
 const source=readFileSync(new URL('../public/js/connected-activities.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/coachWrite\(|portalStateWrite\(|localStorage\.|fetch\(/);
});
