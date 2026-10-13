import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_AWARENESS_PREFERENCES as defaults, parseAwarenessPreferences as parse } from "../src/awareness-preferences";
import { readFileSync } from "node:fs";
test("Awareness is opt-in and has privacy-preserving defaults", () => {
  assert.equal(defaults.enabled,false); assert.equal(defaults.mode,"inbox");
  assert.equal(defaults.dailyPushBudget,2); assert.equal(defaults.sources.github,false);
  assert.deepEqual(parse(defaults),defaults);
});
test("valid customized quiet hours, sources, pause and zero budget", () => {
  const p = parse({...defaults,enabled:true,paused:true,mode:"digest",dailyPushBudget:0,quietHours:{start:"23:15",end:"07:45"},sources:{...defaults.sources,github:true}});
  assert.equal(p.sources.github,true); assert.equal(p.paused,true);
});
test("rejects unknown keys, unsafe budgets, malformed quiet hours and missing sources", () => {
  for (const value of [
    {...defaults, secret:"oops"}, {...defaults,dailyPushBudget:3},
    {...defaults,dailyPushBudget:-1}, {...defaults,dailyPushBudget:1.5},
    {...defaults,quietHours:{start:"25:00",end:"08:00"}},
    {...defaults,quietHours:{start:"08:00",end:"08:00"}},
    {...defaults,sources:{daybook:true}}, {...defaults,enabled:"true"}
  ]) assert.throws(() => parse(value));
});
test("mobile UI exposes labeled controls and saves only through authenticated API", () => {
  const html = readFileSync(new URL("../src/app.html",import.meta.url),"utf8");
  assert.match(html,/renderAwarenessPreferences/);
  assert.match(html,/api\("\/awareness\/preferences"/);
  assert.match(html,/Save Awareness settings/);
  assert.match(html,/Pause suggestions/);
});
