import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureTaskIds } from "../src/task-id-assign.ts";
import { splitTaskId } from "../src/task-id.ts";
import { taskDeferrals } from "../src/awareness-deferrals.ts";
import { threeDeferrals } from "../src/awareness-rules.ts";

const zone = "America/Los_Angeles";
const idOf = (content: string, needle: string) =>
  splitTaskId(content.split("\n").find(l => l.includes(needle))!).id;

test("open scheduled tasks get an ID; done, unscheduled and already-tagged ones don't", () => {
  const input = [
    "# Errands",
    "- [ ] Renew registration @2026-10-20 9am",
    "- [ ] Take meds @daily 8am",
    "- [ ] Someday idea",
    "- [x] Paid rent @2026-10-01",
    "- [ ] Dentist @2026-10-21 ^d3nt1s",
    "Plain text @2026-10-22"
  ].join("\n");
  const { after, assigned } = ensureTaskIds(null, input, zone);
  const lines = after.split("\n");
  assert.equal(assigned, 2);
  assert.match(lines[1], /^- \[ \] Renew registration @2026-10-20 9am \^[a-z0-9]{6}$/);
  assert.match(lines[2], /^- \[ \] Take meds @daily 8am \^[a-z0-9]{6}$/);
  assert.equal(lines[3], "- [ ] Someday idea");
  assert.equal(lines[4], "- [x] Paid rent @2026-10-01");
  assert.equal(lines[5], "- [ ] Dentist @2026-10-21 ^d3nt1s");
  assert.equal(lines[6], "Plain text @2026-10-22");
  assert.notEqual(idOf(after, "Renew"), idOf(after, "Take meds"));
});

test("content with nothing to tag comes back unchanged", () => {
  const input = "# Notes\n- [ ] Call mom\n- [ ] Pay rent @2026-10-20 ^r3nt01\n";
  assert.deepEqual(ensureTaskIds(input, input, zone), { before: input, after: input, assigned: 0 });
});

test("daily log notes are never tagged", () => {
  const input = "- [ ] Odd task in a log @2026-10-20";
  assert.equal(ensureTaskIds(null, input, zone, "journal/log/2026-10-14.md").after, input);
});

test("the first postponement of an untagged task already counts", () => {
  const before = "- [ ] Write cover letter @2026-10-15 9am";
  const { before: tagged, after } = ensureTaskIds(before, "- [ ] Write cover letter @2026-10-17 9am", zone);
  const id = idOf(after, "cover letter");
  assert.equal(idOf(tagged, "cover letter"), id);
  assert.deepEqual(taskDeferrals(tagged, after, zone).map(d => d.taskId), [id]);
});

test("a rewrite that drops an ID gets the same ID back", () => {
  const before = "- [ ] Write cover letter @2026-10-15 9am ^c0v3r1";
  const { after } = ensureTaskIds(before, "- [ ] Write cover letter @2026-10-16 9am", zone);
  assert.equal(after, "- [ ] Write cover letter @2026-10-16 9am ^c0v3r1");
  assert.equal(taskDeferrals(before, after, zone).length, 1);
});

test("an ambiguous title never borrows an ID", () => {
  const before = "- [ ] Call back @2026-10-15 ^aaaa11\n- [ ] Call back @2026-10-16 ^bbbb22";
  const { after } = ensureTaskIds(before, "- [ ] Call back @2026-10-18", zone);
  assert.ok(!["aaaa11", "bbbb22"].includes(idOf(after, "Call back")!));
});

test("a copied line keeps its ID once and the copy is left for Apple sync to re-tag", () => {
  const before = "- [ ] Water plants @2026-10-15 ^w4t3r1";
  const input = before + "\n" + before;
  assert.equal(ensureTaskIds(before, input, zone).after, input);
});

test("three postponements of a task made in Daybook produce a suggestion", () => {
  let content = ensureTaskIds(null, "- [ ] Book dentist @2026-10-15 9am", zone).after;
  const events = [];
  for (const [i, day] of ["2026-10-16", "2026-10-18", "2026-10-21"].entries()) {
    const next = ensureTaskIds(content, content.replace(/@\S+/, "@" + day), zone);
    for (const d of taskDeferrals(next.before, next.after, zone)) {
      events.push({ id: "e" + i, ownerId: "me", type: "task.deferred", occurredAt: new Date(Date.UTC(2026, 9, 14, i)).toISOString(),
        subjectRef: { kind: "task", id: d.taskId }, metadata: d });
    }
    content = next.after;
  }
  assert.equal(events.length, 3);
  const suggestions = threeDeferrals(events as any, "me", new Date(Date.UTC(2026, 9, 14, 5)));
  assert.equal(suggestions.length, 1);
});

test("every note write path tags tasks before saving", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const web = readFileSync(new URL("../src/web.ts", import.meta.url), "utf8");
  const core = readFileSync(new URL("../src/core.ts", import.meta.url), "utf8");
  const between = (s: string, a: string, b: string) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)));
  for (const [src, from, to] of [
    [index, 'registerTool("save_note"', 'registerTool("search_notes"'],
    [index, 'registerTool("update_note"', 'registerTool("delete_note"'],
    [web, 'case "POST /note"', 'case "PUT /note"'],
    [web, 'case "PUT /note"', 'case "DELETE /note"'],
    [web, 'case "POST /calendar/task"', 'case "GET /priorities"']
  ] as const) assert.match(between(src, from, to), /ensureTaskIds\(/, from);
  assert.match(between(core, "export async function addTask", "export async function addReminder"), /withTaskId\(/);
});
