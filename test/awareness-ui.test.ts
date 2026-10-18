import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const html = readFileSync(new URL("../src/app.html", import.meta.url), "utf8");
test("Awareness is reachable through a mobile-friendly navigation route", () => {
  // Reached from the Today section's page switcher (one link only: no duplicate on the greeting card).
  assert.doesNotMatch(html, /class="today-suggestions"/);
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
test("an app left open reloads after a deploy instead of redrawing with old code", () => {
  const web = readFileSync(new URL("../src/web.ts", import.meta.url), "utf8");
  assert.match(web, /case "GET \/config": return json\(\{[\s\S]{0,200}version: VERSION/);
  assert.match(html, /latest\.version !== cfg\.version\) \{ location\.reload\(\)/);
});
test("Settings folds the extras into one-line rows and opens the one a link points to", () => {
  for (const id of ["briefings", "shortcuts", "apple-reminders", "calendar", "updates", "diagnostics"]) assert.match(html, new RegExp('\\["' + id + '", "'));
  assert.match(html, /foldSettings\(target\)/);
  assert.match(html, /if \(id === open\) fold\.open = true/);
});
