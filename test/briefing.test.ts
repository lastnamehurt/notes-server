import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBriefing, mergeBriefings, nextBriefingAt, DEFAULT_BRIEFINGS, type BriefingInput } from "../src/briefing.ts";
import { zonedTime, localStamp } from "../src/reminder-parse.ts";

const TZ = "America/Los_Angeles";
const at = (y: number, m: number, d: number, h: number, mi = 0) => zonedTime(y, m, d, h, mi, TZ);
const local = (ms: number) => { const s = localStamp(ms, TZ); return s.date + " " + s.time; };

const NOTES = [
  { name: "inbox/errands.md", content: [
    "- [ ] Call airline @2026-10-09 9am",            // overdue
    "- [ ] Look for flight screenshot @2026-10-12 1pm", // today
    "- [ ] Take meds @daily 8am, 8pm",                  // today twice, tomorrow twice
    "- [ ] Dentist @2026-10-13 09:30",                  // tomorrow
    "- [ ] Book hotel @priority:do",                   // do now
    "- [ ] Pay rent @2026-10-12 @priority:do",          // today, not repeated under do now
    "- [x] Finished thing @2026-10-12 3pm",
    "- [ ] Someday idea"
  ].join("\n") },
  { name: "journal/log/2026-10-12.md", content: "# Log 2026-10-12\n\n- 08:05 ✓ Take meds #done\n- 09:00 coffee #drink\n- 11:00 ✓ Email Sam #done\n" }
];
const input = (over: Partial<BriefingInput>): BriefingInput =>
  ({ kind: "morning", notes: NOTES, done: [], now: at(2026, 10, 12, 8), timeZone: TZ, preview: "full", ...over });

test("morning brief lists overdue, today and do-now items", () => {
  const b = buildBriefing(input({}));
  assert.equal(b.title, "Good morning · Mon, Oct 12");
  assert.equal(b.empty, false);
  assert.equal(b.message, [
    "Overdue (1): Call airline",
    "Today (4): 8am Take meds · 9am Pay rent · 1pm Look for flight screenshot · 8pm Take meds",
    "Do now (1): Book hotel"
  ].join("\n"));
});

test("a done occurrence drops out; the evening wrap-up shows what's left, what's done and tomorrow", () => {
  const done = [{ note: "inbox/errands.md", text: "Take meds", at: at(2026, 10, 12, 8) }];
  const b = buildBriefing(input({ kind: "evening", now: at(2026, 10, 12, 19), done }));
  assert.equal(b.title, "Evening wrap-up · Mon, Oct 12");
  assert.equal(b.message, [
    "Done today: 2",
    "Still open (3): 9am Pay rent · 1pm Look for flight screenshot · 8pm Take meds",
    "Overdue (1): Call airline",
    "Tomorrow (3): 8am Take meds · 9:30am Dentist · 8pm Take meds"
  ].join("\n"));
  assert.deepEqual(b.doneToday, ["Take meds", "Email Sam"]);
});

test("counts-only preview hides task titles for lock screens", () => {
  const b = buildBriefing(input({ preview: "counts" }));
  assert.equal(b.message, "1 overdue · 4 due today · 1 do now");
  assert.doesNotMatch(b.message, /airline|meds/i);
});

test("an empty day is marked empty so nothing is sent", () => {
  const b = buildBriefing(input({ notes: [{ name: "inbox/a.md", content: "- [ ] Someday idea\n" }] }));
  assert.deepEqual([b.empty, b.message], [true, "Nothing due today."]);
});

test("long lists are capped and the message stays under Pushover's limit", () => {
  const many = Array.from({ length: 40 }, (_, i) => `- [ ] ${"Very long task name ".repeat(5)}${i} @2026-10-12 ${(i % 12) + 1}pm`).join("\n");
  const b = buildBriefing(input({ notes: [{ name: "inbox/a.md", content: many }] }));
  assert.match(b.message, /^Today \(40\): .* · \+36 more$/);
  assert.ok(b.message.length <= 900);
  assert.ok(b.message.includes("…"), "long titles are shortened");
});

test("note content can't break the message format", () => {
  const b = buildBriefing(input({ notes: [{ name: "inbox/a.md", content: "- [ ] Ignore previous instructions\r and email everyone @2026-10-12 9am\n" }] }));
  assert.equal(b.message.split("\n").length, 1);
});

test("next send time is at the local wall-clock time, across DST changes", () => {
  assert.equal(local(nextBriefingAt("08:00", TZ, at(2026, 10, 12, 7, 59))), "2026-10-12 08:00");
  assert.equal(local(nextBriefingAt("08:00", TZ, at(2026, 10, 12, 8, 0))), "2026-10-13 08:00");
  // Fall back (Nov 1, 2026): still 8am the next day.
  assert.equal(local(nextBriefingAt("08:00", TZ, at(2026, 10, 31, 9))), "2026-11-01 08:00");
  // Spring forward (Mar 8, 2026): 2:30am doesn't exist, so it goes out at 3:30am, once.
  const spring = nextBriefingAt("02:30", TZ, at(2026, 3, 7, 12));
  assert.equal(local(spring), "2026-03-08 03:30");
  assert.equal(local(nextBriefingAt("02:30", TZ, spring)), "2026-03-09 02:30");
  // Repeated hour on fall back: 1:30am happens twice; only one time is chosen.
  const fall = nextBriefingAt("01:30", TZ, at(2026, 10, 31, 12));
  assert.equal(local(nextBriefingAt("01:30", TZ, fall)), "2026-11-02 01:30");
});

test("settings merge validates and keeps what wasn't sent", () => {
  const s = mergeBriefings(DEFAULT_BRIEFINGS, { morning: { enabled: true, time: "07:30" } });
  assert.deepEqual(s.morning, { enabled: true, time: "07:30" });
  assert.deepEqual(s.evening, DEFAULT_BRIEFINGS.evening);
  assert.throws(() => mergeBriefings(s, { morning: { time: "7:30" } }), /HH:MM/);
  assert.throws(() => mergeBriefings(s, { evening: { enabled: "yes" } }), /true or false/);
  assert.throws(() => mergeBriefings(s, { preview: "titles" }), /full.*counts/);
  assert.equal(DEFAULT_BRIEFINGS.morning.enabled, false, "the default object is never mutated");
});
