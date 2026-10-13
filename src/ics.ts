// iCalendar (RFC 5545) for Daybook, both ways. Pure: no network or storage.
//  - buildIcs: publishes tasks with a due time as events, so they show next to meetings in any calendar app.
//  - parseIcs: reads the events of a calendar the owner subscribed to (read-only, no sign-in needed).
// Tasks are published as VEVENTs (not VTODOs) because Google Calendar ignores VTODO.
import { zonedTime } from "./reminder-parse";

export interface IcsTask { id: string; title: string; dueAt: string; note: string }
export interface IcsEvent { uid: string; title: string; start: number; end: number | null; allDay: boolean }

const MAX_FEED_BYTES = 2_000_000;
const MAX_EVENTS = 500;
const DURATION_MS = 15 * 60_000;

/** Text values: escape \ ; , and newlines (RFC 5545 section 3.3.11). */
export function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
export function unescapeText(value: string): string {
  return value.replace(/\\(n|N|,|;|\\)/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

/** UTC timestamp in the form 20261013T150000Z. */
export function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Fold lines longer than 75 octets (continuation lines start with a space). Simplified to characters. */
function fold(line: string): string {
  if (line.length <= 73) return line;
  const parts: string[] = [];
  for (let i = 0; i < line.length; i += 73) parts.push((i === 0 ? "" : " ") + line.slice(i, i + 73));
  return parts.join("\r\n");
}

export function buildIcs(tasks: IcsTask[], now = Date.now()): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Daybook//Tasks//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Daybook tasks"];
  for (const task of tasks.slice(0, MAX_EVENTS)) {
    const start = Date.parse(task.dueAt);
    if (!Number.isFinite(start)) continue;
    lines.push("BEGIN:VEVENT",
      `UID:${escapeText(task.id)}@daybook`,
      `DTSTAMP:${utcStamp(now)}`,
      `DTSTART:${utcStamp(start)}`,
      `DTEND:${utcStamp(start + DURATION_MS)}`,
      `SUMMARY:${escapeText(task.title)}`,
      `DESCRIPTION:${escapeText("From your note " + task.note)}`,
      "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Daybook task", "TRIGGER:-PT0M", "END:VALARM",
      "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** Unfold continuation lines, then split into name/params/value. */
function contentLines(text: string): { name: string; params: Record<string, string>; value: string }[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  return unfolded.split(/\r?\n/).flatMap(raw => {
    const colon = raw.indexOf(":");
    if (colon < 0) return [];
    const [name, ...paramParts] = raw.slice(0, colon).split(";");
    const params: Record<string, string> = {};
    for (const p of paramParts) { const eq = p.indexOf("="); if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, ""); }
    return [{ name: name.toUpperCase(), params, value: raw.slice(colon + 1) }];
  });
}

/** A DATE or DATE-TIME value in its own zone (TZID), in UTC, or floating (use the owner's zone). */
function toMs(value: string, params: Record<string, string>, ownerZone: string): { ms: number; allDay: boolean } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!m[4]) return { ms: zonedTime(y, mo, d, 0, 0, params.TZID || ownerZone), allDay: true };
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] || 0)];
  if (m[7]) return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false };
  const zone = params.TZID || ownerZone;
  return { ms: zonedTime(y, mo, d, h, mi, zone) + s * 1000, allDay: false };
}

/** Events from a subscribed calendar, between a day before now and `days` ahead. Recurring events are skipped (v1). */
export function parseIcs(text: string, opts: { now?: number; days?: number; zone?: string } = {}): IcsEvent[] {
  if (text.length > MAX_FEED_BYTES) throw new Error("That calendar is too large to read");
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("That address isn't an iCalendar feed");
  const now = opts.now ?? Date.now();
  const from = now - 86400000, to = now + (opts.days ?? 14) * 86400000;
  const zone = opts.zone || "UTC";
  const events: IcsEvent[] = [];
  let current: Record<string, { params: Record<string, string>; value: string }[]> | null = null;
  for (const line of contentLines(text)) {
    if (line.name === "BEGIN" && line.value === "VEVENT") { current = {}; continue; }
    if (line.name === "END" && line.value === "VEVENT") {
      if (current && !current.RRULE && current.DTSTART) {
        const start = toMs(current.DTSTART[0].value, current.DTSTART[0].params, zone);
        const endProp = current.DTEND?.[0] ?? null;
        const end = endProp ? toMs(endProp.value, endProp.params, zone) : null;
        if (start && start.ms >= from && start.ms <= to) {
          events.push({
            uid: unescapeText(current.UID?.[0]?.value ?? start.ms + ""),
            title: unescapeText(current.SUMMARY?.[0]?.value ?? "(no title)"),
            start: start.ms, end: end?.ms ?? null, allDay: start.allDay,
          });
        }
      }
      current = null;
      continue;
    }
    if (current) (current[line.name] ??= []).push({ params: line.params, value: line.value });
  }
  return events.sort((a, b) => a.start - b.start).slice(0, MAX_EVENTS);
}
