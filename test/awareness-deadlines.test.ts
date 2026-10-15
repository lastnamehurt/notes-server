import test from "node:test";
import assert from "node:assert/strict";
import {deadlineSuggestions} from "../src/awareness-deadlines";
import {awarenessTasks, untaggedTaskKey} from "../src/awareness-tasks";
import {AwarenessInbox} from "../src/awareness-inbox";
import {buildBriefing} from "../src/briefing";

const now=new Date("2026-10-13T19:00:00Z");
const ctx={now,ownerId:"local",timeZone:"America/Los_Angeles"};
const task=(id:string,dueAt:string,overrides:Record<string,unknown>={})=>({id,dueAt,ownerId:"local",completed:false,...overrides});

test("only tasks overdue two days or more get a nudge, with privacy-safe text",()=>{
 const result=deadlineSuggestions([
  task("late","2026-10-10T16:00:00Z",{title:"Confidential medical information"}),
  task("yesterday","2026-10-12T16:00:00Z"),
  task("soon","2026-10-14T16:00:00Z"),
  task("ancient","2026-09-20T16:00:00Z")],ctx);
 assert.deepEqual(result.map(x=>x.subjectRefs[0].id),["late"]);
 assert.equal(result[0].ruleId,"task-overdue");
 assert.equal(result[0].urgency,"high");
 assert.ok(!JSON.stringify(result).includes("Confidential"));
});

test("one nudge per due date: the next day repeats the same key, a new date gets a new one",()=>{
 const first=deadlineSuggestions([task("a","2026-10-10T16:00:00Z")],ctx)[0];
 const nextDay=deadlineSuggestions([task("a","2026-10-10T16:00:00Z")],{...ctx,now:new Date("2026-10-14T19:00:00Z")})[0];
 const moved=deadlineSuggestions([task("a","2026-10-09T16:00:00Z")],ctx)[0];
 assert.equal(first.dedupeKey,nextDay.dedupeKey);
 assert.notEqual(first.dedupeKey,moved.dedupeKey);
 assert.ok(Date.parse(first.expiresAt)>Date.parse(first.createdAt));
});

test("completed, recurring, foreign-owner, invalid and duplicated tasks are skipped",()=>{
 const due="2026-10-10T16:00:00Z";
 const r=deadlineSuggestions([task("a",due,{completed:true}),task("b",due,{recurring:true}),task("c",due,{ownerId:"other"}),
  task("bad id",due),task("d","bad"),task("e",due),task("e",due)],ctx);
 assert.deepEqual(r.map(x=>x.subjectRefs[0].id),["e"]);
});

test("invalid timezone fails closed",()=>{
 assert.throws(()=>deadlineSuggestions([],{...ctx,timeZone:"Mars/Phobos"}));
});

test("open tasks are read with their ID, or a stable key that hides the title",async()=>{
 const notes=[{name:"inbox/a.md",content:[
  "- [ ] Tagged @2026-10-10 9am ^t4gg3d","- [ ] Secret plan @2026-10-11","- [ ] Meds @daily 8am",
  "- [x] Done @2026-10-01","- [ ] No date"].join("\n")},{name:"journal/log/2026-10-13.md",content:"- [ ] Log task @2026-10-01"}];
 const tasks=await awarenessTasks(notes,"America/Los_Angeles");
 assert.deepEqual(tasks.map(t=>[t.title,t.dueAt!==null,t.recurring]),[["Tagged",true,false],["Secret plan",true,false],["Meds",false,true],["No date",false,false]]);
 assert.equal(tasks[0].key,"t4gg3d");
 assert.equal(tasks[1].key,await untaggedTaskKey("inbox/a.md","Secret plan"));
 assert.match(tasks[1].key,/^n[0-9a-f]{20}$/);
});

test("an expired suggestion drops out of the inbox list",async()=>{
 const store=new Map<string,unknown>();
 const inbox=new AwarenessInbox({get:async k=>store.get(k) as any,put:async(k,v)=>{store.set(k,v);},
  list:async({prefix})=>new Map([...store].filter(([k])=>k.startsWith(prefix))) as any});
 const [s]=deadlineSuggestions([task("a","2026-10-10T16:00:00Z")],ctx);
 await inbox.add("local",s);
 assert.equal((await inbox.list("local",{now:now.toISOString()})).items.length,1);
 assert.equal(await inbox.expire("local",s.id,now.toISOString()),true);
 assert.equal((await inbox.list("local",{now:now.toISOString()})).items.length,0);
 assert.equal(await inbox.expire("local",s.id,now.toISOString()),false);
});

test("digest mode: the morning briefing counts suggestions without naming them",()=>{
 const base={kind:"morning" as const,notes:[],done:[],now:now.getTime(),timeZone:"America/Los_Angeles",preview:"full" as const};
 assert.equal(buildBriefing(base).empty,true);
 const b=buildBriefing({...base,suggestions:2});
 assert.equal(b.empty,false);
 assert.match(b.message,/2 new suggestions in Suggestions/);
 assert.equal(buildBriefing({...base,suggestions:1,preview:"counts"}).message,"1 new suggestion");
 assert.equal(buildBriefing({...base,kind:"evening",suggestions:3}).suggestions,0);
});
