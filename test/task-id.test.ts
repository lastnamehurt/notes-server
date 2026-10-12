import { test } from "node:test";
import assert from "node:assert/strict";
import { splitTaskId, newTaskId, withTaskId } from "../src/task-id.ts";
import { parseReminders } from "../src/reminder-parse.ts";
import { tasksFromNotes, changeTaskPriority } from "../src/priorities.ts";

test("splits a trailing task ID and leaves other lines alone", () => {
  assert.deepEqual(splitTaskId("- [ ] Call airline @2026-10-15 9am ^t7k2q"), { line: "- [ ] Call airline @2026-10-15 9am", id: "t7k2q" });
  assert.deepEqual(splitTaskId("- [ ] Caret ^ in the middle"), { line: "- [ ] Caret ^ in the middle", id: null });
  assert.deepEqual(splitTaskId("- [ ] Too short ^ab"), { line: "- [ ] Too short ^ab", id: null });
  assert.equal(withTaskId("- [ ] Pay rent ^old1", "new22"), "- [ ] Pay rent ^new22");
});

test("new IDs are 6 characters and avoid taken ones", () => {
  const id = newTaskId();
  assert.match(id, /^[a-z0-9]{6}$/);
  assert.notEqual(newTaskId(new Set([id])), id);
});

test("reminders read the same with or without an ID", () => {
  const plain = parseReminders("inbox/a.md", "- [ ] Take meds @daily 8am, 8pm\n- [ ] Dentist @2026-10-20 17:30 @priority:do", "America/Los_Angeles", 0);
  const tagged = parseReminders("inbox/a.md", "- [ ] Take meds @daily 8am, 8pm ^m3ds01\n- [ ] Dentist @2026-10-20 17:30 @priority:do ^d3nt1s", "America/Los_Angeles", 0);
  assert.equal(tagged.length, 3);
  assert.deepEqual(tagged, plain);
});

test("priority tasks hide the ID and keep it last when the priority changes", () => {
  const content = "- [ ] Book flights @priority:plan ^fl1ght";
  assert.deepEqual(tasksFromNotes([{ name: "inbox/a.md", content }]), [{ note: "inbox/a.md", line: 0, text: "Book flights", priority: "plan" }]);
  assert.equal(changeTaskPriority(content, 0, "do"), "- [ ] Book flights @priority:do ^fl1ght");
  assert.equal(changeTaskPriority(content, 0, "inbox"), "- [ ] Book flights ^fl1ght");
});
