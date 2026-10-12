import {test} from "node:test";
import {strict as assert} from "node:assert";
import {timedEntry,readSessions,timeSummary} from "../src/time-tracking";
test("manual duration persists as timestamped journal metadata",()=>{
 const line=timedEntry("Walked","cardio","2026-10-11T10:00:00.000Z","2026-10-11T10:30:00.000Z");
 assert.match(line,/#cardio @session:2026-10-11T10:00:00.000Z\/2026-10-11T10:30:00.000Z/);
 const sessions=readSessions([{name:"journal/log/2026-10-11.md",content:"- 03:00 "+line}]);
 assert.equal(sessions[0].minutes,30);
});
test("overlapping activities count once for tracked time",()=>{
 const sessions=readSessions([{name:"journal/log/2026-10-11.md",content:"- 10:00 "+timedEntry("A","work","2026-10-11T10:00:00.000Z","2026-10-11T11:00:00.000Z")+"\n- 10:30 "+timedEntry("B","music","2026-10-11T10:30:00.000Z","2026-10-11T11:30:00.000Z")}]);
 const summary=timeSummary(sessions,"2026-10-11T00:00:00.000Z","2026-10-12T00:00:00.000Z");
 assert.equal(summary.trackedMinutes,90);
 assert.equal(summary.byType.reduce((n,t)=>n+t.minutes,0),120);
});
test("reject invalid session spans",()=>{
 assert.throws(()=>timedEntry("Walk","cardio","2026-10-11T11:00:00Z","2026-10-11T10:00:00Z"));
});
