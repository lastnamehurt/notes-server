import test from "node:test";
import assert from "node:assert/strict";
import {deadlineSuggestions} from "../src/awareness-deadlines";
const now=new Date("2026-10-13T19:00:00Z");
const ctx={now,ownerId:"local",timeZone:"America/Los_Angeles",reminderTaskIds:new Set<string>()};
const task=(id:string,dueAt:string,overrides:Record<string,unknown>={})=>({id,dueAt,ownerId:"local",completed:false,...overrides});
test("upcoming and overdue candidates have stable privacy-safe evidence",()=>{
 const result=deadlineSuggestions([task("abc","2026-10-14T18:00:00Z",{title:"Confidential medical information"}),task("def","2026-10-13T15:00:00Z")],ctx);
 assert.deepEqual(result.map(x=>x.ruleId),["task-deadline","task-overdue"]);
 assert.equal(result[1].urgency,"high");
 assert.ok(result.every(x=>!JSON.stringify(x).includes("Confidential")));
 assert.deepEqual(deadlineSuggestions([task("abc","2026-10-14T18:00:00Z")],ctx).map(x=>x.dedupeKey),[result[0].dedupeKey]);
});
test("completed, recurring, foreign-owner, invalid and duplicated tasks are skipped",()=>{
 const r=deadlineSuggestions([task("a","2026-10-14T18:00:00Z",{completed:true}),task("b","2026-10-14T18:00:00Z",{recurring:true}),task("c","2026-10-14T18:00:00Z",{ownerId:"other"}),task("bad id","2026-10-14T18:00:00Z"),task("d","bad"),task("e","2026-10-14T18:00:00Z"),task("e","2026-10-14T18:00:00Z")],ctx);
 assert.deepEqual(r.map(x=>x.subjectRefs[0].id),["e"]);
});
test("reminder collisions and briefing windows suppress suggestions",()=>{
 assert.deepEqual(deadlineSuggestions([task("abc","2026-10-14T18:00:00Z")],{...ctx,reminderTaskIds:new Set(["abc"])}),[]);
 assert.deepEqual(deadlineSuggestions([task("abc","2026-10-14T18:00:00Z")],{...ctx,briefingWindow:{startsAt:"2026-10-13T18:00:00Z",endsAt:"2026-10-13T20:00:00Z"}}),[]);
});
test("out-of-range deadlines, just-due tasks and stale overdue items are ignored",()=>{
 assert.deepEqual(deadlineSuggestions([task("a","2026-10-16T19:00:00Z"),task("b","2026-10-13T18:30:00Z"),task("c","2026-10-01T19:00:00Z")],ctx),[]);
});
test("invalid timezone and briefing interval fail closed",()=>{
 assert.throws(()=>deadlineSuggestions([],{...ctx,timeZone:"Mars/Phobos"}));
 assert.throws(()=>deadlineSuggestions([],{...ctx,briefingWindow:{startsAt:"invalid",endsAt:"2026-10-13T20:00:00Z"}}));
});
