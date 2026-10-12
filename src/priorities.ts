/** Lightweight GTD capture + Eisenhower priorities stored directly in Markdown tasks. */
export const PRIORITIES = ["do", "plan", "delegate", "someday"] as const;
export type Priority = typeof PRIORITIES[number];
export type Task = { note: string; line: number; text: string; priority: Priority | "inbox" };
const TAG = /(?:^|\s)@priority:(do|plan|delegate|someday)\b/;
export function classifyTask(line: string): { text: string; priority: Task["priority"] } | null {
  const match = /^\s*[-*]\s+\[ \]\s+(.+)$/.exec(line);
  if (!match) return null;
  const tag = TAG.exec(match[1]);
  return { text: match[1].replace(TAG, "").trim(), priority: tag ? tag[1] as Priority : "inbox" };
}
export function tasksFromNotes(notes: {name: string; content: string}[]): Task[] {
  return notes.flatMap(({name,content}) => content.split("\n").flatMap((line, index) => {
    const task = classifyTask(line);
    return task ? [{note:name,line:index,text:task.text,priority:task.priority}] : [];
  }));
}
export function changeTaskPriority(content: string, line: number, priority: Task["priority"]): string {
  if (!Number.isSafeInteger(line) || line < 0 || ![...PRIORITIES,"inbox"].includes(priority)) throw new Error("Invalid priority or line");
  const lines = content.split("\n");
  if (line >= lines.length || !classifyTask(lines[line])) throw new Error("Task no longer exists");
  lines[line] = lines[line].replace(TAG, "").trimEnd() + (priority === "inbox" ? "" : " @priority:" + priority);
  return lines.join("\n");
}
