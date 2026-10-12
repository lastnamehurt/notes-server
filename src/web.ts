import { tasksFromNotes, changeTaskPriority } from "./priorities";
import { runDiagnostics } from "./diagnostics";
// Web app at /app: a phone-first UI over the same notes, logs and reminders the MCP tools use.
// Unlocked with MCP_BEARER_TOKEN; the session is an HMAC-signed, HttpOnly, SameSite=Strict cookie.

import { GithubNotes, CATEGORIES, type Category, type Env } from "./github";
import { appendLog, recentLogs, editLog } from "./log";
import { scheduler, scheduleNote, loadSettings, saveSettings, rescan, checkPassword, completeReminder, addReminder, startOfToday, effectiveEnv } from "./core";
import { applySettings, notesConfigured, type Settings } from "./settings";
import { listRepos, prepareRepo, startDeviceFlow, pollDeviceFlow, ensureNotesRepo, githubClientId, githubLogin, ownsNotesRepo } from "./setup";
import { sendPush } from "./reminders";
import { makeBackup, parseBackup, restoreMissing } from "./backup";
import { signSession, verifySession } from "./action";
import { APP_HTML, MANIFEST } from "./ui";
import { pushConfigured } from "./reminder-parse";

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
  "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff"
};

export async function handleApp(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/app";
  if (!env.MCP_BEARER_TOKEN) return new Response("Server not configured: set MCP_BEARER_TOKEN (your password)", { status: 503 });

  if (path === "/app" && request.method === "GET") return new Response(APP_HTML, { headers: HTML_HEADERS });
  if (path === "/app/manifest.webmanifest")
    return new Response(MANIFEST, { headers: { "Content-Type": "application/manifest+json" } });

  // Mutating requests must come from this origin (SameSite=Strict already blocks cross-site cookies).
  if (request.method !== "GET" && request.headers.get("Origin") !== url.origin) return fail("Bad origin", 403);

  // Which single sign-in the lock screen shows: GitHub once notes are set up, the password before that.
  if (path === "/app/login/info" && request.method === "GET") {
    const configured = await effectiveEnv(env);
    return json({ method: configured.NOTES_REPO ? "github" : "password" });
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
      case "GET /config": return json({
        timeZone: env.NOTES_TIMEZONE || "America/Los_Angeles", categories: CATEGORIES, push: pushConfigured(env),
        configured: notesConfigured(env), canSetup: !env.DEPLOY_CONFIGURED, githubConnect: Boolean(githubClientId(env))
      });
      case "GET /settings": {
        const s = (await loadSettings(env, true)) ?? {};
        return json({ notesRepo: s.notesRepo ?? null, timezone: s.timezone ?? null, hasToken: Boolean(s.githubToken),
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
        // Connected: find or create a private "notes" repository and save it right away.
        const { repo, created } = await ensureNotesRepo(env, result.token);
        const { branch } = await prepareRepo(env, result.token, repo);
        const { timezone } = await request.json<{ timezone?: string }>().catch(() => ({ timezone: undefined }));
        const prev = (await loadSettings(env, true)) ?? {};
        let tz = prev.timezone || "America/Los_Angeles";
        if (timezone) try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); tz = timezone; } catch { /* keep */ }
        await saveSettings(env, { ...prev, githubToken: result.token, notesRepo: repo, notesBranch: branch, timezone: tz });
        return json({ state: "done", repo, created });
      }
      case "POST /setup": {
        if (env.DEPLOY_CONFIGURED) return fail("This server's notes are set in its deployment settings.", 409);
        const body = await request.json<{ token?: string; repo?: string; timezone?: string; ntfyTopic?: string; pushoverUser?: string; pushoverToken?: string }>();
        const prev = (await loadSettings(env, true)) ?? {};
        const token = body.token?.trim() || prev.githubToken;
        if (!token) return fail("Paste your GitHub access key first.");
        const timezone = body.timezone?.trim() || prev.timezone || "America/Los_Angeles";
        try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { return fail("Unknown time zone " + timezone); }
        const topic = body.ntfyTopic?.trim();
        if (topic && !/^[A-Za-z0-9_-]{20,64}$/.test(topic)) return fail("Notification topic must be 20 to 64 letters, digits, - or _ (long, so nobody can guess it).");
        const repo = (body.repo ?? "").trim();
        const { branch } = await prepareRepo(env, token, repo);
        const settings: Settings = {
          githubToken: token, notesRepo: repo, notesBranch: branch, timezone,
          ntfyTopic: topic || undefined,
          pushoverUser: body.pushoverUser?.trim() || undefined, pushoverToken: body.pushoverToken?.trim() || undefined
        };
        await saveSettings(env, settings);
        // Schedule reminders already written in the notes (e.g. a repository moved from another server).
        const reminders = await rescan(applySettings({ ...env, GITHUB_TOKEN: "", NOTES_REPO: "", NOTES_TIMEZONE: undefined, NOTES_BRANCH: undefined }, settings)).catch(() => 0);
        return json({ ok: true, repo, branch, reminders });
      }
      case "POST /test-push": {
        await sendPush(env, { note: "Setup", text: "Test notification from your notes ✓", at: Date.now() }, url.origin);
        return json({ ok: true });
      }
    }
    if (!notesConfigured(env)) return fail("Finish setup first.", 409);
    const notes = new GithubNotes(env);
    switch (route) {
      case "GET /priorities": return json(tasksFromNotes(await notes.all()));
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
        return json(await scheduleNote(env, await notes.update(name, content, sha), content));
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
      case "POST /log": {
        const { entry, date, time } = await request.json<{ entry: string; date?: string; time?: string }>();
        return json(await appendLog(notes, entry, { date, time, timeZone: env.NOTES_TIMEZONE }));
      }
      case "GET /logs": return json(await recentLogs(notes, Number(url.searchParams.get("days") ?? 7), env.NOTES_TIMEZONE));
      case "GET /reminders": {
        // Upcoming, plus what already went off today and what was marked done, so Today can show both.
        const since = startOfToday(env);
        const s = scheduler(env);
        return json({ upcoming: await s.upcoming(), firedToday: await s.firedSince(since), doneToday: await s.doneSince(since) });
      }
      case "POST /reminder": return json(await addReminder(env, await request.json()));
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
