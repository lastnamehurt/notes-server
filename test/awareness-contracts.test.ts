import assert from "node:assert/strict";
import test from "node:test";
import { awarenessCandidateSchema, awarenessDecisionSchema, parseAwarenessCandidate, parseAwarenessEvent } from "../src/awareness-contracts";

const date = "2026-10-13T12:00:00Z";
const later = "2026-10-14T12:00:00Z";
const event = () => ({
  id: "evt-1", ownerId: "owner-1", type: "task.deferred", source: "daybook",
  occurredAt: date, observedAt: date, subjectRef: { kind: "task", id: "task-1" },
  metadata: { taskId: "task-1", fromDueAt: date, toDueAt: later },
});
const candidate = () => ({
  id: "candidate-1", ownerId: "owner-1", ruleId: "three-deferrals",
  evidenceEventIds: ["evt-1"], subjectRefs: [{ kind: "task", id: "task-1" }],
  reason: "This task has been deferred repeatedly", suggestedActions: ["open", "snooze"],
  urgency: "normal", createdAt: date, expiresAt: later, dedupeKey: "task-1:three-deferrals",
});

test("accepts grounded owner-scoped task deferral", () => {
  assert.equal(parseAwarenessEvent(event(), "owner-1").type, "task.deferred");
});
test("rejects cross-owner event and candidate", () => {
  assert.throws(() => parseAwarenessEvent(event(), "owner-2"), /owner mismatch/);
  assert.throws(() => parseAwarenessCandidate(candidate(), "owner-2"), /owner mismatch/);
});
test("rejects unknown event type, source and malformed timestamp", () => {
  assert.throws(() => parseAwarenessEvent({ ...event(), type: "device.screenshot" }, "owner-1"));
  assert.throws(() => parseAwarenessEvent({ ...event(), source: "browser" }, "owner-1"));
  assert.throws(() => parseAwarenessEvent({ ...event(), occurredAt: "tomorrow" }, "owner-1"));
});
test("rejects secret-bearing and oversized event metadata rather than retaining it", () => {
  assert.throws(() => parseAwarenessEvent({ ...event(), metadata: { ...event().metadata, bearerToken: "secret" } }, "owner-1"));
  assert.throws(() => parseAwarenessEvent({ ...event(), metadata: { ...event().metadata, content: "a".repeat(5000) } }, "owner-1"));
});
test("rejects mismatched subject identity", () => {
  assert.throws(() => parseAwarenessEvent({ ...event(), subjectRef: { kind: "task", id: "other" } }, "owner-1"), /reference mismatch/);
});
test("rejects reschedules that are not actual deferrals", () => {
  assert.throws(() => parseAwarenessEvent({ ...event(), metadata: { taskId: "task-1", fromDueAt: later, toDueAt: date } }, "owner-1"), /move an existing due date later/);
  assert.throws(() => parseAwarenessEvent({ ...event(), metadata: { taskId: "task-1", fromDueAt: null, toDueAt: later } }, "owner-1"), /move an existing due date later/);
});
test("accepts valid candidate and decisions", () => {
  assert.equal(parseAwarenessCandidate(candidate(), "owner-1").ruleId, "three-deferrals");
  for (const disposition of [
    { disposition: "send", channel: "inbox" },
    { disposition: "digest", nextEligibleAt: later },
    { disposition: "suppress", reason: "quiet hours" },
  ]) assert.equal(awarenessDecisionSchema.safeParse(disposition).success, true);
});
test("rejects candidate without evidence, expired candidate and unknown decision properties", () => {
  assert.equal(awarenessCandidateSchema.safeParse({ ...candidate(), evidenceEventIds: [] }).success, false);
  assert.equal(awarenessCandidateSchema.safeParse({ ...candidate(), expiresAt: date }).success, false);
  assert.equal(awarenessDecisionSchema.safeParse({ disposition: "send", channel: "push", rawContent: "private" }).success, false);
});
