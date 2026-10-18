import { test } from "node:test";
import assert from "node:assert/strict";
import { insertLogLine, logPath } from "../src/log.ts";
import { signAction, verifyAction, signSession, verifySession, equalSecret } from "../src/action.ts";

test("log lines are created and kept in time order", () => {
  let c = insertLogLine(null, "2026-10-10", "- 09:12 coffee #drink");
  assert.equal(c, "# Log 2026-10-10\n\n- 09:12 coffee #drink\n");
  c = insertLogLine(c, "2026-10-10", "- 13:00 burrito #food");
  c = insertLogLine(c, "2026-10-10", "- 08:00 eggs #food");
  assert.equal(c, "# Log 2026-10-10\n\n- 08:00 eggs #food\n- 09:12 coffee #drink\n- 13:00 burrito #food\n");
  assert.equal(logPath("2026-10-10"), "journal/log/2026-10-10.md");
});

test("Done links verify and reject tampering", async () => {
  const token = await signAction("secret", { note: "goals/meds.md", text: "Take meds ✓" });
  assert.deepEqual(await verifyAction("secret", token), { note: "goals/meds.md", text: "Take meds ✓" });
  assert.equal(await verifyAction("other", token), null);
  const [p, s] = token.split(".");
  assert.equal(await verifyAction("secret", p + "x." + s), null);
  assert.equal(await verifyAction("secret", "garbage"), null);
  assert.ok(!/[,+/=]/.test(token), "token must be safe inside an ntfy Actions header");
});

test("sessions expire and can't be forged", async () => {
  const now = Date.parse("2026-10-10T10:00:00Z");
  const v = await signSession("secret", now + 1000);
  assert.equal(await verifySession("secret", v, now), true);
  assert.equal(await verifySession("secret", v, now + 2000), false);
  assert.equal(await verifySession("other", v, now), false);
  assert.equal(await verifySession("secret", (now + 999999) + "." + v.split(".")[1], now), false);
  assert.equal(await verifySession("secret", "", now), false);
  assert.equal(await equalSecret("a", "a"), true);
  assert.equal(await equalSecret("a", "b"), false);
});

test("a day's writing leaves out the heading and old copies of log lines", async () => {
  const { dayWriting } = await import("../src/log.ts");
  const old = "# 2026-10-10\n\nGood day.\n\n<!-- daybook:activity:start -->\n## Activity\n- 09:12 coffee #drink\n<!-- daybook:activity:end -->\n";
  assert.equal(dayWriting(old), "Good day.");
  assert.equal(dayWriting("# 2026-10-10\n\n<!-- daybook:activity:start -->\n## Activity\n_No activity recorded._\n<!-- daybook:activity:end -->\n"), "");
  assert.equal(dayWriting("Ran 5k.\n\nFelt great."), "Ran 5k.\n\nFelt great.");
});
