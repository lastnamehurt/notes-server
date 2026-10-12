/** Repeat rule: local weekdays (0 = Sunday) at a local minute-of-day. */
export interface Repeat { days: number[]; minute: number; }
export interface Reminder { note: string; text: string; at: number; repeat?: Repeat; }

export interface ReminderEnv {
  NOTES_TIMEZONE?: string;
  NTFY_TOPIC?: string;
  NTFY_SERVER?: string;
  NTFY_TOKEN?: string;
  PUSHOVER_TOKEN?: string;
  PUSHOVER_USER?: string;
  PUBLIC_URL?: string;
  MCP_BEARER_TOKEN?: string;
  /** Same secret as MCP_BEARER_TOKEN, under the name the Deploy to Cloudflare form uses. */
  PASSWORD?: string;
}

export const DEFAULT_TIMEZONE = "America/Los_Angeles";

/** True when some push provider (Pushover or ntfy) is configured. */
export const pushConfigured = (env: ReminderEnv) => Boolean((env.PUSHOVER_TOKEN && env.PUSHOVER_USER) || env.NTFY_TOPIC);

/** Accept "topic", " topic\n", "ntfy.sh/topic" or "https://ntfy.sh/topic/" and return just the topic. */
export function normalizeTopic(raw: string): string {
  const parts = raw.trim().replace(/\/+$/, "").split("/");
  return parts[parts.length - 1];
}
const DEFAULT_MINUTE = 9 * 60;
const FULL_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const PRESETS: Record<string, number[]> = {
  daily: [0, 1, 2, 3, 4, 5, 6], everyday: [0, 1, 2, 3, 4, 5, 6],
  weekdays: [1, 2, 3, 4, 5], weekends: [0, 6]
};

// "- [ ] <text> @<when> [<time>[, <time>...]]". Greedy text so the last " @" is the schedule.
const LINE = /^\s*[-*]\s+\[ \]\s+(.+)\s+@([a-z0-9,-]+)(?:\s+(.+?))?\s*$/i;

/** Wall-clock parts of instant `ms` in `timeZone`. */
function localParts(ms: number, timeZone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** Milliseconds to add to UTC to get wall-clock time in `timeZone` at instant `ms`. */
function zoneOffset(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** Convert a wall-clock time in `timeZone` to a UTC epoch (handles DST). */
export function zonedTime(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - zoneOffset(guess, timeZone);
  return guess - zoneOffset(first, timeZone);
}

/** YYYY-MM-DD and HH:MM for an instant in `timeZone`. */
export function localStamp(ms: number, timeZone = DEFAULT_TIMEZONE): { date: string; time: string } {
  const p = localParts(ms, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { date: `${p.y}-${pad(p.mo)}-${pad(p.d)}`, time: `${pad(p.h)}:${pad(p.mi)}` };
}

/** First occurrence of `repeat` strictly after `after`. */
export function nextOccurrence(repeat: Repeat, timeZone: string, after = Date.now()): number {
  const today = localParts(after, timeZone);
  for (let i = 0; i <= 8; i++) {
    const day = new Date(Date.UTC(today.y, today.mo - 1, today.d + i));
    if (!repeat.days.includes(day.getUTCDay())) continue;
    const t = zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(),
      Math.floor(repeat.minute / 60), repeat.minute % 60, timeZone);
    if (t > after) return t;
  }
  throw new Error("No upcoming occurrence");
}

/** "9am", "5:30pm", "17:30", "12am" → minute of day, or null if invalid. */
export function parseTime(s: string): number | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(s.trim());
  if (!m) return null;
  let h = +m[1];
  const mi = m[2] === undefined ? 0 : +m[2];
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
  }
  return h > 23 || mi > 59 ? null : h * 60 + mi;
}

/** "daily" / "weekdays" / "mon,wed,fri" → weekday numbers, or null. */
function parseDays(spec: string): number[] | null {
  const s = spec.toLowerCase();
  if (PRESETS[s]) return PRESETS[s];
  const days: number[] = [];
  for (const token of s.split(",")) {
    // "mon", "tues", "thursday": a prefix (3+ letters) of a full day name
    const d = FULL_DAYS.findIndex(name => token.length >= 3 && name.startsWith(token));
    if (d < 0) return null;
    days.push(d);
  }
  return [...new Set(days)].sort((a, b) => a - b);
}

/**
 * Unchecked task lines with a schedule. Checked ([x]) lines are inactive.
 *   - [ ] Renew registration @2026-10-14 9am     one-off (time optional, default 9am)
 *   - [ ] Take meds @daily 8am, 8pm              repeating: daily, weekdays, weekends, mon,wed,fri
 */
export function parseReminders(note: string, content: string, timeZone = DEFAULT_TIMEZONE, now = Date.now()): Reminder[] {
  const out: Reminder[] = [];
  for (const line of content.split("\n")) {
    // Priority is task metadata, not part of the schedule or reminder title.
    const cleanLine = line.replace(/(?:^|\s)@priority:(?:do|plan|delegate|someday)\b/gi, "");
    const m = LINE.exec(cleanLine);
    if (!m) continue;
    const [, rawText, spec, rawTimes] = m;
    const text = rawText.trim();
    const minutes = rawTimes === undefined ? [DEFAULT_MINUTE] : rawTimes.split(",").map(parseTime);
    if (minutes.some(x => x === null)) continue;
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(spec);
    if (date) {
      const [y, mo, d] = [+date[1], +date[2], +date[3]];
      if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      for (const min of minutes as number[])
        out.push({ note, text, at: zonedTime(y, mo, d, Math.floor(min / 60), min % 60, timeZone) });
      continue;
    }
    const days = parseDays(spec);
    if (!days) continue;
    for (const min of minutes as number[]) {
      const repeat = { days, minute: min };
      out.push({ note, text, repeat, at: nextOccurrence(repeat, timeZone, now) });
    }
  }
  return out;
}
