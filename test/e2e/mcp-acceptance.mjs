// MCP acceptance test: does what Claude does when you add this server as a custom connector, against a
// real local copy of the Worker (wrangler dev) and a stand-in GitHub.
//   discover OAuth -> register a client -> sign in with the password (PKCE) -> get a token
//   -> MCP initialize -> list tools -> save, read, search, list, log, read logs, delete a note
// Claude registers with a client metadata document on public HTTPS instead of dynamic registration;
// everything after registration is the same code path.
//
// Run: npm run test:mcp            (starts and stops everything itself; needs ports 8787 and 8788 free)
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startFakeGithub } from "./fake-github.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PORT = 8787, GH_PORT = 8788, PASSWORD = "acceptance-test-password";
const BASE = `http://localhost:${PORT}`;
const REDIRECT = "http://127.0.0.1:9/callback";
let failures = 0;
const check = (ok, what) => { console.log((ok ? "PASS " : "FAIL ") + what); if (!ok) failures++; };
const b64url = buf => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ---------- start the stand-in GitHub and the Worker ----------
const gh = await startFakeGithub(GH_PORT);
const devVars = ROOT + ".dev.vars";
const hadDevVars = existsSync(devVars);
const savedDevVars = hadDevVars ? readFileSync(devVars, "utf8") : null;
writeFileSync(devVars, [
  `PASSWORD=${PASSWORD}`, "GITHUB_TOKEN=test-token", "NOTES_REPO=me/notes", "NOTES_TIMEZONE=America/Los_Angeles",
  `GITHUB_API_URL=http://127.0.0.1:${GH_PORT}`, "ALLOW_CLIENT_REGISTRATION=true"
].join("\n") + "\n");
rmSync(ROOT + ".wrangler/state", { recursive: true, force: true });
const worker = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true });
let workerLog = ""; worker.stdout.on("data", d => (workerLog += d)); worker.stderr.on("data", d => (workerLog += d));
const cleanup = () => {
  for (const sig of ["SIGTERM", "SIGKILL"]) try { process.kill(-worker.pid, sig); } catch {}
  gh.server.close();
  if (hadDevVars) writeFileSync(devVars, savedDevVars); else rmSync(devVars, { force: true });
};
process.on("exit", cleanup);
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(BASE + "/health")).ok) break; } catch {}
  await new Promise(r => setTimeout(r, 1000));
  if (i === 59) { console.log(workerLog.slice(-2000)); throw new Error("Worker didn't start"); }
}

try {
  // ---------- 1. Unauthenticated request points at the OAuth metadata ----------
  const anon = await fetch(BASE + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check(anon.status === 401, "/mcp without a token is refused (401)");
  check(/resource_metadata=/.test(anon.headers.get("www-authenticate") || ""), "401 names the protected-resource metadata");

  const prm = await (await fetch(BASE + "/.well-known/oauth-protected-resource/mcp")).json();
  check(prm.resource === BASE + "/mcp", "Protected-resource metadata names this server's /mcp");
  const asUrl = prm.authorization_servers[0];
  const meta = await (await fetch(asUrl + "/.well-known/oauth-authorization-server")).json();
  check(meta.code_challenge_methods_supported?.includes("S256"), "Authorization server supports PKCE S256");

  // ---------- 2. Register a client (Claude uses a metadata document instead) ----------
  const reg = await (await fetch(meta.registration_endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "MCP acceptance test", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] })
  })).json();
  check(Boolean(reg.client_id), "Client registered");

  // ---------- 3. Sign in with the password ----------
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(12));
  const authUrl = new URL(meta.authorization_endpoint);
  Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, scope: "notes:read notes:write",
    state, code_challenge: challenge, code_challenge_method: "S256", resource: BASE + "/mcp" }).forEach(([k, v]) => authUrl.searchParams.set(k, v));
  const consentPage = async () => {
    const r = await fetch(authUrl, { redirect: "manual" });
    const html = await r.text();
    const cookies = (r.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).join("; ");
    return { status: r.status, html, cookies, handle: (/name="handle" value="([^"]+)"/.exec(html) || [])[1] };
  };
  const first = await consentPage();
  check(first.status === 200 && first.html.includes("MCP acceptance test") && Boolean(first.handle), "Sign-in page names the client and asks for the password");
  const approve = (page, password) => fetch(asUrl + "/authorize", {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(page.cookies ? { Cookie: page.cookies } : {}), Origin: asUrl },
    body: new URLSearchParams({ handle: page.handle, password, decision: "approve" })
  });
  const wrong = await approve(first, "not-the-password");
  check(wrong.status === 403, "Wrong password is refused");
  const second = await consentPage();
  const ok = await approve(second, PASSWORD);
  const location = new URL(ok.headers.get("location") || "http://invalid/");
  check(ok.status === 302 && location.origin + location.pathname === REDIRECT && location.searchParams.get("state") === state, "Right password redirects back with a code");

  const tok = await (await fetch(meta.token_endpoint, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: location.searchParams.get("code"), redirect_uri: REDIRECT,
      client_id: reg.client_id, code_verifier: verifier, resource: BASE + "/mcp" })
  })).json();
  check(Boolean(tok.access_token) && Boolean(tok.refresh_token), "Code exchanged for access and refresh tokens");

  // ---------- 4. MCP over streamable HTTP ----------
  let session, id = 0;
  const rpc = async (method, params, notify = false) => {
    const r = await fetch(BASE + "/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer " + tok.access_token, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18", ...(session ? { "Mcp-Session-Id": session } : {}) },
      body: JSON.stringify(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++id, method, params })
    });
    session = r.headers.get("mcp-session-id") || session;
    if (notify) return r.status;
    const text = await r.text();
    const json = (r.headers.get("content-type") || "").includes("text/event-stream")
      ? JSON.parse(text.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5)).pop())
      : JSON.parse(text);
    if (json.error) throw new Error(method + ": " + JSON.stringify(json.error));
    return json.result;
  };
  const call = async (name, args = {}) => {
    const res = await rpc("tools/call", { name, arguments: args });
    const text = res.content?.[0]?.text ?? "";
    return { error: Boolean(res.isError), text, data: (() => { try { return JSON.parse(text); } catch { return text; } })() };
  };

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "acceptance", version: "1" } });
  check(init.serverInfo?.name === "personal-notes", "initialize: server identifies as personal-notes");
  check(/REMINDERS/.test(init.instructions || ""), "initialize: server sends its usage instructions");
  await rpc("notifications/initialized", {}, true);

  const tools = (await rpc("tools/list", {})).tools.map(t => t.name).sort();
  const expected = ["complete_reminder", "delete_note", "get_logs", "get_note", "list_notes", "list_reminders", "log", "save_note", "search_notes", "sync_notes", "update_note"];
  check(JSON.stringify(tools) === JSON.stringify(expected), `tools/list: all ${expected.length} tools (${tools.join(", ")})`);

  const saved = await call("save_note", { content: "# Acceptance check\nmarker-7f3a\n- [ ] Water plants @2099-01-01 9am", category: "inbox" });
  check(!saved.error && /^inbox\/\d{4}-\d{2}-\d{2}-acceptance-check\.md$/.test(saved.data.name), "save_note creates a note: " + saved.text);
  check(saved.data.reminders?.length === 1, "save_note schedules its reminder");
  const name = saved.data.name;
  check((await call("get_note", { name })).data.includes("marker-7f3a"), "get_note reads it back");
  check(JSON.stringify((await call("search_notes", { query: "marker-7f3a" })).data) === JSON.stringify([name]), "search_notes finds it");
  check((await call("list_notes")).data.includes(name), "list_notes lists it");
  check((await call("list_reminders")).data.some(r => r.text === "Water plants"), "list_reminders shows its reminder");
  const updated = await call("update_note", { name, content: "# Acceptance check\nmarker-7f3a updated\n" });
  check(!updated.error && (await call("get_note", { name })).data.includes("updated"), "update_note changes it");
  const logged = await call("log", { entry: "acceptance tea #drink" });
  check(!logged.error && /acceptance tea/.test(logged.data.line), "log adds an entry");
  check((await call("get_logs", { days: 1 })).data.some(l => l.content.includes("acceptance tea")), "get_logs reads it");
  check(!(await call("delete_note", { name })).error, "delete_note deletes it");
  check((await call("get_note", { name })).error, "get_note after delete reports an error");
  check(!(await call("list_reminders")).data.some(r => r.text === "Water plants"), "Deleting the note stops its reminder");
  check(![...gh.files.keys()].includes(name) && [...gh.files.keys()].some(p => p.startsWith("journal/log/")), "GitHub holds the log and not the deleted note");

  // ---------- 5. Scale: Cloudflare's free plan allows 50 outside calls per request ----------
  const b64 = t => Buffer.from(t).toString("base64");
  for (let i = 0; i < 600; i++) gh.files.set(`inbox/2026-01-01-bulk-${i}.md`, { content: b64(`# Bulk ${i}\n${i === 451 ? "needle-q9" : "hay"}\n- [ ] Bulk reminder ${i} @2099-02-01 9am`), sha: "b" + i });
  const today = new Date();
  for (let n = 0; n < 200; n++) {
    const d = new Date(today.getTime() - n * 86_400_000).toISOString().slice(0, 10);
    gh.files.set(`journal/log/${d}.md`, { content: b64(`# Log ${d}\n\n- 08:00 tea #drink\n`), sha: "l" + n });
  }
  const githubCalls = async fn => { const before = gh.calls.length; const out = await fn(); return { out, calls: gh.calls.length - before }; };
  const s1 = await githubCalls(() => call("search_notes", { query: "needle-q9" }));
  check(!s1.error && JSON.stringify(s1.out.data) === JSON.stringify(["inbox/2026-01-01-bulk-451.md"]) && s1.calls <= 2, `search across ${gh.files.size} notes: found it with ${s1.calls} GitHub call(s)`);
  const s2 = await githubCalls(() => call("get_logs", { days: 90 }));
  check(!s2.out.error && s2.out.data.length >= 89 && s2.calls <= 2, `90 days of logs (${s2.out.data.length} days) with ${s2.calls} GitHub call(s)`);
  const s3 = await githubCalls(() => call("sync_notes"));
  check(!s3.out.error && s3.out.data.upcomingReminders === 600 && s3.calls <= 2, `rescan of 600 notes' reminders with ${s3.calls} GitHub call(s)`);

  const refreshed = await (await fetch(meta.token_endpoint, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id })
  })).json();
  check(Boolean(refreshed.access_token), "Refresh token gets a new access token");
  const bad = await fetch(BASE + "/mcp", { method: "POST", headers: { Authorization: "Bearer not-a-token", "Content-Type": "application/json" }, body: "{}" });
  check(bad.status === 401, "A made-up token is refused");
} catch (e) {
  failures++;
  console.log("FAIL " + (e.stack || e));
  console.log(workerLog.slice(-3000));
}
console.log(failures ? `${failures} failed` : "All MCP acceptance checks passed");
cleanup();
process.exit(failures ? 1 : 0);
