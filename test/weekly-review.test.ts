import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildReview, reviewDue } from "../src/weekly-review";

test("weekly review fires only Sunday 18:00 in local timezone", () => {
  assert.equal(reviewDue(Date.parse("2026-10-12T01:07:00Z"), "America/Los_Angeles"), true);
  assert.equal(reviewDue(Date.parse("2026-10-12T00:07:00Z"), "America/Los_Angeles"), false);
  assert.equal(reviewDue(Date.parse("2026-10-12T02:07:00Z"), "America/Los_Angeles"), false);
});

test("weekly review summarizes activity and incomplete tasks without counting old logs", () => {
  const notes = [
    { name: "journal/log/2026-10-11.md", content: "# Log\n- 08:00 Morning walk\n- 09:00 ✓ Finished weekly planning #done" },
    { name: "journal/log/2026-10-01.md", content: "# Log\n- 10:00 old entry" },
    { name: "inbox/plan.md", content: "# Plan\n- [ ] Call hotel @priority:do\n- [x] Already done\n- [ ] Read book @priority:plan" }
  ];
  const result = buildReview("2026-10-11", notes, new Set(["2026-10-11"]));
  assert.match(result, /Days with activity: 1/);
  assert.match(result, /Journal entries: 2/);
  assert.match(result, /Completed reminder occurrences logged: 1/);
  assert.match(result, /Currently open tasks: 2/);
  assert.match(result, /Call hotel/);
  assert.doesNotMatch(result, /old entry/);
});
