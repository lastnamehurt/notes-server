import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const reminders = readFileSync(new URL("../src/reminders.ts",import.meta.url),"utf8");
const web = readFileSync(new URL("../src/web.ts",import.meta.url),"utf8");
test("Awareness delivery is explicitly requested through authenticated app API",()=>{
  assert.match(web,/case "POST \/awareness\/deliver"/);
  assert.match(web,/scheduler\(env\)\.awarenessDeliver\(body\.id\)/);
});
test("delivery reuses existing provider stack without touching reminder alarm flow",()=>{
  assert.match(reminders,/async awarenessDeliver\(id: string\)/);
  assert.match(reminders,/await sendNotice\(env, \{ title: "Daybook Awareness"/);
  assert.match(reminders,/async alarm\(\): Promise<void>/);
});
test("delivery reserves dedupe key and daily budget before provider IO",()=>{
  const block = reminders.slice(reminders.indexOf("async awarenessDeliver("),reminders.indexOf("/** Awareness inbox stays"));
  assert.ok(block.indexOf("await this.ctx.storage.put(dedupe") < block.indexOf("await sendNotice("));
  assert.ok(block.indexOf("await this.ctx.storage.put(daily") < block.indexOf("await sendNotice("));
  assert.match(block,/already-delivered/);
  assert.match(block,/delivery-unconfirmed/);
});
test("opt-out and no-provider paths return without sending",()=>{
  const block = reminders.slice(reminders.indexOf("async awarenessDeliver("),reminders.indexOf("/** Awareness inbox stays"));
  assert.match(block,/decision.action !== "send"/);
  assert.match(block,/!pushConfigured\(env\)/);
});
