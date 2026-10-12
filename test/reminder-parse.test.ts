import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReminders, zonedTime } from "../src/reminder-parse.ts";

const iso = (ms: number) => new Date(ms).toISOString();

test("parses date, time formats, and defaults to 9am Pacific", () => {
  const rs = parseReminders("inbox/x.md", [
    "# Errands",
    "- [ ] Renew registration @2026-10-14 9am",
    "- [ ] Call shop @2026-10-14 5:30pm",
    "* [ ] Standup prep @2026-10-15 17:30",
    "- [ ] Pay bill @2026-10-16",
    "- [x] Done already @2026-10-14 9am",
    "- [ ] No date here",
    "- [ ] Bad hour @2026-10-14 13pm",
    "Some prose mentioning @2026-10-14"
  ].join("\n"));
  assert.deepEqual(rs.map(r => [r.text, iso(r.at)]), [
    ["Renew registration", "2026-10-14T16:00:00.000Z"],
    ["Call shop", "2026-10-15T00:30:00.000Z"],
    ["Standup prep", "2026-10-16T00:30:00.000Z"],
    ["Pay bill", "2026-10-16T16:00:00.000Z"]
  ]);
});

test("handles 12am/12pm and DST boundaries", () => {
  const [mid, noon] = parseReminders("n.md", "- [ ] a @2026-12-01 12am\n- [ ] b @2026-12-01 12pm");
  assert.equal(iso(mid.at), "2026-12-01T08:00:00.000Z");
  assert.equal(iso(noon.at), "2026-12-01T20:00:00.000Z");
  assert.equal(iso(zonedTime(2026, 11, 2, 9, 0, "America/Los_Angeles")), "2026-11-02T17:00:00.000Z"); // after fall back
  assert.equal(iso(zonedTime(2026, 3, 9, 9, 0, "America/Los_Angeles")), "2026-03-09T16:00:00.000Z");  // after spring forward
  assert.equal(iso(zonedTime(2026, 10, 14, 9, 0, "America/New_York")), "2026-10-14T13:00:00.000Z");
});

import { nextOccurrence, parseTime } from "../src/reminder-parse.ts";

// Saturday 2026-10-10 03:09 Pacific
const NOW = Date.parse("2026-10-10T10:09:00Z");

test("repeating reminders: daily with several times", () => {
  const rs = parseReminders("meds.md", "- [ ] Take meds @daily 8am, 8pm", "America/Los_Angeles", NOW);
  assert.deepEqual(rs.map(r => [r.text, iso(r.at), r.repeat]), [
    ["Take meds", "2026-10-10T15:00:00.000Z", { days: [0, 1, 2, 3, 4, 5, 6], minute: 480 }],
    ["Take meds", "2026-10-11T03:00:00.000Z", { days: [0, 1, 2, 3, 4, 5, 6], minute: 1200 }]
  ]);
});

test("repeating reminders: weekdays, weekends, day lists, last @ wins", () => {
  const rs = parseReminders("n.md", [
    "- [ ] Stretch @weekdays 7am",           // Sat now -> Mon 10/12
    "- [ ] Long run @weekends",              // 9am today (Sat)
    "- [ ] Gym @Mon,wed,FRIDAY 6pm",
    "- [ ] Email bob@example.com re @tues 10am",
    "- [x] Paused @daily 9am",
    "- [ ] Nonsense @funday 9am",
    "- [ ] Bad time @daily 25:00"
  ].join("\n"), "America/Los_Angeles", NOW);
  assert.deepEqual(rs.map(r => [r.text, iso(r.at)]), [
    ["Stretch", "2026-10-12T14:00:00.000Z"],
    ["Long run", "2026-10-10T16:00:00.000Z"],
    ["Gym", "2026-10-13T01:00:00.000Z"],
    ["Email bob@example.com re", "2026-10-13T17:00:00.000Z"]
  ]);
});

test("nextOccurrence rolls forward and survives DST", () => {
  const daily9 = { days: [0, 1, 2, 3, 4, 5, 6], minute: 540 };
  const sat9am = Date.parse("2026-10-10T16:00:00Z");
  assert.equal(iso(nextOccurrence(daily9, "America/Los_Angeles", sat9am)), "2026-10-11T16:00:00.000Z");
  // Sat Oct 31 9am PDT -> Sun Nov 1 9am PST (clocks fall back that night)
  assert.equal(iso(nextOccurrence(daily9, "America/Los_Angeles", Date.parse("2026-10-31T16:00:00Z"))), "2026-11-01T17:00:00.000Z");
  const mon = { days: [1], minute: 540 };
  assert.equal(iso(nextOccurrence(mon, "America/Los_Angeles", Date.parse("2026-10-12T16:00:00Z"))), "2026-10-19T16:00:00.000Z");
});

test("parseTime", () => {
  assert.deepEqual(["9am", "12am", "12pm", "5:30pm", "17:30", "0:05", "13pm", "9:60", "x"].map(parseTime),
    [540, 0, 720, 1050, 1050, 5, null, null, null]);
});

test("normalizeTopic strips server prefixes and whitespace", async () => {
  const { normalizeTopic } = await import("../src/reminder-parse.ts");
  for (const raw of ["my-topic", " my-topic\n", "ntfy.sh/my-topic", "https://ntfy.sh/my-topic/"]) {
    assert.equal(normalizeTopic(raw), "my-topic");
  }
});

test("pushConfigured needs both Pushover secrets or an ntfy topic", async () => {
  const { pushConfigured } = await import("../src/reminder-parse.ts");
  assert.equal(pushConfigured({}), false);
  assert.equal(pushConfigured({ PUSHOVER_TOKEN: "t" }), false);
  assert.equal(pushConfigured({ PUSHOVER_TOKEN: "t", PUSHOVER_USER: "u" }), true);
  assert.equal(pushConfigured({ NTFY_TOPIC: "x" }), true);
});


test("priority metadata after a 24-hour timestamp still schedules a reminder", () => {
  const reminders = parseReminders("inbox/flight.md", "- [ ] Look for screenshot @2026-10-11 23:00 @priority:do");
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].text, "Look for screenshot");
  assert.equal(iso(reminders[0].at), "2026-10-12T06:00:00.000Z");
});
