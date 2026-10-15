/**
 * Overdue nudges (#96, slimmed down): a dated task that has sat overdue for two days or more.
 * Reminders already ping at the due time and briefings list what's due, so there is no "due soon"
 * rule; this only catches what slipped through. Deterministic: no AI, network calls or writes.
 */
export interface DeadlineTask {
  id: string; ownerId: string; dueAt: string; completed: boolean;
  recurring?: boolean; title?: string;
}
export interface DeadlineContext { now: Date; ownerId: string; timeZone: string; }
export interface DeadlineSuggestion {
  id: string; ownerId: string; ruleId: "task-overdue";
  evidenceEventIds: string[]; subjectRefs: {kind:"task";id:string}[];
  reason: string; suggestedActions: ("open"|"reschedule"|"dismiss")[];
  urgency: "normal"|"high"; createdAt: string; expiresAt: string; dedupeKey: string;
}
const DAY = 86_400_000;
/** Overdue at least this long before a nudge; older than the window and it's no longer news. */
export const OVERDUE_AFTER_MS = 2 * DAY;
export const OVERDUE_WINDOW_MS = 14 * DAY;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/;

/**
 * At most one suggestion per task per due date: moving the date (or finishing the task) ends it,
 * and a task left overdue is nudged once, not every day.
 * Never include private task title/content in push-ready reason text.
 */
export function deadlineSuggestions(tasks: readonly DeadlineTask[], ctx: DeadlineContext): DeadlineSuggestion[] {
  const now = ctx.now.getTime();
  if (!Number.isFinite(now) || !idPattern.test(ctx.ownerId)) throw new Error("Invalid deadline context");
  // Validate timezone up front: an invalid setting must not generate prompts.
  new Intl.DateTimeFormat("en-US",{timeZone:ctx.timeZone}).format(ctx.now);
  const seen = new Set<string>();
  const out: DeadlineSuggestion[] = [];
  for (const task of tasks) {
    if (task.ownerId !== ctx.ownerId || task.completed || task.recurring ||
        !idPattern.test(task.id) || seen.has(task.id)) continue;
    const due = Date.parse(task.dueAt);
    if (!Number.isFinite(due)) continue;
    const late = now - due;
    if (late < OVERDUE_AFTER_MS || late > OVERDUE_WINDOW_MS) continue;
    seen.add(task.id);
    const dedupeKey = "task-overdue:" + task.id + ":" + due;
    out.push({
      id: dedupeKey, ownerId: ctx.ownerId, ruleId: "task-overdue",
      evidenceEventIds: ["task-due:" + task.id + ":" + due],
      subjectRefs: [{kind:"task",id:task.id}],
      reason: "A task has been overdue for a couple of days. Do it, give it a new date, or let it go?",
      suggestedActions: ["open","reschedule","dismiss"],
      urgency: "high",
      createdAt: ctx.now.toISOString(),
      expiresAt: new Date(due + OVERDUE_WINDOW_MS).toISOString(),
      dedupeKey
    });
  }
  return out;
}
