import test from "node:test";
import assert from "node:assert/strict";
import {rankAwareness,scoreRelevance,type RelevanceFeedback} from "../src/awareness-relevance";
const now=Date.parse("2026-10-13T12:00:00Z");
const candidate={id:"one",ownerId:"alice",ruleId:"deadlines",urgency:"normal",createdAt:"2026-10-12T00:00:00Z"};
const item=(action:RelevanceFeedback["action"],ownerId="alice",ruleId="deadlines",at="2026-10-12T12:00:00Z"):RelevanceFeedback=>({action,ownerId,ruleId,at});
const ctx={ownerId:"alice",enabled:true,now};
test("fallback remains deterministic with insufficient feedback",()=>{
 assert.deepEqual(scoreRelevance(candidate,[item("opened")],ctx),{score:0,evidenceCount:0,mode:"fallback"});
});
test("feedback can prioritize a relevant candidate",()=>{
 const other={...candidate,id:"two",ruleId:"deferrals"};
 const result=rankAwareness([other,candidate],[item("opened"),item("opened"),item("opened")],ctx);
 assert.deepEqual(result.map(x=>x.id),["one","two"]);
});
test("negative feedback lowers rank without disabling consent gates",()=>{
 const result=scoreRelevance(candidate,[item("muted"),item("dismissed"),item("snoozed")],ctx);
 assert.equal(result.score,-6);
 assert.deepEqual(scoreRelevance(candidate,[item("opened"),item("opened"),item("opened")],{...ctx,enabled:false}),{score:0,evidenceCount:0,mode:"fallback"});
});
test("cross-owner feedback and candidates never leak",()=>{
 assert.equal(scoreRelevance(candidate,[item("opened","bob"),item("opened","bob"),item("opened","bob")],ctx).mode,"fallback");
 assert.deepEqual(rankAwareness([{...candidate,ownerId:"bob"},candidate],[],ctx).map(x=>x.id),["one"]);
});
test("stale, future and unrelated feedback cannot change relevance",()=>{
 const events=[item("opened","alice","deadlines","2025-01-01T00:00:00Z"),item("opened","alice","deadlines","2027-01-01T00:00:00Z"),item("opened","alice","other")];
 assert.equal(scoreRelevance(candidate,events,ctx).mode,"fallback");
});
test("bounded scoring prevents feedback storms",()=>{
 const result=scoreRelevance(candidate,Array.from({length:200},()=>item("opened")),ctx);
 assert.equal(result.score,10);assert.equal(result.evidenceCount,50);
});
