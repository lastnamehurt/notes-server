import type { GithubNotes } from "./github";
import { localStamp, DEFAULT_TIMEZONE } from "./reminder-parse";

// One note per day: journal/log/YYYY-MM-DD.md, lines "- HH:MM entry #tag", kept in time order.
export const LOG_PREFIX = "journal/log/";
export const logPath = (date: string) => LOG_PREFIX + date + ".md";

/** Insert `line` (starting "- HH:MM") into a day's log content, keeping lines sorted by time. */
export function insertLogLine(existing: string | null, date: string, line: string): string {
  if (existing === null) return `# Log ${date}\n\n${line}\n`;
  const lines = existing.trimEnd().split("\n");
  const time = line.slice(2, 7);
  let at = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const m = /^- (\d{2}:\d{2}) /.exec(lines[i]);
    if (m && m[1] > time) { at = i; break; }
  }
  lines.splice(at, 0, line);
  return lines.join("\n") + "\n";
}


/**
 * Daily journal is a readable projection of the canonical timestamped log.
 * Generated content is bounded by markers so user-authored reflections survive
 * subsequent log edits and deletes.
 */
export const journalPath = (date: string) => "journal/daily/" + date + ".md";
const JOURNAL_START = "<!-- daybook:activity:start -->";
const JOURNAL_END = "<!-- daybook:activity:end -->";

export function journalWithActivity(existing: string | null, date: string, logContent: string): string {
  const activity = logContent.split("\n").filter(line => /^- \d{2}:\d{2} /.test(line));
  const section = JOURNAL_START + "\n## Activity\n" +
    (activity.length ? activity.join("\n") + "\n" : "_No activity recorded._\n") +
    JOURNAL_END;
  if (existing === null) return "# " + date + "\n\n" + section + "\n";
  const start = existing.indexOf(JOURNAL_START);
  const end = existing.indexOf(JOURNAL_END);
  if (start >= 0 && end > start) {
    return existing.slice(0, start) + section + existing.slice(end + JOURNAL_END.length);
  }
  return existing.trimEnd() + "\n\n" + section + "\n";
}

/** Rebuild journal activity from the canonical log; safe to retry after partial failure. */
export async function syncDailyJournal(notes: GithubNotes, date: string): Promise<void> {
  const source = await notes.get(logPath(date));
  const path = journalPath(date);
  for (let attempt = 0; attempt < 3; attempt++) {
    let existing: { content: string; sha: string } | null = null;
    try { existing = await notes.get(path); }
    catch (e) { if (!(e instanceof Error && e.message.startsWith("Note or notes repository not found"))) throw e; }
    const next = journalWithActivity(existing?.content ?? null, date, source.content);
    if (existing?.content === next) return;
    try { await notes.put(path, next, existing?.sha); return; }
    catch (e) {
      if (!(e instanceof Error && e.message.startsWith("GitHub conflict")) || attempt === 2) throw e;
    }
  }
}

export interface LogOptions { date?: string; time?: string; timeZone?: string; now?: number; }

export async function appendLog(notes: GithubNotes, entry: string, opts: LogOptions = {}): Promise<{ name: string; line: string }> {
  const clean = entry.replace(/\s*\n+\s*/g, " ").trim();
  if (!clean) throw new Error("Log entry cannot be empty");
  if (opts.date && !/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) throw new Error("date must be YYYY-MM-DD");
  if (opts.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(opts.time)) throw new Error("time must be HH:MM (24-hour)");
  const stamp = localStamp(opts.now ?? Date.now(), opts.timeZone || DEFAULT_TIMEZONE);
  const date = opts.date ?? stamp.date;
  const line = `- ${opts.time ?? stamp.time} ${clean}`;
  const name = logPath(date);
  for (let attempt = 0; attempt < 3; attempt++) {
    let existing: { content: string; sha: string } | null = null;
    try { existing = await notes.get(name); }
    catch (e) { if (!(e instanceof Error && e.message.startsWith("Note or notes repository not found"))) throw e; }
    try {
      await notes.put(name, insertLogLine(existing?.content ?? null, date, line), existing?.sha);
      await syncDailyJournal(notes, date);
      return { name, line };
    } catch (e) {
      // Concurrent append (e.g. Done button and chat at once): re-read and retry.
      if (!(e instanceof Error && e.message.startsWith("GitHub conflict")) || attempt === 2) throw e;
    }
  }
  throw new Error("unreachable");
}

/** Daily logs from the last `days` calendar days (including today), newest first. */
export async function recentLogs(notes: GithubNotes, days: number, timeZone = DEFAULT_TIMEZONE, now = Date.now()): Promise<{ date: string; content: string }[]> {
  const span = Math.max(1, Math.min(Math.floor(days), 90));
  const cutoff = logPath(localStamp(now - (span - 1) * 86_400_000, timeZone).date);
  return (await notes.all(undefined, LOG_PREFIX)).filter(n => n.name >= cutoff)
    .map(n => ({ date: n.name.slice(LOG_PREFIX.length, -3), content: n.content }));
}

export interface LogEdit { date: string; original: string; entry?: string; time?: string; remove?: boolean; }

/** Change or delete one line (matched exactly) in a day's log, keeping time order. */
export async function editLog(notes: GithubNotes, edit: LogEdit): Promise<{ name: string; line: string | null }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(edit.date)) throw new Error("date must be YYYY-MM-DD");
  const name = logPath(edit.date);
  const { content, sha } = await notes.get(name);
  const lines = content.trimEnd().split("\n");
  const at = lines.indexOf(edit.original);
  if (at < 0) throw new Error("That entry changed since you opened it. Refresh and try again.");
  lines.splice(at, 1);
  let next = lines.join("\n") + "\n";
  let line: string | null = null;
  if (!edit.remove) {
    const clean = (edit.entry ?? "").replace(/\s*\n+\s*/g, " ").trim();
    if (!clean) throw new Error("Log entry cannot be empty");
    if (!edit.time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(edit.time)) throw new Error("time must be HH:MM (24-hour)");
    line = `- ${edit.time} ${clean}`;
    next = insertLogLine(next, edit.date, line);
  }
  await notes.put(name, next, sha);
  await syncDailyJournal(notes, edit.date);
  return { name, line };
}
