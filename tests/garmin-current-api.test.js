import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchPermissions,fetchUserId,deregister} from '../api/_lib/garmin-client.js';
import {readFileSync} from 'node:fs';
test('OAuth2 identity, permission and deregistration reads use the current partner gateway',async()=>{
 const calls=[];const request=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(url.endsWith('/id')?{userId:'u1'}:{permissions:['ACTIVITY_EXPORT','WORKOUT_IMPORT']}),{status:200});};
 assert.equal(await fetchUserId('token',request),'u1');assert.deepEqual(await fetchPermissions('token',request),['ACTIVITY_EXPORT','WORKOUT_IMPORT']);await deregister('token',request);
 assert.deepEqual(calls.map(c=>c.url),['https://apis.garmin.com/partner-gateway/rest/user/id','https://apis.garmin.com/partner-gateway/rest/user/permissions','https://apis.garmin.com/partner-gateway/rest/user/registration']);assert.equal(calls[2].options.method,'DELETE');
});
test('history requires verified HISTORICAL_DATA_EXPORT permission',()=>{
 const source=readFileSync(new URL('../api/garmin.js',import.meta.url),'utf8');
 assert.match(source,/const historyAvailable = permissionsVerified && permissions.includes\('HISTORICAL_DATA_EXPORT'\)/);
 assert.match(source,/if \(!reconnectRecommended && historyAvailable && !connection.backfill_requested_at\)/);
});
