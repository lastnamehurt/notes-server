import { GithubNotes, localDate, type Env } from "./github";
import { tasksFromNotes } from "./priorities";
import { pushConfigured, DEFAULT_TIMEZONE } from "./reminder-parse";
import { sendPush } from "./reminders";

type Note = { name: string; content: string };
const DAY = 86400000;

export function reviewDue(now: number, zone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, weekday: "short", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(now));
  const part = (type: string) => parts.find(p => p.type === type)?.value;
  return part("weekday") === "Sun" && part("hour") === "18";
}

export function buildReview(date: string, notes: Note[], weekDates: Set<string>): string {
  const logs = notes.filter(n => n.name.startsWith("journal/log/") &&
    weekDates.has(n.name.slice("journal/log/".length, -3)));
  const logLines = logs.flatMap(n => n.content.split("\n").filter(l => /^- \d{2}:\d{2} /.test(l)));
  const completed = logLines.filter(l => /^- \d{2}:\d{2} ✓/.test(l));
  const open = tasksFromNotes(notes.filter(n => !n.name.startsWith("journal/")));
  const urgent = open.filter(t => t.priority === "do");
  const planned = open.filter(t => t.priority === "plan");
  const lines = (items: string[]) => items.length ?
    items.slice(0, 10).map(t => "- " + t.replace(/[\r\n]/g, " ").slice(0, 200)).join("\n") :
    "- None recorded";
  return [
    "# Weekly review — " + date,
    "",
    "## Snapshot",
    "- Days with activity: " + logs.filter(n => /^- \d{2}:\d{2} /m.test(n.content)).length,
    "- Journal entries: " + logLines.length,
    "- Completed reminder occurrences logged: " + completed.length,
    "- Currently open tasks: " + open.length,
    "- Do now: " + urgent.length,
    "- Plan: " + planned.length,
    "",
    "## Completed reminders",
    lines(completed.map(l => l.replace(/^- \d{2}:\d{2} /, ""))),
    "",
    "## Priorities for next week",
    lines([...urgent, ...planned].map(t => t.text)),
    "",
    "## Reflection",
    "What went well?",
    "",
    "What could go better?",
    "",
    "What matters most next week?",
    "",
    "_Generated from available Daybook records. Task totals describe current open items, not historical completions._",
    "",
  ].join("\n");
}

/** Called by the existing hourly cron; a fixed note path makes repeats safe. */
export async function runWeeklyReview(env: Env, now = Date.now()): Promise<boolean> {
  const zone = env.NOTES_TIMEZONE || DEFAULT_TIMEZONE;
  if (!reviewDue(now, zone)) return false;
  const date = localDate(zone, new Date(now));
  const path = "journal/weekly-review-" + date + ".md";
  const github = new GithubNotes(env);
  const snapshot = await github.all();
  if (snapshot.some(n => n.name === path)) return false;
  const dates = new Set(Array.from({length: 7}, (_, daysAgo) =>
    localDate(zone, new Date(now - daysAgo * DAY))));
  const review = buildReview(date, snapshot, dates);
  try {
    await github.put(path, review);
  } catch (error) {
    // A concurrent run might have created the same review.
    if (error instanceof Error && /conflict|already exists|422|409/i.test(error.message)) return false;
    throw error;
  }
  if (pushConfigured(env)) {
    try {
      await sendPush(env, {
        note: path,
        text: "Your Daybook weekly review is ready. Look back and choose next week's focus.",
        at: now,
      });
    } catch (error) {
      console.error("Weekly review notification failed", error);
    }
  }
  return true;
}
