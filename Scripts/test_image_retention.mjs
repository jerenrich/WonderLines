import assert from 'node:assert/strict';
import {cleanExpiredRecoveryImages} from '../workers/coloring-sheets-api/src/image-retention.mjs';

const now=Date.parse('2026-10-31T12:00:00Z'),cutoff=now-86400000;
const compare='f66c3047-7ae6-4a1d-9144-7514e7a44961',app='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const object=(key,time)=>({key,uploaded:new Date(time)});
const expired=object(`${app}/${id}.png`,cutoff-1),boundary=object(`${app}/${id.replace('bbbbbbbb','cccccccc')}.png`,cutoff);
const protectedObjects=[object(`${compare}/${id}.png`,0),object(`${compare.toUpperCase()}/${id}.png`,0),object(`${app}/${id}.usage.json`,0),object(`reports/${app}/${id}.png`,0),object('unknown.png',0)];
let deleted=[],pages=0;
const bucket={list:async({cursor,limit})=>{assert.equal(limit,1000);pages++;return cursor?{objects:[boundary],truncated:false}:{objects:[expired,...protectedObjects],truncated:true,cursor:'next'};},delete:async keys=>deleted.push(...keys)};
const result=await cleanExpiredRecoveryImages(bucket,compare,now);
assert.deepEqual(deleted,[expired.key]);assert.equal(result.removed,1);assert.equal(pages,2);
for(const invalid of [undefined,'',app+'/',null])await assert.rejects(cleanExpiredRecoveryImages(bucket,invalid,now),/invalid_image_retention_configuration/);
await assert.rejects(cleanExpiredRecoveryImages(bucket,compare,NaN),/invalid_image_retention_configuration/);
await assert.rejects(cleanExpiredRecoveryImages({list:async()=>({objects:[{...expired,uploaded:null}]}),delete:async()=>assert.fail()},compare,now),/invalid_image_retention_timestamp/);
await assert.rejects(cleanExpiredRecoveryImages({...bucket,delete:async()=>{throw Error('delete failed');}},compare,now),/delete failed/);
await assert.rejects(cleanExpiredRecoveryImages({list:async()=>({objects:[],truncated:true,cursor:'same'})},compare,now),/invalid_image_retention_cursor/);
assert.equal((await cleanExpiredRecoveryImages({list:async()=>({objects:protectedObjects,truncated:false}),delete:async()=>assert.fail()},compare,now)).removed,0);
console.log('PASS: 24-hour app recovery expiry, permanent comparison exemption, exact boundary, pagination, scoped keys, invalid configuration, deletion failures and cursor protection.');
