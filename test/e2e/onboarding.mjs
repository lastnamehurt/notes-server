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
import nodeCrypto from "node:crypto";
import { startFakePush, decryptPush } from "../support/fake-push.mjs";

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
const dispatches = [];
const gh = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const p = new URL(req.url, "http://x").pathname;
  const send = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o ?? {})); };
  if (p.startsWith("/ntfy/")) { pushes.push(body); return send(200); }
  // A newer published version, and her own copy of the code (found via her GitHub connection).
  if (p === "/version.ts") { res.writeHead(200, { "content-type": "text/plain" }); return res.end('export const VERSION = "2099.1.1";\nexport const VERSION_NOTE = "Test update note.";\n'); }
  // Her copy isn't called notes-server here, so the app has to find it among her repositories.
  if (p === "/repos/jane/my-daybook/contents/.github/workflows/update-daybook.yml") return req.headers.authorization === "Bearer " + TOKEN ? send(200, { type: "file" }) : send(401);
  if (p === "/repos/jane/my-daybook" && req.method === "GET") return req.headers.authorization === "Bearer " + TOKEN ? send(200, { default_branch: "main" }) : send(401);
  if (p === "/repos/jane/my-daybook/actions/workflows/update-daybook.yml/dispatches" && req.method === "POST") {
    if (req.headers.authorization !== "Bearer " + TOKEN) return send(401);
    dispatches.push(JSON.parse(body)); res.writeHead(204); return res.end();
  }
  if (p === "/login/device/code") return send(200, { device_code: "dev-" + ++seq, user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
  if (p === "/login/oauth/access_token") return send(200, approved ? { access_token: TOKEN, token_type: "bearer", scope: "repo" } : { error: "authorization_pending" });
  if (req.headers.authorization !== "Bearer " + TOKEN) return send(401, { message: "Bad credentials" });
  if (p === "/user") return send(200, { login: "jane" });
  if (p === "/user/repos" && req.method === "GET") return send(200, [...Object.entries(repos).map(([full_name, r]) => ({ full_name, private: r.private })),
    ...(/affiliation=owner/.test(req.url) ? [{ full_name: "jane/my-daybook", private: false }] : [])]);
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

// ---------- stand-in push service, and this "phone's" push keys ----------
// Headless browsers can't reach Google's real push service, so the page gets a stand-in subscription
// (pointing at a local push service) whose private key this test holds, and decrypts what the app sends.
const pushService = await startFakePush();
const phoneKeys = nodeCrypto.createECDH("prime256v1"); phoneKeys.generateKeys();
const phoneAuth = nodeCrypto.randomBytes(16);
const phoneSub = { endpoint: pushService.url + "/phone-1", keys: { p256dh: phoneKeys.getPublicKey().toString("base64url"), auth: phoneAuth.toString("base64url") } };
const fakePushManager = sub => {
  // As on a phone where the person tapped Allow. (Playwright's lightweight headless browser always says "denied".)
  Object.defineProperty(Notification, "permission", { get: () => "granted", configurable: true });
  Notification.requestPermission = async () => "granted";
  const make = key => ({ endpoint: sub.endpoint, options: { applicationServerKey: key },
    toJSON: () => ({ endpoint: sub.endpoint, expirationTime: null, keys: sub.keys }),
    unsubscribe: async () => { localStorage.removeItem("fake-push-sub"); return true; } });
  PushManager.prototype.subscribe = async function (o) {
    const k = new Uint8Array(o.applicationServerKey); localStorage.setItem("fake-push-sub", JSON.stringify([...k])); return make(k.buffer);
  };
  PushManager.prototype.getSubscription = async function () {
    const k = localStorage.getItem("fake-push-sub"); return k ? make(new Uint8Array(JSON.parse(k)).buffer) : null;
  };
};
const received = () => pushService.received.filter(r => r.path === "/phone-1").map(r => JSON.parse(decryptPush(r.body, phoneKeys, phoneAuth)));

// ---------- Worker with only a password ----------
const devVars = ROOT + ".dev.vars";
const saved = existsSync(devVars) ? readFileSync(devVars, "utf8") : null;
writeFileSync(devVars, [`PASSWORD=${PASSWORD}`, `GITHUB_API_URL=http://127.0.0.1:${GH}`, `GITHUB_LOGIN_URL=http://127.0.0.1:${GH}`,
  "GITHUB_CLIENT_ID=onboarding-test", "PUSH_ALLOW_HTTP=true", `DAYBOOK_VERSION_URL=http://127.0.0.1:${GH}/version.ts`].join("\n") + "\n");
rmSync(ROOT + ".wrangler/state", { recursive: true, force: true });
const worker = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true });
let log = ""; worker.stdout.on("data", d => (log += d)); worker.stderr.on("data", d => (log += d));
let browser;
const cleanup = () => {
  for (const sig of ["SIGTERM", "SIGKILL"]) try { process.kill(-worker.pid, sig); } catch {}
  gh.close(); pushService.close();
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
  const ctx = await browser.newContext({ ...phone, permissions: ["clipboard-read", "clipboard-write", "notifications"] });
  await ctx.addInitScript(fakePushManager, phoneSub);
  // Outside sites stand-ins: the test never touches github.com or claude.ai.
  await ctx.route(/^https:\/\/(github\.com|claude\.ai|chatgpt\.com|cursor\.com)\//, r => r.fulfill({ status: 200, contentType: "text/html", body: "<h1>stand-in</h1>" }));
  await ctx.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, r => r.abort());
  ctx.setDefaultTimeout(20000);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e.stack || e).slice(0, 500)));

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
  await page.waitForSelector("#push-on");
  check(!/ntfy|pushover/i.test(await page.innerText("#s4")), "Reminders step: no ntfy or Pushover, just Turn on notifications");
  await page.click("#push-on");
  await page.waitForFunction(() => /Notifications are on for this/.test(document.querySelector("#push-box")?.textContent || ""));
  check(true, "Turn on notifications: on for this device, nothing to install");
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
  check(await page.locator("#test").count() === 1, "Finish screen offers a test notification");
  await page.click("#test");
  for (let i = 0; i < 30 && !received().length; i++) await page.waitForTimeout(200);
  const test = received()[0];
  check(test?.title === "Reminder" && test?.body === "Test notification from Daybook ✓" && /\/app#today$/.test(test?.url || ""),
    "Test notification arrives encrypted for this device, and decrypts: " + JSON.stringify(test));
  const auth = pushService.received[0]?.headers.authorization || "";
  check(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/.test(auth), "Sent with the app's own push key (VAPID)");

  // 4. First use
  await page.click("text=Open my notes");
  await page.waitForTimeout(1200);
  // Settings is the gear in the header.
  const tabsShown = await page.locator("#tabs").isVisible();
  check(tabsShown && await page.locator("#settingsTab").isVisible(), "Tabs and Settings appear after setup");

  // 5. Settings later: checks work when Settings is opened directly
  const later = await ctx.newPage();
  later.on("pageerror", e => errors.push(String(e.stack || e).slice(0, 500)));
  // Settings folds its extras into one-line rows; a link to a row opens it.
  await later.goto(BASE + "/app#settings/diagnostics");
  await later.waitForSelector("#run-diagnostics");
  await later.click("#run-diagnostics");
  await later.waitForFunction(() => { const o = document.querySelector("#diagnostics-results"); return o && !/Checking/.test(o.textContent) && o.textContent.trim(); });
  check((await later.innerText("#diagnostics-results")).trim().length > 0, "Run checks shows results when Settings is opened directly");

  // 6. Updates: banner on Today with Update now (her copy found among her repositories), and in Settings
  const today = await ctx.newPage();
  today.on("pageerror", e => errors.push(String(e.stack || e).slice(0, 500)));
  await today.goto(BASE + "/app#today");
  await today.waitForSelector("#update-banner");
  check(/Test update note/.test(await today.innerText("#update-banner")), "Today shows 'An update is available' with the note");
  check(await today.locator("#update-banner .update-run").isVisible(), "Banner offers Update now (no trip to GitHub)");
  await today.click("#update-later");
  await today.reload(); await today.waitForTimeout(1500);
  check(await today.locator("#update-banner").count() === 0, "Later hides the banner for this version");
  await later.reload(); await later.waitForSelector("#update-status .update-run");
  check(/Version 2099\.1\.1 is available/.test(await later.innerText("#update-status")), "Settings shows the available version");
  await later.click("#update-status .update-run");
  await later.waitForFunction(() => /Updating\./.test(document.querySelector("#update-status")?.textContent || ""));
  check(dispatches.length === 1 && dispatches[0].ref === "main", "Update now starts Update Daybook in her copy (jane/my-daybook): " + JSON.stringify(dispatches));
  check(await later.getAttribute("#update-status a", "href") === "https://github.com/jane/my-daybook/actions/workflows/update-daybook.yml", "and links to watch it on GitHub");

  // 7. Coming back on another phone: password box first, GitHub as the alternative
  const fresh = await browser.newContext(phone);
  await fresh.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, r => r.abort());
  const back = await fresh.newPage();
  back.on("pageerror", e => errors.push(String(e.stack || e).slice(0, 500)));
  await back.goto(BASE + "/app");
  await back.waitForSelector("#key");
  check(await back.locator("#ghbtn").isVisible(), "Return visit offers the password and Sign in with GitHub");
  await back.fill("#key", PASSWORD);
  await back.click("#lockform button[type=submit]");
  await back.waitForSelector("#tabs:not([hidden])");
  check(true, "Password unlocks after setup");

  // 8. Settings shows this device; another phone (an iPhone in Safari, not from the Home Screen) is told how
  const settings = await ctx.newPage();
  settings.on("pageerror", e => errors.push(String(e.stack || e).slice(0, 400)));
  await settings.goto(BASE + "/app#settings");
  await settings.waitForFunction(() => /Notifications are on for this/.test(document.querySelector("#push-box")?.textContent || ""));
  check(true, "Settings: notifications on for this device");
  const iphone = await browser.newContext({ ...phone, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
  await iphone.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, r => r.abort());
  const ip = await iphone.newPage();
  ip.on("pageerror", e => errors.push(String(e.stack || e).slice(0, 500)));
  await ip.goto(BASE + "/app");
  await ip.fill("#key", PASSWORD); await ip.click("#lockform button[type=submit]");
  await ip.waitForSelector("#tabs:not([hidden])");
  // Navigating while Today is still loading: Settings must end up on screen, not be replaced by the slower Today render.
  await ip.goto(BASE + "/app#settings");
  await ip.waitForTimeout(1500);
  const ipText = await ip.waitForFunction(() => document.querySelector("#push-box")?.textContent, null, { timeout: 15000 }).then(r => r.jsonValue()).catch(() => "");
  check(/Add to Home Screen/.test(ipText) && await ip.locator("#push-on").count() === 0, "iPhone in Safari: told to add Daybook to the Home Screen first");
  await iphone.close();

  // 9. A real reminder goes off on this device (written in a note, due in about a minute)
  const due = new Date(Date.now() + 75_000);
  const local = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(due);
  const part = t => local.find(p => p.type === t).value;
  const when = `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
  const saveNote = await settings.request.post(BASE + "/app/api/note", { headers: { Origin: BASE },
    data: { category: "inbox", content: `# Water\n- [ ] Drink water @${when}` } });
  check(saveNote.ok(), "Saved a note with a reminder at " + when);
  const before = received().length;
  for (let i = 0; i < 90 && received().length === before; i++) await settings.waitForTimeout(2000);
  const reminder = received().at(-1);
  check(reminder?.title === "Reminder" && reminder?.body === "Drink water" && /\/done\?a=/.test(reminder?.done || ""),
    "The reminder arrives on this device at its time, with a Done link: " + JSON.stringify(reminder));
  check(!received()[0]?.done, "(the test notification had no Done button)");

  // 10. Turn off on this device
  await settings.click("#push-off");
  await settings.waitForSelector("#push-on");
  const after = await (await settings.request.get(BASE + "/app/api/push")).json();
  check(after.devices.length === 0, "Turn off removes this device");
  await settings.click("#push-on");
  await settings.waitForFunction(() => /Notifications are on for this/.test(document.querySelector("#push-box")?.textContent || ""));
  check(true, "and it can be turned back on");

  // 11. Someone already on ntfy (older option): shown under "older option", can stop using it
  const topic = "notes-legacytopic1234567890";
  const legacySave = await settings.request.post(BASE + "/app/api/setup", { headers: { Origin: BASE }, data: { repo: "jane/notes", ntfyTopic: topic } });
  check(legacySave.ok(), "(an older setup with ntfy)");
  await settings.goto(BASE + "/app#settings"); await settings.reload();
  await settings.waitForSelector("#legacy-push");
  check(/ntfy \(older option\)/.test(await settings.innerText("#legacy-push summary")) && await settings.isChecked("#uselegacy"), "ntfy shows as the older option, kept as a backup");
  // The notifications box fills in after Settings draws, alongside other Settings requests.
  await settings.waitForFunction(() => /instead of ntfy/.test(document.querySelector("#push-box")?.innerText || ""), null, { timeout: 5000 }).catch(() => {});
  check(/instead of ntfy/.test(await settings.innerText("#push-box")), "and says reminders now go to devices instead");
  await settings.click("#legacy-push summary");
  await settings.uncheck("#uselegacy");
  await settings.click("#save");
  await settings.waitForSelector("#copymcp");
  const afterLegacy = await (await settings.request.get(BASE + "/app/api/settings")).json();
  check(afterLegacy.notify === null && !afterLegacy.ntfyTopic, "Unticking stops ntfy");
  check((await (await settings.request.get(BASE + "/app/api/push")).json()).devices.length === 1, "and keeps this device's notifications");

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
