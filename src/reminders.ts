import { DurableObject } from "cloudflare:workers";
import { nextOccurrence, normalizeTopic, pushConfigured, DEFAULT_TIMEZONE, type Reminder, type ReminderEnv } from "./reminder-parse";
import { signAction } from "./action";
import { sendOnce } from "./delivery";
import { applySettings, type Settings } from "./settings";
import { GithubNotes, type Env } from "./github";
import { buildBriefing, mergeBriefings, nextBriefingAt, DEFAULT_BRIEFINGS, BRIEFING_KINDS, type BriefingKind, type BriefingSettings, type Briefing } from "./briefing";
import { localStamp } from "./reminder-parse";
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

/** A plain notification (briefings, weekly review): title, text and an optional link. Pushover when configured, otherwise ntfy. */
export async function sendNotice(env: ReminderEnv, n: { title: string; message: string; url?: string; urlTitle?: string; tags?: string }): Promise<void> {
  if (!pushConfigured(env)) throw new Error("No push provider configured (set PUSHOVER_TOKEN + PUSHOVER_USER, or NTFY_TOPIC)");
  let response: Response, provider: string;
  if (env.PUSHOVER_TOKEN && env.PUSHOVER_USER) {
    provider = "Pushover";
    const form = new URLSearchParams({ token: env.PUSHOVER_TOKEN.trim(), user: env.PUSHOVER_USER.trim(), title: n.title, message: n.message });
    if (n.url) { form.set("url", n.url); form.set("url_title", n.urlTitle || "Open Daybook"); }
    response = await fetch("https://api.pushover.net/1/messages.json", { method: "POST", body: form });
  } else {
    provider = "ntfy";
    const server = (env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
    // ntfy headers must be Latin-1; RFC 2047 encoding keeps titles like "Good morning · Mon" intact.
    const headers: Record<string, string> = { "Title": "=?UTF-8?B?" + btoa(String.fromCharCode(...new TextEncoder().encode(n.title))) + "?=" };
    if (n.tags) headers["Tags"] = n.tags;
    if (env.NTFY_TOKEN) headers["Authorization"] = "Bearer " + env.NTFY_TOKEN;
    if (n.url) headers["Click"] = n.url;
    response = await fetch(server + "/" + encodeURIComponent(normalizeTopic(env.NTFY_TOPIC!)), { method: "POST", headers, body: n.message });
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim().slice(0, 300);
    throw new Error(provider + " returned " + response.status + (detail ? ": " + detail : ""));
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
// Briefings (see briefing.ts). The "brief:" prefix must not overlap the reminder ("r:"), done ("d:"), fired ("f:") or "sent:" keys.
const BRIEFINGS = "briefings";
const briefNext = (kind: BriefingKind) => "brief:next:" + kind;
const briefSent = (kind: BriefingKind, date: string) => "brief:sent:" + kind + ":" + date;
const briefTries = (kind: BriefingKind, date: string) => "brief:tries:" + kind + ":" + date;
const briefStatus = (kind: BriefingKind) => "brief:status:" + kind;
const BRIEF_TEST = "brief:lastTest";
/** A briefing more than this late (the server was asleep or failing) is skipped, not sent at an odd hour. */
const BRIEF_STALE_MS = 2 * 3600 * 1000;
const BRIEF_MAX_TRIES = 6;

export interface BriefingStatus { at: number; result: "sent" | "skipped" | "failed"; detail?: string; }
export interface BriefingState { settings: BriefingSettings; next: Partial<Record<BriefingKind, number>>; status: Partial<Record<BriefingKind, BriefingStatus>>; }
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
    for (const kind of BRIEFING_KINDS) {
      const at = await this.ctx.storage.get<number>(briefNext(kind));
      if (at !== undefined) next = Math.min(next, at);
    }
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

  /* ---------- Briefings ---------- */

  private zone(env: ReminderEnv): string { return env.NOTES_TIMEZONE || DEFAULT_TIMEZONE; }
  private async briefingEnv(): Promise<Env> { return applySettings(this.env as unknown as Env, await this.getSettings()); }

  async getBriefings(): Promise<BriefingState> {
    const settings = (await this.ctx.storage.get<BriefingSettings>(BRIEFINGS)) ?? DEFAULT_BRIEFINGS;
    const state: BriefingState = { settings, next: {}, status: {} };
    for (const kind of BRIEFING_KINDS) {
      const next = await this.ctx.storage.get<number>(briefNext(kind));
      const status = await this.ctx.storage.get<BriefingStatus>(briefStatus(kind));
      if (next !== undefined) state.next[kind] = next;
      if (status) state.status[kind] = status;
    }
    return state;
  }

  /**
   * Save briefing settings. `revision` must match the saved one, so two editors can't overwrite each
   * other. Turning a briefing off, or changing its time, drops its pending send.
   */
  async setBriefings(input: unknown, revision: number): Promise<BriefingState> {
    const current = (await this.ctx.storage.get<BriefingSettings>(BRIEFINGS)) ?? DEFAULT_BRIEFINGS;
    if (revision !== current.revision) throw new Error("Briefing settings changed elsewhere; reload and try again");
    const settings = { ...mergeBriefings(current, input), revision: current.revision + 1 };
    await this.ctx.storage.put(BRIEFINGS, settings);
    const zone = this.zone(await this.briefingEnv());
    for (const kind of BRIEFING_KINDS) {
      if (settings[kind].enabled) await this.ctx.storage.put(briefNext(kind), nextBriefingAt(settings[kind].time, zone, Date.now()));
      else await this.ctx.storage.delete(briefNext(kind));
    }
    await this.reschedule();
    return this.getBriefings();
  }

  /** Build a briefing now from the live notes, without sending it. */
  async previewBriefing(kind: BriefingKind, now = Date.now()): Promise<Briefing> {
    const env = await this.briefingEnv();
    const settings = (await this.ctx.storage.get<BriefingSettings>(BRIEFINGS)) ?? DEFAULT_BRIEFINGS;
    const notes = await new GithubNotes(env).all();
    return buildBriefing({ kind, notes, done: await this.doneSince(now - 2 * 86_400_000), now, timeZone: this.zone(env), preview: settings.preview });
  }

  /** Send a briefing right now (Settings' "Send test"). At most once a minute. */
  async testBriefing(kind: BriefingKind, origin?: string): Promise<Briefing> {
    const last = await this.ctx.storage.get<number>(BRIEF_TEST);
    if (last && Date.now() - last < 60_000) throw new Error("Wait a minute before sending another test");
    await this.ctx.storage.put(BRIEF_TEST, Date.now());
    const b = await this.previewBriefing(kind);
    await sendNotice(await this.briefingEnv(), { title: b.title, message: b.message, url: await this.appLink(origin), tags: "sunrise" });
    return b;
  }

  private async appLink(origin?: string): Promise<string | undefined> {
    const base = this.env.PUBLIC_URL?.trim() || origin || await this.ctx.storage.get<string>(ORIGIN);
    return base ? base.replace(/\/+$/, "") + "/app#today" : undefined;
  }

  /**
   * Send due briefings. Each kind goes out at most once per local date: a "sent" mark is recorded
   * after the provider accepts it, failures retry every few minutes up to a limit, and a briefing
   * that is hours late is skipped rather than sent at an odd time.
   */
  private async runBriefings(now: number): Promise<void> {
    const settings = (await this.ctx.storage.get<BriefingSettings>(BRIEFINGS)) ?? DEFAULT_BRIEFINGS;
    let env: Env | undefined, notes: { name: string; content: string }[] | undefined;
    for (const kind of BRIEFING_KINDS) {
      const due = await this.ctx.storage.get<number>(briefNext(kind));
      if (due === undefined || due > now + 1000) continue;
      env ??= await this.briefingEnv();
      const zone = this.zone(env);
      const date = localStamp(due, zone).date;
      const advance = async (status?: BriefingStatus) => {
        if (status) await this.ctx.storage.put(briefStatus(kind), status);
        if (settings[kind].enabled) await this.ctx.storage.put(briefNext(kind), nextBriefingAt(settings[kind].time, zone, Math.max(now, due)));
        else await this.ctx.storage.delete(briefNext(kind));
      };
      if (!settings[kind].enabled) { await advance(); continue; }
      if (await this.ctx.storage.get(briefSent(kind, date))) { await advance(); continue; }
      if (now - due > BRIEF_STALE_MS) { await advance({ at: now, result: "skipped", detail: "Missed its time by over two hours" }); continue; }
      try {
        notes ??= await new GithubNotes(env).all();
        const b = buildBriefing({ kind, notes, done: await this.doneSince(now - 2 * 86_400_000), now, timeZone: zone, preview: settings.preview });
        if (b.empty) {
          await this.ctx.storage.put(briefSent(kind, date), { at: now });
          await advance({ at: now, result: "skipped", detail: "Nothing to report" });
          continue;
        }
        const url = await this.appLink();
        // Record the send only after the provider accepts it; a retry after that never resends.
        await sendOnce(false, () => sendNotice(env!, { title: b.title, message: b.message, url, tags: "sunrise" }),
          () => this.ctx.storage.put(briefSent(kind, date), { at: now }));
        await advance({ at: now, result: "sent" });
      } catch (e) {
        const tries = ((await this.ctx.storage.get<number>(briefTries(kind, date))) ?? 0) + 1;
        await this.ctx.storage.put(briefTries(kind, date), tries);
        const detail = e instanceof Error ? e.message : String(e);
        if (tries >= BRIEF_MAX_TRIES) await advance({ at: now, result: "failed", detail: `Gave up after ${tries} tries: ${detail}` });
        else {
          await this.ctx.storage.put(briefStatus(kind), { at: now, result: "failed", detail: `Will retry: ${detail}` } satisfies BriefingStatus);
          await this.ctx.storage.put(briefNext(kind), now + RETRY_MS);
        }
      }
    }
    // Forget old per-day marks.
    const old = await this.ctx.storage.list({ prefix: "brief:" });
    const cutoff = localStamp(now - 7 * 86_400_000, DEFAULT_TIMEZONE).date;
    const stale = [...old.keys()].filter(k => /^brief:(sent|tries):/.test(k) && k.slice(-10) < cutoff);
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
    // Briefings run after reminders, and their failures never affect reminder delivery.
    try { await this.runBriefings(Date.now()); } catch (e) { console.error("briefings failed", e); }
    await this.reschedule();
    if (failed) await this.ctx.storage.setAlarm(Math.min(Date.now() + RETRY_MS, (await this.ctx.storage.getAlarm()) ?? Infinity));
  }
}
