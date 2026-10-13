/**
 * Awareness contracts and untrusted-input validation.
 *
 * Pure module: no storage, notification, or task mutation side effects.
 * Every persisted event is scoped to an owner and uses allowlisted metadata.
 */
import { z } from "zod";

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/);
const isoDate = z.iso.datetime({ offset: true });
const source = z.enum(["daybook", "schedule", "apple-reminders", "calendar", "github"]);
const subjectKind = z.enum(["task", "note", "event", "goal"]);
export const awarenessSubjectSchema = z.strictObject({ kind: subjectKind, id });
export type AwarenessSubject = z.infer<typeof awarenessSubjectSchema>;

const base = z.strictObject({
  id,
  ownerId: id,
  occurredAt: isoDate,
  observedAt: isoDate,
  subjectRef: awarenessSubjectSchema,
});

// Strict per-type schemas prevent arbitrary text, credentials or provider payloads
// from being accidentally persisted as event metadata.
const taskMetadata = z.strictObject({
  fromDueAt: isoDate.nullable(),
  toDueAt: isoDate.nullable(),
  taskId: id,
});
const taskCreated = z.strictObject({ taskId: id });
const taskCompleted = z.strictObject({ taskId: id, occurrenceAt: isoDate.nullable().optional() });
const reminderDue = z.strictObject({ taskId: id, dueAt: isoDate });
const noteCreated = z.strictObject({ noteId: id });
const goalUpdated = z.strictObject({ goalId: id });
const calendarChanged = z.strictObject({ providerEventId: id, startAt: isoDate.nullable() });
const githubStatus = z.strictObject({
  repository: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  itemNumber: z.number().int().positive().max(2147483647),
  status: z.enum(["opened", "closed", "merged", "success", "failure", "cancelled"]),
});

export const awarenessEventSchema = z.discriminatedUnion("type", [
  base.extend({ type: z.literal("task.created"), source: z.literal("daybook"), metadata: taskCreated }),
  base.extend({ type: z.literal("task.updated"), source: z.enum(["daybook", "apple-reminders"]), metadata: taskMetadata }),
  base.extend({ type: z.literal("task.deferred"), source: z.enum(["daybook", "apple-reminders"]), metadata: taskMetadata }),
  base.extend({ type: z.literal("task.completed"), source: z.enum(["daybook", "apple-reminders"]), metadata: taskCompleted }),
  base.extend({ type: z.literal("reminder.due"), source: z.literal("schedule"), metadata: reminderDue }),
  base.extend({ type: z.literal("note.created"), source: z.literal("daybook"), metadata: noteCreated }),
  base.extend({ type: z.literal("goal.updated"), source: z.literal("daybook"), metadata: goalUpdated }),
  base.extend({ type: z.literal("calendar.changed"), source: z.literal("calendar"), metadata: calendarChanged }),
  base.extend({ type: z.literal("github.status"), source: z.literal("github"), metadata: githubStatus }),
]);
export type AwarenessEvent = z.infer<typeof awarenessEventSchema>;

export const awarenessCandidateSchema = z.strictObject({
  id,
  ownerId: id,
  ruleId: id,
  evidenceEventIds: z.array(id).min(1).max(20),
  subjectRefs: z.array(awarenessSubjectSchema).min(1).max(20),
  reason: z.string().trim().min(1).max(500),
  suggestedActions: z.array(z.enum(["open", "snooze", "reschedule", "dismiss"])).min(1).max(4),
  urgency: z.enum(["low", "normal", "high"]),
  createdAt: isoDate,
  expiresAt: isoDate,
  dedupeKey: id,
}).superRefine((value, ctx) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
    ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Candidate must expire after creation" });
  }
});
export type AwarenessCandidate = z.infer<typeof awarenessCandidateSchema>;

export const awarenessDecisionSchema = z.discriminatedUnion("disposition", [
  z.strictObject({ disposition: z.literal("send"), channel: z.enum(["push", "inbox"]) }),
  z.strictObject({ disposition: z.literal("digest"), nextEligibleAt: isoDate }),
  z.strictObject({ disposition: z.literal("suppress"), reason: z.string().trim().min(1).max(200) }),
]);
export type AwarenessDecision = z.infer<typeof awarenessDecisionSchema>;

export function parseAwarenessEvent(input: unknown, expectedOwnerId: string): AwarenessEvent {
  const event = awarenessEventSchema.parse(input);
  if (!id.safeParse(expectedOwnerId).success || event.ownerId !== expectedOwnerId) {
    throw new Error("Awareness event owner mismatch");
  }
  if ((event.type === "task.created" || event.type === "task.updated" || event.type === "task.deferred" || event.type === "task.completed") &&
    (event.subjectRef.kind !== "task" || event.subjectRef.id !== event.metadata.taskId)) {
    throw new Error("Awareness task reference mismatch");
  }
  if (event.type === "reminder.due" && (event.subjectRef.kind !== "task" || event.subjectRef.id !== event.metadata.taskId)) {
    throw new Error("Awareness reminder reference mismatch");
  }
  if (event.type === "note.created" && (event.subjectRef.kind !== "note" || event.subjectRef.id !== event.metadata.noteId)) {
    throw new Error("Awareness note reference mismatch");
  }
  if (event.type === "goal.updated" && (event.subjectRef.kind !== "goal" || event.subjectRef.id !== event.metadata.goalId)) {
    throw new Error("Awareness goal reference mismatch");
  }
  if (event.type === "task.deferred" && (!event.metadata.fromDueAt || !event.metadata.toDueAt ||
    Date.parse(event.metadata.toDueAt) <= Date.parse(event.metadata.fromDueAt))) {
    throw new Error("A deferral must move an existing due date later");
  }
  return event;
}

export function parseAwarenessCandidate(input: unknown, expectedOwnerId: string): AwarenessCandidate {
  const candidate = awarenessCandidateSchema.parse(input);
  if (!id.safeParse(expectedOwnerId).success || candidate.ownerId !== expectedOwnerId) {
    throw new Error("Awareness candidate owner mismatch");
  }
  return candidate;
}
