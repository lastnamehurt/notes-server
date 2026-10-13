import { GithubNotes, type Env } from "./github";
import { parseReminders, pushConfigured, localStamp, zonedTime, DEFAULT_TIMEZONE, type Reminder } from "./reminder-parse";
import { LOG_PREFIX, appendLog } from "./log";
import { equalSecret } from "./action";
import { applySettings, deployConfigured, type Settings } from "./settings";
import { notesFor } from "./storage";

// Shared by the MCP tools and the web app.

export const scheduler = (env: Env) => env.REMINDERS.get(env.REMINDERS.idFromName("global"));
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const fmt = (env: Env, r: Reminder) => ({
  text: r.text,
  ...(r.repeat ? { repeats: r.repeat.days.length === 7 ? "daily" : r.repeat.days.map(d => DAY[d]).join(",") } : {}),
  [r.repeat ? "next" : "at"]: new Date(r.at).toLocaleString("en-US", {
    timeZone: env.NOTES_TIMEZONE || DEFAULT_TIMEZONE, dateStyle: "medium", timeStyle: "short" })
});

/** Schedule a note's reminders; reports problems instead of failing the save. */
export async function scheduleNote(env: Env, name: string, content: string) {
  try {
    const upcoming = await scheduler(env).setNote(name, parseReminders(name, content, env.NOTES_TIMEZONE));
    const out: Record<string, unknown> = { name };
    if (upcoming.length) {
      out.reminders = upcoming.map(r => fmt(env, r));
      if (!pushConfigured(env)) out.warning = "Reminders saved but no push provider is configured (PUSHOVER_TOKEN + PUSHOVER_USER, or NTFY_TOPIC), so no push will be sent";
    }
    return out;
  } catch (e) {
    return { name, warning: "Note saved but reminders could not be scheduled: " + (e instanceof Error ? e.message : String(e)) };
  }
}

export async function rescan(env: Env): Promise<number> {
  // Daily logs never hold reminders and grow by one a day; skip them so the scan stays bounded.
  const notes = await notesFor(env).all(LOG_PREFIX);
  return scheduler(env).replaceAll(notes.flatMap(n => parseReminders(n.name, n.content, env.NOTES_TIMEZONE)));
}


// Setup-page settings live in the "global" Durable Object; keep a short per-isolate copy so most requests skip the call.
let cached: { at: number; settings: Settings | undefined } | undefined;
const SETTINGS_TTL_MS = 10_000;

export async function loadSettings(env: Env, fresh = false): Promise<Settings | undefined> {
  if (!fresh && cached && Date.now() - cached.at < SETTINGS_TTL_MS) return cached.settings;
  const settings = await scheduler(env).getSettings();
  cached = { at: Date.now(), settings };
  return settings;
}

export async function saveSettings(env: Env, settings: Settings): Promise<void> {
  await scheduler(env).putSettings(settings);
  cached = { at: Date.now(), settings };
}

/** The deployment's Env with setup-page settings filled in. Skips the lookup when the deployment sets everything. */
export async function effectiveEnv(env: Env): Promise<Env> {
  const fromDeploy = deployConfigured(env);
  if (fromDeploy && pushConfigured(env)) return { ...env, DEPLOY_CONFIGURED: true };
  return { ...applySettings(env, await loadSettings(env)), DEPLOY_CONFIGURED: fromDeploy };
}

const TOO_MANY = "Too many wrong passwords. Wait 15 minutes and try again.";

/** Check a password against MCP_BEARER_TOKEN with a shared limit on wrong guesses. Returns an error message, or null when correct. */
export async function checkPassword(env: Env, attempt: string): Promise<string | null> {
  const s = scheduler(env);
  if (!(await s.passwordAttemptAllowed())) return TOO_MANY;
  if (env.MCP_BEARER_TOKEN && attempt && (await equalSecret(attempt, env.MCP_BEARER_TOKEN))) return null;
  await s.recordPasswordFailure();
  return "That password doesn't match. Use the one you chose when you set up this server.";
}

const tz = (env: Env) => env.NOTES_TIMEZONE || DEFAULT_TIMEZONE;
const TASK = /^(\s*[-*]\s+\[)( |x|X)(\]\s+.*)$/;

/** Local midnight today, as an epoch. */
export function startOfToday(env: Env, now = Date.now()): number {
  const [y, m, d] = localStamp(now, tz(env)).date.split("-").map(Number);
  return zonedTime(y, m, d, 0, 0, tz(env));
}

/**
 * Mark a reminder done: log it, stop that occurrence from pushing, and for a one-off
 * tick its box in the note (which also unschedules it). `at` is the occurrence; if
 * omitted (e.g. from chat), the occurrence today closest to now is used.
 */
export async function completeReminder(env: Env, note: string, text: string, at?: number): Promise<{ ticked: boolean }> {
  const notes = notesFor(env);
  const s = scheduler(env);
  if (at === undefined) {
    const since = startOfToday(env);
    const candidates = [...await s.firedSince(since), ...(await s.upcoming()).filter(r => r.at < since + 86_400_000)]
      .filter(r => r.note === note && r.text === text);
    candidates.sort((a, b) => Math.abs(a.at - Date.now()) - Math.abs(b.at - Date.now()));
    at = candidates[0]?.at;
  }
  await appendLog(notes, "✓ " + text + " #done", { timeZone: env.NOTES_TIMEZONE });
  if (at !== undefined) await s.markDone(note, text, at);
  let doc: { content: string };
  try { doc = await notes.get(note); } catch { return { ticked: false }; }
  const lines = doc.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const [r] = parseReminders(note, lines[i], tz(env));
    if (!r || r.text !== text || r.repeat || !TASK.test(lines[i]) || /\[[xX]\]/.test(lines[i])) continue;
    lines[i] = lines[i].replace(TASK, "$1x$3");
    const content = lines.join("\n");
    await notes.update(note, content);
    await scheduleNote(env, note, content);
    return { ticked: true };
  }
  return { ticked: false };
}

/** The inbox note new tasks collect in: an existing "Tasks" or "Reminders" note, newest first. */
export const TASKS_NOTE = /^inbox\/(?:\d{4}-\d{2}-\d{2}-)?(?:tasks|reminders)(?:-\d+)?\.md$/;
export const TASK_PRIORITIES = ["do", "plan", "delegate", "someday"] as const;

/**
 * Add "- [ ] <text> [@<schedule>] [@priority:<p>]" to a note (default: the inbox Tasks note, created if needed).
 * The schedule is optional; when given it must be readable and, for a one-off, in the future.
 */
export async function addTask(env: Env, input: { text: string; schedule?: string; priority?: string; note?: string }) {
  const text = (input.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error("Say what needs doing");
  if (parseReminders("check", "- [ ] " + text, tz(env)).length)
    throw new Error("Use the date and time options instead of typing @ in the task");
  const schedule = (input.schedule ?? "").trim();
  const priority = (input.priority ?? "").trim();
  if (priority && !(TASK_PRIORITIES as readonly string[]).includes(priority)) throw new Error("Unknown priority");
  const line = `- [ ] ${text}` + (schedule ? ` @${schedule}` : "") + (priority ? ` @priority:${priority}` : "");
  if (schedule) {
    const parsed = parseReminders("check", line, tz(env));
    if (!parsed.length) throw new Error("Couldn't read that date and time");
    if (!parsed[0].repeat && parsed.every(r => r.at <= Date.now())) throw new Error("That time has already passed");
  }
  const notes = notesFor(env);
  const name = input.note || (await notes.list()).find(n => TASKS_NOTE.test(n));
  if (!name) {
    const content = "# Tasks\n\n" + line + "\n";
    return { ...(await scheduleNote(env, await notes.save(content, "inbox"), content)), line };
  }
  const lines = (await notes.get(name)).content.trimEnd().split("\n");
  let at = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) if (TASK.test(lines[i])) { at = i + 1; break; }
  lines.splice(at, 0, line);
  const content = lines.join("\n") + "\n";
  await notes.update(name, content);
  return { ...(await scheduleNote(env, name, content)), line };
}

/** Add a task that must have a schedule (a reminder). */
export async function addReminder(env: Env, input: { text: string; schedule: string; note?: string }) {
  if (!(input.schedule ?? "").trim()) throw new Error("Couldn't read that date and time");
  return addTask(env, input);
}
