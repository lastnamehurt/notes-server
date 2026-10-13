// The installer, end to end against a stand-in Cloudflare API: a new person makes a key, picks an address and a
// password, and installs; coming back offers Update it; and the installed app updates itself (Update now)
// from the installer's bundle without GitHub, keeping its password and settings.
//
// Run: npm run test:installer   (builds the bundle; needs ports 8794-8797 free; CHROMIUM_PATH optional)
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import { writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { startFakeCloudflare } from "../support/fake-cloudflare.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const INSTALLER = 8794, APP = 8795, CF = 8796, VERSIONS = 8797;
const TOKEN = "cf-e2e-" + "k".repeat(30), PASSWORD = "installer-e2e-password-1";
let failures = 0;
const annotate = msg => { if (process.env.GITHUB_ACTIONS) console.log(`::error title=Installer walk-through::${String(msg).replace(/\r?\n/g, " %0A")}`); };
const check = (ok, what) => { console.log((ok ? "PASS " : "FAIL ") + what); if (!ok) { failures++; annotate(what); } };

execFileSync("node", ["scripts/build-bundle.mjs"], { cwd: ROOT, stdio: "inherit" });
const manifest = JSON.parse(readFileSync(ROOT + "installer/bundle/manifest.json", "utf8"));

const cf = await startFakeCloudflare({ token: TOKEN, port: CF });
// A newer published version, so the installed app shows Update now.
const versions = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end('export const VERSION = "2099.1.1";\nexport const VERSION_NOTE = "Installer test update.";\n');
});
await new Promise(r => versions.listen(VERSIONS, "127.0.0.1", r));

const procs = [];
function start(args, label) {
  const p = spawn("npx", ["wrangler", "dev", ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true });
  p.log = ""; p.stdout.on("data", d => (p.log += d)); p.stderr.on("data", d => (p.log += d)); p.label = label;
  procs.push(p); return p;
}
async function ready(port, p) {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {}
    if (i > 90) { console.log(p.log.slice(-2500)); throw new Error(p.label + " didn't start"); }
    await new Promise(r => setTimeout(r, 1000));
  }
}

// The installed app, as the installer configures it (its own key, account, name and where updates come from).
const devVars = ROOT + ".dev.vars";
const saved = existsSync(devVars) ? readFileSync(devVars, "utf8") : null;
writeFileSync(devVars, [`PASSWORD=${PASSWORD}`, `CF_API_TOKEN=${TOKEN}`, "CF_ACCOUNT_ID=acc-1", `CF_API_URL=${cf.url}`, "DAYBOOK_SCRIPT=daybook",
  `DAYBOOK_INSTALLER=http://127.0.0.1:${INSTALLER}`, `DAYBOOK_VERSION_URL=http://127.0.0.1:${VERSIONS}/version.ts`].join("\n") + "\n");
rmSync(ROOT + ".wrangler/state", { recursive: true, force: true });
const installer = start(["-c", "installer/wrangler.jsonc", "--port", String(INSTALLER), "--ip", "127.0.0.1",
  "--var", `CF_API_URL:${cf.url}`, "--var", "READY_HOST_SUFFIX:.workers.dev", "--inspector-port", "9331"], "installer");
const app = start(["--port", String(APP), "--ip", "127.0.0.1", "--inspector-port", "9332"], "app");
let browser;
const cleanup = () => {
  for (const p of procs) for (const sig of ["SIGTERM", "SIGKILL"]) try { process.kill(-p.pid, sig); } catch {}
  cf.close(); versions.close();
  if (saved !== null) writeFileSync(devVars, saved); else rmSync(devVars, { force: true });
};
process.on("exit", cleanup);

try {
  await ready(INSTALLER, installer);
  await ready(APP, app);
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  const ctx = await browser.newContext(phone);
  ctx.setDefaultTimeout(20000);
  await ctx.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, r => r.abort());
  const errors = [];
  const page = await ctx.newPage();
  page.on("pageerror", e => errors.push(String(e)));
  const I = `http://127.0.0.1:${INSTALLER}`;

  // 1. The page, and the key link that fills in the permissions
  await page.goto(I + "/");
  const keyHref = await page.getAttribute("#keylink", "href");
  const keyUrl = new URL(keyHref);
  const perms = JSON.parse(keyUrl.searchParams.get("permissionGroupKeys"));
  check(keyUrl.host === "dash.cloudflare.com" && keyUrl.pathname === "/profile/api-tokens" && keyUrl.searchParams.get("name") === "Daybook",
    "Create my key opens Cloudflare's token page, named Daybook");
  check(JSON.stringify(perms) === JSON.stringify([{ key: "workers_scripts", type: "edit" }, { key: "workers_kv_storage", type: "edit" }, { key: "account_settings", type: "read" }]),
    "The key asks only for apps, their storage, and reading the account: " + JSON.stringify(perms));
  check(!/github/i.test((await page.innerText("main")).replace(/read the code/i, "")), "No GitHub step anywhere on the page");

  // 2. A wrong key, then the right one
  await page.fill("#token", "not-a-real-key");
  await page.click("#check");
  await page.waitForFunction(() => document.querySelector("#checkerr").textContent.trim());
  check(/didn't accept that key/.test(await page.innerText("#checkerr")), "A wrong key gets a plain explanation");
  await page.fill("#token", TOKEN);
  await page.click("#check");
  await page.waitForSelector("#s3[aria-disabled=false]");
  check(/jane\.doe@example\.com's Account/.test(await page.innerText("#acct")), "Shows which Cloudflare account the key belongs to");
  check(await page.inputValue("#sub") === "jane-doe", "Suggests an address from the account: " + await page.inputValue("#sub"));

  // 3. Address and password
  await page.fill("#sub", "taken"); await page.fill("#pw", PASSWORD);
  await page.click("#install");
  await page.waitForFunction(() => document.querySelector("#installerr").textContent.trim());
  check(/Someone already has taken\.workers\.dev/.test(await page.innerText("#installerr")), "A taken address says so");
  await page.fill("#sub", "jane"); await page.fill("#pw", "short");
  await page.click("#install");
  await page.waitForFunction(() => /12 characters/.test(document.querySelector("#installerr").textContent));
  check(true, "A short password is caught before anything is installed");
  check(!cf.state.scripts.has("daybook"), "Nothing installed yet");

  // 4. Install. The real app address isn't reachable from the test, so its "ready" check is answered here.
  await page.route("**/api/ready", r => r.fulfill({ status: 200, contentType: "application/json", body: '{"ready":true}' }));
  await page.fill("#pw", PASSWORD);
  await page.click("#install");
  await page.waitForSelector("#ready:not([hidden])");
  check(await page.innerText("#appurl") === "https://daybook.jane.workers.dev/app", "Done: shows her app's address");
  check(await page.getAttribute("#open", "href") === "https://daybook.jane.workers.dev/app", "Open my app goes there");
  check(await page.innerText("#mcpurl") === "https://daybook.jane.workers.dev/mcp", "and the Claude address");
  check(await page.inputValue("#token") === "" && await page.inputValue("#pw") === "", "Key and password are cleared from the page");
  const s = cf.state.scripts.get("daybook");
  const by = Object.fromEntries((s?.bindings ?? []).map(b => [b.name, b]));
  check(s && s.workersDev && s.crons.join() === manifest.crons.join(), "Cloudflare: app uploaded, address turned on, hourly check scheduled");
  check(by.PASSWORD?.text === PASSWORD && by.PASSWORD.type === "secret_text", "Her password is a secret in her own account");
  check(by.CF_API_TOKEN?.type === "secret_text" && by.DAYBOOK_INSTALLER?.text === I, "Her app keeps the key and knows where updates come from");
  check(s?.modules.get("index.js")?.text.length === readFileSync(ROOT + "installer/bundle/files/index.js.txt", "utf8").length, "Uploaded code is the built app");
  check(s?.tag === manifest.migrations.at(-1).tag, "All storage set up (" + s?.tag + ")");

  // 5. The bundle installed apps update from
  const served = await (await fetch(I + "/bundle/manifest.json")).json();
  check(served.version === manifest.version && served.modules.length === manifest.modules.length, "Installer publishes the current version " + served.version);

  // 6. Coming back with a key: already installed, Update it
  const again = await ctx.newPage();
  again.on("pageerror", e => errors.push(String(e)));
  await again.goto(I + "/");
  await again.fill("#token", TOKEN);
  await again.click("#check");
  await again.waitForSelector("#update");
  check(/already installed in this account, at https:\/\/daybook\.jane\.workers\.dev/.test(await again.innerText("#checkerr")), "Coming back says it's already installed");
  const uploadsBefore = s.uploads;
  await again.click("#update");
  await again.waitForFunction(() => /Updated to version/.test(document.querySelector("#checkerr").textContent));
  check(cf.state.scripts.get("daybook").uploads === uploadsBefore + 1, "Update it re-uploads the app");
  check(cf.state.scripts.get("daybook").bindings.find(b => b.name === "PASSWORD")?.text === PASSWORD, "and keeps her password");

  // 7. The installed app updates itself: Update now, no GitHub
  const A = `http://127.0.0.1:${APP}`;
  const me = await ctx.newPage();
  me.on("pageerror", e => errors.push(String(e)));
  await me.goto(A + "/app");
  await me.fill("#key", PASSWORD); await me.click("#lockform button[type=submit]");
  // The success bar for a new install: open the app, finish first-run setup WITHOUT notifications,
  // then save a note and open it again. Reminders are a separate, optional feature.
  await me.waitForSelector("#save");
  check(/\(optional\)/.test(await me.innerText("#s4 h3")), "First run: the reminders step says it's optional");
  check(/Skip this and tap Save and finish/.test(await me.innerText("#s4 .skip-note")), "and says how to skip it");
  check(!/ntfy|pushover/i.test(await me.innerText("#s4")), "No ntfy or Pushover for a new install");
  await me.click("#save");
  await me.waitForFunction(() => /notifications are off/i.test(document.querySelector("#main")?.textContent || ""), null, { timeout: 30000 });
  check(true, "Setup finishes with notifications skipped, and says they can be turned on later");
  const marker = "oat-milk-" + Date.now();
  await me.goto(A + "/app#new/inbox");
  await me.waitForSelector("#edform #title");
  await me.fill("#title", "Groceries"); await me.fill("#body", "- " + marker);
  await me.click("#edform #save");
  await me.waitForFunction(m => (document.querySelector("#doc")?.textContent || "").includes(m), marker, { timeout: 20000 });
  check(true, "Saves a note in the app");
  await me.goto(A + "/app#notes"); await me.reload();
  await me.click("text=Groceries");
  await me.waitForFunction(m => (document.querySelector("#doc")?.textContent || "").includes(m), marker, { timeout: 20000 });
  check(true, "Finds the note again and opens it");
  await me.goto(A + "/app#settings"); await me.reload();
  await me.waitForSelector("#update-status .update-run");
  check(/Version 2099\.1\.1 is available/.test(await me.innerText("#update-status")), "Her app shows the new version with Update now");
  const before = cf.state.scripts.get("daybook").uploads;
  await me.click("#update-status .update-run");
  await me.waitForFunction(() => /Updating\./.test(document.querySelector("#update-status")?.textContent || ""));
  check(/reloads by itself in a moment/.test(await me.innerText("#update-status")) && !/GitHub/.test(await me.innerText("#update-status")),
    "Update now updates in place, no GitHub");
  const after = cf.state.scripts.get("daybook");
  check(after.uploads === before + 1, "Her app uploaded the new version to her own Cloudflare account");
  check(JSON.stringify(after.lastMetadata.keep_bindings) === JSON.stringify(["secret_text", "secret_key", "plain_text", "json", "kv_namespace"]),
    "keeping her password, key, settings and sign-in storage");
  check(after.bindings.find(b => b.name === "PASSWORD")?.text === PASSWORD && after.bindings.find(b => b.name === "CF_API_TOKEN"), "Password and key still there afterwards");
  check(errors.length === 0, "No page errors " + JSON.stringify(errors));
} catch (e) {
  failures++;
  console.log("FAIL " + (e.stack || e));
  annotate((e.stack || String(e)).slice(0, 900));
  for (const p of procs) console.log(`--- ${p.label} log ---\n` + p.log.slice(-2000));
} finally {
  await browser?.close();
}
console.log(failures ? `${failures} failed` : "All installer checks passed");
cleanup();
process.exit(failures ? 1 : 0);
