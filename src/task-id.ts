// Persistent task IDs, written at the end of a task line as " ^t7k2q" (Obsidian's block-ID style).
// They survive moving lines or notes, and every task parser strips them before reading the line,
// so titles, schedules and priorities read the same with or without one.

const ID_TOKEN = /\s+\^([a-z0-9]{4,12})\s*$/;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** The line without its trailing ID, and the ID if there was one. */
export function splitTaskId(line: string): { line: string; id: string | null } {
  const m = ID_TOKEN.exec(line);
  return m ? { line: line.slice(0, m.index), id: m[1] } : { line, id: null };
}

/** The line with any trailing task ID removed. */
export const stripTaskId = (line: string): string => splitTaskId(line).line;

/** A new random ID: 6 lowercase letters or digits (about 2 billion possibilities). */
export function newTaskId(taken: ReadonlySet<string> = new Set()): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const id = Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join("");
    if (!taken.has(id)) return id;
  }
}

/** Append `id` to a task line, replacing any ID it already has. */
export const withTaskId = (line: string, id: string): string => stripTaskId(line).trimEnd() + " ^" + id;
