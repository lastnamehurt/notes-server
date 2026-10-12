/** User-defined log types remain plain #tags in the existing daily journal. */
export const LOG_TYPE_PREFIX = "journal/types/";
export function normalizeLogType(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug || slug.length > 48) throw new Error("Log type must contain 1–48 letters, digits or hyphens");
  return slug;
}
export function typePath(name: string): string { return LOG_TYPE_PREFIX + normalizeLogType(name) + ".md"; }
export function withLogType(entry: string, type: string): string {
  const slug = normalizeLogType(type);
  const clean = entry.replace(/\s*\n+\s*/g, " ").trim();
  if (!clean) throw new Error("Log entry cannot be empty");
  return clean + (new RegExp("(?:^|\\s)#" + slug + "(?:\\s|$)").test(clean) ? "" : " #" + slug);
}
export function parseLogTypes(notes: {name:string;content:string}[]): {name:string;count:number}[] {
  const declared = new Set(notes.filter(n => n.name.startsWith(LOG_TYPE_PREFIX)).map(n => n.name.slice(LOG_TYPE_PREFIX.length,-3)));
  const counts = new Map<string,number>();
  for (const n of notes.filter(n => /^journal\/log\/\d{4}-\d{2}-\d{2}\.md$/.test(n.name))) {
    for (const line of n.content.split("\n")) {
      if (!/^- \d{2}:\d{2} /.test(line)) continue;
      for (const match of line.matchAll(/(?:^|\s)#([a-z][a-z0-9-]*)\b/g)) counts.set(match[1], (counts.get(match[1]) || 0) + 1);
    }
  }
  for (const type of counts.keys()) declared.add(type);
  return [...declared].sort().map(name => ({name,count:counts.get(name)||0}));
}
