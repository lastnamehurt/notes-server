import test from "node:test";
import assert from "node:assert/strict";
import { threeDeferrals } from "../src/awareness-rules";

const now = new Date("2026-10-13T12:00:00Z");
const date = (day: number) => `2026-10-${String(day).padStart(2, "0")}T12:00:00Z`;
const move = (id: string, from: number, to: number, taskId = "abc123", ownerId = "local") => ({
  id, ownerId, type: "task.deferred", occurredAt: date(to), subjectRef: { kind: "task", id: taskId },
  metadata: { taskId, fromDueAt: date(from), toDueAt: date(to) }
});
test("three connected postponements produce one inbox candidate with evidence", () => {
  const events = [move("a", 1, 2), move("b", 2, 3), move("c", 3, 4)];
  const result = threeDeferrals(events, "local", now);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].evidenceEventIds, ["a", "b", "c"]);
  assert.equal(result[0].ruleId, "task-three-deferrals");
  assert.equal(result[0].dedupeKey, "task-three-deferrals:abc123");
});
test("two postponements never trigger", () => {
  assert.deepEqual(threeDeferrals([move("a",1,2), move("b",2,3)], "local", now), []);
});
test("replayed IDs and duplicate transitions do not inflate count", () => {
  const a = move("a",1,2), b = move("b",2,3), echo = move("echo",2,3);
  assert.deepEqual(threeDeferrals([a,a,b,echo], "local", now), []);
});
test("cross-owner, mismatched subject and unrelated event types are excluded", () => {
  const a = move("a",1,2), b = move("b",2,3), c = move("c",3,4);
  assert.deepEqual(threeDeferrals([a,b,{...c,ownerId:"other"}], "local", now), []);
  assert.deepEqual(threeDeferrals([a,b,{...c,subjectRef:{kind:"task",id:"other"}}], "local", now), []);
  assert.deepEqual(threeDeferrals([a,b,{...c,type:"task.updated"}], "local", now), []);
});
test("broken transition chains and invalid dates do not trigger", () => {
  assert.deepEqual(threeDeferrals([move("a",1,2),move("b",4,5),move("c",5,6)],"local",now), []);
  assert.deepEqual(threeDeferrals([move("a",1,2),move("b",2,3),{...move("c",3,4),occurredAt:"not-a-date"}],"local",now), []);
});
test("rule emits no push, and each task remains separate", () => {
  const events = [move("a",1,2),move("b",2,3),move("c",3,4),move("d",1,2,"other"),move("e",2,3,"other"),move("f",3,4,"other")];
  assert.equal(threeDeferrals(events,"local",now).length,2);
});
