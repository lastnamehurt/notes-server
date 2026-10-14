import test from "node:test";
import assert from "node:assert/strict";
import { alertedByReminders, MIRROR_FRESH_MS } from "../src/reminders.ts";

const NOW = Date.parse("2026-10-13T19:00:00-07:00");
const meds = { note: "inbox/errands.md", text: "Take meds" };
const mirror = { at: NOW - 3600_000, keys: ["inbox/errands.md\u0000Take meds"] };

test("a task in Apple Reminders is alerted by Reminders, not Daybook", () => {
  assert.equal(alertedByReminders(mirror, meds, NOW, undefined), true, "Reminders only is the default");
  assert.equal(alertedByReminders(mirror, meds, NOW, "reminders"), true);
  assert.equal(alertedByReminders(mirror, { note: "inbox/errands.md", text: "Stretch" }, NOW, undefined), false, "not synced");
  assert.equal(alertedByReminders(mirror, { note: "other.md", text: "Take meds" }, NOW, undefined), false, "same title, other note");
});

test("Daybook alerts again when asked to, before any sync, or once the sync goes stale", () => {
  assert.equal(alertedByReminders(mirror, meds, NOW, "both"), false);
  assert.equal(alertedByReminders(undefined, meds, NOW, undefined), false);
  assert.equal(alertedByReminders({ ...mirror, at: NOW - MIRROR_FRESH_MS - 1 }, meds, NOW, undefined), false);
});
