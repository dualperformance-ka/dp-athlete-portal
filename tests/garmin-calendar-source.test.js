import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {matchActivityToSession} from '../public/js/strava-match.js';
const read=p=>readFileSync(new URL('../public/js/'+p,import.meta.url),'utf8');
function fixture(activities){
 const s={id:'run1',date:'2026-11-05',plannedKm:13};
 const context={Set,window:{matchActivityToSession,_connectedActivityFeed:{activities}},allSessions:[s],getType:()=> 'run',plannedRunKm:s=>s.plannedKm,calendarStravaDistanceKm:()=>13.2,calendarKmLabel:km=>Number(km.toFixed(1))+'km',resolveRunDisplay:()=>({meta:{}})};
 vm.createContext(context);vm.runInContext(read('connected-activities.js').replace(/^export /gm,''),context);
 const source=read('08-training.js'),start=source.indexOf('function monthSessionDetail('),end=source.indexOf('\nfunction ',start+1);
 vm.runInContext(source.slice(start,end),context);
 return {context,s};
}
const activity={id:'garmin:g1',provider:'Garmin',type:'Run',sport_type:'Run',distance:13100,moving_time:3600,elapsed_time:3600,start_date:'2026-11-05T00:00:00Z',start_date_local:'2026-11-05T10:30:00'};
test('the Week calendar prefers actual Garmin distance and attribution',()=>{
 const {context,s}=fixture([activity]);assert.equal(context.monthSessionDetail(s),'13.1km · Garmin');
});
test('a linked account without Garmin activities keeps the existing Strava result',()=>{
 const {context,s}=fixture([]);assert.equal(context.monthSessionDetail(s),'13.2km · Strava');
});
test('a single Garmin recording is not assigned to two same-day sessions',()=>{
 const {context,s}=fixture([activity]);const second={...s,id:'run2'};context.allSessions.push(second);
 assert.ok(context.window.getConnectedSessionMatch(s));assert.equal(context.window.getConnectedSessionMatch(second),null);
});
test('combined Garmin warmup/main recordings keep Garmin attribution',()=>{
 const {context,s}=fixture([{...activity,distance:6000,moving_time:1800,elapsed_time:1800},{...activity,id:'garmin:g2',distance:7000,start_date:'2026-11-05T00:40:00Z',start_date_local:'2026-11-05T11:10:00',moving_time:1800,elapsed_time:1800}]);
 assert.equal(context.monthSessionDetail(s),'13km · Garmin');
});
test('connection status distinguishes linking from data received',()=>{
 const boot=read('10-boot.js');assert.match(boot,/Account linked\. No Garmin data received yet/);
 assert.match(read('connected-activities.js'),/Waiting for the first Garmin activity/);
});

test('a matching Garmin ride supplies the calendar and ride detail while preserving feedback', () => {
  const strava = { ...activity, id: 123, provider: 'Strava', type: 'Ride', sport_type: 'Ride', distance: 50000 };
  const garmin = { ...strava, id: 'garmin:ride', provider: 'Garmin', distance: 50075, device: 'Garmin fenix 7' };
  const { context, s } = fixture([garmin]);
  Object.assign(context, {
    getType: () => 'ride',
    getStravaSessionMatch: () => ({ activity: strava }),
    logs: { [s.id]: { __stravaMatch: { activity: strava } } },
    _sessionOverrides: {},
    esc: String,
    stravaActivitySummary: a => ({ distance: a.distance / 1000, duration: a.moving_time / 60 }),
    enduranceStravaReviewHtml: () => 'Strava review',
    runCheckinHtml: () => 'Session feedback'
  });
  const source = read('08-training.js');
  const start = source.indexOf('function endurancePrescriptionHtml(');
  vm.runInContext(source.slice(start, source.indexOf('\nfunction ', start + 1)), context);

  assert.equal(context.monthSessionDetail(s), '50.1km · Garmin');
  const html = context.endurancePrescriptionHtml(s, 'ride', 0);
  assert.match(html, /Garmin fenix 7/);
  assert.match(html, /50.1 km/);
  assert.match(html, /Session feedback/);
  assert.doesNotMatch(html, /Synced from Strava|Strava review/);

  context.window._connectedActivityFeed.activities = [{ ...garmin, start_date: '2026-11-05T05:00:00Z' }];
  assert.match(context.endurancePrescriptionHtml(s, 'ride', 0), /Synced from Strava/);
});
