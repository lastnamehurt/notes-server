// Notes stored in the app itself (no GitHub), end to end, against a real local Worker (wrangler dev):
//   phone setup with the default "In this app" -> Claude's connection (OAuth + every note tool) -> scale
//   -> Download all my notes (zip) -> Settings → Move my notes to GitHub (stand-in GitHub) -> notes now on GitHub.
// Run: npm run test:app-storage   (needs ports 8792 and 8793 free; CHROMIUM_PATH optional)
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync, rmSync, existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { gzipSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PORT = 8792, GH = 8793, PASSWORD = "app-storage-test-password";
const BASE = `http://127.0.0.1:${PORT}`;
const REDIRECT = "http://127.0.0.1:9/callback";
let failures = 0;
const annotate = msg => { if (process.env.GITHUB_ACTIONS) console.log(`::error title=App storage::${String(msg).replace(/\r?\n/g, " %0A")}`); };
const check = (ok, what) => { console.log((ok ? "PASS " : "FAIL ") + what); if (!ok) { failures++; annotate(what); } };
const b64url = buf => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ---------- stand-in GitHub: device sign-in, repo creation, contents, trees, tarball, git data (for the move) ----------
const TOKEN = "gho_" + "m".repeat(36);
const repos = {}; // full name -> { private, commits: Map<sha, {tree: Map<path, content>}>, head }
let seq = 0, approved = false;
const newSha = () => createHash("sha1").update(String(++seq) + Math.random()).digest("hex");
const ghServer = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const p = new URL(req.url, "http://x").pathname;
  const send = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o ?? {})); };
  if (p === "/version.ts") { res.writeHead(200, { "content-type": "text/plain" }); return res.end('export const VERSION = "2099.1.1";\nexport const VERSION_NOTE = "Test update.";\n'); }
  if (p === "/login/device/code") return send(200, { device_code: "dev-" + ++seq, user_code: "MOVE-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
  if (p === "/login/oauth/access_token") return send(200, approved ? { access_token: TOKEN, token_type: "bearer", scope: "repo" } : { error: "authorization_pending" });
  if (req.headers.authorization !== "Bearer " + TOKEN) return send(401, { message: "Bad credentials" });
  if (p === "/user") return send(200, { login: "jane" });
  if (p === "/user/repos" && req.method === "POST") {
    const b = JSON.parse(body), full = "jane/" + b.name;
    if (repos[full]) return send(422);
    const sha = newSha();
    repos[full] = { private: !!b.private, commits: new Map([[sha, new Map([["README.md", "# " + b.name + "\n"]])]]), head: sha };
    return send(201, { full_name: full });
  }
  const m = /^\/repos\/(\w+\/[\w.-]+)(\/.*)?$/.exec(p);
  const repo = m && repos[m[1]];
  if (!repo) return send(404, { message: "Not Found" });
  const rest = m[2] || "";
  const files = repo.commits.get(repo.head);
  if (!rest) return send(200, { private: repo.private, default_branch: "main", permissions: { push: true } });
  if (rest.startsWith("/git/trees/main")) return send(200, { truncated: false, tree: [...files.keys()].map(path => ({ path, type: "blob" })) });
  if (rest === "/git/ref/heads/main") return send(200, { object: { sha: repo.head } });
  if (rest.startsWith("/git/commits/") && req.method === "GET") { const sha = rest.split("/").pop(); return repo.commits.has(sha) ? send(200, { sha, tree: { sha: "tree-" + sha } }) : send(404); }
  if (rest === "/git/trees" && req.method === "POST") {
    const b = JSON.parse(body), base = repo.commits.get(b.base_tree.replace("tree-", ""));
    const next = new Map(base); for (const e of b.tree) next.set(e.path, e.content);
    const tsha = "pending-" + ++seq; repo.pendingTrees ??= new Map(); repo.pendingTrees.set(tsha, next);
    return send(201, { sha: tsha });
  }
  if (rest === "/git/commits" && req.method === "POST") {
    const b = JSON.parse(body), sha = newSha();
    repo.commits.set(sha, repo.pendingTrees.get(b.tree)); return send(201, { sha });
  }
  if (rest === "/git/refs/heads/main" && req.method === "PATCH") { repo.head = JSON.parse(body).sha; return send(200, {}); }
  if (rest.startsWith("/tarball/")) {
    const enc = new TextEncoder(), blocks = [];
    for (const [path, text] of files) {
      const data = Buffer.from(text), h = new Uint8Array(512), put = (v, at) => h.set(enc.encode(v), at);
      put("jane-repo-abc/" + path, 0); put("0000644\0", 100); put("0000000\0", 108); put("0000000\0", 116);
      put(data.length.toString(8).padStart(11, "0") + "\0", 124); put("00000000000\0", 136); put("        ", 148); h[156] = 48; put("ustar\0", 257); put("00", 263);
      let sum = 0; for (const b of h) sum += b; put(sum.toString(8).padStart(6, "0") + "\0 ", 148);
      blocks.push(Buffer.from(h), data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    const gz = gzipSync(Buffer.concat(blocks)); res.writeHead(200, { "content-type": "application/x-gzip", "content-length": gz.length }); return res.end(gz);
  }
  if (rest.startsWith("/contents/")) {
    const path = decodeURIComponent(rest.slice("/contents/".length).split("?")[0]);
    const blobSha = t => createHash("sha1").update(t).digest("hex");
    if (req.method === "GET") return files.has(path) ? send(200, { type: "file", encoding: "base64", content: Buffer.from(files.get(path)).toString("base64"), sha: blobSha(files.get(path)) }) : send(404);
    const b = JSON.parse(body);
    if (req.method === "PUT") {
      if (files.has(path) ? b.sha !== blobSha(files.get(path)) : b.sha) return send(409);
      const next = new Map(files); next.set(path, Buffer.from(b.content, "base64").toString());
      const sha = newSha(); repo.commits.set(sha, next); repo.head = sha; return send(200, { content: { path } });
    }
  }
  send(404, { message: "Not Found" });
});
await new Promise(r => ghServer.listen(GH, "127.0.0.1", r));

// ---------- Worker with only a password (a fresh install) ----------
const devVars = ROOT + ".dev.vars";
const saved = existsSync(devVars) ? readFileSync(devVars, "utf8") : null;
writeFileSync(devVars, [`PASSWORD=${PASSWORD}`, `GITHUB_API_URL=http://127.0.0.1:${GH}`, `GITHUB_LOGIN_URL=http://127.0.0.1:${GH}`,
  "GITHUB_CLIENT_ID=app-storage-test", "ALLOW_CLIENT_REGISTRATION=true", `DAYBOOK_VERSION_URL=http://127.0.0.1:${GH}/version.ts`].join("\n") + "\n");
rmSync(ROOT + ".wrangler/state", { recursive: true, force: true });
const worker = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true });
let log = ""; worker.stdout.on("data", d => (log += d)); worker.stderr.on("data", d => (log += d));
let browser;
const cleanup = () => {
  for (const sig of ["SIGTERM", "SIGKILL"]) try { process.kill(-worker.pid, sig); } catch {}
  ghServer.close();
  if (saved !== null) writeFileSync(devVars, saved); else rmSync(devVars, { force: true });
};
process.on("exit", cleanup);
for (let i = 0; ; i++) {
  try { if ((await fetch(BASE + "/health")).ok) break; } catch {}
  if (i > 90) { console.log(log.slice(-2000)); throw new Error("Worker didn't start"); }
  await new Promise(r => setTimeout(r, 1000));
}

try {
  // ---------- 1. Phone setup, keeping the default "In this app" ----------
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "Europe/London", acceptDownloads: true });
  await ctx.route(/^https:\/\/(github\.com|claude\.ai|chatgpt\.com|cursor\.com)\//, r => r.fulfill({ status: 200, contentType: "text/html", body: "<h1>stand-in</h1>" }));
  await ctx.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, r => r.abort());
  ctx.setDefaultTimeout(20000);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(String(e)));
  await page.goto(BASE + "/app");
  await page.fill("#key", PASSWORD); await page.click("#lockform button[type=submit]");
  await page.waitForSelector('input[name="storage"]');
  check(await page.locator('input[name="storage"][value="app"]').isChecked(), "Setup defaults to keeping notes in the app");
  check(await page.locator("#s2").isHidden(), "GitHub steps stay out of the way until chosen");
  await page.click('input[name="storage"][value="github"]');
  check(await page.locator("#s2").isVisible(), "Choosing GitHub shows Connect GitHub");
  await page.click('input[name="storage"][value="app"]');
  await page.click("#save");
  await page.waitForSelector("#copymcp");
  check(/You're set up/.test(await page.innerText("main")), "Save and finish works with no GitHub at all");
  await page.click("text=Open my notes");
  await page.waitForSelector("#tabs:not([hidden])");

  // ---------- 2. Claude's connection: OAuth, then every note tool ----------
  const meta = await (await fetch(BASE + "/.well-known/oauth-authorization-server")).json();
  const reg = await (await fetch(meta.registration_endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "App storage test", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }) })).json();
  const verifier = b64url(randomBytes(32)), challenge = b64url(createHash("sha256").update(verifier).digest());
  const authUrl = new URL(meta.authorization_endpoint);
  Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, scope: "notes:read notes:write", state: "s1",
    code_challenge: challenge, code_challenge_method: "S256", resource: BASE + "/mcp" }).forEach(([k, v]) => authUrl.searchParams.set(k, v));
  const consent = await fetch(authUrl, { redirect: "manual" });
  const html = await consent.text(), cookies = (consent.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).join("; ");
  const handle = /name="handle" value="([^"]+)"/.exec(html)[1];
  const scope = (/name="scope" value="([^"]*)"/.exec(html) || [])[1] ?? "";
  const ok = await fetch(BASE + "/authorize", { method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookies ? { Cookie: cookies } : {}), Origin: BASE },
    body: new URLSearchParams({ handle, scope, password: PASSWORD, decision: "approve" }) });
  if (!ok.headers.get("location")) throw new Error(`Sign-in didn't redirect (${ok.status}): ${(await ok.text()).slice(0, 300)}`);
  const code = new URL(ok.headers.get("location")).searchParams.get("code");
  const tok = await (await fetch(meta.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource: BASE + "/mcp" }) })).json();
  check(Boolean(tok.access_token), "Claude can sign in");
  let session, id = 0;
  const rpc = async (method, params, notify = false) => {
    const r = await fetch(BASE + "/mcp", { method: "POST", headers: { Authorization: "Bearer " + tok.access_token, "Content-Type": "application/json",
      Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", ...(session ? { "Mcp-Session-Id": session } : {}) },
      body: JSON.stringify(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++id, method, params }) });
    session = r.headers.get("mcp-session-id") || session;
    if (notify) return;
    const text = await r.text();
    const json = (r.headers.get("content-type") || "").includes("event-stream") ? JSON.parse(text.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5)).pop()) : JSON.parse(text);
    if (json.error) throw new Error(method + ": " + JSON.stringify(json.error));
    return json.result;
  };
  const call = async (name, args = {}) => {
    const res = await rpc("tools/call", { name, arguments: args });
    const text = res.content?.[0]?.text ?? "";
    return { error: Boolean(res.isError), text, data: (() => { try { return JSON.parse(text); } catch { return text; } })() };
  };
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "app-storage", version: "1" } });
  await rpc("notifications/initialized", {}, true);
  const saved1 = await call("save_note", { content: "# Plants\nwater the ferns marker-a1\n- [ ] Water plants @2099-01-01 9am", category: "inbox" });
  check(!saved1.error && /^inbox\/.*plants\.md$/.test(saved1.data.name) && saved1.data.reminders?.length === 1, "save_note stores in the app and schedules its reminder: " + saved1.text.slice(0, 120));
  const name = saved1.data.name;
  check((await call("get_note", { name })).data.includes("marker-a1"), "get_note reads it back");
  check(JSON.stringify((await call("search_notes", { query: "marker-a1" })).data) === JSON.stringify([name]), "search_notes finds it");
  check(!(await call("update_note", { name, content: "# Plants\nwater the ferns marker-a1 updated\n- [ ] Water plants @2099-01-01 9am" })).error, "update_note works");
  check((await call("get_note", { name })).data.includes("updated"), "update is saved");
  check(!(await call("log", { entry: "tea #drink" })).error, "log works");
  check((await call("get_logs", { days: 1 })).data.some(l => l.content.includes("tea #drink")), "get_logs reads it");
  check((await call("list_reminders")).data.some(r => r.text === "Water plants"), "reminders scheduled from app-stored notes");
  const doomed = (await call("save_note", { content: "# Temporary\nbye", category: "inbox" })).data.name;
  check(!(await call("delete_note", { name: doomed })).error && (await call("get_note", { name: doomed })).error, "delete_note removes a note");
  const same = await call("save_note", { content: "# Plants\nsecond", category: "inbox" });
  check(/plants-2\.md$/.test(same.data.name), "Same title the same day gets a -2 name: " + same.data.name);

  // ---------- 3. Scale ----------
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) await call("save_note", { content: `# Bulk ${i}\n${i === 137 ? "needle-z7" : "hay"}`, category: "reference" });
  const s = await call("search_notes", { query: "needle-z7" });
  check(s.data.length === 1 && /bulk-137\.md$/.test(s.data[0]), `search across ${(await call("list_notes")).data.length} app-stored notes (saved 200 in ${Math.round((Date.now() - t0) / 1000)}s)`);
  check(!(await call("sync_notes")).error, "reminder rescan works on app storage");

  // ---------- 4. Download all my notes ----------
  await page.goto(BASE + "/app#settings");
  await page.waitForSelector("#move-gh");
  check(/stored in this app/i.test(await page.innerText("#s2")), "Settings says notes are stored in the app");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click('a[href="/app/api/export"]')]);
  const dir = mkdtempSync(join(tmpdir(), "daybook-")), zipPath = join(dir, "notes.zip");
  await download.saveAs(zipPath);
  const inZip = JSON.parse(execFileSync("python3", ["-c", "import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({i.filename: z.read(i).decode() for i in z.infolist()}))", zipPath]).toString());
  check(/^daybook-notes-\d{4}-\d{2}-\d{2}\.zip$/.test(download.suggestedFilename()), "Download is named daybook-notes-<date>.zip");
  check(inZip[name]?.includes("updated") && Object.keys(inZip).length >= 203, `Zip holds every note as a Markdown file (${Object.keys(inZip).length} files)`);

  // ---------- 4b. Updates without GitHub: the app asks once which repository is her copy ----------
  await page.waitForSelector("#update-status .update-repo");
  check(true, "Settings asks which GitHub repository is her copy (no GitHub connection to find it)");
  await page.fill("#update-status .update-repo input", "https://github.com/jane/my-daybook");
  await page.click("#update-status .update-repo button[type=submit]");
  await page.waitForSelector("#update-status a.a-btn");
  check(await page.getAttribute("#update-status a.a-btn", "href") === "https://github.com/jane/my-daybook/actions/workflows/update-daybook.yml",
    "After naming it, Open Update Daybook goes straight to her copy");

  // ---------- 5. Move my notes to GitHub ----------
  await page.click("#move-gh summary");
  await page.click("#gh-start");
  await page.waitForSelector("#gh-code");
  approved = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForSelector("#gh-flow .gh-ok", { timeout: 30000 });
  const moved = await page.innerText("#gh-flow");
  check(/Moved \d+ notes? to jane\/daybook-notes/.test(moved), "Move reports what it did: " + moved);
  const repo = repos["jane/daybook-notes"];
  const onGithub = repo && repo.commits.get(repo.head);
  check(repo?.private === true, "Moved into a new private repository");
  check(onGithub && [...Object.keys(inZip)].every(p => onGithub.get(p) === inZip[p]), "Every note arrived on GitHub unchanged");
  check((await call("get_note", { name })).data.includes("updated"), "Claude now reads notes from GitHub");
  const after = await call("save_note", { content: "# After move\nnew", category: "inbox" });
  check(!after.error && repos["jane/daybook-notes"].commits.get(repos["jane/daybook-notes"].head) !== undefined, "New notes save after the move: " + after.text.slice(0, 80));
  await page.reload(); await page.waitForSelector("#gh-flow");
  check(/daybook-notes/.test(await page.innerText("#s2")) && await page.locator("#move-gh").count() === 0, "Settings now shows GitHub storage");
  check(errors.length === 0, "No page errors " + JSON.stringify(errors));
} catch (e) {
  failures++;
  console.log("FAIL " + (e.stack || e));
  annotate((e.stack || String(e)).slice(0, 900));
  console.log(log.slice(-2500));
}
await browser?.close();
console.log(failures ? `${failures} failed` : "All app-storage checks passed");
cleanup();
process.exit(failures ? 1 : 0);
