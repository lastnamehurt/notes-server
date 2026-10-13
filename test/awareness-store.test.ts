import assert from "node:assert/strict";
import test from "node:test";
import { AwarenessEventStore, AWARENESS_RETENTION_MS } from "../src/awareness-store";

class MemoryStorage {
  data = new Map<string, unknown>();
  async get<T>(key: string) { return this.data.get(key) as T | undefined; }
  async put<T>(key: string, value: T) { this.data.set(key, value); }
  async delete(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) this.data.delete(key); }
  async list<T>({ prefix }: { prefix: string; limit?: number }) {
    return new Map([...this.data].filter(([key]) => key.startsWith(prefix))) as Map<string, T>;
  }
}
const when = "2026-10-13T12:00:00Z";
const make = (id: string, ownerId = "owner-1", occurredAt = when) => ({
  id, ownerId, occurredAt, observedAt: when, type: "task.created", source: "daybook",
  subjectRef: { kind: "task", id: "task-1" }, metadata: { taskId: "task-1" },
});
test("append persists event, identical retry is idempotent", async () => {
  const store = new AwarenessEventStore(new MemoryStorage());
  assert.equal((await store.append(make("e-1"), "owner-1")).inserted, true);
  assert.equal((await store.append(make("e-1"), "owner-1")).inserted, false);
  assert.equal((await store.list("owner-1")).length, 1);
});
test("same event ID with changed payload is rejected", async () => {
  const store = new AwarenessEventStore(new MemoryStorage());
  await store.append(make("e-1"), "owner-1");
  await assert.rejects(() => store.append({ ...make("e-1"), observedAt: "2026-10-14T12:00:00Z" }, "owner-1"), /conflict/);
});
test("owner isolation applies to writes, reads and identical IDs", async () => {
  const store = new AwarenessEventStore(new MemoryStorage());
  await store.append(make("e-1"), "owner-1");
  await store.append(make("e-1", "owner-2"), "owner-2");
  await assert.rejects(() => store.append(make("e-2", "owner-2"), "owner-1"), /owner mismatch/);
  assert.deepEqual((await store.list("owner-1")).map(e => e.ownerId), ["owner-1"]);
  assert.deepEqual((await store.list("owner-2")).map(e => e.ownerId), ["owner-2"]);
});
test("out-of-order arrivals are read chronologically", async () => {
  const store = new AwarenessEventStore(new MemoryStorage());
  await store.append(make("e-3", "owner-1", "2026-10-15T12:00:00Z"), "owner-1");
  await store.append(make("e-1", "owner-1", "2026-10-11T12:00:00Z"), "owner-1");
  await store.append(make("e-2"), "owner-1");
  assert.deepEqual((await store.list("owner-1")).map(e => e.id), ["e-1", "e-2", "e-3"]);
  assert.deepEqual((await store.list("owner-1", 2)).map(e => e.id), ["e-2", "e-3"]);
});
test("invalid metadata cannot enter persistence", async () => {
  const storage = new MemoryStorage(), store = new AwarenessEventStore(storage);
  await assert.rejects(() => store.append({ ...make("e-1"), metadata: { taskId: "task-1", secret: "token" } }, "owner-1"));
  assert.equal(storage.data.size, 0);
});
test("retention prunes only expired owner events", async () => {
  const store = new AwarenessEventStore(new MemoryStorage());
  await store.append(make("old"), "owner-1");
  await store.append(make("other", "owner-2"), "owner-2");
  const now = Date.parse(when) + AWARENESS_RETENTION_MS + 1;
  assert.equal(await store.prune("owner-1", now), 1);
  assert.equal((await store.list("owner-1")).length, 0);
  assert.equal((await store.list("owner-2")).length, 1);
});
