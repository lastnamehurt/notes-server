import { calendarTasks, dayStart, noteRevision, editCalendarTask } from "./calendar";
import { timedEntry, readSessions, timeSummary } from "./time-tracking";
import { normalizeLogType, typePath, withLogType, parseLogTypes } from "./log-types";
import { tasksFromNotes, changeTaskPriority } from "./priorities";
import { runDiagnostics } from "./diagnostics";
import { checkForUpdate, parseRepo, resetOwnRepo, runUpdate } from "./updates";
// Web app at /app: a phone-first UI over the same notes, logs and reminders the MCP tools use.
// Unlocked with MCP_BEARER_TOKEN; the session is an HMAC-signed, HttpOnly, SameSite=Strict cookie.

import { GithubNotes, CATEGORIES, type Category, type Env } from "./github";
import { appendLog, recentLogs, editLog, journalPath, journalWithActivity, LOG_PREFIX } from "./log";
import { scheduler, scheduleNote, loadSettings, saveSettings, rescan, checkPassword, completeReminder, addReminder, addTask, startOfToday, effectiveEnv } from "./core";
import { applySettings, cleanName, notesConfigured, type Settings } from "./settings";
import { listRepos, prepareRepo, startDeviceFlow, pollDeviceFlow, ensureNotesRepo, githubClientId, githubLogin, ownsNotesRepo, moveAppNotesToGithub } from "./setup";
import { AppNotes } from "./app-notes";
import { GithubNotes as GithubStore } from "./github";
import { makeZip } from "./zip";
import { sendPush } from "./reminders";
import { deviceName, validEndpoint, type Subscription } from "./web-push";
import { makeBackup, parseBackup, restoreMissing } from "./backup";
import { signSession, verifySession } from "./action";
import { APP_HTML, MANIFEST, SERVICE_WORKER } from "./ui";
import { pushConfigured, parseReminders, nextOccurrence } from "./reminder-parse";
import { runAppleSync, SyncError } from "./apple-sync-run";
import { notesFor } from "./storage";
import { taskDeferrals } from "./awareness-deferrals";
import { buildIcs, parseIcs } from "./ics";
import { b64url } from "./web-push";

/** Best-effort post-commit capture; a history failure must never undo a saved note. */
async function captureTaskDeferrals(env: Env, name: string, before: string, after: string): Promise<void> {
  const changes = taskDeferrals(before, after, env.NOTES_TIMEZONE || "America/Los_Angeles");
  if (!changes.length) return;
  const revision = await noteRevision(before + "\\u0000" + after + "\\u0000" + name);
  await scheduler(env).recordTaskDeferrals(changes.map((change, i) => ({
    ...change, id: "defer-" + revision.slice(0, 40) + "-" + i
  })));
}

const COOKIE = "notes_session";
const SESSION_DAYS = 30;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const fail = (message: string, status = 400) => json({ error: message }, status);

function cookie(request: Request, name: string): string {
  for (const part of (request.headers.get("Cookie") ?? "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return "";
}

const sessionCookie = (value: string, maxAge: number) =>
  `${COOKIE}=${encodeURIComponent(value)}; Path=/app; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff"
};

/** Tasks as the Shortcut and calendar feeds see them: title without the date text, and the due time if one is set. */
function exportableTasks(notes: { name: string; content: string }[], timezone: string) {
  return tasksFromNotes(notes).map(task => {
    const source = notes.find(n => n.name === task.note);
    const rawLine = source?.content.split("\n")[task.line] || "";
    const parsed = parseReminders(task.note, rawLine, timezone);
    const oneOff = parsed.find(rem => !rem.repeat);
    const title = task.text.replace(/\s+@\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\b/i, "").trim();
    const repeat = parsed.find(rem => rem.repeat);
    return { id: task.note + ":" + task.line, title, priority: task.priority,
      dueAt: oneOff ? new Date(oneOff.at).toISOString() : null,
      repeating: Boolean(repeat), sourceNote: task.note };
  });
}

/** Constant-time comparison of two secrets (hashed first, so lengths and prefixes don't leak). */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Subscribed calendar: only https addresses on public hostnames, fetched with a timeout and a size limit. */
function validCalendarUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const literal = /^[\d.]+$/.test(host) || host.includes(":") || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal");
  if (u.protocol !== "https:" || literal || u.href.length > 500) return null;
  return u.href;
}
const calendarCache = new Map<string, { at: number; text: string }>();

/** Check the Shortcuts secret (SHORTCUTS_TOKEN). Returns an error response, or null when allowed. */
async function shortcutAuth(request: Request, env: Env): Promise<Response | null> {
  if (!env.SHORTCUTS_TOKEN || env.SHORTCUTS_TOKEN.length < 32) return fail("Shortcut sync is not configured", 404);
  const supplied = request.headers.get("Authorization")?.replace(/^Bearer /i, "") ?? "";
  // Hash both inputs before comparison to avoid timing differences from prefix matches.
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [expected, actual] = await Promise.all([digest(env.SHORTCUTS_TOKEN), digest(supplied)]);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ actual[i];
  return diff === 0 ? null : fail("Unauthorized", 401);
}

export async function handleApp(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/app";
  if (!env.MCP_BEARER_TOKEN) return new Response("Server not configured: set MCP_BEARER_TOKEN (your password)", { status: 503 });

  if (path === "/app" && request.method === "GET") return new Response(APP_HTML, { headers: HTML_HEADERS });
  if (path === "/app/manifest.webmanifest")
    return new Response(MANIFEST, { headers: { "Content-Type": "application/manifest+json" } });
  // Shows notifications from this app (see sw.txt). Scoped to /app so it never sees Claude's sign-in pages.
  if (path === "/app/sw.js" && request.method === "GET")
    return new Response(SERVICE_WORKER, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache", "Service-Worker-Allowed": "/app" } });

  // Apple Reminders two-way sync, called by an iPhone Shortcut. Shortcuts sends no Origin header, so this
  // sits before the same-origin check and authenticates with its own secret instead of the app password.
  if (path === "/app/shortcuts/sync" && request.method === "POST") {
    const denied = await shortcutAuth(request, env);
    if (denied) return denied;
    const configured = await effectiveEnv(env);
    if (!notesConfigured(configured)) return fail("Notes not configured", 409);
    if (Number(request.headers.get("Content-Length") || 0) > 2_000_000) return fail("Request too large", 413);
    let body: unknown;
    try { body = await request.json(); } catch { return fail("Send the reminders as JSON", 400); }
    try {
      return json(await runAppleSync(body, {
        notes: notesFor(configured), scheduler: scheduler(configured), timeZone: configured.NOTES_TIMEZONE,
        url: id => url.origin + "/app#task/" + id,
        noteChanged: (name, content) => scheduleNote(configured, name, content),
        deferralsCommitted: events => scheduler(configured).recordTaskDeferrals(events)
      }));
    } catch (e) {
      if (e instanceof SyncError) return fail(e.message, e.status);
      return fail(e instanceof Error ? e.message : String(e), 502);
    }
  }

  // Calendar feed (iCalendar) of tasks with a due time. The secret in the address is the only way in.
  if (path === "/app/calendar.ics" && request.method === "GET") {
    const settings = await loadSettings(env, true);
    const token = new URL(request.url).searchParams.get("token") ?? "";
    if (!settings?.calendarToken || !token || !(await sameSecret(token, settings.calendarToken))) return fail("Not found", 404);
    const configured = await effectiveEnv(env);
    if (!notesConfigured(configured)) return fail("Notes not configured", 409);
    const timezone = configured.NOTES_TIMEZONE || "America/Los_Angeles";
    const tasks = exportableTasks(await notesFor(configured).all(), timezone).filter(t => t.dueAt);
    return new Response(buildIcs(tasks.map(t => ({ id: t.id, title: t.title, dueAt: t.dueAt!, note: t.sourceNote })), Date.now()), {
      headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": 'inline; filename="daybook.ics"' },
    });
  }

  // Read-only Shortcut feed. A separate secret avoids exposing the app/MCP password to Shortcuts.
  if (path === "/app/shortcuts/tasks" && request.method === "GET") {
    const denied = await shortcutAuth(request, env);
    if (denied) return denied;
    const configured = await effectiveEnv(env);
    if (!notesConfigured(configured)) return fail("Notes not configured", 409);
    const notes = await notesFor(configured).all();
    const timezone = configured.NOTES_TIMEZONE || "America/Los_Angeles";
    const exported = exportableTasks(notes, timezone);
    return json({ version: 1, timezone, tasks: exported });

  }

  // Mutating requests must come from this origin (SameSite=Strict already blocks cross-site cookies).
  if (request.method !== "GET" && request.headers.get("Origin") !== url.origin) return fail("Bad origin", 403);

  // Which single sign-in the lock screen shows: GitHub once notes are set up, the password before that.
  if (path === "/app/login/info" && request.method === "GET") {
    const configured = await effectiveEnv(env);
    return json({ method: configured.NOTES_STORAGE !== "app" && configured.NOTES_REPO ? "github" : "password" });
  }
  if (path === "/app/login" && request.method === "POST") {
    const { key } = await request.json<{ key?: string }>().catch(() => ({ key: "" }));
    const problem = await checkPassword(env, key ?? "");
    if (problem) return fail(problem, 401);
    const value = await signSession(env.MCP_BEARER_TOKEN, Date.now() + SESSION_DAYS * 86_400_000);
    return new Response(null, { status: 204, headers: { "Set-Cookie": sessionCookie(value, SESSION_DAYS * 86_400) } });
  }
  // Sign in with GitHub, as the owner of the notes repository. The token only proves who approved; it is not kept.
  if (path === "/app/login/github/start" && request.method === "POST") {
    const s = scheduler(env);
    const configured = await effectiveEnv(env);
    if (!configured.NOTES_REPO) return fail("Sign in with your password until your notes are set up.", 409);
    if (!(await s.passwordAttemptAllowed())) return fail("Too many wrong passwords. Wait 15 minutes and try again.", 429);
    try {
      const flow = await startDeviceFlow(env, "");
      return json({ userCode: flow.userCode, verificationUri: flow.verificationUri, interval: flow.interval, deviceCode: flow.deviceCode });
    } catch (err) {
      return fail((err as Error).message, 502);
    }
  }
  if (path === "/app/login/github/poll" && request.method === "POST") {
    const { deviceCode } = await request.json<{ deviceCode?: string }>().catch(() => ({ deviceCode: "" }));
    if (!deviceCode) return fail("Start sign-in again.", 400);
    const result = await pollDeviceFlow(env, deviceCode);
    if (result.state === "pending") return json({ state: "pending", interval: result.interval });
    if (result.state === "failed") return json(result);
    const configured = await effectiveEnv(env);
    const login = await githubLogin(env, result.token);
    if (!ownsNotesRepo(login, configured.NOTES_REPO)) {
      await scheduler(env).recordPasswordFailure();
      return json({ state: "failed", message: `That GitHub account (${login}) doesn't own these notes. Sign in as the owner, or use your password.` });
    }
    const value = await signSession(env.MCP_BEARER_TOKEN, Date.now() + SESSION_DAYS * 86_400_000);
    return new Response(JSON.stringify({ state: "done" }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": sessionCookie(value, SESSION_DAYS * 86_400) }
    });
  }
  if (path === "/app/logout" && request.method === "POST")
    return new Response(null, { status: 204, headers: { "Set-Cookie": sessionCookie("", 0) } });

  if (!path.startsWith("/app/api/")) return fail("Not found", 404);
  if (!(await verifySession(env.MCP_BEARER_TOKEN, cookie(request, COOKIE)))) return fail("Locked", 401);

  const route = request.method + " " + path.slice("/app/api".length);
  try {
    // Setup page: works before notes are configured.
    switch (route) {
      case "GET /awareness/preferences": return json(await scheduler(env).awarenessPreferences());
      case "PUT /awareness/preferences": {
        const body: unknown = await request.json();
        return json(await scheduler(env).setAwarenessPreferences(body));
      }
      case "POST /awareness/deliver": {
        const body = await request.json<{ id?: string }>();
        if (!body.id || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/.test(body.id)) return fail("Invalid Awareness candidate");
        return json(await scheduler(env).awarenessDeliver(body.id));
      }
      case "GET /awareness/history": {
        const limit = Number(url.searchParams.get("limit") ?? "100");
        return json(await scheduler(env).awarenessHistoryList(limit));
      }
      case "POST /awareness/history/prune": {
        return json(await scheduler(env).awarenessHistoryPrune());
      }
      case "DELETE /awareness/history": {
        return json(await scheduler(env).awarenessHistoryErase());
      }
      case "GET /awareness/inbox": {
        const limit = Number(url.searchParams.get("limit") ?? "20");
        const cursor = url.searchParams.get("cursor") || undefined;
        return json(await scheduler(env).awarenessInboxList(limit, cursor));
      }
      case "GET /awareness/item": {
        const id = url.searchParams.get("id") ?? "";
        const item = await scheduler(env).awarenessInboxGet(id);
        return item ? json(item) : fail("Awareness item not found", 404);
      }
      case "POST /awareness/action": {
        const body = await request.json<{ id?: string; action?: string; until?: string }>();
        if (!body.id || !["dismiss", "snooze", "mute"].includes(body.action ?? "")) return fail("Invalid Awareness action");
        const item = await scheduler(env).awarenessInboxAction(body.id, body.action as "dismiss" | "snooze" | "mute", body.until);
        return item ? json(item) : fail("Awareness item not found", 404);
      }
      case "GET /update": return json(await checkForUpdate(env));
      // Settings → Your name. Works on every server, including ones configured on the deployment.
      case "POST /profile": {
        const { name } = await request.json<{ name?: string }>();
        const prev = (await loadSettings(env, true)) ?? {};
        const clean = cleanName(name);
        await saveSettings(env, { ...prev, name: clean || undefined });
        return json({ name: clean || null });
      }
      case "POST /update/run": return json(await runUpdate(env));
      case "POST /update/repo": {
        const { repo } = await request.json<{ repo?: string }>();
        const name = parseRepo(repo || "");
        if (!name) return fail("Enter it like yourname/notes-server, or paste its GitHub address.");
        await saveSettings(env, { ...((await loadSettings(env, true)) ?? {}), codeRepo: name });
        resetOwnRepo();
        return json({ repo: name });
      }
      case "GET /config": return json({
        timeZone: env.NOTES_TIMEZONE || "America/Los_Angeles", categories: CATEGORIES, push: pushConfigured(env),
        configured: notesConfigured(env), canSetup: !env.DEPLOY_CONFIGURED, githubConnect: Boolean(githubClientId(env)),
        storage: env.DEPLOY_CONFIGURED ? "github" : (env.NOTES_STORAGE ?? null), appStorage: Boolean(env.NOTES),
        name: env.OWNER_NAME?.trim() || null,
        notesRepo: env.NOTES_STORAGE !== "app" && notesConfigured(env) ? env.NOTES_REPO?.trim() || null : null
      });
      case "GET /settings": {
        const s = (await loadSettings(env, true)) ?? {};
        return json({ storage: env.DEPLOY_CONFIGURED ? "github" : (env.NOTES_STORAGE ?? null), appStorage: Boolean(env.NOTES),
          notesRepo: s.notesRepo ?? null, timezone: s.timezone ?? null, hasToken: Boolean(s.githubToken),
          notify: s.pushoverUser ? "pushover" : s.ntfyTopic ? "ntfy" : null, ntfyTopic: s.ntfyTopic ?? null });
      }
      case "POST /setup/repos": {
        if (env.DEPLOY_CONFIGURED) return fail("This server's notes are set in its deployment settings.", 409);
        const { token } = await request.json<{ token?: string }>();
        const key = token?.trim() || (await loadSettings(env, true))?.githubToken;
        if (!key) return fail("Paste your GitHub access key first.");
        return json(await listRepos(env, key));
      }
      case "POST /setup/github/start": {
        if (env.DEPLOY_CONFIGURED) return fail("This server's notes are set in its deployment settings.", 409);
        const flow = await startDeviceFlow(env);
        await scheduler(env).setDeviceFlow({ deviceCode: flow.deviceCode, expiresAt: flow.expiresAt });
        return json({ userCode: flow.userCode, verificationUri: flow.verificationUri, interval: flow.interval, expiresAt: flow.expiresAt });
      }
      case "POST /setup/github/poll": {
        if (env.DEPLOY_CONFIGURED) return fail("This server's notes are set in its deployment settings.", 409);
        const s = scheduler(env);
        const pending = await s.getDeviceFlow();
        if (!pending || pending.expiresAt < Date.now()) return json({ state: "failed", message: "The code expired. Tap Connect GitHub to get a new one." });
        const result = await pollDeviceFlow(env, pending.deviceCode);
        if (result.state !== "done") {
          if (result.state === "failed") await s.setDeviceFlow(null);
          return json(result);
        }
        await s.setDeviceFlow(null);
        const { timezone, move } = await request.json<{ timezone?: string; move?: boolean }>().catch(() => ({ timezone: undefined, move: false }));
        const prev = (await loadSettings(env, true)) ?? {};
        // Settings → Move my notes to GitHub: copy everything into a new private repo, then switch.
        if (move) {
          if (env.NOTES_STORAGE !== "app") return json({ state: "failed", message: "Your notes are already on GitHub." });
          const appNotes = await new AppNotes(env).snapshot();
          const moved = await moveAppNotesToGithub(env, result.token, appNotes, (repo, branch) =>
            new GithubStore({ ...env, GITHUB_TOKEN: result.token, NOTES_REPO: repo, NOTES_BRANCH: branch, NOTES_STORAGE: "github" }));
          const next: Settings = { ...prev, storage: "github", githubToken: result.token, notesRepo: moved.repo, notesBranch: moved.branch };
          await saveSettings(env, next);
          await rescan(applySettings({ ...env, GITHUB_TOKEN: "", NOTES_REPO: "", NOTES_BRANCH: undefined, NOTES_STORAGE: undefined }, next)).catch(() => 0);
          return json({ state: "done", repo: moved.repo, moved: moved.moved });
        }
        // Connected during setup: find or create a private "notes" repository and save it right away.
        const { repo, created } = await ensureNotesRepo(env, result.token);
        const { branch } = await prepareRepo(env, result.token, repo);
        let tz = prev.timezone || "America/Los_Angeles";
        if (timezone) try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); tz = timezone; } catch { /* keep */ }
        await saveSettings(env, { ...prev, storage: "github", githubToken: result.token, notesRepo: repo, notesBranch: branch, timezone: tz });
        return json({ state: "done", repo, created });
      }
      case "POST /setup": {
        const body = await request.json<{ storage?: "app" | "github"; token?: string; repo?: string; timezone?: string; ntfyTopic?: string; pushoverUser?: string; pushoverToken?: string }>();
        const prev = (await loadSettings(env, true)) ?? {};
        const timezone = body.timezone?.trim() || prev.timezone || "America/Los_Angeles";
        try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { return fail("Unknown time zone " + timezone); }
        const topic = body.ntfyTopic?.trim();
        if (topic && !/^[A-Za-z0-9_-]{20,64}$/.test(topic)) return fail("Notification topic must be 20 to 64 letters, digits, - or _ (long, so nobody can guess it).");
        // ntfy/Pushover are older options: only changed when the page sent them (it shows them only to setups that use them).
        const legacyGiven = ["ntfyTopic", "pushoverUser", "pushoverToken"].some(k => k in body);
        const pushSettings = legacyGiven
          ? { ntfyTopic: topic || undefined,
              pushoverUser: body.pushoverUser === undefined ? prev.pushoverUser : body.pushoverUser.trim() || undefined,
              pushoverToken: body.pushoverToken === undefined ? prev.pushoverToken : body.pushoverToken.trim() || undefined }
          : { ntfyTopic: prev.ntfyTopic, pushoverUser: prev.pushoverUser, pushoverToken: prev.pushoverToken };
        // Notes set on the deployment: Settings still saves the time zone and notification choices.
        if (env.DEPLOY_CONFIGURED) {
          await saveSettings(env, { ...prev, timezone, ...pushSettings });
          return json({ ok: true, storage: "github" });
        }
        // Notes kept in this app: nothing to connect. (Moving to GitHub later is in Settings.)
        const storage = body.storage ?? prev.storage ?? (prev.notesRepo ? "github" : "app");
        if (storage === "app") {
          if (!env.NOTES) return fail("This copy of the app can't store notes itself yet. Update it, or connect GitHub.");
          const settings: Settings = { ...prev, storage: "app", timezone, ...pushSettings };
          await saveSettings(env, settings);
          const reminders = await rescan(applySettings({ ...env, GITHUB_TOKEN: "", NOTES_REPO: "", NOTES_TIMEZONE: undefined, NOTES_BRANCH: undefined, NOTES_STORAGE: undefined }, settings)).catch(() => 0);
          return json({ ok: true, storage: "app", reminders });
        }
        const token = body.token?.trim() || prev.githubToken;
        if (!token) return fail("Paste your GitHub access key first.");
        const repo = (body.repo ?? "").trim();
        const { branch } = await prepareRepo(env, token, repo);
        const settings: Settings = { storage: "github", githubToken: token, notesRepo: repo, notesBranch: branch, timezone, codeRepo: prev.codeRepo, name: prev.name, ...pushSettings };
        await saveSettings(env, settings);
        // Schedule reminders already written in the notes (e.g. a repository moved from another server).
        const reminders = await rescan(applySettings({ ...env, GITHUB_TOKEN: "", NOTES_REPO: "", NOTES_TIMEZONE: undefined, NOTES_BRANCH: undefined, NOTES_STORAGE: undefined }, settings)).catch(() => 0);
        return json({ ok: true, repo, branch, reminders });
      }
      case "POST /test-push": {
        // Fresh settings: a device that just turned notifications on may be newer than this copy's cache.
        const fresh = applySettings(env, await loadSettings(env, true));
        await sendPush(fresh, { note: "Setup", text: "Test notification from Daybook ✓", at: Date.now() }, url.origin,
          { prune: async gone => { await scheduler(env).removeSubscriptions(gone); }, test: true });
        return json({ ok: true });
      }
      // Notifications on this device (web push): the app's public key and the devices that have them on.
      case "GET /push": {
        const { publicKey, devices } = await scheduler(env).webPush();
        return json({ publicKey, devices: devices.map(d => ({ endpoint: d.endpoint, device: d.device, added: d.added })),
          legacy: { ntfy: Boolean(env.NTFY_TOPIC), pushover: Boolean(env.PUSHOVER_TOKEN && env.PUSHOVER_USER) } });
      }
      case "POST /push/subscribe": {
        const { subscription: sub, replaces } = await request.json<{ subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }; replaces?: string }>();
        if (!sub?.endpoint || !validEndpoint(sub.endpoint, env.PUSH_ALLOW_HTTP === "true") || !sub.keys?.p256dh || !sub.keys?.auth)
          return fail("This browser sent an incomplete notification subscription. Try again.");
        const s = scheduler(env);
        await s.webPush(); // make sure the key exists
        if (replaces && replaces !== sub.endpoint) await s.removeSubscriptions([replaces]);
        const devices = await s.addSubscription({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
          device: deviceName(request.headers.get("User-Agent") ?? ""), added: Date.now() } satisfies Subscription);
        await loadSettings(env, true);
        return json({ devices: devices.map(d => ({ endpoint: d.endpoint, device: d.device, added: d.added })) });
      }
      // AI assistants connected to Daybook (OAuth grants), and a way to disconnect one.
      case "GET /assistants": {
        const oauth = (env as any).OAUTH_PROVIDER;
        if (!oauth) return json({ assistants: [] });
        const { items } = await oauth.listUserGrants("notes-owner", { limit: 50 });
        const assistants = await Promise.all(items.map(async (g: any) => {
          const client = await oauth.lookupClient(g.clientId).catch(() => null);
          return { id: g.id, name: client?.clientName || "Unnamed assistant", logo: client?.logoUri || null, since: g.createdAt };
        }));
        return json({ assistants });
      }
      case "POST /assistants/disconnect": {
        const { id } = await request.json<{ id?: string }>();
        const oauth = (env as any).OAUTH_PROVIDER;
        if (!id || !oauth) return fail("Which assistant?");
        await oauth.revokeGrant(id, "notes-owner");
        return json({ ok: true });
      }
      // Calendar: a private feed of your tasks (regenerate to revoke), and one subscribed calendar to read.
      case "POST /calendar/token": {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const token = b64url(bytes);
        const prev = (await loadSettings(env, true)) ?? {};
        await saveSettings(env, { ...prev, calendarToken: token });
        return json({ url: new URL(request.url).origin + "/app/calendar.ics?token=" + token });
      }
      case "POST /calendar/feed": {
        const { url } = await request.json<{ url?: string }>();
        const prev = (await loadSettings(env, true)) ?? {};
        if (!url?.trim()) { calendarCache.clear(); await saveSettings(env, { ...prev, calendarFeed: undefined }); return json({ url: null }); }
        const clean = validCalendarUrl(url);
        if (!clean) return fail("Paste the calendar's secret address, starting with https://");
        calendarCache.clear();
        await saveSettings(env, { ...prev, calendarFeed: clean });
        return json({ url: clean });
      }
      case "GET /calendar/upcoming": {
        const settings = await loadSettings(env, true);
        if (!settings?.calendarFeed) return json({ events: [], connected: false });
        const cached = calendarCache.get(settings.calendarFeed);
        let text: string;
        if (cached && Date.now() - cached.at < 15 * 60_000) text = cached.text;
        else {
          try {
            const res = await fetch(settings.calendarFeed, { signal: AbortSignal.timeout(8000), redirect: "follow" });
            if (!res.ok) return fail("Your calendar didn't answer (" + res.status + "). Check the address.", 502);
            const length = Number(res.headers.get("content-length") ?? 0);
            if (length > 2_000_000) return fail("That calendar is too large to read.", 502);
            text = await res.text();
          } catch { return fail("Couldn't reach your calendar. Check the address and your connection.", 502); }
          calendarCache.set(settings.calendarFeed, { at: Date.now(), text });
        }
        try {
          const configured = await effectiveEnv(env);
          const events = parseIcs(text, { days: 14, zone: configured.NOTES_TIMEZONE || "America/Los_Angeles" });
          return json({ connected: true, events: events.slice(0, 30).map(e => ({ title: e.title, start: e.start, end: e.end, allDay: e.allDay })) });
        } catch (e) { return fail(e instanceof Error ? e.message : String(e), 502); }
      }
      case "POST /push/unsubscribe": {
        const { endpoint } = await request.json<{ endpoint?: string }>();
        if (!endpoint) return fail("Which device?");
        const devices = await scheduler(env).removeSubscriptions([endpoint]);
        await loadSettings(env, true);
        return json({ devices: devices.map(d => ({ endpoint: d.endpoint, device: d.device, added: d.added })) });
      }
    }
    if (!notesConfigured(env)) return fail("Finish setup first.", 409);
    const notes = notesFor(env);
    switch (route) {
      // Settings → Download all my notes: every note as plain Markdown files in a zip, from either storage.
      case "GET /export": {
        const zip = makeZip(await notes.snapshot());
        const day = new Date().toISOString().slice(0, 10);
        return new Response(zip as unknown as BodyInit, { headers: { "Content-Type": "application/zip", "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="daybook-notes-${day}.zip"` } });
      }
      case "GET /briefings": return json(await scheduler(env).getBriefings());
      case "PUT /briefings": {
        const { settings, revision } = await request.json<{ settings: unknown; revision: number }>();
        try { return json(await scheduler(env).setBriefings(settings, Number(revision))); }
        catch (e) { const m = e instanceof Error ? e.message : String(e); return fail(m, /changed elsewhere/.test(m) ? 409 : 400); }
      }
      case "POST /briefings/preview":
      case "POST /briefings/test": {
        const { kind } = await request.json<{ kind: string }>();
        if (kind !== "morning" && kind !== "evening") return fail('kind must be "morning" or "evening"');
        if (route === "POST /briefings/preview") return json(await scheduler(env).previewBriefing(kind));
        try { return json(await scheduler(env).testBriefing(kind, url.origin)); }
        catch (e) { const m = e instanceof Error ? e.message : String(e); return fail(m, /Wait a minute/.test(m) ? 429 : 502); }
      }
      case "GET /calendar": {
        const zone = env.NOTES_TIMEZONE || "America/Los_Angeles";
        const from = url.searchParams.get("from") || "", to = url.searchParams.get("to") || "";
        const tasks = await calendarTasks(await notes.all(), from, to, zone);
        const done = await scheduler(env).doneSince(dayStart(from, zone));
        for (const task of tasks) if (task.repeating) task.occurrences = task.occurrences.filter(r => !done.some(d => d.note === r.note && d.text === r.text && d.at === r.at));
        return json({ tasks, timeZone: zone });
      }
      case "POST /calendar/task": {
        const { name, line, revision, schedule, priority, done, at } = await request.json<{name:string;line:number;revision:string;schedule?:string;priority?:"do"|"plan"|"delegate"|"someday"|"inbox";done?:boolean;at?:number}>();
        if (!Number.isSafeInteger(line) || line < 0) return fail("Choose a valid task");
        const current = await notes.get(name);
        if (!revision || await noteRevision(current.content) !== revision) return fail("Note changed; refresh Tasks and try again", 409);
        const raw = current.content.split("\n")[line];
        const parsed = parseReminders(name, raw || "", env.NOTES_TIMEZONE);
        if (done && parsed[0]?.repeat) {
          if (!Number.isFinite(at)) return fail("Choose a repeating occurrence to complete");
          const reminder = parsed.find(r => r.repeat && nextOccurrence(r.repeat,env.NOTES_TIMEZONE || "America/Los_Angeles",at! - 1) === at);
          if (!reminder) return fail("That occurrence is no longer scheduled; refresh Tasks");
          return json(await completeReminder(env,name,reminder.text,at));
        }
        const updated = editCalendarTask(current.content,line,{schedule,priority,done},env.NOTES_TIMEZONE || "America/Los_Angeles");
        await notes.update(name,updated,current.sha);
        await captureTaskDeferrals(env, name, current.content, updated).catch(e => console.error("Awareness capture failed", e));
        const result = await scheduleNote(env,name,updated);
        if (done && parsed.length) {
          await appendLog(notes,"✓ " + parsed[0].text + " #done",{timeZone:env.NOTES_TIMEZONE});
          for (const reminder of parsed) await scheduler(env).markDone(name,reminder.text,reminder.at);
        }
        return json(result);
      }
      case "GET /priorities": return json(tasksFromNotes(await notes.all()).map(task => {
        const parsed = parseReminders(task.note, "- [ ] " + task.text, env.NOTES_TIMEZONE);
        const oneOff = parsed.find(r => !r.repeat);
        return {...task, dueAt:oneOff?.at ?? null, title:parsed[0]?.text ?? task.text};
      }));
      case "POST /priorities": {
        const { name, line, priority, sha } = await request.json<{name:string;line:number;priority:"do"|"plan"|"delegate"|"someday"|"inbox";sha?:string}>();
        const current = await notes.get(name);
        if (!sha || current.sha !== sha) return fail("Note changed; refresh and try again", 409);
        const updated = changeTaskPriority(current.content, line, priority);
        return json(await notes.update(name, updated, sha));
      }
      case "GET /notes": return json(await notes.list());
      case "GET /note": {
        const name = url.searchParams.get("name") ?? "";
        const { content, sha } = await notes.get(name);
        return json({ name, content, sha });
      }
      case "POST /note": {
        const { content, category } = await request.json<{ content: string; category: string }>();
        if (!CATEGORIES.includes(category as Category)) return fail("Pick a folder for the note");
        return json(await scheduleNote(env, await notes.save(content, category as Category), content));
      }
      case "PUT /note": {
        const { name, content, sha } = await request.json<{ name: string; content: string; sha?: string }>();
        const current = await notes.get(name);
        const saved = await notes.update(name, content, sha);
        await captureTaskDeferrals(env, name, current.content, content).catch(e => console.error("Awareness capture failed", e));
        return json(await scheduleNote(env, saved, content));
      }
      case "DELETE /note": {
        const name = url.searchParams.get("name") ?? "";
        await notes.delete(name);
        await scheduler(env).removeNote(name);
        return json({ name });
      }
      case "GET /backup": {
        const backup = makeBackup(await notes.all());
        return new Response(JSON.stringify(backup), { headers: {
          "Content-Type": "application/json", "Content-Disposition": "attachment; filename=notes-backup.json",
          "Cache-Control": "no-store" } });
      }
      case "POST /restore": {
        const backup = parseBackup(await request.json());
        const existing = new Set(await notes.list());
        const restored = await restoreMissing(backup, existing, (name, content) => notes.put(name, content));
        await rescan(env);
        return json({ restored });
      }
      case "GET /diagnostics": return json(await runDiagnostics(env));
      case "GET /health": {
        const [github, pushError] = await Promise.allSettled([notes.list(), scheduler(env).lastError()]);
        return json({ github: github.status === "fulfilled" ? "ok" : "error",
          reminders: pushError.status === "fulfilled" ? (pushError.value ? "degraded" : "ok") : "error",
          pushConfigured: pushConfigured(env),
          noteCount: github.status === "fulfilled" ? github.value.length : null }, github.status === "fulfilled" ? 200 : 503);
      }
      case "GET /search": return json(await notes.search(url.searchParams.get("q") ?? ""));
      case "POST /time-session": {
        const {type,entry,start,end}=await request.json<{type:string;entry:string;start:string;end:string}>();
        const line=timedEntry(entry,type,start,end);
        const stamp=new Date(start);
        const date=new Intl.DateTimeFormat("en-CA",{timeZone:env.NOTES_TIMEZONE||"America/Los_Angeles",year:"numeric",month:"2-digit",day:"2-digit"}).format(stamp);
        const time=new Intl.DateTimeFormat("en-GB",{timeZone:env.NOTES_TIMEZONE||"America/Los_Angeles",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(stamp);
        return json(await appendLog(notes,line,{date,time,timeZone:env.NOTES_TIMEZONE}));
      }
      case "GET /time-summary": {
        const now=Date.now();
        const from=url.searchParams.get("from")||new Date(now-7*86400000).toISOString();
        const to=url.searchParams.get("to")||new Date(now).toISOString();
        return json(timeSummary(readSessions(await notes.all(undefined,"journal/log/")),from,to));
      }
      case "GET /log-types": return json(parseLogTypes(await notes.all()));
      case "POST /log-types": {
        const { name } = await request.json<{name:string}>();
        const type = normalizeLogType(name);
        const path = typePath(type);
        try { await notes.get(path); return fail("Log type already exists", 409); }
        catch (e) { if (!(e instanceof Error && e.message.startsWith("Note or notes repository not found"))) throw e; }
        await notes.put(path, "# " + type + "\n");
        return json({name:type});
      }
      case "POST /typed-log": {
        const { entry, type, date, time } = await request.json<{entry:string;type:string;date?:string;time?:string}>();
        return json(await appendLog(notes, withLogType(entry,type), {date,time,timeZone:env.NOTES_TIMEZONE}));
      }
      case "POST /log": {
        const { entry, date, time } = await request.json<{ entry: string; date?: string; time?: string }>();
        return json(await appendLog(notes, entry, { date, time, timeZone: env.NOTES_TIMEZONE }));
      }
      case "GET /logs": return json(await recentLogs(notes, Number(url.searchParams.get("days") ?? 7), env.NOTES_TIMEZONE));
      case "GET /journal/backfill": {
        const logs = (await notes.all(undefined, LOG_PREFIX))
          .filter(n => /^journal\/log\/\d{4}-\d{2}-\d{2}\.md$/.test(n.name))
          .sort((a, b) => a.name.localeCompare(b.name));
        const journals = new Map((await notes.all(undefined, "journal/daily/")).map(n => [n.name, n.content]));
        const pending = logs.filter(n => {
          const date = n.name.slice(LOG_PREFIX.length, -3);
          const current = journals.get(journalPath(date)) ?? null;
          return current !== journalWithActivity(current, date, n.content);
        });
        return json({ total: logs.length, pending: pending.length, dates: pending.map(n => n.name.slice(LOG_PREFIX.length, -3)) });
      }
      case "POST /journal/backfill": {
        const { dates } = await request.json<{ dates?: string[] }>();
        if (!Array.isArray(dates) || dates.length === 0 || dates.length > 10 ||
            dates.some(d => typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) ||
            new Set(dates).size !== dates.length) return fail("Choose 1–10 distinct journal dates", 400);
        const results: { date: string; status: string; error?: string }[] = [];
        for (const date of dates) {
          try {
            const source = await notes.get(LOG_PREFIX + date + ".md");
            const path = journalPath(date);
            let status = "unchanged";
            for (let attempt = 0; attempt < 3; attempt++) {
              let current: { content: string; sha: string } | null = null;
              try { current = await notes.get(path); }
              catch (e) { if (!(e instanceof Error && e.message.startsWith("Note or notes repository not found"))) throw e; }
              const next = journalWithActivity(current?.content ?? null, date, source.content);
              if (current?.content === next) break;
              try {
                await notes.put(path, next, current?.sha);
                status = current ? "updated" : "created";
                break;
              } catch (e) {
                if (!(e instanceof Error && e.message.startsWith("GitHub conflict")) || attempt === 2) throw e;
              }
            }
            results.push({ date, status });
          } catch (e) {
            results.push({ date, status: "failed", error: e instanceof Error ? e.message : "Unknown error" });
          }
        }
        return json({ results });
      }

      case "GET /reminders": {
        // Upcoming, plus what already went off today and what was marked done, so Today can show both.
        const since = startOfToday(env);
        const s = scheduler(env);
        return json({ upcoming: await s.upcoming(), firedToday: await s.firedSince(since), doneToday: await s.doneSince(since) });
      }
      case "POST /reminder": return json(await addReminder(env, await request.json()));
      case "POST /task": return json(await addTask(env, await request.json()));
      case "POST /complete": {
        const { note, text, at } = await request.json<{ note: string; text: string; at?: number }>();
        return json(await completeReminder(env, note, text, typeof at === "number" ? at : undefined));
      }
      case "POST /log/edit": return json(await editLog(notes, await request.json()));
      case "GET /goals": {
        const out = await notes.all(undefined, "goals/");
        return json(out);
      }
    }
    return fail("Not found", 404);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Something went wrong");
  }
}
