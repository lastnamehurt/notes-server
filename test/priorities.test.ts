import { test } from "node:test";
import { strict as assert } from "node:assert";
import { classifyTask, tasksFromNotes, changeTaskPriority } from "../src/priorities";

test("GTD inbox is the default; completed tasks are ignored", () => {
  const tasks = tasksFromNotes([{ name:"inbox/a.md", content:"# Test\n- [ ] Call dentist\n- [x] Paid bill\n- [ ] Book travel @priority:plan" }]);
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.map(t => t.priority), ["inbox", "plan"]);
  assert.equal(tasks[1].line, 3);
});
test("priority changes preserve schedule text and unrelated lines", () => {
  const before = "# Tasks\n- [ ] Pay bill @2026-11-01 9am\n- [ ] Read";
  const changed = changeTaskPriority(before, 1, "do");
  assert.match(changed, /Pay bill @2026-11-01 9am @priority:do/);
  assert.equal(changeTaskPriority(changed, 1, "inbox"), before);
});
test("cannot change completed tasks or arbitrary lines", () => {
  assert.throws(() => changeTaskPriority("- [x] Done", 0, "do"));
  assert.throws(() => changeTaskPriority("- [ ] Open", 0, "unknown" as never));
  assert.equal(classifyTask("- [ ] Task @priority:someday")?.priority, "someday");
});
