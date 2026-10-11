import { DurableObject } from "cloudflare:workers";
import { nextOccurrence, normalizeTopic, pushConfigured, DEFAULT_TIMEZONE, type Reminder, type ReminderEnv } from "./reminder-parse";
import { signAction } from "./action";
import { applySettings, type Settings } from "./settings";
import type { Env } from "./github";
export * from "./reminder-parse";

/** Signed link that logs the reminder as done in today's log. */
async function doneUrl(env: ReminderEnv, r: Reminder, origin?: string): Promise<string | undefined> {
  const base = env.PUBLIC_URL?.trim() || origin;
  const secret = env.MCP_BEARER_TOKEN || env.PASSWORD;
  if (!base || !secret) return undefined;
  return base.replace(/\/+$/, "") + "/done?a=" + await signAction(secret, r);
}

/** Send via Pushover when configured, otherwise ntfy. */
export async function sendPush(env: ReminderEnv, r: Reminder, origin?: string): Promise<void> {
  if (!pushConfigured(env)) throw new Error("No push provider configured (set PUSHOVER_TOKEN + PUSHOVER_USER, or NTFY_TOPIC)");
  const done = await doneUrl(env, r, origin);
  if (env.PUSHOVER_TOKEN && env.PUSHOVER_USER) return sendPushover(env, r, done);
  return sendNtfy(env, r, done);
}

async function sendPushover(env: ReminderEnv, r: Reminder, done?: string): Promise<void> {
  const form = new URLSearchParams({
    token: env.PUSHOVER_TOKEN!.trim(), user: env.PUSHOVER_USER!.trim(),
    title: "Reminder", message: r.text + "\n\n" + r.note
  });
  if (done) { form.set("url", done); form.set("url_title", "Mark done"); }
  const response = await fetch("https://api.pushover.net/1/messages.json", { method: "POST", body: form });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim().slice(0, 300);
    throw new Error("Pushover returned " + response.status + (detail ? ": " + detail : ""));
  }
}

async function sendNtfy(env: ReminderEnv, r: Reminder, done?: string): Promise<void> {
  const server = (env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
  const headers: Record<string, string> = { "Title": "Reminder", "Tags": "bell" };
  if (env.NTFY_TOKEN) headers["Authorization"] = "Bearer " + env.NTFY_TOKEN;
  // "Done" button: logs the item as done in today's log without opening anything.
  if (done) headers["Actions"] = "http, Done, " + done + ", method=POST, clear=true";
  const body = r.text + "\n\n" + r.note;
  const response = await fetch(server + "/" + encodeURIComponent(normalizeTopic(env.NTFY_TOPIC!)), { method: "POST", headers, body });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim().slice(0, 300);
    throw new Error("ntfy returned " + response.status + (detail ? ": " + detail : ""));
  }
}

const SEP = "\u0000";
const key = (r: Reminder) => "r:" + r.note + SEP + r.at + SEP + r.text;
const notePrefix = (note: string) => "r:" + note + SEP;
const RETRY_MS = 5 * 60 * 1000;
const LAST_ERROR = "status:lastError";
const ORIGIN = "status:origin";
const SETTINGS = "settings";
const FAILS = "status:passwordFailures";
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

export interface PushError { at: number; message: string; reminder: string; }

/** Single instance ("global") that stores upcoming reminders and fires them with an alarm. */
export class ReminderScheduler extends DurableObject<ReminderEnv> {
  private async all(prefix = "r:"): Promise<Map<string, Reminder>> {
    return this.ctx.storage.list<Reminder>({ prefix });
  }

  private async reschedule(): Promise<void> {
    let next = Infinity;
    for (const r of (await this.all()).values()) next = Math.min(next, r.at);
    if (next === Infinity) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
  }

  /** Replace the reminders for one note. Past-due times are dropped so edits never re-fire old items. */
  async setNote(note: string, reminders: Reminder[]): Promise<Reminder[]> {
    const old = [...(await this.all(notePrefix(note))).keys()];
    if (old.length) await this.ctx.storage.delete(old);
    const upcoming = reminders.filter(r => r.at > Date.now());
    for (const r of upcoming) await this.ctx.storage.put(key(r), r);
    await this.reschedule();
    return upcoming;
  }

  async removeNote(note: string): Promise<void> {
    await this.setNote(note, []);
  }

  /** Rebuild from a full scan of the notes repository. */
  async replaceAll(reminders: Reminder[]): Promise<number> {
    const old = [...(await this.all()).keys()];
    for (let i = 0; i < old.length; i += 128) await this.ctx.storage.delete(old.slice(i, i + 128));
    const upcoming = reminders.filter(r => r.at > Date.now());
    for (const r of upcoming) await this.ctx.storage.put(key(r), r);
    await this.reschedule();
    return upcoming.length;
  }

  /** Most recent push failure, cleared by the next successful push. */
  async lastError(): Promise<PushError | undefined> {
    return this.ctx.storage.get<PushError>(LAST_ERROR);
  }

  /** Wrong-password limit shared by the app's unlock and Claude's sign-in page: 10 misses per 15 minutes. */
  async passwordAttemptAllowed(): Promise<boolean> {
    const f = await this.ctx.storage.get<{ since: number; count: number }>(FAILS);
    return !f || Date.now() - f.since > FAIL_WINDOW_MS || f.count < MAX_FAILS;
  }

  async recordPasswordFailure(): Promise<void> {
    const f = await this.ctx.storage.get<{ since: number; count: number }>(FAILS);
    const fresh = !f || Date.now() - f.since > FAIL_WINDOW_MS;
    await this.ctx.storage.put(FAILS, fresh ? { since: Date.now(), count: 1 } : { since: f!.since, count: f!.count + 1 });
  }

  /** Settings saved from the app's setup page (this "global" instance holds them; see settings.ts). */
  async getSettings(): Promise<Settings | undefined> {
    return this.ctx.storage.get<Settings>(SETTINGS);
  }

  async putSettings(settings: Settings): Promise<void> {
    await this.ctx.storage.put(SETTINGS, settings);
  }

  /** Public origin of the Worker, recorded from incoming requests so notifications can link back to /done. */
  async setOrigin(origin: string): Promise<void> {
    if ((await this.ctx.storage.get<string>(ORIGIN)) !== origin) await this.ctx.storage.put(ORIGIN, origin);
  }

  async upcoming(): Promise<Reminder[]> {
    return [...(await this.all()).values()].sort((a, b) => a.at - b.at);
  }

  async alarm(): Promise<void> {
    let failed = false;
    const origin = await this.ctx.storage.get<string>(ORIGIN);
    const env = applySettings(this.env as unknown as Env, await this.getSettings());
    for (const [k, r] of await this.all()) {
      if (r.at > Date.now() + 1000) continue;
      try {
        await sendPush(env, r, origin);
        await this.ctx.storage.delete([k, LAST_ERROR]);
        if (r.repeat) {
          const at = nextOccurrence(r.repeat, env.NOTES_TIMEZONE || DEFAULT_TIMEZONE, Math.max(r.at, Date.now()));
          const next = { ...r, at };
          await this.ctx.storage.put(key(next), next);
        }
      }
      catch (e) {
        failed = true;
        console.error("push failed", e);
        const message = e instanceof Error ? e.message : String(e);
        await this.ctx.storage.put(LAST_ERROR, { at: Date.now(), message, reminder: r.text } satisfies PushError);
      }
    }
    await this.reschedule();
    if (failed) await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
  }
}
