import test from "node:test";
import assert from "node:assert/strict";
import {explainAwareness} from "../src/awareness-explanations";
const now=Date.parse("2026-10-13T12:00:00Z");
const candidate={ownerId:"alice",ruleId:"task-three-deferrals",reason:"Unverified AI claim",evidenceEventIds:["ev1","ev2"]};
const evidence=[
 {id:"ev1",ownerId:"alice",source:"daybook",observedAt:"2026-10-12T12:00:00Z",description:"Task postponed on Monday",permitted:true},
 {id:"ev2",ownerId:"alice",source:"daybook",observedAt:"2026-10-13T09:00:00Z",description:"Task postponed again",permitted:true}
];
const options={ownerId:"alice",enabled:true,now};
test("explains only referenced authorized evidence",()=>{
 const result=explainAwareness(candidate,evidence,options);
 assert.equal(result.status,"available");assert.equal(result.evidence.length,2);
 assert.match(result.text,/Task postponed on Monday/);
 assert.ok(!result.text.includes("Unverified AI claim"));
});
test("missing evidence cannot be invented",()=>{
 const result=explainAwareness(candidate,evidence.slice(0,1),options);
 assert.equal(result.status,"unavailable");assert.deepEqual(result.evidence,[]);
});
test("owner isolation, consent and revoked evidence fail closed",()=>{
 for(const o of [{...options,ownerId:"bob"},{...options,enabled:false}])
  assert.equal(explainAwareness(candidate,evidence,o).status,"unavailable");
 assert.equal(explainAwareness(candidate,[{...evidence[0],permitted:false},evidence[1]],options).status,"unavailable");
 assert.equal(explainAwareness(candidate,[{...evidence[0],ownerId:"bob"},evidence[1]],options).status,"unavailable");
});
test("expired evidence and duplicates fail closed",()=>{
 assert.equal(explainAwareness(candidate,[{...evidence[0],observedAt:"2025-01-01T00:00:00Z"},evidence[1]],options).status,"unavailable");
 assert.equal(explainAwareness(candidate,[...evidence,evidence[0]],options).status,"unavailable");
});
test("markup is stripped from explanation text",()=>{
 const result=explainAwareness(candidate,[{...evidence[0],description:"<img onerror=alert(1)> postponed"},evidence[1]],options);
 assert.equal(result.status,"available");assert.ok(!result.text.includes("<"));
});
