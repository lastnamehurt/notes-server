import test from "node:test";
import assert from "node:assert/strict";
import {appleSignals} from "../src/awareness-apple-signals";
const consent={enabled:true,paused:false,appleReminders:true,connected:true};
const before=[{id:"abc123",dueAt:"2026-10-14T12:00:00Z",completed:false}];
const after=[{id:"abc123",dueAt:"2026-10-16T12:00:00Z",completed:false}];
const run="run-12345678";
test("later due date produces a stable deferral signal",()=>{
 const result=appleSignals(before,after,run,consent);
 assert.equal(result.length,1);assert.equal(result[0].type,"task.deferred");
 assert.equal(result[0].fromDueAt,before[0].dueAt);
 assert.deepEqual(result,appleSignals(before,after,run,consent));
});
test("opt-out, pause and disconnect prevent signal creation",()=>{
 for(const change of [{enabled:false},{paused:true},{appleReminders:false},{connected:false}])
  assert.deepEqual(appleSignals(before,after,run,{...consent,...change}),[]);
});
test("sync echoes, duplicate IDs and unchanged state do not generate events",()=>{
 assert.deepEqual(appleSignals(before,before,run,consent),[]);
 assert.deepEqual(appleSignals([...before,...before],after,run,consent),[]);
 assert.deepEqual(appleSignals(before,[...after,...after],run,consent).length,1);
});
test("completion and earlier dates are not mistaken for deferrals",()=>{
 assert.equal(appleSignals(before,[{...before[0],completed:true}],run,consent)[0].type,"task.completed");
 assert.equal(appleSignals(before,[{...before[0],dueAt:"2026-10-13T12:00:00Z"}],run,consent)[0].type,"task.updated");
});
test("signal metadata excludes private titles and note contents",()=>{
 const result=appleSignals([{...before[0],title:"private"} as never],after,run,consent);
 assert.ok(!JSON.stringify(result).includes("private"));
});
