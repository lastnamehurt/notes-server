// Give scheduled tasks a persistent ID when a note is saved, so Awareness can follow a task across
// edits even when it isn't synced with Apple Reminders. Apple sync already treats an ID it hasn't
// seen as a new Daybook task, so assigning one here changes nothing for people who use it.

import { splitTaskId, newTaskId, withTaskId } from "./task-id";
import { parseTaskLine } from "./apple-sync";
import { LOG_PREFIX } from "./log";

/** Open, scheduled task lines without an ID are the ones worth tracking. */
const needsId = (raw: string, zone: string): string | null => {
  const t = parseTaskLine(raw, zone);
  return t && !t.id && !t.checked && t.schedule !== null ? t.title : null;
};

/**
 * `after` with an ID on every open, scheduled task that lacks one, plus `before` with the same IDs
 * put on the matching ID-less lines, so a postponement made in this very save is still detected.
 * A task whose ID was dropped by a rewrite gets its old ID back when its title matches exactly one
 * task in `before`. Daily log notes are left alone.
 */
export function ensureTaskIds(before: string | null, after: string, zone: string, name = ""):
  { before: string; after: string; assigned: number } {
  const prior = before ?? "";
  if (name.startsWith(LOG_PREFIX)) return { before: prior, after, assigned: 0 };
  const beforeLines = prior.split("\n");
  const afterLines = after.split("\n");

  // Titles in `before`: the ID a task had (if its title is unique), and the ID-less lines.
  const titleCount = new Map<string, number>();
  const oldId = new Map<string, string>();
  const idless = new Map<string, number[]>();
  for (const [i, raw] of beforeLines.entries()) {
    const t = parseTaskLine(raw, zone);
    if (!t) continue;
    titleCount.set(t.title, (titleCount.get(t.title) ?? 0) + 1);
    if (t.id) { if (!t.checked) oldId.set(t.title, t.id); }
    else idless.set(t.title, [...(idless.get(t.title) ?? []), i]);
  }

  const taken = new Set<string>();
  for (const raw of [...beforeLines, ...afterLines]) { const id = splitTaskId(raw).id; if (id) taken.add(id); }
  const inAfter = new Set(afterLines.map(raw => splitTaskId(raw).id).filter((id): id is string => !!id));

  const pending = afterLines.map(raw => needsId(raw, zone));
  const pendingCount = new Map<string, number>();
  for (const title of pending) if (title !== null) pendingCount.set(title, (pendingCount.get(title) ?? 0) + 1);

  let assigned = 0;
  for (const [i, raw] of afterLines.entries()) {
    const title = pending[i];
    if (title === null) continue;
    const previous = titleCount.get(title) === 1 ? oldId.get(title) : undefined;
    const id = previous && !inAfter.has(previous) ? previous : newTaskId(taken);
    taken.add(id); inAfter.add(id);
    afterLines[i] = withTaskId(raw, id);
    assigned++;
    // The same task in `before` (only when unambiguous) gets the ID too, for deferral detection.
    const match = idless.get(title);
    if (!previous && match?.length === 1 && titleCount.get(title) === 1 && pendingCount.get(title) === 1) {
      beforeLines[match[0]] = withTaskId(beforeLines[match[0]], id);
    }
  }
  return assigned
    ? { before: beforeLines.join("\n"), after: afterLines.join("\n"), assigned }
    : { before: prior, after, assigned: 0 };
}
