import { DurableObject } from "cloudflare:workers";
import { nextOccurrence, normalizeTopic, pushConfigured, DEFAULT_TIMEZONE, type Reminder, type ReminderEnv } from "./reminder-parse";
import { signAction } from "./action";
import { sendOnce } from "./delivery";
import { applySettings, type Settings } from "./settings";
import type { Env } from "./github";
export * from "./reminder-parse";

/** Signed link that marks this occurrence of the reminder done (see completeReminder). */
async function doneUrl(env: ReminderEnv, r: Reminder, origin?: string): Promise<string | undefined> {
  const base = env.PUBLIC_URL?.trim() || origin;
  const secret = env.MCP_BEARER_TOKEN || env.PASSWORD;
  if (!base || !secret) return undefined;
  return base.replace(/\/+$/, "") + "/done?a=" + await signAction(secret, { note: r.note, text: r.text, at: r.at });
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
const DEVICE_FLOW = "status:deviceFlow";
const FAILS = "status:passwordFailures";
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

export interface PushError { at: number; message: string; reminder: string; }

const KEEP_FIRED_MS = 48 * 3600 * 1000;
// Apple Reminders sync. Prefixes must not overlap the reminder ("r:"), done ("d:"), fired ("f:") or "sent:" keys.
const SYNC_BASE = "sync:base:";
const SYNC_LOCK = "sync:lock";
const SYNC_RUN = "sync:run:";
// "Done" marker for one occurrence, so a reminder completed early doesn't push when its time comes.
const doneKey = (note: string, text: string, at: number) => "d:" + at + SEP + note + SEP + text;
const firedKey = (r: Reminder) => "f:" + r.at + SEP + r.note + SEP + r.text;
// Persist successful provider acknowledgement before updating fired history.
// A later storage failure must not resend an already acknowledged notification.
const deliveredKey = (r: Reminder) => "sent:" + r.at + SEP + r.note + SEP + r.text;

/** A reminder that already went off (kept ~2 days so Today can still offer Done). */
export interface Fired { note: string; text: string; at: number; repeat: boolean; }

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

  /** A "Connect GitHub" sign-in in progress (the device code never leaves the server). */
  async getDeviceFlow(): Promise<{ deviceCode: string; expiresAt: number } | undefined> {
    return this.ctx.storage.get(DEVICE_FLOW);
  }

  async setDeviceFlow(flow: { deviceCode: string; expiresAt: number } | null): Promise<void> {
    if (flow) await this.ctx.storage.put(DEVICE_FLOW, flow);
    else await this.ctx.storage.delete(DEVICE_FLOW);
  }

  /** Public origin of the Worker, recorded from incoming requests so notifications can link back to /done. */
  async setOrigin(origin: string): Promise<void> {
    if ((await this.ctx.storage.get<string>(ORIGIN)) !== origin) await this.ctx.storage.put(ORIGIN, origin);
  }

  async upcoming(): Promise<Reminder[]> {
    return [...(await this.all()).values()].sort((a, b) => a.at - b.at);
  }

  /** Reminders that went off since `since` (oldest first); also prunes old history. */
  async firedSince(since: number): Promise<Fired[]> {
    const all = await this.ctx.storage.list<Fired>({ prefix: "f:" });
    const stale = [...all].filter(([, f]) => f.at < Date.now() - KEEP_FIRED_MS).map(([k]) => k);
    if (stale.length) await this.ctx.storage.delete(stale.slice(0, 128));
    return [...all.values()].filter(f => f.at >= since).sort((a, b) => a.at - b.at);
  }

  /** Mark one occurrence done so it won't push. */
  async markDone(note: string, text: string, at: number): Promise<void> {
    await this.ctx.storage.put(doneKey(note, text, at), { note, text, at });
    const old = await this.ctx.storage.list<{ at: number }>({ prefix: "d:" });
    const stale = [...old].filter(([, v]) => v.at < Date.now() - 3 * 86_400_000).map(([k]) => k);
    if (stale.length) await this.ctx.storage.delete(stale.slice(0, 128));
  }

  /** Occurrences marked done with times at or after `since`. */
  async doneSince(since: number): Promise<{ note: string; text: string; at: number }[]> {
    return [...(await this.ctx.storage.list<{ note: string; text: string; at: number }>({ prefix: "d:" })).values()].filter(d => d.at >= since);
  }

  /* ---------- Apple Reminders sync state (see apple-sync.ts) ---------- */

  /** The last state both sides agreed on, per task ID. */
  async syncBase(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of await this.ctx.storage.list({ prefix: SYNC_BASE })) out[k.slice(SYNC_BASE.length)] = v;
    return out;
  }

  /** Replace the whole base. */
  async putSyncBase(base: Record<string, unknown>): Promise<void> {
    const old = [...(await this.ctx.storage.list({ prefix: SYNC_BASE })).keys()].filter(k => !(k.slice(SYNC_BASE.length) in base));
    for (let i = 0; i < old.length; i += 128) await this.ctx.storage.delete(old.slice(i, i + 128));
    const entries = Object.entries(base).map(([id, v]) => [SYNC_BASE + id, v] as const);
    for (let i = 0; i < entries.length; i += 128) await this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
  }

  /**
   * Start a sync run. Returns the saved response if this run already finished (a retried request),
   * "busy" if another run holds the lock, or "go". The lock expires so a crashed run can't block sync.
   */
  async syncStart(runId: string, lockMs: number): Promise<{ status: "go" | "busy" | "replay"; response?: unknown }> {
    const done = await this.ctx.storage.get<{ at: number; response: unknown }>(SYNC_RUN + runId);
    if (done) return { status: "replay", response: done.response };
    const lock = await this.ctx.storage.get<{ runId: string; until: number }>(SYNC_LOCK);
    if (lock && lock.until > Date.now() && lock.runId !== runId) return { status: "busy" };
    await this.ctx.storage.put(SYNC_LOCK, { runId, until: Date.now() + lockMs });
    return { status: "go" };
  }

  /** Finish a run: remember its response for replays (a day), release the lock, prune old runs. */
  async syncFinish(runId: string, response: unknown | null): Promise<void> {
    if (response !== null) await this.ctx.storage.put(SYNC_RUN + runId, { at: Date.now(), response });
    const lock = await this.ctx.storage.get<{ runId: string }>(SYNC_LOCK);
    if (lock?.runId === runId) await this.ctx.storage.delete(SYNC_LOCK);
    const runs = await this.ctx.storage.list<{ at: number }>({ prefix: SYNC_RUN });
    const stale = [...runs].filter(([, v]) => v.at < Date.now() - 86_400_000).map(([k]) => k);
    if (stale.length) await this.ctx.storage.delete(stale.slice(0, 128));
  }

  async alarm(): Promise<void> {
    let failed = false;
    const origin = await this.ctx.storage.get<string>(ORIGIN);
    const env = applySettings(this.env as unknown as Env, await this.getSettings());
    for (const [k, r] of await this.all()) {
      if (r.at > Date.now() + 1000) continue;
      try {
        const alreadyDone = await this.ctx.storage.get(doneKey(r.note, r.text, r.at));
        const alreadyDelivered = await this.ctx.storage.get(deliveredKey(r));
        if (!alreadyDone) {
          // Without a push provider the reminder still "goes off" (shows as due in the app) and repeats roll forward.
          if (pushConfigured(env) && !alreadyDelivered) {
            await sendOnce(false, () => sendPush(env, r, origin), () => this.ctx.storage.put(deliveredKey(r), { at: r.at }));
            await this.ctx.storage.delete(LAST_ERROR);
          }
          await this.ctx.storage.put(firedKey(r), { note: r.note, text: r.text, at: r.at, repeat: Boolean(r.repeat) } satisfies Fired);
        }
        // Schedule the next occurrence before deleting the current one; if storage
        // fails, the acknowledged current occurrence can safely be retried.
        if (r.repeat) {
          const at = nextOccurrence(r.repeat, env.NOTES_TIMEZONE || DEFAULT_TIMEZONE, Math.max(r.at, Date.now()));
          const next = { ...r, at };
          await this.ctx.storage.put(key(next), next);
        }
        await this.ctx.storage.delete(k);
        await this.ctx.storage.delete(deliveredKey(r));
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
