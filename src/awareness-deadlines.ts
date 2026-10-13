/** Deterministic deadline/overdue suggestions; no AI, network calls, or writes. */
export interface DeadlineTask {
  id: string; ownerId: string; dueAt: string; completed: boolean;
  recurring?: boolean; title?: string;
}
export interface DeadlineContext {
  now: Date; ownerId: string; timeZone: string;
  reminderTaskIds: ReadonlySet<string>;
  briefingWindow?: { startsAt: string; endsAt: string };
}
export interface DeadlineSuggestion {
  id: string; ownerId: string; ruleId: "task-deadline" | "task-overdue";
  evidenceEventIds: string[]; subjectRefs: {kind:"task";id:string}[];
  reason: string; suggestedActions: ("open"|"reschedule"|"dismiss")[];
  urgency: "normal"|"high"; createdAt: string; expiresAt: string; dedupeKey: string;
}
const HOUR = 3_600_000, DAY = 24*HOUR;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/;
/**
 * Generate at most one suggestion per task. Reminder collisions and briefing
 * windows suppress prompts, rather than competing for user attention.
 * Never include private task title/content in push-ready reason text.
 */
export function deadlineSuggestions(tasks: readonly DeadlineTask[], ctx: DeadlineContext): DeadlineSuggestion[] {
  const now = ctx.now.getTime();
  if (!Number.isFinite(now) || !idPattern.test(ctx.ownerId)) throw new Error("Invalid deadline context");
  // Validate timezone up front: an invalid setting must not generate prompts.
  new Intl.DateTimeFormat("en-US",{timeZone:ctx.timeZone}).format(ctx.now);
  const window = ctx.briefingWindow;
  if (window) {
    const start = Date.parse(window.startsAt), end = Date.parse(window.endsAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("Invalid briefing window");
    if (now >= start && now < end) return [];
  }
  const seen = new Set<string>();
  const out: DeadlineSuggestion[] = [];
  for (const task of tasks) {
    if (task.ownerId !== ctx.ownerId || task.completed || task.recurring ||
        !idPattern.test(task.id) || seen.has(task.id) || ctx.reminderTaskIds.has(task.id)) continue;
    const due = Date.parse(task.dueAt);
    if (!Number.isFinite(due)) continue;
    const distance = due-now;
    // Upcoming within 24h, or overdue by 1h-7d. Avoid immediate due-time noise.
    const overdue = distance <= -HOUR && distance >= -7*DAY;
    const upcoming = distance > HOUR && distance <= DAY;
    if (!overdue && !upcoming) continue;
    seen.add(task.id);
    const ruleId = overdue ? "task-overdue" : "task-deadline";
    const bucket = new Intl.DateTimeFormat("en-CA",{
      timeZone:ctx.timeZone,year:"numeric",month:"2-digit",day:"2-digit"
    }).format(ctx.now);
    const dedupeKey = ruleId+":"+task.id+":"+bucket;
    out.push({
      id: dedupeKey, ownerId:ctx.ownerId, ruleId,
      evidenceEventIds:["task-due:"+task.id+":"+encodeURIComponent(task.dueAt)],
      subjectRefs:[{kind:"task",id:task.id}],
      reason: overdue
        ? "A task is overdue. Would you like to reschedule it or mark it done?"
        : "A task is due within the next day. Would you like to review it?",
      suggestedActions:["open","reschedule","dismiss"],
      urgency: overdue?"high":"normal",
      createdAt:ctx.now.toISOString(),
      expiresAt:new Date(now+DAY).toISOString(),
      dedupeKey
    });
  }
  return out;
}
