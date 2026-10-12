import { validPath, validateContent } from "./github";

export interface NotesBackup {
  format: "notes-server-backup";
  version: 1;
  exportedAt: string;
  notes: { name: string; content: string }[];
}
export function makeBackup(notes: {name:string;content:string}[]): NotesBackup {
  return { format: "notes-server-backup", version: 1, exportedAt: new Date().toISOString(),
    notes: notes.map(({name,content}) => ({name,content})) };
}
export function parseBackup(value: unknown): NotesBackup {
  if (!value || typeof value !== "object") throw new Error("Invalid backup");
  const b = value as Partial<NotesBackup>;
  if (b.format !== "notes-server-backup" || b.version !== 1 || !Array.isArray(b.notes) || b.notes.length > 10000)
    throw new Error("Unsupported backup format or size");
  const seen = new Set<string>();
  for (const note of b.notes) {
    if (!note || typeof note.name !== "string" || !validPath(note.name) ||
        typeof note.content !== "string" || note.content.length > 1024 * 1024 || seen.has(note.name))
      throw new Error("Invalid or duplicate backup note");
    validateContent(note.content);
    seen.add(note.name);
  }
  return b as NotesBackup;
}
export async function restoreMissing(
  backup: NotesBackup,
  existing: Set<string>,
  write: (name:string, content:string)=>Promise<unknown>
): Promise<number> {
  for (const n of backup.notes) if (existing.has(n.name)) throw new Error("Restore refused: existing note " + n.name);
  for (const n of backup.notes) await write(n.name,n.content);
  return backup.notes.length;
}
