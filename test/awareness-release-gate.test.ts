import test from "node:test";
import assert from "node:assert/strict";
import {DEFAULT_AWARENESS_PREFERENCES} from "../src/awareness-preferences";
import {interruptionDecision} from "../src/awareness-interruption";
import {rankAwareness} from "../src/awareness-relevance";
import {AwarenessInbox} from "../src/awareness-inbox";
const now=new Date("2026-10-13T17:00:00Z");
const candidate={id:"c1",ownerId:"alice",ruleId:"deadlines",dedupeKey:"d1",reason:"Deadline",createdAt:"2026-10-13T12:00:00Z",expiresAt:"2026-10-14T12:00:00Z",evidenceEventIds:["e1"],subjectRefs:[],suggestedActions:[],urgency:"normal"};
const store=()=>{const data=new Map<string,unknown>();return {
 get:async<T>(key:string)=>data.get(key) as T|undefined,
 put:async<T>(key:string,value:T)=>{data.set(key,value);},
 list:async<T>({prefix}:{prefix:string})=>new Map([...data].filter(([k])=>k.startsWith(prefix))) as Map<string,T>
};};
test("Awareness remains opt-out, inbox-only and external sources off by default",()=>{
 const p=DEFAULT_AWARENESS_PREFERENCES;
 assert.equal(p.enabled,false);assert.equal(p.mode,"inbox");
 assert.deepEqual([p.sources.appleReminders,p.sources.calendar,p.sources.github],[false,false,false]);
});
test("default preferences cannot authorize a push",()=>{
 const result=interruptionDecision(DEFAULT_AWARENESS_PREFERENCES,{now,timeZone:"UTC",candidateCreatedAt:candidate.createdAt,candidateExpiresAt:candidate.expiresAt,candidateDedupeKey:candidate.dedupeKey,sentToday:0,dismissed:false,muted:false,stale:false,alreadyDelivered:false});
 assert.equal(result.action,"suppress");
});
test("owner-scoped inbox cannot be read or ranked across owners",async()=>{
 const inbox=new AwarenessInbox(store());
 await inbox.add("alice",candidate);
 assert.equal(await inbox.get("bob","c1"),null);
 assert.deepEqual((await inbox.list("bob",{now:now.toISOString()})).items,[]);
 assert.deepEqual(rankAwareness([candidate],[],{ownerId:"bob",enabled:true,now:now.getTime()}),[]);
});
test("owner mismatch cannot insert another owner's suggestion",async()=>{
 const inbox=new AwarenessInbox(store());
 await assert.rejects(inbox.add("bob",candidate),/Invalid awareness candidate/);
});
