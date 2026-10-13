import test from "node:test";
import assert from "node:assert/strict";
import { taskDeferrals } from "../src/awareness-deferrals";

const zone = "America/Los_Angeles";
const task = (date: string, id = "abc123", extra = "") => `- [ ] Pay bill @${date} ${extra} ^${id}`;
test("later due date on same open task is a deferral", () => {
  const events = taskDeferrals(task("2026-10-20"), task("2026-10-23"), zone);
  assert.equal(events.length, 1);
  assert.equal(events[0].taskId, "abc123");
  assert.ok(Date.parse(events[0].toDueAt) > Date.parse(events[0].fromDueAt));
});
test("priority edits, unchanged schedules, earlier dates and completion do not defer", () => {
  const old = task("2026-10-20");
  assert.deepEqual(taskDeferrals(old, task("2026-10-20", "abc123", "@priority:do"), zone), []);
  assert.deepEqual(taskDeferrals(old, task("2026-10-19"), zone), []);
  assert.deepEqual(taskDeferrals(old, old.replace("[ ]", "[x]"), zone), []);
});
test("unidentified, renamed ID, duplicated ID and recurring tasks are ignored", () => {
  assert.deepEqual(taskDeferrals("- [ ] Pay bill @2026-10-20", "- [ ] Pay bill @2026-10-23", zone), []);
  assert.deepEqual(taskDeferrals(task("2026-10-20"), task("2026-10-23", "def456"), zone), []);
  assert.deepEqual(taskDeferrals(task("2026-10-20"), task("2026-10-23") + "\n" + task("2026-10-24"), zone), []);
  assert.deepEqual(taskDeferrals(task("daily 8am"), task("daily 9am"), zone), []);
});
test("moving a task line retains identity; unrelated task changes do not defer", () => {
  const old = task("2026-10-20") + "\n" + task("2026-10-20", "def456");
  const next = task("2026-10-20", "def456") + "\n" + task("2026-10-22");
  assert.deepEqual(taskDeferrals(old, next, zone).map(x => x.taskId), ["abc123"]);
});
