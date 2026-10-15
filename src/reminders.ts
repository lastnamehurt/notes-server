import { DurableObject } from "cloudflare:workers";
import { AwarenessInbox, type InboxCandidate } from "./awareness-inbox";
import { threeDeferrals, type DeferralEvidence } from "./awareness-rules";
import { deadlineSuggestions } from "./awareness-deadlines";
import { DEFAULT_SIGNAL_SETTINGS, parseSignalSettings, paymentOutcome, spendSummary, type Payment, type SignalSettings, type SpendSummary } from "./signals";
import { AwarenessHistory } from "./awareness-history";
import { interruptionDecision } from "./awareness-interruption";
import { DEFAULT_AWARENESS_PREFERENCES, parseAwarenessPreferences, type AwarenessPreferences } from "./awareness-preferences";
import { nextOccurrence, normalizeTopic, pushConfigured, legacyPushConfigured, webPushConfigured, NO_PUSH, DEFAULT_TIMEZONE, type Reminder, type ReminderEnv } from "./reminder-parse";
import { generateVapidKeys, sendWebPush, type PushMessage, type Subscription, type WebPushState } from "./web-push";
import { signAction } from "./action";
import { sendOnce } from "./delivery";
import { applySettings, type Settings } from "./settings";
import { GithubNotes, type Env } from "./github";
import { buildBriefing, mergeBriefings, nextBriefingAt, DEFAULT_BRIEFINGS, BRIEFING_KINDS, type BriefingKind, type BriefingSettings, type Briefing } from "./briefing";
import { localStamp } from "./reminder-parse";
import { notesFor } from "./storage";
export * from "./reminder-parse";

/** Signed link that marks this occurrence of the reminder done (see completeReminder). */
async function doneUrl(env: ReminderEnv, r: Reminder, origin?: string): Promise<string | undefined> {
  const base = env.PUBLIC_URL?.trim() || origin;
  const secret = env.MCP_BEARER_TOKEN || env.PASSWORD;
  if (!base || !secret) return undefined;
  return base.replace(/\/+$/, "") + "/done?a=" + await signAction(secret, { note: r.note, text: r.text, at: r.at });
}

/** Where to tell the app a device's push subscription has expired. */
export interface DeliveryOptions { prune?: (gone: string[]) => Promise<void>; /** A test: no Done button. */ test?: boolean }

const baseUrl = (env: ReminderEnv, origin?: string) => (env.PUBLIC_URL?.trim() || origin || "").replace(/\/+$/, "") || undefined;

/**
 * Send to every device that turned on notifications in the app. ntfy and Pushover (older options) are used
 * only when no device has notifications on, so nobody gets everything twice after switching.
 * Throws when nothing was delivered, so callers retry.
 */
async function deliver(env: ReminderEnv, message: PushMessage, legacy: () => Promise<void>, opts: DeliveryOptions = {}, origin?: string): Promise<void> {
  if (webPushConfigured(env)) {
    const fromUrl = (() => { try { return message.url ? new URL(message.url).origin : undefined; } catch { return undefined; } })();
    const base = baseUrl(env, origin) ?? fromUrl;
    const r = await sendWebPush(env.WEB_PUSH!, message, base?.startsWith("https://") ? base : "mailto:daybook@users.noreply.github.com");
    if (r.gone.length) await opts.prune?.(r.gone).catch(e => console.error("couldn't forget expired devices", e));
    if (r.delivered) return;
    if (legacyPushConfigured(env)) return legacy();
    if (r.errors.length) throw new Error("Notification didn't send: " + r.errors.join("; "));
    throw new Error("Notifications were turned off on every device. Turn them on again in the app's Settings.");
  }
  if (legacyPushConfigured(env)) return legacy();
  throw new Error(NO_PUSH);
}

/** A reminder going off: tapping opens Today; where devices show buttons, Done marks it done. */
export async function sendPush(env: ReminderEnv, r: Reminder, origin?: string, opts: DeliveryOptions = {}): Promise<void> {
  if (!pushConfigured(env)) throw new Error(NO_PUSH);
  const done = opts.test ? undefined : await doneUrl(env, r, origin);
  const base = baseUrl(env, origin);
  return deliver(env, { title: "Reminder", body: r.text, url: base ? base + "/app#today" : "/app#today", done, tag: "r-" + r.at + "-" + r.text.slice(0, 40) },
    () => env.PUSHOVER_TOKEN && env.PUSHOVER_USER ? sendPushover(env, r, done) : sendNtfy(env, r, done), opts, origin);
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

/** A plain notification (briefings, weekly review): title, text and an optional link. */
export async function sendNotice(env: ReminderEnv, n: { title: string; message: string; url?: string; urlTitle?: string; tags?: string }, opts: DeliveryOptions = {}): Promise<void> {
  if (!pushConfigured(env)) throw new Error(NO_PUSH);
  return deliver(env, { title: n.title, body: n.message, url: n.url, tag: n.tags }, () => sendLegacyNotice(env, n), opts);
}

/** ntfy or Pushover (older options). */
async function sendLegacyNotice(env: ReminderEnv, n: { title: string; message: string; url?: string; urlTitle?: string; tags?: string }): Promise<void> {
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
const WEB_PUSH = "webpush";
const DEVICE_FLOW = "status:deviceFlow";
const FAILS = "status:passwordFailures";
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

export interface PushError { at: number; message: string; reminder: string; }

const KEEP_FIRED_MS = 48 * 3600 * 1000;
// Briefings (see briefing.ts). The "brief:" prefix must not overlap the reminder ("r:"), done ("d:"), fired ("f:") or "sent:" keys.
const BRIEFINGS = "briefings";
/** Signals: stored taps to pay, by payment id. Kept 90 days. */
const PAYMENT = "signal:payment:";
const PAYMENT_RETENTION_MS = 90 * 86_400_000;
/** Digest mode: a suggestion already counted in a morning briefing (keyed by its dedupe key). */
const DIGESTED = "awareness:digested:local:";
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
// Apple Reminders sync. Prefixes must not overlap the reminder ("r:"), done ("d:"), fired ("f:") or "sent:" keys.
const SYNC_BASE = "sync:base:";
const SYNC_LOCK = "sync:lock";
const SYNC_RUN = "sync:run:";
/** Tasks Apple Reminders reported having at the last successful sync, and when that was. */
const SYNC_MIRROR = "sync:mirror";
/** After this long without a sync, Daybook sends its own notifications again for every task. */
export const MIRROR_FRESH_MS = 36 * 3600 * 1000;
export interface SyncMirror { at: number; keys: string[]; summary?: unknown; }
/** Whether Apple Reminders should alert for this reminder instead of a Daybook notification. */
export function alertedByReminders(mirror: SyncMirror | undefined, r: { note: string; text: string }, now: number, mode: Settings["taskAlerts"]): boolean {
  if (mode === "both" || !mirror || now - mirror.at > MIRROR_FRESH_MS) return false;
  return mirror.keys.includes(r.note + SEP + r.text);
}
// "Done" marker for one occurrence, so a reminder completed early doesn't push when its time comes.
const doneKey = (note: string, text: string, at: number) => "d:" + at + SEP + note + SEP + text;
const firedKey = (r: Reminder) => "f:" + r.at + SEP + r.note + SEP + r.text;
// Persist successful provider acknowledgement before updating fired history.
// A later storage failure must not resend an already acknowledged notification.
const deliveredKey = (r: Reminder) => "sent:" + r.at + SEP + r.note + SEP + r.text;

/** A reminder that already went off (kept ~2 days so Today can still offer Done). */
export interface Fired { note: string; text: string; at: number; repeat: boolean; }

/** Only native task sources with current consent may supply rule evidence. */
const deferralSourceAllowed = (preferences: AwarenessPreferences, source: string) =>
  source === "daybook" ? preferences.sources.daybook : source === "appleReminders" && preferences.sources.appleReminders;

/** Single instance ("global") that stores upcoming reminders and fires them with an alarm. */
export class ReminderScheduler extends DurableObject<ReminderEnv> {
  async awarenessPreferences(): Promise<AwarenessPreferences> {
    const saved = await this.ctx.storage.get<AwarenessPreferences>("awareness:preferences:local");
    return saved ? parseAwarenessPreferences(saved) : DEFAULT_AWARENESS_PREFERENCES;
  }
  async setAwarenessPreferences(input: unknown): Promise<AwarenessPreferences> {
    const preferences = parseAwarenessPreferences(input);
    await this.ctx.storage.put("awareness:preferences:local", preferences);
    return preferences;
  }

  /**
   * Explicit opt-in delivery for an existing inbox candidate. Durable Object serializes
   * invocations; a reservation is written before contacting the push provider.
   * A provider timeout is ambiguous, so never retry it automatically (at-most-once).
   * Existing reminders and briefings are unaffected.
   */
  async awarenessDeliver(id: string): Promise<{ status: string; reason: string }> {
    const inbox = new AwarenessInbox(this.ctx.storage);
    const entry = await inbox.get("local", id);
    if (!entry) return { status: "suppressed", reason: "not-found" };
    const candidate = entry.candidate;
    const now = new Date();
    const prefs = await this.awarenessPreferences();
    const env = applySettings(this.env as unknown as Env, await this.getSettings());
    const zone = env.NOTES_TIMEZONE || DEFAULT_TIMEZONE;
    const dedupe = "awareness:delivery:local:" + encodeURIComponent(candidate.dedupeKey);
    const reserved = await this.ctx.storage.get<{ at: string }>(dedupe);
    // The same candidate may be retried after a response is lost, but never re-sent.
    if (reserved) return { status: "suppressed", reason: "already-delivered" };

    let date: string;
    try { date = localStamp(now.getTime(), zone).date; }
    catch { return { status: "suppressed", reason: "invalid-timezone" }; }
    const daily = "awareness:delivery-count:local:" + date;
    const count = (await this.ctx.storage.get<number>(daily)) ?? 0;
    const last = await this.ctx.storage.get<string>("awareness:delivery:last:local");
    let decision: ReturnType<typeof interruptionDecision>;
    try { decision = interruptionDecision(prefs, {
      now, timeZone: zone, candidateCreatedAt: candidate.createdAt,
      candidateExpiresAt: candidate.expiresAt, candidateDedupeKey: candidate.dedupeKey,
      lastSentAt: last, sentToday: count,
      dismissed: entry.state === "dismissed", muted: entry.state === "muted",
      stale: entry.state !== "active", alreadyDelivered: Boolean(reserved)
    }); } catch { return { status: "suppressed", reason: "invalid-policy" }; }
    if (decision.action !== "send") return { status: decision.action, reason: decision.reason };
    // Recheck evidence consent at delivery time: source revocation also applies
    // to suggestions already in the inbox. Missing provenance fails closed.
    if (candidate.ruleId.startsWith("payment-") && !(await this.signalSettings()).payment.enabled)
      return { status: "suppressed", reason: "source-not-authorized" };
    if (candidate.ruleId === "task-overdue" && !prefs.sources.daybook)
      return { status: "suppressed", reason: "source-not-authorized" };
    if (candidate.ruleId === "task-three-deferrals") {
      for (const eventId of candidate.evidenceEventIds) {
        const event = await this.ctx.storage.get<{ source: string }>("awareness:event:local:" + eventId);
        if (!event || !deferralSourceAllowed(prefs, event.source))
          return { status: "suppressed", reason: "source-not-authorized" };
      }
    }
    if (!pushConfigured(env)) return { status: "digest", reason: "push-not-configured" };
    // Reserve before network IO: prevents concurrent duplicate sends, even on provider timeout.
    await this.ctx.storage.put(dedupe, { at: now.toISOString() });
    await this.ctx.storage.put(daily, count + 1);
    await this.ctx.storage.put("awareness:delivery:last:local", now.toISOString());
    try {
      const url = (await this.appLink())?.replace(/#today$/, "#awareness");
      await sendNotice(env, { title: "Daybook Awareness", message: candidate.reason, url, tags: "bell" }, this.pruning);
      await new AwarenessHistory(this.ctx.storage).record("local", id, "sent");
      return { status: "sent", reason: "delivered" };
    } catch {
      // Keep the reservation. An uncertain provider response must not create duplicate pushes.
      await new AwarenessHistory(this.ctx.storage).record("local", id, "delivery-unconfirmed");
      return { status: "digest", reason: "delivery-unconfirmed" };
    }
  }

  /**
   * Send pending suggestions on the owner's behalf (#95). Runs right after a new suggestion is
   * created and from the hourly cron, so one held back by quiet hours, cooldown or the daily cap
   * goes out once it's allowed. Every gate (opt-in, mode, consent, quiet hours, budget, dedupe)
   * stays in awarenessDeliver; this only decides which suggestions to offer it. At most one push
   * per run, since the cooldown would hold back the rest anyway.
   */
  async awarenessDispatchPending(): Promise<{ sent: number; checked: number }> {
    const prefs = await this.awarenessPreferences();
    if (!prefs.enabled || prefs.paused || prefs.mode !== "proactive") return { sent: 0, checked: 0 };
    const { items } = await new AwarenessInbox(this.ctx.storage).list("local", { limit: 20 });
    let checked = 0;
    for (const entry of items) {
      if (entry.state !== "active") continue;
      const dedupe = "awareness:delivery:local:" + encodeURIComponent(entry.candidate.dedupeKey);
      if (await this.ctx.storage.get(dedupe)) continue; // already sent (or attempted)
      checked++;
      const result = await this.awarenessDeliver(entry.candidate.id);
      if (result.status === "sent") return { sent: 1, checked };
      // Held back for a reason that applies to every suggestion right now: stop and retry next hour.
      if (["quiet-hours", "daily-cap", "cooldown", "push-not-configured", "delivery-unconfirmed"].includes(result.reason)) break;
    }
    return { sent: 0, checked };
  }

  /** Awareness inbox stays within this installation's existing private Durable Object. */
  async awarenessHistoryList(limit = 100) {
    return new AwarenessHistory(this.ctx.storage).list("local", limit);
  }
  async awarenessHistoryErase() {
    return { deleted: await new AwarenessHistory(this.ctx.storage).erase("local") };
  }
  async awarenessHistoryPrune() {
    return { deleted: await new AwarenessHistory(this.ctx.storage).prune("local") };
  }

  async awarenessInboxList(limit = 20, cursor?: string) {
    return new AwarenessInbox(this.ctx.storage).list("local", { limit, cursor });
  }
  async awarenessInboxGet(id: string) {
    return new AwarenessInbox(this.ctx.storage).get("local", id);
  }
  async awarenessInboxAction(id: string, action: "dismiss" | "snooze" | "mute", until?: string) {
    const result = await new AwarenessInbox(this.ctx.storage).action("local", id, action, until);
    if (result) await new AwarenessHistory(this.ctx.storage).record("local", id, action === "snooze" ? "snoozed" : action === "mute" ? "muted" : "dismissed");
    return result;
  }
  async awarenessInboxAdd(candidate: InboxCandidate) {
    return new AwarenessInbox(this.ctx.storage).add("local", candidate);
  }

  /* ---------- Signals (#147): tap to pay ---------- */

  async signalSettings(): Promise<SignalSettings> {
    const saved = await this.ctx.storage.get<SignalSettings>("signals:settings");
    if (!saved) return DEFAULT_SIGNAL_SETTINGS;
    try { return parseSignalSettings(saved); } catch { return DEFAULT_SIGNAL_SETTINGS; }
  }
  async setSignalSettings(input: unknown): Promise<SignalSettings> {
    const settings = parseSignalSettings(input);
    await this.ctx.storage.put("signals:settings", settings);
    return settings;
  }
  private async payments(): Promise<Payment[]> {
    return [...(await this.ctx.storage.list<Payment>({ prefix: PAYMENT })).values()];
  }
  /** Today's and this week's totals from taps (for the app and briefings). */
  async signalSpend(now = Date.now()): Promise<SpendSummary> {
    const env = applySettings(this.env as unknown as Env, await this.getSettings());
    return spendSummary(await this.payments(), await this.signalSettings(), now, env.NOTES_TIMEZONE || DEFAULT_TIMEZONE);
  }
  /** The evening briefing's spend line, or null when the payment signal is off. */
  private async briefingSpend(now: number): Promise<{ today: number; count: number; week: number; hidden: boolean } | null> {
    const settings = await this.signalSettings();
    if (!settings.payment.enabled) return null;
    const s = await this.signalSpend(now);
    return { today: s.today, count: s.todayCount, week: s.weekTotal, hidden: settings.hideAmounts };
  }
  /** Erase every stored payment (Settings → Signals → Erase). */
  async signalErase(): Promise<{ deleted: number }> {
    const keys = [...(await this.ctx.storage.list({ prefix: PAYMENT })).keys()];
    for (let i = 0; i < keys.length; i += 128) await this.ctx.storage.delete(keys.slice(i, i + 128));
    return { deleted: keys.length };
  }

  /**
   * A tap to pay from the Shortcut. Off unless the owner turned the payment signal on. Idempotent by
   * payment id. Stores amount, currency, card label and category only, kept for 90 days. Suggestions
   * (big purchase, drink goal, spend target) go to the Awareness inbox when Awareness is on and not
   * paused, then through the usual delivery gates. Returns the log line the caller should append.
   */
  async recordPayment(payment: Payment): Promise<{ recorded: boolean; reason?: string; log: string | null; summary?: SpendSummary; suggestions: number }> {
    const settings = await this.signalSettings();
    if (!settings.payment.enabled) return { recorded: false, reason: "off", log: null, suggestions: 0 };
    const env = applySettings(this.env as unknown as Env, await this.getSettings());
    const zone = env.NOTES_TIMEZONE || DEFAULT_TIMEZONE;
    const key = PAYMENT + payment.id;
    if (await this.ctx.storage.get(key)) {
      return { recorded: false, reason: "duplicate", log: null, summary: spendSummary(await this.payments(), settings, payment.at, zone), suggestions: 0 };
    }
    await this.ctx.storage.put(key, payment);
    const all = await this.payments();
    const stale = all.filter(p => p.at < payment.at - PAYMENT_RETENTION_MS).map(p => PAYMENT + p.id);
    if (stale.length) await this.ctx.storage.delete(stale.slice(0, 128));
    const outcome = paymentOutcome(payment, all.filter(p => p.at >= payment.at - PAYMENT_RETENTION_MS), settings, zone);
    let created = 0;
    const prefs = await this.awarenessPreferences();
    if (prefs.enabled && !prefs.paused && outcome.suggestions.length) {
      const inbox = new AwarenessInbox(this.ctx.storage);
      for (const suggestion of outcome.suggestions) if ((await inbox.add("local", suggestion)).inserted) created++;
      if (created) {
        try { await this.awarenessDispatchPending(); }
        catch (e) { console.warn("Awareness dispatch failed", e instanceof Error ? e.message : "unknown"); }
      }
    }
    return { recorded: true, log: outcome.log, summary: outcome.summary, suggestions: created };
  }

  /**
   * Overdue nudges (#96), from the hourly scan of the notes. `tasks` are the open one-off dated tasks
   * (key and due time only, never titles). Adds a suggestion for each task overdue two days or more,
   * retires earlier overdue suggestions whose task was since done or given a new date, and offers new
   * ones for push in proactive mode. Needs Awareness on with the Daybook tasks source.
   */
  async recordOverdueTasks(tasks: { id: string; dueAt: number }[], now = new Date()): Promise<{ created: number; retired: number }> {
    const prefs = await this.awarenessPreferences();
    if (!prefs.enabled || prefs.paused || !prefs.sources.daybook) return { created: 0, retired: 0 };
    const env = applySettings(this.env as unknown as Env, await this.getSettings());
    const suggestions = deadlineSuggestions(tasks.slice(0, 2000).map(t => ({
      id: t.id, ownerId: "local", dueAt: new Date(t.dueAt).toISOString(), completed: false
    })).filter(t => Number.isFinite(Date.parse(t.dueAt))), { now, ownerId: "local", timeZone: env.NOTES_TIMEZONE || DEFAULT_TIMEZONE });
    const inbox = new AwarenessInbox(this.ctx.storage);
    let created = 0, retired = 0;
    for (const suggestion of suggestions) if ((await inbox.add("local", suggestion)).inserted) created++;
    // Still-current overdue suggestions are exactly the ones just produced; any other open one is stale.
    const current = new Set(suggestions.map(s => s.dedupeKey));
    const open = await this.ctx.storage.list<{ candidate: { id: string; ruleId: string; dedupeKey: string } }>({ prefix: "awareness:inbox:local:" });
    for (const entry of open.values()) {
      if (entry.candidate.ruleId !== "task-overdue" || current.has(entry.candidate.dedupeKey)) continue;
      if (await inbox.expire("local", entry.candidate.id, now.toISOString())) retired++;
    }
    if (created) {
      try { await this.awarenessDispatchPending(); }
      catch (e) { console.warn("Awareness dispatch failed", e instanceof Error ? e.message : "unknown"); }
    }
    return { created, retired };
  }

  /**
   * Internal, owner-local event capture. The global scheduler belongs to one
   * private Daybook installation. Suggestions go to the inbox; a push is offered only in proactive mode.
   * Keep this path free of Zod imports (Worker startup compatibility).
   */
  async recordTaskDeferrals(events: { id: string; taskId: string; fromDueAt: string; toDueAt: string }[], source: "daybook" | "appleReminders" = "daybook"): Promise<number> {
    if (source !== "daybook" && source !== "appleReminders") throw new Error("Invalid deferral source");
    // Apple is an external source: do not retain its evidence without consent.
    const preferences = await this.awarenessPreferences();
    if (source === "appleReminders" && (!preferences.enabled || preferences.paused || !preferences.sources.appleReminders)) return 0;
    let inserted = 0;
    for (const event of events.slice(0, 100)) {
      if (!/^[a-z0-9-]{1,160}$/.test(event.id) || !/^[a-z0-9]{4,12}$/.test(event.taskId) ||
        !Number.isFinite(Date.parse(event.fromDueAt)) || !Number.isFinite(Date.parse(event.toDueAt)) ||
        Date.parse(event.toDueAt) <= Date.parse(event.fromDueAt)) throw new Error("Invalid task deferral");
      const key = "awareness:event:local:" + event.id;
      const existing = await this.ctx.storage.get(key);
      if (existing) continue; // same committed transition, retried
      const now = new Date().toISOString();
      await this.ctx.storage.put(key, {
        id: event.id, ownerId: "local", occurredAt: now, observedAt: now,
        type: "task.deferred", source,
        subjectRef: { kind: "task", id: event.taskId },
        metadata: { taskId: event.taskId, fromDueAt: event.fromDueAt, toDueAt: event.toDueAt }
      });
      inserted++;
    }
    // Native Awareness rule. It never reads note text; pushes go through awarenessDeliver's gates.
    // Consent is checked after capture, so disabling Awareness cannot create suggestions.
    if (inserted > 0) {
      if (preferences.enabled && !preferences.paused && deferralSourceAllowed(preferences, source)) {
        const stored = await this.ctx.storage.list<DeferralEvidence & { source: string }>({ prefix: "awareness:event:local:" });
        const evidence = [...stored.values()].filter(e => e.ownerId === "local" && deferralSourceAllowed(preferences, e.source));
        const inbox = new AwarenessInbox(this.ctx.storage);
        let created = false;
        for (const suggestion of threeDeferrals(evidence, "local")) {
          if ((await inbox.add("local", suggestion)).inserted) created = true;
        }
        // Proactive mode only: offer the new suggestion for push. Never fails the capture.
        if (created) {
          try { await this.awarenessDispatchPending(); }
          catch (e) { console.warn("Awareness dispatch failed", e instanceof Error ? e.message : "unknown"); }
        }
      }
    }
    return inserted;
  }

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
    const settings = await this.ctx.storage.get<Settings>(SETTINGS);
    const webPush = await this.ctx.storage.get<WebPushState>(WEB_PUSH);
    return webPush?.subscriptions.length ? { ...settings, webPush } : settings;
  }

  async putSettings(settings: Settings): Promise<void> {
    // Devices are kept on their own (below), so saving settings never undoes a device turning notifications on.
    const { webPush: _devices, ...rest } = settings;
    await this.ctx.storage.put(SETTINGS, rest);
  }

  /** The app's push key (made once, on first use) and the devices with notifications on. */
  async webPush(): Promise<{ publicKey: string; devices: Subscription[] }> {
    let state = await this.ctx.storage.get<WebPushState>(WEB_PUSH);
    if (!state?.vapid) {
      state = { vapid: await generateVapidKeys(), subscriptions: state?.subscriptions ?? [] };
      await this.ctx.storage.put(WEB_PUSH, state);
    }
    return { publicKey: state.vapid!.publicKey, devices: state.subscriptions };
  }

  /** A device turned notifications on (or its browser renewed its subscription). */
  async addSubscription(sub: Subscription): Promise<Subscription[]> {
    const state = await this.ctx.storage.get<WebPushState>(WEB_PUSH);
    if (!state?.vapid) throw new Error("Push key missing; reload the app and try again");
    const subscriptions = [sub, ...state.subscriptions.filter(s => s.endpoint !== sub.endpoint)].slice(0, 20);
    await this.ctx.storage.put(WEB_PUSH, { ...state, subscriptions });
    return subscriptions;
  }

  /** Forget devices: turned off in Settings, or expired according to their push service. */
  async removeSubscriptions(endpoints: string[]): Promise<Subscription[]> {
    const state = await this.ctx.storage.get<WebPushState>(WEB_PUSH);
    if (!state) return [];
    const subscriptions = state.subscriptions.filter(s => !endpoints.includes(s.endpoint));
    await this.ctx.storage.put(WEB_PUSH, { ...state, subscriptions });
    return subscriptions;
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

  /**
   * Digest mode (#85): active suggestions not yet counted in a morning briefing. Empty unless
   * Awareness is on, not paused and set to digest.
   */
  async awarenessDigestPending(): Promise<string[]> {
    const prefs = await this.awarenessPreferences();
    if (!prefs.enabled || prefs.paused || prefs.mode !== "digest") return [];
    const { items } = await new AwarenessInbox(this.ctx.storage).list("local", { limit: 100 });
    const out: string[] = [];
    for (const entry of items) {
      if (entry.state !== "active") continue;
      if (await this.ctx.storage.get(DIGESTED + encodeURIComponent(entry.candidate.dedupeKey))) continue;
      out.push(entry.candidate.dedupeKey);
    }
    return out;
  }
  private async markDigested(keys: string[], at: number): Promise<void> {
    for (const k of keys) await this.ctx.storage.put(DIGESTED + encodeURIComponent(k), { at });
  }

  /** Build a briefing now from the live notes, without sending it. */
  async previewBriefing(kind: BriefingKind, now = Date.now()): Promise<Briefing> {
    const env = await this.briefingEnv();
    const settings = (await this.ctx.storage.get<BriefingSettings>(BRIEFINGS)) ?? DEFAULT_BRIEFINGS;
    const notes = await notesFor(env).all();
    const suggestions = kind === "morning" ? (await this.awarenessDigestPending()).length : 0;
    const spend = kind === "evening" ? await this.briefingSpend(now) : null;
    return buildBriefing({ kind, notes, done: await this.doneSince(now - 2 * 86_400_000), now, timeZone: this.zone(env), preview: settings.preview, name: env.OWNER_NAME, suggestions, spend });
  }

  /** Send a briefing right now (Settings' "Send test"). At most once a minute. */
  async testBriefing(kind: BriefingKind, origin?: string): Promise<Briefing> {
    const last = await this.ctx.storage.get<number>(BRIEF_TEST);
    if (last && Date.now() - last < 60_000) throw new Error("Wait a minute before sending another test");
    await this.ctx.storage.put(BRIEF_TEST, Date.now());
    const b = await this.previewBriefing(kind);
    await sendNotice(await this.briefingEnv(), { title: b.title, message: b.message, url: await this.appLink(origin), tags: "sunrise" }, this.pruning);
    return b;
  }

  private pruning: DeliveryOptions = { prune: async gone => { await this.removeSubscriptions(gone); } };

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
        notes ??= await notesFor(env).all();
        const digest = kind === "morning" ? await this.awarenessDigestPending() : [];
        const spend = kind === "evening" ? await this.briefingSpend(now) : null;
        const b = buildBriefing({ kind, notes, done: await this.doneSince(now - 2 * 86_400_000), now, timeZone: zone, preview: settings.preview, name: env!.OWNER_NAME, suggestions: digest.length, spend });
        if (b.empty) {
          await this.ctx.storage.put(briefSent(kind, date), { at: now });
          await advance({ at: now, result: "skipped", detail: "Nothing to report" });
          continue;
        }
        const url = await this.appLink();
        // Record the send only after the provider accepts it; a retry after that never resends.
        await sendOnce(false, () => sendNotice(env!, { title: b.title, message: b.message, url, tags: "sunrise" }, this.pruning),
          () => this.ctx.storage.put(briefSent(kind, date), { at: now }));
        // Counted once: tomorrow's briefing only mentions suggestions that arrive after this one.
        await this.markDigested(digest, now);
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

  /** Record which tasks Apple Reminders has (note + title), after a successful sync run. */
  async recordMirror(keys: string[], summary?: unknown): Promise<void> {
    await this.ctx.storage.put(SYNC_MIRROR, { at: Date.now(), keys, summary } satisfies SyncMirror);
  }

  async syncMirror(): Promise<SyncMirror | undefined> { return this.ctx.storage.get<SyncMirror>(SYNC_MIRROR); }

  async alarm(): Promise<void> {
    let failed = false;
    const origin = await this.ctx.storage.get<string>(ORIGIN);
    const settings = await this.getSettings();
    const env = applySettings(this.env as unknown as Env, settings);
    const mirror = await this.syncMirror();
    for (const [k, r] of await this.all()) {
      if (r.at > Date.now() + 1000) continue;
      try {
        const alreadyDone = await this.ctx.storage.get(doneKey(r.note, r.text, r.at));
        const alreadyDelivered = await this.ctx.storage.get(deliveredKey(r));
        if (!alreadyDone) {
          // Without a push provider the reminder still "goes off" (shows as due in the app) and repeats roll forward.
          // A task that's in Apple Reminders gets its alert from iOS; sending ours too would double it.
          if (pushConfigured(env) && !alreadyDelivered && !alertedByReminders(mirror, r, Date.now(), settings?.taskAlerts)) {
            await sendOnce(false, () => sendPush(env, r, origin, this.pruning), () => this.ctx.storage.put(deliveredKey(r), { at: r.at }));
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
