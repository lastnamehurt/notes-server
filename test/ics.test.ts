import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIcs, parseIcs, escapeText, unescapeText, utcStamp } from "../src/ics.ts";

const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);

test("tasks publish as events at their due time, in UTC, with escaped text", () => {
  const ics = buildIcs([{ id: "inbox/meds.md:4", title: "Take meds, with food; now", dueAt: "2026-10-13T15:00:00.000Z", note: "inbox/meds.md" }], NOW);
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.match(ics, /DTSTART:20261013T150000Z/);
  assert.match(ics, /DTEND:20261013T151500Z/);
  assert.match(ics, /SUMMARY:Take meds\\, with food\; now/);
  assert.match(ics, /UID:inbox\/meds\.md:4@daybook/);
  assert.ok(ics.trimEnd().endsWith("END:VCALENDAR"));
});

test("tasks without a usable time are left out", () => {
  const ics = buildIcs([{ id: "a:1", title: "No time", dueAt: "not a date", note: "a" }], NOW);
  assert.ok(!ics.includes("BEGIN:VEVENT"));
});

test("text escaping round-trips", () => {
  const s = "a, b; c\\d\nline";
  assert.equal(unescapeText(escapeText(s)), s);
  assert.equal(utcStamp(Date.UTC(2026, 0, 2, 3, 4, 5)), "20260102T030405Z");
});

test("reads events from a subscribed calendar, in the window, with folded lines", () => {
  const feed = [
    "BEGIN:VCALENDAR", "VERSION:2.0",
    "BEGIN:VEVENT", "UID:one", "DTSTART:20261013T150000Z", "DTEND:20261013T160000Z",
    "SUMMARY:Dentist at the very long clinic name that keeps going and going and",
    " continues here", "END:VEVENT",
    "BEGIN:VEVENT", "UID:local", "DTSTART;TZID=America/Los_Angeles:20261014T093000",
    "SUMMARY:Standup", "END:VEVENT",
    "BEGIN:VEVENT", "UID:allday", "DTSTART;VALUE=DATE:20261015", "SUMMARY:Holiday", "END:VEVENT",
    "BEGIN:VEVENT", "UID:old", "DTSTART:20250101T000000Z", "SUMMARY:Old", "END:VEVENT",
    "BEGIN:VEVENT", "UID:weekly", "DTSTART:20261013T170000Z", "RRULE:FREQ=WEEKLY", "SUMMARY:Repeats", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const events = parseIcs(feed, { now: NOW, days: 14, zone: "America/Los_Angeles" });
  assert.deepEqual(events.map(e => e.uid), ["one", "local", "allday"]);
  assert.match(events[0].title, /going andcontinues here$/);
  assert.equal(events[1].start, Date.UTC(2026, 9, 14, 16, 30));   // 09:30 Pacific (UTC-7 in October)
  assert.equal(events[2].allDay, true);
  assert.equal(events[0].end, Date.UTC(2026, 9, 13, 16, 0));
});

test("rejects things that are not calendars, and oversized feeds", () => {
  assert.throws(() => parseIcs("<html>nope</html>"), /iCalendar/);
  assert.throws(() => parseIcs("BEGIN:VCALENDAR" + "x".repeat(2_100_000)), /too large/);
});

test("a feed Daybook publishes can be read back as events", () => {
  const due = "2026-10-14T16:30:00.000Z";
  const ics = buildIcs([{ id: "inbox/x.md:2", title: "Call mom, Sunday", dueAt: due, note: "inbox/x.md" }], NOW);
  const [event] = parseIcs(ics, { now: NOW, days: 14 });
  assert.equal(event.title, "Call mom, Sunday");
  assert.equal(event.start, Date.parse(due));
  assert.equal(event.uid, "inbox/x.md:2@daybook");
});
