import { GithubNotes, type Env } from "./github";
import { parseReminders, pushConfigured, DEFAULT_TIMEZONE, type Reminder } from "./reminder-parse";
import { LOG_PREFIX } from "./log";
import { equalSecret } from "./action";
import { applySettings, deployConfigured, type Settings } from "./settings";

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
  const notes = await new GithubNotes(env).all(LOG_PREFIX);
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
