import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const html = readFileSync(new URL("../src/app.html", import.meta.url), "utf8");
test("Awareness is reachable through a mobile-friendly navigation route", () => {
  // Reached from Today's "Suggestions" link and the Today section's page switcher.
  assert.match(html, /<a class="today-suggestions" href="#awareness">Suggestions<\/a>/);
  assert.match(html, /\["awareness", "Suggestions"\]/);
  assert.match(html, /view === "awareness"\) await renderAwareness\(\)/);
  assert.match(html, /\.awareness-actions button[^}]*min-height: 44px/);
});
test("Awareness renders private text safely and offers evidence and actions", () => {
  assert.match(html, /reason\.textContent = candidate\.reason/);
  assert.doesNotMatch(html, /innerHTML\s*=\s*candidate\.reason/);
  assert.match(html, /summary\.textContent = "Why this\?"/);
  for (const action of ["dismiss", "snooze", "mute"]) assert.match(html, new RegExp('act\\("[^"]+", "' + action + '"\\)'));
});
test("Awareness works without enabling push and supports loading and errors", () => {
  assert.match(html, /No notifications required/);
  assert.match(html, /\/awareness\/inbox\?limit=20/);
  assert.match(html, /\/awareness\/action/);
  assert.match(html, /Could not load Awareness:/);
  assert.match(html, /more\.onclick = \(\) => load\(true\)/);
});
