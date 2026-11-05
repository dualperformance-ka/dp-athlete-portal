import {test,expect} from '@playwright/test';
import {bootPortal,localISO} from './harness.mjs';
const id='11111111-1111-4111-8111-111111111111';
const workout={workoutName:'6 × 1 km intervals',sport:'RUNNING',segments:[{steps:[{type:'WorkoutStep',intensity:'WARMUP',durationType:'TIME',durationValue:600,targetType:'OPEN'},{type:'WorkoutRepeatStep',repeatValue:6,steps:[{type:'WorkoutStep',intensity:'INTERVAL',durationType:'DISTANCE',durationValue:1000,targetType:'PACE',targetValueLow:1000/285,targetValueHigh:1000/270},{type:'WorkoutStep',intensity:'RECOVERY',durationType:'TIME',durationValue:90,targetType:'OPEN'}]}]}]};
async function openWorkout(page,{canSend=true}={}){
 const calls=[];await page.setViewportSize({width:390,height:844});
 await bootPortal(page,{rows:[{id,notion_page_id:id,title:'Intervals',session_type:'run',planned_date:localISO(),status:'Planned',week_label:'Week 12',prescription_mode:'structured'}],garmin:(path,method,url)=>{
  if(url.searchParams.get('mode')==='workout'){calls.push(method);return method==='POST'?{sent:true,date:localISO()}:{workout,date:localISO(),canSend,reconnectUrl:'https://connect.garmin.com/oauth2Confirm?state=test'};}
  return {available:true,connected:true,workoutsAvailable:true,activities:[]};
 }});
 await expect.poll(()=>page.evaluate(()=>!!window._garminWorkoutState?.workoutsAvailable)).toBe(true);
 await page.evaluate(id=>startFocusedSession(sessions.findIndex(s=>s.id===id)),id);
 const panel=page.locator('#focusOverlay .garmin-workout');await expect(panel).toBeVisible();await panel.getByRole('button',{name:'Review for Garmin'}).click();return {panel,calls};
}
test('review then send a running workout to Garmin, once per tap',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 const {panel,calls}=await openWorkout(page);await expect(panel).toContainText('Repeat 6 times');await expect(panel).toContainText('4:30–4:45 /km');expect(calls).toEqual(['GET']);
 await panel.getByRole('button',{name:'Send to Garmin',exact:true}).click();await expect(panel.getByRole('button',{name:'Sent to Garmin Connect'})).toBeDisabled();await expect(panel.getByRole('status')).toContainText('Sync Garmin Connect');expect(calls).toEqual(['GET','POST']);expect(errors).toEqual([]);
});
test('a missing WORKOUT_IMPORT permission offers reconnect before sending',async({page})=>{
 const {panel,calls}=await openWorkout(page,{canSend:false});await expect(panel.getByRole('link',{name:'Reconnect Garmin'})).toBeVisible();await expect(panel.getByRole('button',{name:'Send to Garmin',exact:true})).toHaveCount(0);expect(calls).toEqual(['GET']);
});
