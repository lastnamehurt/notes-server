// Two-way sync between Daybook tasks and one Apple Reminders list, driven by an iPhone Shortcut.
// This file is pure: parsing, the three-way merge and line edits, with no network or storage.
// apple-sync-run.ts reads the notes, calls planSync() and applies the result.
//
// The Shortcut posts a snapshot of the list; the Worker compares each task three ways (Daybook
// now, Apple now, and the base both sides agreed on after the last run) and returns actions.
// See docs/apple-reminders-two-way-sync.md.

import { splitTaskId, newTaskId } from "./task-id";
import { parseReminders, localStamp, zonedTime, nextOccurrence } from "./reminder-parse";
import type { Priority } from "./priorities";

export type ApplePriority = "high" | "medium" | "low" | "none";
export const SYNC_FIELDS = ["title", "due", "completed", "priority"] as const;
export type SyncField = typeof SYNC_FIELDS[number];

/** What both sides can express. `due` is local wall-clock time: "YYYY-MM-DD" (all-day) or "YYYY-MM-DDTHH:MM". */
export interface SyncState { title: string; due: string | null; completed: boolean; priority: ApplePriority; }
/** The last state both sides agreed on, per task ID. `detached`: deleted in Apple Reminders, kept in Daybook. */
export interface BaseEntry extends SyncState { note: string; detached?: boolean; }
export type Base = Record<string, BaseEntry>;

/* ---------- Daybook task lines ---------- */

const TASK_LINE = /^(\s*[-*]\s+\[)( |x|X)(\]\s+)(.+)$/;
const PRIORITY_TAG = /(?:^|\s)@priority:(do|plan|delegate|someday)\b/i;
const SCHEDULED = /^(.+)\s+(@[a-z0-9,-]+(?:\s+.+?)?)\s*$/i;

export interface TaskLine {
  /** Indent, bullet and "[". */ open: string;
  checked: boolean;
  /** "] " and whatever spacing follows. */ close: string;
  title: string;
  /** The schedule exactly as written, e.g. "@2026-10-15 9am" or "@daily 8am, 8pm". */ schedule: string | null;
  priority: Priority | "inbox";
  id: string | null;
}

/** Parse a task line ("- [ ]" or "- [x]") into parts, reading schedules exactly as the reminder parser does. */
export function parseTaskLine(raw: string, timeZone: string): TaskLine | null {
  const { line, id } = splitTaskId(raw);
  const m = TASK_LINE.exec(line);
  if (!m) return null;
  let body = m[4];
  const p = PRIORITY_TAG.exec(body);
  if (p) body = body.slice(0, p.index) + body.slice(p.index + p[0].length);
  let title = body.trim(), schedule: string | null = null;
  const s = SCHEDULED.exec(body);
  if (s && parseReminders("check", "- [ ] " + body, timeZone, 0).length) { title = s[1].trim(); schedule = s[2].trim(); }
  if (!title) return null;
  return { open: m[1], checked: m[2] !== " ", close: m[3], title, schedule,
    priority: p ? p[1].toLowerCase() as Priority : "inbox", id };
}

export function formatTaskLine(t: TaskLine): string {
  return t.open + (t.checked ? "x" : " ") + t.close + t.title
    + (t.schedule ? " " + t.schedule : "")
    + (t.priority !== "inbox" ? " @priority:" + t.priority : "")
    + (t.id ? " ^" + t.id : "");
}

const TO_APPLE: Record<Priority | "inbox", ApplePriority> = { do: "high", plan: "medium", delegate: "low", someday: "low", inbox: "none" };

/** Daybook priority for an Apple priority; "low" keeps delegate or someday if the task already had one. */
export function fromApplePriority(p: ApplePriority, current: Priority | "inbox"): Priority | "inbox" {
  if (p === "high") return "do";
  if (p === "medium") return "plan";
  if (p === "low") return current === "delegate" || current === "someday" ? current : "someday";
  return "inbox";
}

/** "2026-10-15" → "@2026-10-15"; "2026-10-15T17:30" → "@2026-10-15 5:30pm". */
export function scheduleFor(due: string): string {
  const [date, time] = due.split("T");
  if (!time) return "@" + date;
  const [h, mi] = time.split(":").map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return "@" + date + " " + hour + (mi ? ":" + String(mi).padStart(2, "0") : "") + (h < 12 ? "am" : "pm");
}

/** Occurrences already marked done, keyed like the scheduler: note, text, time. */
export type DoneSet = ReadonlySet<string>;
export const doneKey = (note: string, text: string, at: number) => note + "\u0000" + text + "\u0000" + at;

export interface DaybookItem {
  id: string; note: string; state: SyncState; priority: Priority | "inbox";
  /** Worth creating in Apple Reminders: open, with a schedule or a priority. */ inScope: boolean;
  repeating: boolean;
  /** Repeating tasks: the epoch of the occurrence `state.due` stands for, and the one after it. */
  at: number | null; followingDue: string | null;
}

const wallClock = (ms: number, timeZone: string) => { const s = localStamp(ms, timeZone); return s.date + "T" + s.time; };

/**
 * Sync state for a task line. One-offs keep the date (and first time) they were written with.
 * Repeating tasks stand for their next occurrence that isn't done; one that went off in the last
 * day and wasn't done stays current, so it shows as overdue in Apple Reminders.
 */
export function daybookItem(note: string, t: TaskLine & { id: string }, timeZone: string, now: number, done: DoneSet): DaybookItem {
  const state: SyncState = { title: t.title, due: null, completed: t.checked, priority: TO_APPLE[t.priority] };
  const item: DaybookItem = { id: t.id, note, state, priority: t.priority, inScope: !t.checked && (t.schedule !== null || t.priority !== "inbox"),
    repeating: false, at: null, followingDue: null };
  if (!t.schedule) return item;
  const rs = parseReminders(note, "- [ ] " + t.title + " " + t.schedule, timeZone, now);
  if (!rs.length) return item;
  if (!rs[0].repeat) {
    const date = t.schedule.slice(1, 11);
    const timed = /^@\d{4}-\d{2}-\d{2}\s+\S/.test(t.schedule);
    state.due = timed ? wallClock(Math.min(...rs.map(r => r.at)), timeZone) : date;
    item.at = Math.min(...rs.map(r => r.at));
    return item;
  }
  item.repeating = true;
  const times: number[] = [];
  for (const r of rs) {
    let at = nextOccurrence(r.repeat!, timeZone, now - 86_400_000);
    for (let i = 0; i < 20 && at < now + 9 * 86_400_000; i++) { times.push(at); at = nextOccurrence(r.repeat!, timeZone, at); }
  }
  const all = [...new Set(times)].sort((a, b) => a - b);
  const isDone = (at: number) => done.has(doneKey(note, t.title, at));
  // Only the latest occurrence that already went off can stay current (overdue); older missed ones roll off.
  const latestPast = all.filter(at => at <= now).pop();
  const open = [...(latestPast !== undefined && !isDone(latestPast) ? [latestPast] : []), ...all.filter(at => at > now && !isDone(at))];
  if (open[0] !== undefined) { item.at = open[0]; state.due = wallClock(open[0], timeZone); }
  if (open[1] !== undefined) item.followingDue = wallClock(open[1], timeZone);
  return item;
}

/** Rewrite one task line with changed sync fields, keeping everything else (bullet, indent, repeat schedule, ID). */
export function editTaskLine(raw: string, set: Partial<SyncState>, timeZone: string): string {
  const t = parseTaskLine(raw, timeZone);
  if (!t) return raw;
  if (set.title !== undefined && set.title.trim()) t.title = set.title.trim();
  if (set.due !== undefined) t.schedule = set.due ? scheduleFor(set.due) : null;
  if (set.completed !== undefined) t.checked = set.completed;
  if (set.priority !== undefined) t.priority = fromApplePriority(set.priority, t.priority);
  return formatTaskLine(t);
}

/** A new task line for something first created in Apple Reminders. */
export function newTaskLine(id: string, s: SyncState): string {
  return formatTaskLine({ open: "- [", checked: s.completed, close: "] ", title: s.title,
    schedule: s.due ? scheduleFor(s.due) : null, priority: fromApplePriority(s.priority, "inbox"), id });
}

/* ---------- Apple snapshot ---------- */

/** A reminder from the Shortcut. A field it couldn't read is undefined and counts as unchanged. */
export interface AppleReminder {
  index: number; taskId: string | null;
  title: string; due: string | null | undefined; completed: boolean; priority: ApplePriority | undefined;
}

const truthy = (v: unknown) => v === true || v === 1 || (typeof v === "string" && /^(true|yes|1)$/i.test(v.trim()));

function applePriority(v: unknown): ApplePriority | undefined {
  if (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v.trim()))) {
    const n = Number(v); // EventKit: 0 none, 1-4 high, 5 medium, 6-9 low
    return n === 0 ? "none" : n <= 4 ? "high" : n === 5 ? "medium" : n <= 9 ? "low" : undefined;
  }
  if (typeof v !== "string") return v === null ? "none" : undefined;
  const s = v.trim().toLowerCase();
  if (!s || s === "none" || s === "no priority") return "none";
  return (["high", "medium", "low"] as const).find(p => p === s);
}

/**
 * Normalize what the Shortcut sent. Dates arrive as ISO 8601 text; an all-day reminder is a date with no
 * time, `allDay: true`, or (when the Shortcut can't tell) a due time of exactly midnight local time.
 */
export function normalizeReminder(raw: Record<string, unknown>, index: number, timeZone: string): AppleReminder {
  const str = (v: unknown) => typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
  const marker = /(?:#task\/|daybook:)([a-z0-9]{4,12})\b/;
  const taskId = (/^[a-z0-9]{4,12}$/.test(str(raw.taskId)) ? str(raw.taskId) : null)
    ?? marker.exec(str(raw.url))?.[1] ?? marker.exec(str(raw.notes))?.[1] ?? null;
  let due: string | null | undefined;
  const d = str(raw.due).trim();
  if (!d) due = raw.due === undefined ? undefined : null;
  else if (/^\d{4}-\d{2}-\d{2}$/.test(d)) due = d;
  else {
    const ms = Date.parse(d);
    if (Number.isNaN(ms)) due = undefined;
    else {
      const s = localStamp(ms, timeZone);
      const allDay = raw.allDay === undefined || raw.allDay === "" ? s.time === "00:00" : truthy(raw.allDay);
      due = allDay ? s.date : s.date + "T" + s.time;
    }
  }
  return { index, taskId, title: str(raw.title).replace(/\s+/g, " ").trim(), due, completed: truthy(raw.completed), priority: applePriority(raw.priority) };
}

/* ---------- The merge ---------- */

export interface AppleDue { due: string | null; allDay: boolean; }
export type Action =
  | ({ op: "create"; taskId: string; url: string; title: string; priority: ApplePriority; completed: boolean } & AppleDue)
  | ({ op: "update"; index: number; taskId: string; title: string; priority: ApplePriority; completed: boolean } & AppleDue)
  | { op: "delete"; index: number; taskId: string }
  | { op: "tag"; index: number; taskId: string; url: string };

export interface Completion { id: string; note: string; title: string; at: number | null; }
export interface Plan {
  actions: Action[];
  /** Field changes to write into existing task lines, by task ID. */ edits: { id: string; note: string; set: Partial<SyncState> }[];
  /** Tasks first created in Apple Reminders, to add to the inbox note. */ added: { id: string; state: SyncState }[];
  /** Completed in Apple Reminders: logged as done, and the occurrence stops notifying. */ completions: Completion[];
  /** Conflicts and removals, written to the day's log. */ logs: string[];
  base: Base;
}

export interface PlanInput {
  daybook: DaybookItem[]; apple: AppleReminder[]; base: Base;
  timeZone: string; inboxNote: string; url: (id: string) => string;
  /** IDs in Daybook notes that aren't synced (checked and never synced, out of scope). Avoided for new IDs. */ takenIds?: Iterable<string>;
}

/** "2026-10-15T09:00" → { due: "2026-10-15T09:00:00-07:00", allDay: false }, with that date's offset. */
export function appleDue(due: string | null, timeZone: string): AppleDue {
  if (!due) return { due: null, allDay: false };
  const [date, time] = due.split("T");
  if (!time) return { due: date, allDay: true };
  const [y, mo, d] = date.split("-").map(Number), [h, mi] = time.split(":").map(Number);
  const offset = Math.round((Date.UTC(y, mo - 1, d, h, mi) - zonedTime(y, mo, d, h, mi, timeZone)) / 60000);
  const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
  return { due: `${date}T${time}:00${offset < 0 ? "-" : "+"}${pad(Math.abs(offset) / 60)}:${pad(Math.abs(offset) % 60)}`, allDay: false };
}

/**
 * Field equality. A date-only due and the same date at 9am count as equal: Daybook reminds at 9am for a
 * date with no time, and some iOS versions can only store a reminder's date with a time.
 */
export function same(f: SyncField, x: unknown, y: unknown): boolean {
  if (x === y) return true;
  if (f !== "due" || typeof x !== "string" || typeof y !== "string") return false;
  return x + "T09:00" === y || y + "T09:00" === x;
}

const quoted = (v: unknown) => v === null ? "none" : typeof v === "boolean" ? (v ? "done" : "open") : JSON.stringify(v);

export function planSync(input: PlanInput): Plan {
  const { timeZone } = input;
  const plan: Plan = { actions: [], edits: [], added: [], completions: [], logs: [], base: {} };
  const byId = new Map(input.daybook.map(d => [d.id, d]));
  const appleById = new Map<string, AppleReminder>();
  const fresh: AppleReminder[] = [];
  for (const a of input.apple) {
    if (!a.taskId) fresh.push(a);
    else if (!appleById.has(a.taskId)) appleById.set(a.taskId, a); // a duplicated reminder: the first one wins
  }
  const ids = new Set([...byId.keys(), ...appleById.keys(), ...Object.keys(input.base)]);
  const taken = new Set([...ids, ...(input.takenIds ?? [])]);
  const toApple = (op: "create" | "update", id: string, s: SyncState, index?: number): Action => op === "create"
    ? { op, taskId: id, url: input.url(id), title: s.title, priority: s.priority, completed: s.completed, ...appleDue(s.due, timeZone) }
    : { op, index: index!, taskId: id, title: s.title, priority: s.priority, completed: s.completed, ...appleDue(s.due, timeZone) };

  for (const id of ids) {
    const d = byId.get(id), a = appleById.get(id), b = input.base[id];

    if (!d) {
      // Gone from Daybook: remove it from Apple Reminders too. Nothing to keep in the base.
      if (a) plan.actions.push({ op: "delete", index: a.index, taskId: id });
      continue;
    }

    if (!a) {
      if (b && !b.detached) {
        // Deleted in Apple Reminders. Never delete the Daybook task: stop syncing it, unless it was
        // already done on both sides (clearing completed reminders is routine and needs no note).
        if (!(b.completed && d.state.completed)) {
          plan.logs.push(`"${d.state.title}" was removed from Apple Reminders; it stays in Daybook and stops syncing until you change it here #removed-in-reminders`);
          plan.base[id] = { ...d.state, note: d.note, detached: true };
        }
        continue;
      }
      const changedSinceDetach = b?.detached && SYNC_FIELDS.some(f => !same(f, d.state[f], b[f]));
      if (b?.detached && !changedSinceDetach) { plan.base[id] = { ...b, note: d.note }; continue; }
      if (d.inScope || changedSinceDetach) {
        plan.actions.push(toApple("create", id, d.state));
        plan.base[id] = { ...d.state, note: d.note };
      }
      continue;
    }

    // On both sides: three-way merge per field.
    let ds = d.state;
    let as: AppleReminder = a;
    if (d.repeating && a.completed && !ds.completed && (!b || !b.completed)) {
      // An occurrence of a repeating task was done in Apple Reminders: record it, then move the
      // reminder on to the next occurrence and reopen it.
      plan.completions.push({ id, note: d.note, title: ds.title, at: d.at });
      ds = { ...ds, due: d.followingDue };
      as = { ...a, completed: false };
    }
    const final = { ...ds };
    const daybookSet: Partial<SyncState> = {};
    for (const f of SYNC_FIELDS) {
      const dv = ds[f];
      const av = as[f] === undefined ? (b ? b[f] : dv) : as[f];
      let appleChanged = !same(f, av, b ? b[f] : dv);
      if (f === "title" && av === "") appleChanged = false;
      if (f === "due" && d.repeating) appleChanged = false; // the repeat rule lives in Daybook
      const daybookChanged = b ? !same(f, dv, b[f]) : true;
      if (appleChanged && !daybookChanged) { (final as any)[f] = av; (daybookSet as any)[f] = av; }
      else if (appleChanged && daybookChanged && !same(f, av, dv))
        plan.logs.push(`Sync conflict on "${ds.title}" (${f}): kept ${quoted(dv)} from Daybook; Apple Reminders had ${quoted(av)} #sync-conflict`);
    }
    if (Object.keys(daybookSet).length) {
      plan.edits.push({ id, note: d.note, set: daybookSet });
      if (daybookSet.completed === true) plan.completions.push({ id, note: d.note, title: ds.title, at: d.at });
    }
    const appleNow = { title: a.title || final.title, due: a.due === undefined ? final.due : a.due,
      completed: a.completed, priority: a.priority ?? final.priority };
    if (SYNC_FIELDS.some(f => !same(f, appleNow[f], final[f]))) plan.actions.push(toApple("update", id, final, a.index));
    plan.base[id] = { ...final, note: d.note };
  }

  for (const a of fresh) {
    // Created in Apple Reminders: add it to Daybook and mark the reminder with its new ID.
    if (!a.title) continue;
    const id = newTaskId(taken);
    taken.add(id);
    const state: SyncState = { title: a.title, due: a.due ?? null, completed: a.completed, priority: a.priority ?? "none" };
    plan.added.push({ id, state });
    plan.actions.push({ op: "tag", index: a.index, taskId: id, url: input.url(id) });
    plan.base[id] = { ...state, note: input.inboxNote };
  }
  return plan;
}
