import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGlance } from "../src/glance.ts";

const spend = { date: "2026-10-18", week: "2026-10-12", today: 10.44, todayCount: 1, weekTotal: 43.14, weekCount: 2, drinksThisWeek: 1, currency: "USD" };
const notes = [
  { name: "inbox/2026-10-17-idea.md", content: "# Idea\n" },
  { name: "inbox/2026-10-16-old.md", content: "# Old\n\nDaybook-status: kept\n" },
  { name: "journal/log/2026-10-18.md", content: "# Log 2026-10-18\n\n- 08:30 coffee #drink\n- 11:47 Tap to pay: bar #drink #spend\n" },
  { name: "projects/x.md", content: "# X\n" }
];

test("the lock screen glance has spending, the inbox and the last log line", () => {
  const g = buildGlance({ now: 1, date: "2026-10-18", spend, hideAmounts: false, dailyTarget: 50, weeklyTarget: 200, notes });
  assert.deepEqual(g.spending, { today: 10.44, week: 43.14, todayCount: 1, currency: "USD", dayPct: 21, weekPct: 22, hidden: false });
  assert.deepEqual(g.notes, { inbox: 1, lastLog: { time: "11:47", text: "bar" } });
});

test("hidden amounts leave only percents; no targets, no spend and no log are fine", () => {
  const g = buildGlance({ now: 1, date: "2026-10-18", spend, hideAmounts: true, dailyTarget: null, weeklyTarget: 200, notes });
  assert.equal(g.spending?.today, null); assert.equal(g.spending?.week, null);
  assert.equal(g.spending?.dayPct, null); assert.equal(g.spending?.weekPct, 22);
  const empty = buildGlance({ now: 1, date: "2026-10-19", spend: null, hideAmounts: false, dailyTarget: null, weeklyTarget: null, notes: [] });
  assert.equal(empty.spending, null);
  assert.deepEqual(empty.notes, { inbox: 0, lastLog: null });
});
