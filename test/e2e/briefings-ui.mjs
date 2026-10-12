// Browser check of Settings → Daily briefings against a local Worker (wrangler dev), a fake GitHub and a
// stand-in ntfy server. Run: npm run test:briefings-ui
import { spawn } from "node:child_process";
import { writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(ROOT + "package.json");
const { chromium } = require("@playwright/test");
const { startFakeGithub } = await import(ROOT + "test/e2e/fake-github.mjs");
const PORT = 8787, GH = 8788, NTFY = 8799, PASSWORD = "briefing-e2e-password", BASE = `http://localhost:${PORT}`;
const pushes = [];
const ntfy = http.createServer((req, res) => { let b = ""; req.on("data", d => b += d); req.on("end", () => { pushes.push({ path: req.url, title: req.headers.title, click: req.headers.click, body: b }); res.end("{}"); }); }).listen(NTFY);
const gh = await startFakeGithub(GH);
const devVars = ROOT + ".dev.vars"; const had = existsSync(devVars) ? readFileSync(devVars, "utf8") : null;
writeFileSync(devVars, [`PASSWORD=${PASSWORD}`, "GITHUB_TOKEN=test-token", "NOTES_REPO=me/notes", "NOTES_TIMEZONE=America/Los_Angeles",
  `GITHUB_API_URL=http://127.0.0.1:${GH}`, "NTFY_TOPIC=daybook", `NTFY_SERVER=http://127.0.0.1:${NTFY}`].join("\n") + "\n");
rmSync(ROOT + ".wrangler/state", { recursive: true, force: true });
const worker = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1"], { cwd: ROOT, stdio: "ignore", detached: true });
const cleanup = () => { try { process.kill(-worker.pid, "SIGKILL"); } catch {} gh.server.close(); ntfy.close(); if (had !== null) writeFileSync(devVars, had); else rmSync(devVars, { force: true }); };
process.on("exit", cleanup);
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/health")).ok) break; } catch {} await new Promise(r => setTimeout(r, 1000)); }
const out = [];
const check = (ok, what) => { out.push((ok ? "PASS " : "FAIL ") + what); };
// PW_CHROMIUM points at a specific Chromium binary when Playwright's own download isn't installed.
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: "dark" });
  const page = await ctx.newPage();
  page.on("pageerror", e => check(false, "page error: " + e.message));
  await page.goto(BASE + "/app");
  const status = await page.evaluate(async key => (await fetch("/app/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) })).status, PASSWORD);
  check(status === 204, "signed in");
  const api = (method, path, data) => page.evaluate(async ([method, path, data]) => {
    const r = await fetch("/app/api" + path, { method, headers: data ? { "Content-Type": "application/json" } : {}, body: data ? JSON.stringify(data) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, [method, path, data]);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  const seeded = await api("POST", "/note", { category: "inbox", content: `# Errands\n\n- [ ] Call airline @${today} 11:30pm\n- [ ] Take meds @daily 8am, 11:59pm\n- [ ] Book hotel @priority:do\n` });
  check(seeded.status === 200, "seeded a note with tasks");
  await page.goto(BASE + "/app#settings"); await page.reload();
  await page.waitForSelector("#brief-morning-on", { timeout: 20000 });
  check(await page.locator("#briefings h3").textContent() === "Daily briefings", "Settings shows Daily briefings");
  check((await page.locator(".brief-status").first().textContent()).startsWith("Off"), "both start off");
  await page.locator("#briefings").scrollIntoViewIfNeeded();
  await page.screenshot({ path: ROOT + "test-results/briefings-off.png", fullPage: false });
  await page.check("#brief-morning-on");
  await page.fill("#brief-morning-time", "07:30");
  await page.selectOption("#brief-preview", "counts");
  await page.click("#brief-save");
  await page.waitForFunction(() => /Next:/.test(document.querySelector(".brief-status")?.textContent || ""));
  check(/Next: \w+ 7:30\s?AM/i.test(await page.locator(".brief-status").first().textContent()), "save shows the next send: " + await page.locator(".brief-status").first().textContent());
  const state = (await api("GET", "/briefings")).body;
  check(state.settings.revision === 1 && state.settings.morning.enabled && state.settings.preview === "counts", "settings saved with revision 1");
  const stale = await api("PUT", "/briefings", { settings: { evening: { enabled: true } }, revision: 0 });
  check(stale.status === 409, "a stale save is refused (409)");
  await page.click('[data-brief-preview="evening"]');
  await page.waitForSelector("#brief-out:not([hidden])", { timeout: 15000 });
  const preview = await page.locator("#brief-out").textContent();
  check(/^Evening wrap-up · .+\n.*still open/.test(preview), "preview shows the evening digest: " + JSON.stringify(preview));
  await page.click('[data-brief-test="morning"]');
  await page.waitForFunction(() => document.querySelector("#brief-out")?.textContent.startsWith("Good morning"));
  await new Promise(r => setTimeout(r, 500));
  check(pushes.length === 1 && pushes[0].path === "/daybook", "Send test reached the push provider");
  const decoded = pushes[0] && /^=\?UTF-8\?B\?(.+)\?=$/.exec(pushes[0].title);
  check(decoded && Buffer.from(decoded[1], "base64").toString("utf8").startsWith("Good morning · "), "title keeps its non-ASCII dot: " + (decoded ? Buffer.from(decoded[1], "base64").toString("utf8") : pushes[0]?.title));
  check(/^\d+ due today · 1 do now$/.test(pushes[0]?.body || ""), "counts-only body: " + pushes[0]?.body);
  check((pushes[0]?.click || "").endsWith("/app#today"), "tapping opens Today: " + pushes[0]?.click);
  await page.click('[data-brief-test="morning"]');
  await page.waitForSelector(".toast", { timeout: 5000 });
  check(/Wait a minute/.test(await page.locator(".toast").last().textContent()), "a second test within a minute is refused");
  check(pushes.length === 1, "and nothing more was sent");
  await page.locator("#brief-out").scrollIntoViewIfNeeded();
  await page.screenshot({ path: ROOT + "test-results/briefings-on.png", fullPage: false });
} finally { await browser.close(); }
console.log(out.join("\n"));
process.exit(out.some(l => l.startsWith("FAIL")) ? 1 : 0);
