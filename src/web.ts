// Web app at /app: a phone-first UI over the same notes, logs and reminders the MCP tools use.
// Unlocked with MCP_BEARER_TOKEN; the session is an HMAC-signed, HttpOnly, SameSite=Strict cookie.

import { GithubNotes, CATEGORIES, type Category, type Env } from "./github";
import { appendLog, recentLogs } from "./log";
import { scheduler, scheduleNote, loadSettings, saveSettings, rescan, checkPassword } from "./core";
import { applySettings, notesConfigured, type Settings } from "./settings";
import { listRepos, prepareRepo } from "./setup";
import { sendPush } from "./reminders";
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

  if (path === "/app/login" && request.method === "POST") {
    const { key } = await request.json<{ key?: string }>().catch(() => ({ key: "" }));
    const problem = await checkPassword(env, key ?? "");
    if (problem) return fail(problem, 401);
    const value = await signSession(env.MCP_BEARER_TOKEN, Date.now() + SESSION_DAYS * 86_400_000);
    return new Response(null, { status: 204, headers: { "Set-Cookie": sessionCookie(value, SESSION_DAYS * 86_400) } });
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
        configured: notesConfigured(env), canSetup: !env.DEPLOY_CONFIGURED
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
      case "GET /notes": return json(await notes.list());
      case "GET /note": return json({ name: url.searchParams.get("name"), content: (await notes.get(url.searchParams.get("name") ?? "")).content });
      case "POST /note": {
        const { content, category } = await request.json<{ content: string; category: string }>();
        if (!CATEGORIES.includes(category as Category)) return fail("Pick a folder for the note");
        return json(await scheduleNote(env, await notes.save(content, category as Category), content));
      }
      case "PUT /note": {
        const { name, content } = await request.json<{ name: string; content: string }>();
        return json(await scheduleNote(env, await notes.update(name, content), content));
      }
      case "DELETE /note": {
        const name = url.searchParams.get("name") ?? "";
        await notes.delete(name);
        await scheduler(env).removeNote(name);
        return json({ name });
      }
      case "GET /search": return json(await notes.search(url.searchParams.get("q") ?? ""));
      case "POST /log": {
        const { entry, date, time } = await request.json<{ entry: string; date?: string; time?: string }>();
        return json(await appendLog(notes, entry, { date, time, timeZone: env.NOTES_TIMEZONE }));
      }
      case "GET /logs": return json(await recentLogs(notes, Number(url.searchParams.get("days") ?? 7), env.NOTES_TIMEZONE));
      case "GET /reminders": return json(await scheduler(env).upcoming());
      case "GET /goals": {
        const names = (await notes.list()).filter(n => n.startsWith("goals/"));
        const out = [];
        for (const name of names) out.push({ name, content: (await notes.get(name)).content });
        return json(out);
      }
    }
    return fail("Not found", 404);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Something went wrong");
  }
}
