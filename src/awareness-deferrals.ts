import { splitTaskId } from "./task-id";
import { parseReminders } from "./reminder-parse";

export interface TaskDeferral {
  taskId: string;
  fromDueAt: string;
  toDueAt: string;
}

/**
 * Detect actual postponements of the same open, ID-bearing, one-off task.
 * ID-less tasks cannot be safely correlated across edits or sync replays.
 * This pure diff deliberately emits nothing for repeats or priority-only edits.
 */
export function taskDeferrals(before: string, after: string, zone: string): TaskDeferral[] {
  const open = (content: string) => {
    const tasks = new Map<string, number | null>();
    const duplicates = new Set<string>();
    for (const line of content.split("\n")) {
      if (!/^\s*[-*]\s+\[ \]\s+/.test(line)) continue;
      const { id } = splitTaskId(line);
      if (!id) continue;
      if (tasks.has(id)) { duplicates.add(id); continue; }
      const reminders = parseReminders("", line, zone);
      const oneOff = reminders.length === 1 && !reminders[0].repeat ? reminders[0].at : null;
      tasks.set(id, oneOff);
    }
    for (const id of duplicates) tasks.delete(id);
    return tasks;
  };
  const previous = open(before), current = open(after);
  const out: TaskDeferral[] = [];
  for (const [taskId, from] of previous) {
    const to = current.get(taskId);
    if (from !== null && from !== undefined && to !== null && to !== undefined && to > from) {
      out.push({ taskId, fromDueAt: new Date(from).toISOString(), toDueAt: new Date(to).toISOString() });
    }
  }
  return out;
}
