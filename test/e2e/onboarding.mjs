// First-run onboarding, driven in a phone-sized browser the way a new user does it, against a real local
// Worker (wrangler dev) that starts with only a PASSWORD (like a fresh Deploy to Cloudflare) and a stand-in
// GitHub (device sign-in, repo creation, contents, tarball).
//   unlock with the password -> Connect GitHub (code, approve, come back) -> Save and finish
//   -> "You're set up" with the Claude address and connect buttons -> Today -> Settings checks -> return visit
//
// Run: npm run test:onboarding   (needs ports 8790 and 8791 free; CHROMIUM_PATH optional)
import { spawn } from "node:child_process";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PORT = 8790, GH = 8791, PASSWORD = "onboarding-test-password-1";
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
// On GitHub Actions, failures are also posted as annotations so they're readable without the log.
const annotate = msg => { if (process.env.GITHUB_ACTIONS) console.log(`::error title=Onboarding walk-through::${String(msg).replace(/\r?\n/g, " %0A")}`); };
const check = (ok, what) => { console.log((ok ? "PASS " : "FAIL ") + what); if (!ok) { failures++; annotate(what); } };

// ---------- stand-in GitHub ----------
const TOKEN = "gho_" + "o".repeat(36);
const repos = {}, pushes = [];
let seq = 0, approved = false;
function tarGz(files) {
  const enc = new TextEncoder(), blocks = [];
  for (const [path, f] of files) {
    const body = Buffer.from(f.content, "base64"), h = new Uint8Array(512);
    const put = (s, at) => h.set(enc.encode(s), at);
    put("jane-notes-abc/" + path, 0); put("0000644\0", 100); put("0000000\0", 108); put("0000000\0", 116);
    put(body.length.toString(8).padStart(11, "0") + "\0", 124); put("00000000000\0", 136); put("        ", 148);
    h[156] = 48; put("ustar\0", 257); put("00", 263);
    let sum = 0; for (const b of h) sum += b; put(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, body, new Uint8Array((512 - (body.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  return gzipSync(Buffer.concat(blocks.map(b => Buffer.from(b))));
}
const gh = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const p = new URL(req.url, "http://x").pathname;
  const send = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o ?? {})); };
  if (p.startsWith("/ntfy/")) { pushes.push(body); return send(200); }
  // A newer published version, and her own copy of the code (found via her GitHub connection).
  if (p === "/version.ts") { res.writeHead(200, { "content-type": "text/plain" }); return res.end('export const VERSION = "2099.1.1";\nexport const VERSION_NOTE = "Test update note.";\n'); }
  if (p === "/repos/jane/notes-server/contents/src/version.ts") return req.headers.authorization === "Bearer " + TOKEN ? send(200, { type: "file" }) : send(401);
  if (p === "/login/device/code") return send(200, { device_code: "dev-" + ++seq, user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
  if (p === "/login/oauth/access_token") return send(200, approved ? { access_token: TOKEN, token_type: "bearer", scope: "repo" } : { error: "authorization_pending" });
  if (req.headers.authorization !== "Bearer " + TOKEN) return send(401, { message: "Bad credentials" });
  if (p === "/user") return send(200, { login: "jane" });
  if (p === "/user/repos" && req.method === "GET") return send(200, Object.entries(repos).map(([full_name, r]) => ({ full_name, private: r.private })));
  if (p === "/user/repos" && req.method === "POST") {
    const b = JSON.parse(body), full = "jane/" + b.name;
    if (repos[full]) return send(422);
    repos[full] = { private: !!b.private, files: new Map(b.auto_init ? [["README.md", { content: Buffer.from("# notes").toString("base64"), sha: "s" + ++seq }]] : []) };
    return send(201, { full_name: full });
  }
  const m = /^\/repos\/(\w+\/[\w.-]+)(?:\/(git\/trees|contents|tarball|commits|branches)\/(.+))?$/.exec(p);
  const repo = m && repos[m[1]];
  if (!repo) return send(404, { message: "Not Found" });
  if (!m[2]) return send(200, { private: repo.private, default_branch: "main", permissions: { push: true, admin: true }, owner: { login: "jane" } });
  const files = repo.files;
  if (m[2] === "git/trees") return send(200, { truncated: false, tree: [...files.keys()].map(path => ({ path, type: "blob", sha: files.get(path).sha })) });
  if (m[2] === "tarball") { const gz = tarGz([...files]); res.writeHead(200, { "content-type": "application/x-gzip", "content-length": gz.length }); return res.end(gz); }
  if (m[2] === "commits" || m[2] === "branches") return send(200, { sha: "c" + seq, commit: { sha: "c" + seq }, name: "main" });
  const path = decodeURIComponent(m[3]), ex = files.get(path);
  if (req.method === "GET") return ex ? send(200, { type: "file", encoding: "base64", content: ex.content, sha: ex.sha }) : send(404);
  const b = JSON.parse(body || "{}");
  if (req.method === "PUT") { if (ex ? b.sha !== ex.sha : b.sha) return send(409); files.set(path, { content: b.content, sha: "s" + ++seq }); return send(200, { content: { path } }); }
  if (req.method === "DELETE") { if (!ex) return send(404); files.delete(path); return send(200); }
  send(405);
});
await new Promise(r => gh.listen(GH, "127.0.0.1", r));

// ---------- Worker with only a password ----------
const devVars = ROOT + ".dev.vars";
const saved = existsSync(devVars) ? readFileSync(devVars, "utf8") : null;
writeFileSync(devVars, [`PASSWORD=${PASSWORD}`, `GITHUB_API_URL=http://127.0.0.1:${GH}`, `GITHUB_LOGIN_URL=http://127.0.0.1:${GH}`,
  "GITHUB_CLIENT_ID=onboarding-test", `NTFY_SERVER=http://127.0.0.1:${GH}/ntfy`, `DAYBOOK_VERSION_URL=http://127.0.0.1:${GH}/version.ts`].join("\n") + "\n");
rmSync(ROOT + ".wrangler/state", { recursive: true, force: true });
const worker = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true });
let log = ""; worker.stdout.on("data", d => (log += d)); worker.stderr.on("data", d => (log += d));
let browser;
const cleanup = () => {
  for (const sig of ["SIGTERM", "SIGKILL"]) try { process.kill(-worker.pid, sig); } catch {}
  gh.close();
  if (saved !== null) writeFileSync(devVars, saved); else rmSync(devVars, { force: true });
};
process.on("exit", cleanup);
for (let i = 0; ; i++) {
  try { if ((await fetch(BASE + "/health")).ok) break; } catch {}
  if (i > 90) { console.log(log.slice(-2000)); throw new Error("Worker didn't start"); }
  await new Promise(r => setTimeout(r, 1000));
}

try {
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: "America/Chicago" };
  const ctx = await browser.newContext({ ...phone, permissions: ["clipboard-read", "clipboard-write"] });
  // Outside sites stand-ins: the test never touches github.com or claude.ai.
  await ctx.route(/^https:\/\/(github\.com|claude\.ai|chatgpt\.com|cursor\.com)\//, r => r.fulfill({ status: 200, contentType: "text/html", body: "<h1>stand-in</h1>" }));
  await ctx.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, r => r.abort());
  ctx.setDefaultTimeout(20000);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));

  // 1. Cloudflare's "Visit" opens the root
  await page.goto(BASE + "/");
  await page.waitForSelector("#key");
  check(page.url().endsWith("/app"), "Visit link lands on the app");
  const lock = await page.innerText("main");
  check(!/MCP_BEARER_TOKEN|PASSWORD\)/.test(lock), "Unlock screen has no developer terms");
  await page.fill("#key", PASSWORD);
  await page.click("button[type=submit]");

  // 2. First-run setup
  await page.waitForSelector('input[name="storage"]');
  check(await page.locator("#tabs").isHidden(), "First run shows only setup");
  // This walk-through takes the GitHub path; test:app-storage covers the default (notes kept in the app).
  await page.click('input[name="storage"][value="github"]');
  await page.waitForSelector("#gh-start");
  check(/access your repositories/.test(await page.innerText("#s2")), "Setup explains what GitHub will ask");
  check(await page.locator("#copytopic").isVisible() && await page.locator("#ntfy-subscribe").count() === 0, "iPhone/desktop: ntfy name with Copy (no Android link)");
  check(await page.locator("#diagnostics").count() === 0, "No diagnostics card during first run");
  await page.click("#gh-start");
  await page.waitForSelector("#gh-code");
  check((await page.innerText("#gh-code")) === "WDJB-MJHT", "Shows the GitHub code");
  const [tab] = await Promise.all([ctx.waitForEvent("page"), page.click("#gh-open")]);
  approved = true;
  await tab.close();
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForSelector(".gh-ok");
  check(repos["jane/notes"]?.private === true, "Connect GitHub made a private notes repo");
  check((await page.inputValue("#tz")) === "America/Chicago", "Time zone detected");

  // 3. Save and finish -> You're set up
  await page.click("#save");
  await page.waitForSelector("#copymcp", { timeout: 10000 }).catch(() => {});
  const done = await page.innerText("main");
  const err = (await page.locator("#saveerr").count()) ? await page.innerText("#saveerr") : "";
  check(/You're set up/.test(done) && !err, "Save and finish shows \"You're set up\"" + (err ? ` (error: ${err})` : ""));
  check(done.includes(BASE + "/mcp"), "Finish screen shows the Claude address");
  check(await page.locator("[data-connect]").count() >= 2, "Finish screen has one-tap connect buttons");
  check(done.includes(BASE + "/app"), "Finish screen shows the app's own address");
  if (await page.locator("#test").count()) {
    await page.click("#test");
    await page.waitForTimeout(1500);
    check(pushes.some(b => b.includes("Test notification")), "Test notification sent");
  }

  // 4. First use
  await page.click("text=Open my notes");
  await page.waitForTimeout(1200);
  check(await page.locator("#tabs").isVisible() && await page.locator("#settingsTab").isVisible(), "Tabs and Settings appear after setup");

  // 5. Settings later: checks work when Settings is opened directly
  const later = await ctx.newPage();
  later.on("pageerror", e => errors.push(String(e)));
  await later.goto(BASE + "/app#settings");
  await later.waitForSelector("#run-diagnostics");
  await later.click("#run-diagnostics");
  await later.waitForFunction(() => { const o = document.querySelector("#diagnostics-results"); return o && !/Checking/.test(o.textContent) && o.textContent.trim(); });
  check((await later.innerText("#diagnostics-results")).trim().length > 0, "Run checks shows results when Settings is opened directly");

  // 6. Updates: banner on Today with a direct link to her copy's Update Daybook, and in Settings
  const today = await ctx.newPage();
  today.on("pageerror", e => errors.push(String(e)));
  await today.goto(BASE + "/app#today");
  await today.waitForSelector("#update-banner");
  check(/Test update note/.test(await today.innerText("#update-banner")), "Today shows 'An update is available' with the note");
  const href = await today.getAttribute("#update-banner a.btn", "href");
  check(href === "https://github.com/jane/notes-server/actions/workflows/update-daybook.yml", "Update button opens her own copy's Update Daybook: " + href);
  await today.click("#update-later");
  await today.reload(); await today.waitForTimeout(1500);
  check(await today.locator("#update-banner").count() === 0, "Later hides the banner for this version");
  check(/Version 2099\.1\.1 is available/.test(await later.innerText("#update-status").catch(() => "")) ||
        /Version 2099\.1\.1 is available/.test(await (async () => { await later.reload(); await later.waitForSelector("#update-status p:not(.muted)"); return later.innerText("#update-status"); })()),
        "Settings shows the available version");

  // 7. Coming back on another phone: password box first, GitHub as the alternative
  const fresh = await browser.newContext(phone);
  await fresh.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, r => r.abort());
  const back = await fresh.newPage();
  back.on("pageerror", e => errors.push(String(e)));
  await back.goto(BASE + "/app");
  await back.waitForSelector("#key");
  check(await back.locator("#ghbtn").isVisible(), "Return visit offers the password and Sign in with GitHub");
  await back.fill("#key", PASSWORD);
  await back.click("#lockform button[type=submit]");
  await back.waitForSelector("#tabs:not([hidden])");
  check(true, "Password unlocks after setup");

  // 8. Android: one-tap Subscribe in ntfy
  const android = await browser.newContext({ ...phone, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36" });
  await android.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, r => r.abort());
  const droid = await android.newPage();
  await droid.goto(BASE + "/app");
  await droid.fill("#key", PASSWORD); await droid.click("#lockform button[type=submit]");
  await droid.waitForSelector("#tabs:not([hidden])");
  await droid.goto(BASE + "/app#settings");
  await droid.waitForSelector("#s4", { state: "attached" });
  const seen = await droid.evaluate(() => ({ ua: navigator.userAgent, link: Boolean(document.querySelector("#ntfy-subscribe")),
    copy: Boolean(document.querySelector("#copytopic")), hash: location.hash, s4: (document.querySelector("#s4")?.innerText || "").slice(0, 160) }));
  if (!seen.link) annotate("Android Settings debug: " + JSON.stringify(seen));
  const ntfyHref = await droid.evaluate(() => document.querySelector("#ntfy-subscribe")?.getAttribute("href"));
  check(/^ntfy:\/\/ntfy\.sh\/notes-[a-z0-9]+\?display=Daybook$/.test(ntfyHref || ""), "Android: Subscribe in ntfy opens the app with her topic: " + ntfyHref);

  check(errors.length === 0, "No page errors " + JSON.stringify(errors));
} catch (e) {
  failures++;
  console.log("FAIL " + (e.stack || e));
  annotate((e.stack || String(e)).slice(0, 900));
  console.log(log.slice(-2000));
}
await browser?.close();
console.log(failures ? `${failures} failed` : "All onboarding checks passed");
cleanup();
process.exit(failures ? 1 : 0);
