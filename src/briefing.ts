// Morning and evening briefings: a short, deterministic digest of what's due, built from the same
// task lines, reminders and done marks the rest of Daybook uses. No AI, no extra storage: the
// scheduler Durable Object sends it at the owner's chosen time (see reminders.ts), and connected AI
// assistants can read the same digest through the prepare_briefing MCP tool and narrate it.

import { parseReminders, localStamp, zonedTime, nextOccurrence, type Reminder } from "./reminder-parse";
import { tasksFromNotes } from "./priorities";
import { LOG_PREFIX, logPath } from "./log";

export const BRIEFING_KINDS = ["morning", "evening"] as const;
export type BriefingKind = typeof BRIEFING_KINDS[number];

export interface BriefingSettings {
  morning: { enabled: boolean; time: string };
  evening: { enabled: boolean; time: string };
  /** "full" lists task titles; "counts" shows only numbers, for lock screens others can see. */
  preview: "full" | "counts";
  /** Bumped on every save so two editors can't silently overwrite each other. */
  revision: number;
}

export const DEFAULT_BRIEFINGS: BriefingSettings = {
  morning: { enabled: false, time: "08:00" }, evening: { enabled: false, time: "19:00" }, preview: "full", revision: 0
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Merge a partial update into the current settings, rejecting anything invalid. Does not bump the revision. */
export function mergeBriefings(current: BriefingSettings, input: unknown): BriefingSettings {
  if (!input || typeof input !== "object") throw new Error("Send briefing settings as an object");
  const i = input as Record<string, any>;
  const out: BriefingSettings = structuredClone(current);
  for (const kind of BRIEFING_KINDS) {
    const k = i[kind];
    if (k === undefined) continue;
    if (!k || typeof k !== "object") throw new Error(`${kind} must be an object`);
    if (k.enabled !== undefined) {
      if (typeof k.enabled !== "boolean") throw new Error(`${kind}.enabled must be true or false`);
      out[kind].enabled = k.enabled;
    }
    if (k.time !== undefined) {
      if (typeof k.time !== "string" || !TIME.test(k.time)) throw new Error(`${kind}.time must be HH:MM (24-hour), like 08:00`);
      out[kind].time = k.time;
    }
  }
  if (i.preview !== undefined) {
    if (i.preview !== "full" && i.preview !== "counts") throw new Error('preview must be "full" or "counts"');
    out.preview = i.preview;
  }
  return out;
}

/** Local midnight `days` after the local date of `ms`. */
function midnight(ms: number, days: number, timeZone: string): number {
  const [y, m, d] = localStamp(ms, timeZone).date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return zonedTime(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), 0, 0, timeZone);
}

/**
 * The next time a briefing at local `time` ("HH:MM") should go out, strictly after `after`.
 * Uses the wall-clock time each day, so DST changes keep it at the same local time. In the hour
 * that clocks skip, it goes out an hour later; in the hour that repeats, it goes out once (the
 * scheduler also allows only one send per local date).
 */
export function nextBriefingAt(time: string, timeZone: string, after: number): number {
  const [h, mi] = time.split(":").map(Number);
  for (let days = 0; days < 3; days++) {
    const [y, m, d] = localStamp(midnight(after, days, timeZone) + 3 * 3600_000, timeZone).date.split("-").map(Number);
    let at = zonedTime(y, m, d, h, mi, timeZone);
    // A time in the hour clocks skip resolves an hour early; move it after the jump instead.
    if (localStamp(at, timeZone).time !== time) at += 3600_000;
    if (at > after) return at;
  }
  throw new Error("No upcoming briefing time");
}

export interface BriefingItem { text: string; note: string; at: number | null; }
export interface Briefing {
  kind: BriefingKind; date: string; title: string; message: string;
  /** Nothing to report: the scheduler skips sending rather than buzz with an empty digest. */
  empty: boolean;
  overdue: BriefingItem[]; today: BriefingItem[]; doNow: BriefingItem[]; doneToday: string[]; tomorrow: BriefingItem[];
  /** Awareness suggestions counted in (morning, digest mode). */
  suggestions: number;
}

/** Occurrences of one reminder in [from, to). */
function occurrences(r: Reminder, from: number, to: number, timeZone: string): number[] {
  if (!r.repeat) return r.at >= from && r.at < to ? [r.at] : [];
  const out: number[] = [];
  for (let at = nextOccurrence(r.repeat, timeZone, from - 1); at < to; at = nextOccurrence(r.repeat, timeZone, at)) out.push(at);
  return out;
}

const MAX_ITEMS = 4;
const MAX_TITLE = 60;
/** Pushover's limit is 1,024 characters; stay under it with room for the link. */
const MAX_MESSAGE = 900;

export function clock(ms: number, timeZone: string): string {
  const [h, mi] = localStamp(ms, timeZone).time.split(":").map(Number);
  return (h % 12 || 12) + (mi ? ":" + String(mi).padStart(2, "0") : "") + (h < 12 ? "am" : "pm");
}

const clean = (s: string) => {
  const one = s.replace(/[\r\n]+/g, " ").trim();
  return one.length > MAX_TITLE ? one.slice(0, MAX_TITLE - 1).trimEnd() + "…" : one;
};

function listLine(label: string, items: string[]): string | null {
  if (!items.length) return null;
  const shown = items.slice(0, MAX_ITEMS).join(" · ");
  return `${label} (${items.length}): ${shown}${items.length > MAX_ITEMS ? ` · +${items.length - MAX_ITEMS} more` : ""}`;
}

export interface BriefingInput {
  kind: BriefingKind;
  notes: { name: string; content: string }[];
  /** Occurrences marked done (from the scheduler), so a finished meds dose doesn't show as open. */
  done: { note: string; text: string; at: number }[];
  now: number; timeZone: string; preview: BriefingSettings["preview"];
  /** The owner's name, for "Good morning, Courtney". */
  name?: string;
  /** Awareness suggestions waiting in digest mode (morning only). Counted, never named. */
  suggestions?: number;
  /** Tap-to-pay totals (evening only), when the payment signal is on. `hidden` keeps amounts off the lock screen. */
  spend?: { today: number; count: number; week: number; hidden: boolean } | null;
}

export function buildBriefing({ kind, notes, done, now, timeZone, preview, name, suggestions = 0, spend = null }: BriefingInput): Briefing {
  const who = name?.trim() ? ", " + name.trim() : "";
  const date = localStamp(now, timeZone).date;
  const today = midnight(now, 0, timeZone), tomorrow = midnight(now, 1, timeZone), dayAfter = midnight(now, 2, timeZone);
  const isDone = new Set(done.map(d => d.note + "\u0000" + d.text + "\u0000" + d.at));
  const open = (note: string, text: string, at: number) => !isDone.has(note + "\u0000" + text + "\u0000" + at);
  const taskNotes = notes.filter(n => !n.name.startsWith(LOG_PREFIX));

  const overdue: BriefingItem[] = [], dueToday: BriefingItem[] = [], dueTomorrow: BriefingItem[] = [];
  for (const n of taskNotes) for (const r of parseReminders(n.name, n.content, timeZone, now)) {
    if (!r.repeat && r.at < today && open(n.name, r.text, r.at)) overdue.push({ text: r.text, note: n.name, at: r.at });
    for (const at of occurrences(r, today, tomorrow, timeZone)) if (open(n.name, r.text, at)) dueToday.push({ text: r.text, note: n.name, at });
    for (const at of occurrences(r, tomorrow, dayAfter, timeZone)) dueTomorrow.push({ text: r.text, note: n.name, at });
  }
  const byTime = (a: BriefingItem, b: BriefingItem) => (a.at ?? 0) - (b.at ?? 0);
  overdue.sort(byTime); dueToday.sort(byTime); dueTomorrow.sort(byTime);
  const listed = new Set([...overdue, ...dueToday].map(i => i.note + "\u0000" + i.text));
  // A priority task's text still carries its schedule; read it the way reminders do so it matches and reads cleanly.
  const plainText = (note: string, text: string) => parseReminders(note, "- [ ] " + text, timeZone, now)[0]?.text ?? text;
  const doNow = tasksFromNotes(taskNotes).filter(t => t.priority === "do")
    .map(t => ({ text: plainText(t.note, t.text), note: t.note, at: null }))
    .filter(t => !listed.has(t.note + "\u0000" + t.text));
  const log = notes.find(n => n.name === logPath(date))?.content ?? "";
  const doneToday = log.split("\n").map(l => /^- \d{2}:\d{2} ✓\s*(.+?)(?:\s+#done)?\s*$/.exec(l)?.[1]).filter((s): s is string => Boolean(s));

  // Evening: what's left today means what hasn't been done yet, including tonight's.
  const label = (i: BriefingItem) => (i.at !== null ? clock(i.at, timeZone) + " " : "") + clean(i.text);
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(new Date(now));
  let lines: (string | null)[], counts: string[], title: string, empty: boolean;
  if (kind === "morning") {
    title = "Good morning" + who + " · " + day;
    empty = !overdue.length && !dueToday.length && !doNow.length && !suggestions;
    const suggested = suggestions ? `${suggestions} new suggestion${suggestions === 1 ? "" : "s"}` : null;
    lines = [listLine("Overdue", overdue.map(i => clean(i.text))), listLine("Today", dueToday.map(label)), listLine("Do now", doNow.map(i => clean(i.text))),
      suggested && `Daybook noticed something: ${suggested} in Suggestions`];
    counts = [overdue.length && `${overdue.length} overdue`, dueToday.length && `${dueToday.length} due today`, doNow.length && `${doNow.length} do now`, suggested].filter(Boolean) as string[];
  } else {
    title = (who ? "Evening" + who : "Evening wrap-up") + " · " + day;
    empty = !doneToday.length && !dueToday.length && !overdue.length && !dueTomorrow.length && !spend?.count;
    const usd = (n: number) => "$" + n.toFixed(2);
    const spent = spend && spend.count ? (spend.hidden ? `Spent today: ${spend.count} payment${spend.count === 1 ? "" : "s"}`
      : `Spent today: ${usd(spend.today)} across ${spend.count} · week ${usd(spend.week)}`) : null;
    lines = [doneToday.length ? `Done today: ${doneToday.length}` : null, listLine("Still open", dueToday.map(label)),
      listLine("Overdue", overdue.map(i => clean(i.text))), listLine("Tomorrow", dueTomorrow.map(label)), spent];
    counts = [doneToday.length && `${doneToday.length} done`, dueToday.length && `${dueToday.length} still open`,
      overdue.length && `${overdue.length} overdue`, dueTomorrow.length && `${dueTomorrow.length} tomorrow`,
      spend?.count && `${spend.count} payment${spend.count === 1 ? "" : "s"}`].filter(Boolean) as string[];
  }
  let message = empty ? (kind === "morning" ? "Nothing due today." : "Nothing to wrap up today.")
    : preview === "counts" ? counts.join(" · ") : lines.filter(Boolean).join("\n");
  if (message.length > MAX_MESSAGE) message = message.slice(0, MAX_MESSAGE - 1).trimEnd() + "…";
  return { kind, date, title, message, empty, overdue, today: dueToday, doNow, doneToday, tomorrow: dueTomorrow, suggestions: kind === "morning" ? suggestions : 0 };
}
