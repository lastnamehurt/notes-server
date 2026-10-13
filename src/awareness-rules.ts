/**
 * First Awareness rule: after three distinct postponements of the same task,
 * propose an inbox suggestion. Pure and deterministic: no push, AI, or writes.
 */
export interface DeferralEvidence {
  id: string;
  ownerId: string;
  type: string;
  occurredAt: string;
  subjectRef: { kind: string; id: string };
  metadata: { taskId?: string; fromDueAt?: string | null; toDueAt?: string | null };
}
export interface ThreeDeferralsSuggestion {
  id: string;
  ownerId: string;
  ruleId: "task-three-deferrals";
  evidenceEventIds: string[];
  subjectRefs: { kind: "task"; id: string }[];
  reason: string;
  suggestedActions: ("open" | "reschedule" | "dismiss")[];
  urgency: "normal";
  createdAt: string;
  expiresAt: string;
  dedupeKey: string;
}

const WINDOW_MS = 30 * 86_400_000;
const EXPIRY_MS = 7 * 86_400_000;

/** Only count validated, distinct, chronological, connected due-date moves. */
export function threeDeferrals(
  events: readonly DeferralEvidence[], ownerId: string, now = new Date()
): ThreeDeferralsSuggestion[] {
  if (!ownerId || !Number.isFinite(now.getTime())) throw new Error("Invalid awareness rule context");
  const byTask = new Map<string, DeferralEvidence[]>();
  const seen = new Set<string>();
  for (const e of events) {
    if (e.ownerId !== ownerId || e.type !== "task.deferred" || e.subjectRef.kind !== "task" ||
        e.subjectRef.id !== e.metadata.taskId || !e.id || seen.has(e.id)) continue;
    const at = Date.parse(e.occurredAt), from = Date.parse(e.metadata.fromDueAt ?? ""), to = Date.parse(e.metadata.toDueAt ?? "");
    if (![at, from, to].every(Number.isFinite) || to <= from ||
        at > now.getTime() || at < now.getTime() - WINDOW_MS) continue;
    seen.add(e.id);
    const group = byTask.get(e.metadata.taskId!) ?? [];
    group.push(e);
    byTask.set(e.metadata.taskId!, group);
  }
  const suggestions: ThreeDeferralsSuggestion[] = [];
  for (const [taskId, group] of byTask) {
    group.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id));
    // Count only genuine successive changes, not parallel sync echoes of the same move.
    const chain: DeferralEvidence[] = [];
    for (const event of group) {
      if (!chain.length || chain[chain.length - 1].metadata.toDueAt === event.metadata.fromDueAt) chain.push(event);
      else if (chain[chain.length - 1].metadata.fromDueAt !== event.metadata.fromDueAt ||
               chain[chain.length - 1].metadata.toDueAt !== event.metadata.toDueAt) {
        chain.length = 0;
        chain.push(event);
      }
    }
    if (chain.length < 3) continue;
    // One suggestion per task per window; inbox persistence enforces dedupeKey.
    const evidence = chain.slice(-3);
    const createdAt = now.toISOString();
    suggestions.push({
      id: "three-deferrals-" + taskId,
      ownerId, ruleId: "task-three-deferrals",
      evidenceEventIds: evidence.map(e => e.id),
      subjectRefs: [{ kind: "task", id: taskId }],
      reason: "You've moved this task's due date three times. Is it worth breaking into a smaller step or choosing a more realistic date?",
      suggestedActions: ["open", "reschedule", "dismiss"],
      urgency: "normal", createdAt,
      expiresAt: new Date(now.getTime() + EXPIRY_MS).toISOString(),
      dedupeKey: "task-three-deferrals:" + taskId
    });
  }
  return suggestions;
}
