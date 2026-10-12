import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTaskLine, formatTaskLine, editTaskLine, newTaskLine, scheduleFor, normalizeReminder, appleDue,
  daybookItem, planSync, doneKey, type Base, type AppleReminder, type DaybookItem, type Plan
} from "../src/apple-sync.ts";
import { zonedTime } from "../src/reminder-parse.ts";

const TZ = "America/Los_Angeles";
// Sun Oct 11 2026, 10:00 local.
const NOW = zonedTime(2026, 10, 11, 10, 0, TZ);
const url = (id: string) => "https://daybook.test/app#task/" + id;

function item(line: string, note = "inbox/tasks.md", done: Set<string> = new Set()): DaybookItem {
  const t = parseTaskLine(line, TZ);
  assert.ok(t && t.id, "test line needs an ID: " + line);
  return daybookItem(note, t as any, TZ, NOW, done);
}
const apple = (index: number, taskId: string | null, fields: Partial<AppleReminder> = {}): AppleReminder =>
  ({ index, taskId, title: "", due: null, completed: false, priority: "none", ...fields });
const baseOf = (items: DaybookItem[]): Base => Object.fromEntries(items.map(d => [d.id, { ...d.state, note: d.note }]));
const appleOf = (items: DaybookItem[]): AppleReminder[] => items.map((d, i) => apple(i, d.id, { ...d.state }));
const run = (daybook: DaybookItem[], appleList: AppleReminder[], base: Base = {}): Plan =>
  planSync({ daybook, apple: appleList, base, timeZone: TZ, inboxNote: "inbox/reminders.md", url });

test("task lines parse and rebuild without changing anything", () => {
  for (const line of [
    "- [ ] Call airline @2026-10-15 9am ^t7k2q",
    "  * [x] Pay rent @2026-11-01 @priority:do ^r3nt01",
    "- [ ] Take meds @daily 8am, 8pm ^m3ds01",
    "- [ ] Book flights @priority:plan ^fl1ght",
    "- [ ] Email Sam about @home stuff ^em41l1"
  ]) assert.equal(formatTaskLine(parseTaskLine(line, TZ)!), line);
  const t = parseTaskLine("- [ ] Email Sam about @home stuff ^em41l1", TZ)!;
  assert.equal(t.title, "Email Sam about @home stuff");
  assert.equal(t.schedule, null);
});

test("line edits change only the synced fields and keep the ID last", () => {
  const line = "  * [ ] Call airline @2026-10-15 9am @priority:plan ^t7k2q";
  assert.equal(editTaskLine(line, { title: "Call airline about seats" }, TZ), "  * [ ] Call airline about seats @2026-10-15 9am @priority:plan ^t7k2q");
  assert.equal(editTaskLine(line, { due: "2026-10-16T17:30" }, TZ), "  * [ ] Call airline @2026-10-16 5:30pm @priority:plan ^t7k2q");
  assert.equal(editTaskLine(line, { due: "2026-10-16" }, TZ), "  * [ ] Call airline @2026-10-16 @priority:plan ^t7k2q");
  assert.equal(editTaskLine(line, { due: null, completed: true, priority: "none" }, TZ), "  * [x] Call airline ^t7k2q");
  assert.equal(editTaskLine("- [ ] Ask Kim @priority:delegate ^k1m001", { priority: "low" }, TZ), "- [ ] Ask Kim @priority:delegate ^k1m001");
  assert.equal(newTaskLine("n3w001", { title: "Buy milk", due: "2026-10-12T12:00", completed: false, priority: "high" }), "- [ ] Buy milk @2026-10-12 12pm @priority:do ^n3w001");
  assert.deepEqual(["2026-10-12T00:00", "2026-10-12T00:05", "2026-10-12T12:30", "2026-10-12T23:00"].map(scheduleFor),
    ["@2026-10-12 12am", "@2026-10-12 12:05am", "@2026-10-12 12:30pm", "@2026-10-12 11pm"]);
});

test("normalizes what the Shortcut sends", () => {
  const r = normalizeReminder({ title: "  Call   airline ", url: "https://x/app#task/t7k2q", due: "2026-10-15T09:00:00-07:00", completed: "Yes", priority: "High" }, 3, TZ);
  assert.deepEqual(r, { index: 3, taskId: "t7k2q", title: "Call airline", due: "2026-10-15T09:00", completed: true, priority: "high" });
  assert.equal(normalizeReminder({ notes: "daybook:abc123", due: "2026-10-15T07:00:00Z" }, 0, TZ).due, "2026-10-15", "midnight local is all-day");
  assert.equal(normalizeReminder({ due: "2026-10-15T07:00:00Z", allDay: false }, 0, TZ).due, "2026-10-15T00:00");
  assert.equal(normalizeReminder({ due: "" }, 0, TZ).due, null);
  assert.equal(normalizeReminder({}, 0, TZ).due, undefined, "missing means unknown, not cleared");
  assert.equal(normalizeReminder({ due: "next tuesday-ish" }, 0, TZ).due, undefined);
  assert.deepEqual([1, 5, 9, 0, "None", "urgent"].map(p => normalizeReminder({ priority: p }, 0, TZ).priority), ["high", "medium", "low", "none", "none", undefined]);
  assert.equal(normalizeReminder({ taskId: "bad id!" }, 0, TZ).taskId, null);
});

test("due dates go to the Shortcut with the right offset on each side of DST", () => {
  assert.deepEqual(appleDue("2026-10-15T09:00", TZ), { due: "2026-10-15T09:00:00-07:00", allDay: false });
  assert.deepEqual(appleDue("2026-11-02T09:00", TZ), { due: "2026-11-02T09:00:00-08:00", allDay: false });
  assert.deepEqual(appleDue("2026-11-02", TZ), { due: "2026-11-02", allDay: true });
});

test("first run creates in-scope tasks only; a second run changes nothing", () => {
  const items = [
    item("- [ ] Call airline @2026-10-15 9am ^t7k2q"),
    item("- [ ] Book flights @priority:plan ^fl1ght"),
    item("- [ ] Someday maybe ^n0pe01"),
    item("- [x] Old thing @2026-10-01 ^0ld001")
  ];
  const first = run(items, []);
  assert.deepEqual(first.actions.map(a => [a.op, a.taskId]), [["create", "t7k2q"], ["create", "fl1ght"]]);
  const create = first.actions[0] as any;
  assert.equal(create.url, url("t7k2q"));
  assert.equal(create.due, "2026-10-15T09:00:00-07:00");
  const again = run(items, appleOf(items.slice(0, 2)), first.base);
  assert.deepEqual(again.actions, []);
  assert.deepEqual(again.edits, []);
  assert.deepEqual(again.logs, []);
});

test("an edit on one side reaches the other", () => {
  const d = item("- [ ] Call airline @2026-10-15 9am ^t7k2q");
  const base = baseOf([d]);
  const fromApple = run([d], [apple(0, "t7k2q", { ...d.state, title: "Call airline about seats", due: "2026-10-16T14:00" })], base);
  assert.deepEqual(fromApple.edits, [{ id: "t7k2q", note: "inbox/tasks.md", set: { title: "Call airline about seats", due: "2026-10-16T14:00" } }]);
  assert.deepEqual(fromApple.actions, []);
  const moved = item("- [ ] Call airline @2026-10-17 9am ^t7k2q");
  const fromDaybook = run([moved], [apple(0, "t7k2q", { ...d.state })], base);
  assert.deepEqual(fromDaybook.edits, []);
  assert.equal((fromDaybook.actions[0] as any).due, "2026-10-17T09:00:00-07:00");
});

test("conflicting edits keep Daybook's value and log Apple's", () => {
  const before = item("- [ ] Call airline @2026-10-15 9am ^t7k2q");
  const after = item("- [ ] Call airline now @2026-10-15 9am ^t7k2q");
  const p = run([after], [apple(0, "t7k2q", { ...before.state, title: "Call the airline" })], baseOf([before]));
  assert.deepEqual(p.edits, []);
  assert.equal((p.actions[0] as any).title, "Call airline now");
  assert.match(p.logs[0], /Sync conflict on "Call airline now" \(title\).*"Call the airline" #sync-conflict/);
  assert.equal(p.base.t7k2q.title, "Call airline now");
});

test("completing a one-off in Apple ticks it in Daybook and records it", () => {
  const d = item("- [ ] Call airline @2026-10-15 9am ^t7k2q");
  const p = run([d], [apple(0, "t7k2q", { ...d.state, completed: true })], baseOf([d]));
  assert.deepEqual(p.edits[0].set, { completed: true });
  assert.deepEqual(p.completions, [{ id: "t7k2q", note: "inbox/tasks.md", title: "Call airline", at: zonedTime(2026, 10, 15, 9, 0, TZ) }]);
  assert.deepEqual(p.actions, []);
  const reopened = run([item("- [x] Call airline @2026-10-15 9am ^t7k2q")], [apple(0, "t7k2q", { ...d.state, completed: false })], p.base);
  assert.deepEqual(reopened.edits[0].set, { completed: false });
});

test("completing a repeating task's occurrence moves the reminder to the next one", () => {
  const d = item("- [ ] Take meds @daily 8am, 8pm ^m3ds01");
  // 8am today already went off and wasn't done, so it is the current (overdue) occurrence.
  assert.equal(d.state.due, "2026-10-11T08:00");
  assert.equal(d.followingDue, "2026-10-11T20:00");
  const p = run([d], [apple(0, "m3ds01", { ...d.state, completed: true })], baseOf([d]));
  assert.deepEqual(p.completions, [{ id: "m3ds01", note: "inbox/tasks.md", title: "Take meds", at: zonedTime(2026, 10, 11, 8, 0, TZ) }]);
  assert.deepEqual(p.edits, []);
  assert.deepEqual(p.actions, [{ op: "update", index: 0, taskId: "m3ds01", title: "Take meds", priority: "none", completed: false, due: "2026-10-11T20:00:00-07:00", allDay: false }]);
  // Next run: the scheduler has the occurrence marked done, so Daybook agrees and nothing changes.
  const done = new Set([doneKey("inbox/tasks.md", "Take meds", zonedTime(2026, 10, 11, 8, 0, TZ))]);
  const d2 = item("- [ ] Take meds @daily 8am, 8pm ^m3ds01", "inbox/tasks.md", done);
  assert.equal(d2.state.due, "2026-10-11T20:00");
  assert.deepEqual(run([d2], [apple(0, "m3ds01", { ...d2.state })], p.base).actions, []);
});

test("Apple can't move a repeating task's schedule; Daybook resets it", () => {
  const d = item("- [ ] Take meds @daily 8am, 8pm ^m3ds01");
  const p = run([d], [apple(0, "m3ds01", { ...d.state, due: "2026-10-11T09:30" })], baseOf([d]));
  assert.deepEqual(p.edits, []);
  assert.deepEqual(p.logs, []);
  assert.equal((p.actions[0] as any).due, "2026-10-11T08:00:00-07:00");
});

test("deleting in Daybook deletes the reminder; deleting in Apple never deletes the task", () => {
  const d = item("- [ ] Call airline @2026-10-15 9am ^t7k2q");
  const base = baseOf([d]);
  assert.deepEqual(run([], [apple(4, "t7k2q", { ...d.state })], base).actions, [{ op: "delete", index: 4, taskId: "t7k2q" }]);
  const removed = run([d], [], base);
  assert.deepEqual(removed.actions, []);
  assert.deepEqual(removed.edits, []);
  assert.match(removed.logs[0], /removed from Apple Reminders.*#removed-in-reminders/);
  assert.equal(removed.base.t7k2q.detached, true);
  // Stays detached until the task changes in Daybook, then comes back.
  const quiet = run([d], [], removed.base);
  assert.deepEqual([quiet.actions, quiet.logs], [[], []]);
  const back = run([item("- [ ] Call airline @2026-10-18 9am ^t7k2q")], [], removed.base);
  assert.equal(back.actions[0].op, "create");
  assert.equal(back.base.t7k2q.detached, undefined);
  // Clearing a reminder that is done on both sides is routine: no log, just stop tracking it.
  const doneBoth = item("- [x] Call airline @2026-10-15 9am ^t7k2q");
  const cleared = run([doneBoth], [], baseOf([doneBoth]));
  assert.deepEqual([cleared.logs, cleared.base], [[], {}]);
});

test("reminders created in Apple are added to Daybook and tagged", () => {
  const p = run([], [apple(2, null, { title: "Buy milk", due: "2026-10-12T12:00", priority: "high" }), apple(3, null, { title: "" })]);
  assert.equal(p.added.length, 1);
  const { id, state } = p.added[0];
  assert.deepEqual(state, { title: "Buy milk", due: "2026-10-12T12:00", completed: false, priority: "high" });
  assert.deepEqual(p.actions, [{ op: "tag", index: 2, taskId: id, url: url(id) }]);
  assert.equal(p.base[id].note, "inbox/reminders.md");
});

test("same-title tasks stay separate, and a duplicated reminder is left alone", () => {
  const a = item("- [ ] Call mom @2026-10-15 9am ^aaaaaa"), b = item("- [ ] Call mom @2026-10-15 9am ^bbbbbb");
  const p = run([a, b], [apple(0, "aaaaaa", { ...a.state }), apple(1, "aaaaaa", { ...a.state, title: "Copy" }), apple(2, "bbbbbb", { ...b.state })], baseOf([a, b]));
  assert.deepEqual([p.actions, p.edits], [[], []]);
});

test("a date-only task stored by iOS at 9am is not treated as an edit", () => {
  const d = item("- [ ] Pay bill @2026-10-16 ^b1ll01");
  assert.equal(d.state.due, "2026-10-16");
  const p = run([d], [apple(0, "b1ll01", { ...d.state, due: "2026-10-16T09:00" })], baseOf([d]));
  assert.deepEqual([p.actions, p.edits], [[], []]);
});

test("with no base (reinstall or lost state), Daybook wins and nothing is duplicated", () => {
  const d = item("- [ ] Call airline @2026-10-15 9am ^t7k2q");
  const p = run([d], [apple(0, "t7k2q", { ...d.state })], {});
  assert.deepEqual([p.actions, p.edits, p.logs], [[], [], []]);
  assert.ok(p.base.t7k2q);
});
