import {test,expect} from '@playwright/test';
import {bootPortal,localISO} from './harness.mjs';
const id='11111111-1111-4111-8111-111111111111';
// The coach acceptance fixture as the server converts it:
// 10 min warm-up, 6 × (1 km at 4:30–4:45/km + 90 s recovery), 10 min cool-down.
const workout=(reps=6)=>({workoutName:'6 × 1 km intervals',sport:'RUNNING',segments:[{segmentOrder:1,sport:'RUNNING',steps:[
 {type:'WorkoutStep',stepOrder:1,intensity:'WARMUP',durationType:'TIME',durationValue:600,targetType:'OPEN',description:'Easy jog, build to steady'},
 {type:'WorkoutRepeatStep',stepOrder:2,repeatType:'REPEAT_UNTIL_STEPS_CMPLT',repeatValue:reps,steps:[
  {type:'WorkoutStep',stepOrder:3,intensity:'INTERVAL',durationType:'DISTANCE',durationValue:1000,targetType:'PACE',targetValueLow:1000/285,targetValueHigh:1000/270,description:''},
  {type:'WorkoutStep',stepOrder:4,intensity:'RECOVERY',durationType:'TIME',durationValue:90,targetType:'OPEN',description:'Walk or jog'}]},
 {type:'WorkoutStep',stepOrder:5,intensity:'COOLDOWN',durationType:'TIME',durationValue:600,targetType:'OPEN',description:''}]}]});
const preview=(over={})=>({sessionId:id,workout:workout(),date:localISO(),fingerprint:'f'.repeat(64),canSend:true,reconnectUrl:'https://connect.garmin.com/oauth2Confirm?state=test',receipt:null,...over});

async function openWorkout(page,{sessionType='Intervals',width=390,onGet=()=>preview(),onPost=()=>({sent:true,state:'saved',date:localISO()})}={}){
 const calls=[],errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!/\/_vercel\//.test(m.location().url||''))errors.push(m.text());}); // the harness aborts Vercel Analytics on purpose
 await page.setViewportSize({width,height:844});
 await bootPortal(page,{rows:[{id,notion_page_id:id,title:'6 × 1 km intervals',session_type:sessionType,planned_date:localISO(),status:'Planned',week_label:'Week 12',prescription_mode:'structured'}],garmin:(path,method,url)=>{
  if(url.searchParams.get('mode')==='workout'){
   if(method==='POST'){const body=JSON.parse(page.__lastPost||'{}');calls.push({method,body});return onPost(body,calls);}
   calls.push({method});return onGet(calls);
  }
  return {available:true,connected:true,workoutsAvailable:true,activities:[]};
 }});
 await page.route(url=>url.pathname==='/api/garmin'&&url.searchParams.get('mode')==='workout',async route=>{page.__lastPost=route.request().postData();await route.fallback();});
 await expect.poll(()=>page.evaluate(()=>!!window._garminWorkoutState?.workoutsAvailable)).toBe(true);
 await page.evaluate(id=>startFocusedSession(sessions.findIndex(s=>s.id===id)),id);
 const panel=page.locator('#focusOverlay .garmin-workout');
 return {panel,calls,errors};
}
async function review(panel){await expect(panel).toBeVisible();await panel.getByRole('button',{name:'Review for Garmin'}).click();}

test('review shows the coach fixture exactly, then one tap saves it to Garmin Connect',async({page})=>{
 const {panel,calls,errors}=await openWorkout(page);await review(panel);
 const items=panel.locator('.garmin-workout-preview li');
 await expect(items.nth(0)).toContainText('Warm-up · 10 min');await expect(items.nth(0)).toContainText('Easy jog, build to steady');
 await expect(items.nth(1)).toContainText('Repeat 6 times');
 await expect(items.nth(2)).toContainText('Interval · 1 km · 4:30–4:45 /km');
 await expect(items.nth(3)).toContainText('Recovery · 90 s');await expect(items.nth(3)).toContainText('Walk or jog');
 await expect(items.nth(4)).toContainText('Cool-down · 10 min');
 await expect(panel).toContainText('Garmin calendar date:');
 await expect(panel.getByRole('status')).toContainText('Ready to send');
 expect(calls.map(c=>c.method)).toEqual(['GET']);
 // No horizontal overflow on a phone.
 expect(await page.evaluate(()=>{const el=document.querySelector('#focusOverlay .garmin-workout');return el.scrollWidth<=el.clientWidth+1&&document.documentElement.scrollWidth<=window.innerWidth+1;})).toBe(true);
 if(process.env.GARMIN_SCREENSHOT)await panel.screenshot({path:process.env.GARMIN_SCREENSHOT});
 const send=panel.getByRole('button',{name:'Send to Garmin',exact:true});
 await send.dblclick();
 await expect(panel.getByRole('button',{name:'Saved to Garmin Connect'})).toBeDisabled();
 const status=panel.getByRole('status');
 await expect(status).toContainText('Saved to your Garmin Connect calendar');await expect(status).toContainText('Sync your watch');
 await expect(status).toContainText('won’t change by itself');await expect(status).not.toContainText('on your watch');
 if(process.env.GARMIN_SCREENSHOT)await panel.screenshot({path:process.env.GARMIN_SCREENSHOT.replace(/\.png$/,'-saved.png')});
 const posts=calls.filter(c=>c.method==='POST');expect(posts).toHaveLength(1);
 expect(posts[0].body).toEqual({sessionId:id,fingerprint:'f'.repeat(64)});
 expect(errors).toEqual([]);
});
test('the review fits a 360 px phone without sideways scrolling',async({page})=>{
 const {panel,errors}=await openWorkout(page,{width:360});await review(panel);
 await expect(panel.getByRole('button',{name:'Send to Garmin',exact:true})).toBeVisible();
 const fit=await page.evaluate(()=>{const el=document.querySelector('#focusOverlay .garmin-workout');const r=el.getBoundingClientRect();return {right:r.right,vw:window.innerWidth,overflow:el.scrollWidth-el.clientWidth};});
 expect(fit.right).toBeLessThanOrEqual(fit.vw);expect(fit.overflow).toBeLessThanOrEqual(1);expect(errors).toEqual([]);
});
test('a missing WORKOUT_IMPORT permission offers reconnect before sending',async({page})=>{
 const {panel,calls}=await openWorkout(page,{onGet:()=>preview({canSend:false})});await review(panel);
 await expect(panel.getByRole('link',{name:'Reconnect Garmin'})).toHaveAttribute('href',/^https:\/\/connect\.garmin\.com\//);
 await expect(panel.getByRole('button',{name:'Send to Garmin',exact:true})).toHaveCount(0);expect(calls.map(c=>c.method)).toEqual(['GET']);
});
test('a stale preview is replaced by the coach’s new version before anything is sent',async({page})=>{
 let posts=0;
 const {panel,calls}=await openWorkout(page,{onPost:body=>{posts++;return posts===1?{__http:{status:409,body:{error:'This session changed since you reviewed it.',code:'stale_preview',preview:preview({workout:workout(5),fingerprint:'e'.repeat(64)})}}}:{sent:true,state:'saved',date:localISO()};}});
 await review(panel);await expect(panel).toContainText('Repeat 6 times');
 await panel.getByRole('button',{name:'Send to Garmin',exact:true}).click();
 await expect(panel).toContainText('Repeat 5 times');await expect(panel).not.toContainText('Repeat 6 times');
 await expect(panel.getByRole('status')).toContainText('Review the new version');
 await panel.getByRole('button',{name:'Send to Garmin',exact:true}).click();
 await expect(panel.getByRole('status')).toContainText('Saved to your Garmin Connect calendar');
 expect(calls.filter(c=>c.method==='POST').map(c=>c.body.fingerprint)).toEqual(['f'.repeat(64),'e'.repeat(64)]);
});
test('a reschedule that has not saved yet blocks sending the old date',async({page})=>{
 const {panel}=await openWorkout(page,{onGet:()=>preview({date:'2030-01-02'})});await review(panel);
 await expect(panel.getByRole('status')).toContainText('Wait for your change to save');
 await expect(panel.getByRole('button',{name:'Send to Garmin',exact:true})).toHaveCount(0);
});
test('an uncertain delivery is never reported as sent and cannot be blindly retried',async({page})=>{
 const {panel}=await openWorkout(page,{onGet:()=>preview({receipt:{state:'creating',date:null,sentAt:null,upToDate:false}})});await review(panel);
 await expect(panel.getByRole('status')).toContainText('Not confirmed');await expect(panel.getByRole('button',{name:/Send/})).toHaveCount(0);
});
test('a failed calendar entry says not confirmed and lets the athlete finish it',async({page})=>{
 const {panel}=await openWorkout(page,{onPost:()=>({__http:{status:502,body:{error:'Your workout is in Garmin Connect, but the calendar entry wasn’t confirmed.',code:'schedule_unconfirmed'}}})});
 await review(panel);const send=panel.getByRole('button',{name:'Send to Garmin',exact:true});await send.click();
 await expect(panel.getByRole('status')).toContainText('Not confirmed: Your workout is in Garmin Connect');await expect(send).toBeEnabled();
 await expect(panel.getByRole('button',{name:'Saved to Garmin Connect'})).toHaveCount(0);
});
test('an up-to-date workout says it is already in Garmin Connect and a re-send adds no copy',async({page})=>{
 const {panel}=await openWorkout(page,{onGet:()=>preview({receipt:{state:'sent',date:localISO(),sentAt:new Date().toISOString(),upToDate:true}}),onPost:()=>({sent:true,state:'saved',date:localISO(),unchanged:true})});
 await review(panel);await expect(panel.getByRole('status')).toContainText('Already in your Garmin Connect calendar');
 await panel.getByRole('button',{name:'Send again'}).click();await expect(panel.getByRole('status')).toContainText('Still in your Garmin Connect calendar');
});
test('a coach change after sending offers an update rather than a second copy',async({page})=>{
 const {panel}=await openWorkout(page,{onGet:()=>preview({receipt:{state:'sent',date:localISO(),sentAt:new Date().toISOString(),upToDate:false}})});
 await review(panel);await expect(panel.getByRole('button',{name:'Update in Garmin Connect'})).toBeVisible();await expect(panel.getByRole('status')).toContainText('replace it in Garmin Connect');
});
test('mixed sessions such as a brick do not offer Send to Garmin',async({page})=>{
 const {panel}=await openWorkout(page,{sessionType:'Brick'});await page.waitForTimeout(500);await expect(panel).toHaveCount(0);
});
