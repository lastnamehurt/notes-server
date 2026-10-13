import { tasksFromNotes, changeTaskPriority, type Task } from "./priorities";
import { zonedTime, nextOccurrence, parseReminders, type Reminder } from "./reminder-parse";
import { splitTaskId, withTaskId } from "./task-id";

export function validDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const d = new Date(day + "T12:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === day;
}
export function dayStart(day: string, zone: string): number {
  if (!validDay(day)) throw new Error("Choose a valid date");
  const [y,m,d] = day.split("-").map(Number);
  return zonedTime(y,m,d,0,0,zone);
}
export async function noteRevision(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,"0")).join("");
}
export type CalendarTask = Task & { title: string; revision: string; schedule: string; occurrences: Reminder[]; repeating: boolean };
export async function calendarTasks(notes: {name:string;content:string}[], from: string, to: string, zone: string): Promise<CalendarTask[]> {
  const start = dayStart(from,zone), end = dayStart(to,zone);
  if (end <= start || Date.parse(to) - Date.parse(from) > 62 * 86400000) throw new Error("Choose a range of at most 62 days");
  const revisions = new Map(await Promise.all(notes.map(async n => [n.name, await noteRevision(n.content)] as const)));
  return tasksFromNotes(notes).map(task => {
    const parsed = parseReminders(task.note, "- [ ] " + task.text, zone, start - 1);
    const occurrences: Reminder[] = [];
    for (const reminder of parsed) {
      if (!reminder.repeat) { occurrences.push(reminder); continue; }
      for (let at = reminder.at; at < end; at = nextOccurrence(reminder.repeat,zone,at)) occurrences.push({...reminder,at});
    }
    const schedule = parsed.length ? task.text.slice(task.text.lastIndexOf(" @") + 2).trim() : "";
    return {...task,title:parsed[0]?.text ?? task.text,revision:revisions.get(task.note)!,schedule,occurrences:occurrences.sort((a,b)=>a.at-b.at),repeating:Boolean(parsed[0]?.repeat)};
  });
}
/** Replace a task's schedule without changing its words, priority or persistent ID. */
export function editCalendarTask(content: string, line: number, input: {schedule?:string;priority?:Task["priority"];done?:boolean}, zone: string): string {
  const task = tasksFromNotes([{name:"",content}]).find(t => t.line === line);
  if (!task) throw new Error("Task no longer exists; refresh and try again");
  let updated = content;
  if (input.schedule !== undefined) {
    const parsed = parseReminders("", "- [ ] " + task.text,zone);
    const title = parsed[0]?.text ?? task.text;
    const schedule = input.schedule.trim();
    if (/[\r\n]/.test(schedule) || (schedule && !parseReminders("", "- [ ] " + title + " @" + schedule,zone).length)) throw new Error("Choose a valid date and time");
    const lines = updated.split("\n"), id = splitTaskId(lines[line]).id;
    const prefix = /^\s*[-*]\s+\[ \]\s+/.exec(lines[line])![0];
    const body = prefix + title + (schedule ? " @" + schedule : "") + (task.priority === "inbox" ? "" : " @priority:" + task.priority);
    lines[line] = id ? withTaskId(body,id) : body;
    updated = lines.join("\n");
  }
  if (input.priority !== undefined) updated = changeTaskPriority(updated,line,input.priority);
  if (input.done) {
    const lines = updated.split("\n");
    lines[line] = lines[line].replace("[ ]","[x]");
    updated = lines.join("\n");
  }
  return updated;
}
