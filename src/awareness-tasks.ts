// Read open tasks out of notes for Awareness: a stable key per task (its ^id, or a hash of note and
// title for a task that has none yet) and its single one-off due time. Pure apart from hashing.

import { parseTaskLine } from "./apple-sync";
import { parseReminders } from "./reminder-parse";
import { stripTaskId } from "./task-id";
import { LOG_PREFIX } from "./log";

export interface AwarenessTask { key: string; note: string; title: string; dueAt: number | null; recurring: boolean; }

/** A stable key for a task without an ID. Never contains the title itself. */
export async function untaggedTaskKey(note: string, title: string): Promise<string> {
  const bytes = new TextEncoder().encode(note + "\u0000" + title);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
  return "n" + hash.slice(0, 20);
}

/** Every open task in the notes (daily logs skipped), with its key and one-off due time if it has one. */
export async function awarenessTasks(notes: readonly { name: string; content: string }[], timeZone: string): Promise<AwarenessTask[]> {
  const out: AwarenessTask[] = [];
  for (const n of notes) {
    if (n.name.startsWith(LOG_PREFIX)) continue;
    for (const raw of n.content.split("\n")) {
      const t = parseTaskLine(raw, timeZone);
      if (!t || t.checked) continue;
      const reminders = parseReminders(n.name, stripTaskId(raw), timeZone);
      const recurring = reminders.some(r => r.repeat);
      const dueAt = !recurring && reminders.length === 1 ? reminders[0].at : null;
      out.push({ key: t.id ?? await untaggedTaskKey(n.name, t.title), note: n.name, title: t.title, dueAt, recurring });
    }
  }
  return out;
}
