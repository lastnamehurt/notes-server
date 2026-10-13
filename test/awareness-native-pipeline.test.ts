import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {threeDeferrals} from "../src/awareness-rules";
import {DEFAULT_AWARENESS_PREFERENCES} from "../src/awareness-preferences";
const source=readFileSync(new URL("../src/reminders.ts",import.meta.url),"utf8");
test("scheduler connects committed deferrals to inbox only behind consent",()=>{
 assert.match(source,/if \(inserted > 0\)/);
 assert.match(source,/preferences\.enabled && !preferences\.paused && deferralSourceAllowed\(preferences, source\)/);
 assert.match(source,/threeDeferrals\(evidence, "local"\)/);
 assert.match(source,/inbox\.add\("local", suggestion\)/);
 assert.equal(DEFAULT_AWARENESS_PREFERENCES.enabled,false);
});
test("three distinct connected moves yield one suggestion without push",()=>{
 const now=new Date("2026-10-13T12:00:00Z");
 const dates=["2026-10-15T12:00:00Z","2026-10-16T12:00:00Z","2026-10-17T12:00:00Z","2026-10-18T12:00:00Z"];
 const events=Array.from({length:3},(_,i)=>({id:"e"+i,ownerId:"local",type:"task.deferred",occurredAt:new Date(now.getTime()-(3-i)*60000).toISOString(),subjectRef:{kind:"task",id:"abcd"},metadata:{taskId:"abcd",fromDueAt:dates[i],toDueAt:dates[i+1]}}));
 const result=threeDeferrals(events,"local",now);
 assert.equal(result.length,1);assert.equal(result[0].evidenceEventIds.length,3);
 assert.equal(result[0].ruleId,"task-three-deferrals");
 assert.equal(threeDeferrals(events,"other",now).length,0);
 assert.equal(threeDeferrals([events[0],events[1],events[1]],"local",now).length,0);
});
