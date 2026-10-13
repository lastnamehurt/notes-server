import test from "node:test";
import assert from "node:assert/strict";
import { AwarenessInbox } from "../src/awareness-inbox";

class MemoryStorage {
  data = new Map<string, unknown>();
  async get<T>(key: string) { return this.data.get(key) as T | undefined; }
  async put<T>(key: string, value: T) { this.data.set(key, value); }
  async list<T>({prefix}: {prefix:string}) { return new Map([...this.data].filter(([k]) => k.startsWith(prefix))) as Map<string,T>; }
}
const candidate = (id: string, ownerId = "local") => ({
  id, ownerId, ruleId:"task-three-deferrals", dedupeKey:"task-three-deferrals:"+id,
  reason:"This task was postponed three times", createdAt:"2026-10-13T10:00:00Z",
  expiresAt:"2026-10-20T10:00:00Z", evidenceEventIds:["a","b","c"],
  subjectRefs:[{kind:"task",id}], suggestedActions:["open","dismiss"], urgency:"normal"
});
const now = "2026-10-13T12:00:00Z";
test("add, read, retry and dedupe", async () => {
  const inbox = new AwarenessInbox(new MemoryStorage());
  assert.equal((await inbox.add("local",candidate("abc123"))).inserted,true);
  assert.equal((await inbox.add("local",candidate("abc123"))).inserted,false);
  assert.equal((await inbox.get("local","abc123"))?.candidate.reason,"This task was postponed three times");
  assert.equal((await inbox.list("local",{now})).items.length,1);
});
test("owner isolation and forged candidates", async () => {
  const inbox = new AwarenessInbox(new MemoryStorage());
  await inbox.add("local",candidate("abc123"));
  assert.equal(await inbox.get("other","abc123"),null);
  assert.equal((await inbox.list("other",{now})).items.length,0);
  await assert.rejects(() => inbox.add("other",candidate("abc123")));
});
test("dismiss, mute and snooze hide items; snooze expires", async () => {
  const inbox = new AwarenessInbox(new MemoryStorage());
  for(const id of ["a123","b123","c123"]) await inbox.add("local",candidate(id));
  await inbox.action("local","a123","dismiss",undefined,now);
  await inbox.action("local","b123","mute",undefined,now);
  await inbox.action("local","c123","snooze","2026-10-14T12:00:00Z",now);
  assert.equal((await inbox.list("local",{now})).items.length,0);
  assert.equal((await inbox.list("local",{now:"2026-10-15T12:00:00Z"})).items.length,1);
  await assert.rejects(() => inbox.action("local","c123","snooze","2026-10-12T12:00:00Z",now));
});
test("cursor pagination, unknown items and invalid cursor", async () => {
  const inbox = new AwarenessInbox(new MemoryStorage());
  for(const id of ["a123","b123","c123"]) await inbox.add("local",candidate(id));
  const first = await inbox.list("local",{limit:2,now});
  assert.equal(first.items.length,2);
  assert.ok(first.nextCursor);
  assert.equal((await inbox.list("local",{limit:2,cursor:first.nextCursor!,now})).items.length,1);
  await assert.rejects(() => inbox.list("local",{cursor:"unknown",now}));
  assert.equal(await inbox.action("local","missing","dismiss"),null);
});
test("expired candidates are excluded", async () => {
  const inbox = new AwarenessInbox(new MemoryStorage());
  await inbox.add("local",candidate("abc123"));
  assert.equal((await inbox.list("local",{now:"2026-10-21T12:00:00Z"})).items.length,0);
});
