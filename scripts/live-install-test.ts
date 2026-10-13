// Live check of the installer path against the real Cloudflare API (run by the "Installer live test" workflow
// in the original repository, with its own Cloudflare key). Installs a throwaway Daybook under a separate name,
// signs in, keeps a note in the app's own storage, reads it back, has the app update itself through the
// deployed installer, checks the note survived, then deletes the app and its storage.
//
// Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, INSTALLER_URL (optional; defaults to daybook-installer on the
// account's workers.dev address). Needs installer/bundle (npm run build:bundle).
import { readFileSync } from "node:fs";
import { Cloudflare, checkAccount, install, uninstall, appUrl, type Bundle, type Manifest } from "../src/cloudflare-deploy";

const token = process.env.CLOUDFLARE_API_TOKEN!, accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const name = "daybook-livetest";
const password = "live-" + crypto.randomUUID();
const gh = (kind: "notice" | "error", msg: string) => console.log(`::${kind} title=Installer live test::${msg.replace(/\r?\n/g, " %0A")}`);
let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? "PASS " : "FAIL ") + what); if (!ok) { failures++; gh("error", what); } };

const root = new URL("..", import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(root + "installer/bundle/manifest.json", "utf8")) as Manifest;
const bundle: Bundle = { manifest, files: new Map(manifest.modules.map(m => [m.name, readFileSync(root + "installer/bundle/files/" + m.name + ".txt", "utf8")])) };
const cf = new Cloudflare(token);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(url: string, ok: (r: Response) => Promise<boolean>, what: string, seconds = 180) {
  const started = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (await ok(r)) return true; } catch {}
    if (Date.now() - started > seconds * 1000) { check(false, `${what} (waited ${seconds}s)`); return false; }
    await sleep(3000);
  }
}

// Cloudflare's live log stream for the test app, so a failure shows the app's actual error.
const events: string[] = [];
async function tail(acctId: string): Promise<() => void> {
  const t = await cf.call<{ url: string }>("POST", `/accounts/${acctId}/workers/scripts/${name}/tails`, {});
  const ws = new WebSocket(t.url, "trace-v1");
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("tail didn't connect")); setTimeout(res, 10_000); });
  ws.send(JSON.stringify({ debug: true }));
  ws.onmessage = async m => {
    const text = typeof m.data === "string" ? m.data : await (m.data as Blob).text();
    try {
      const e = JSON.parse(text) as { outcome?: string; event?: { request?: { url?: string } }; exceptions?: { name: string; message: string }[]; logs?: { level: string; message: unknown[] }[] };
      const lines = [...(e.exceptions ?? []).map(x => `EXCEPTION ${x.name}: ${x.message}`), ...(e.logs ?? []).map(l => `${l.level}: ${JSON.stringify(l.message).slice(0, 400)}`)];
      if (lines.length || (e.outcome && e.outcome !== "ok")) events.push(`${e.event?.request?.url ?? "?"} [${e.outcome}] ` + lines.join(" | "));
    } catch { events.push(text.slice(0, 300)); }
  };
  return () => ws.close();
}

let acct = accountId;
let stopTail = () => {};
try {
  const info = await checkAccount(cf, name, accountId);
  acct = info.accountId;
  if (!info.subdomain) throw new Error("This account has no workers.dev address");
  const installer = (process.env.INSTALLER_URL || appUrl("daybook-installer", info.subdomain)).replace(/\/+$/, "");
  if (info.existing) { console.log("Removing a leftover test app"); await uninstall(cf, { accountId: acct, name }); }

  const r = await install(cf, bundle, { name, accountId: acct, password, token, installerUrl: installer });
  const base = r.url;
  try { stopTail = await tail(acct!); } catch (e) { console.log("No live log stream: " + (e instanceof Error ? e.message : e)); }
  check(base === appUrl(name, info.subdomain), "Installed at " + base);
  await waitFor(base + "/health", async res => res.ok && (await res.text()).trim() === "ok", "The new app answers on its workers.dev address");

  // Sign in with the password the installer set.
  // The app only accepts its own pages' requests, so send its origin like a browser would.
  const login = await fetch(base + "/app/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ key: password }) });
  check(login.status === 204, "Signs in with the password the installer set (" + login.status + ")");
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const api = (path: string, init: RequestInit = {}) => fetch(base + "/app/api" + path, { ...init, headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie, ...(init.headers || {}) } });

  const configRes = await api("/config");
  const configText = await configRes.text();
  const config = (() => { try { return JSON.parse(configText); } catch { return {}; } })() as { configured?: boolean; appStorage?: boolean };
  if (!configRes.ok) console.log("GET /config " + configRes.status + ": " + configText.slice(0, 300));
  check(config.appStorage && !config.configured, "Fresh app offers in-app storage and isn't set up yet");
  const setup = await api("/setup", { method: "POST", body: JSON.stringify({ storage: "app", timezone: "America/Los_Angeles" }) });
  check(setup.ok, "First-run setup with notes kept in the app (" + setup.status + " " + (setup.ok ? "" : await setup.text()) + ")");
  const marker = "live-install-" + Date.now();
  const saved = await api("/note", { method: "POST", body: JSON.stringify({ content: "# Live test\n" + marker, category: "inbox" }) });
  check(saved.ok, "Saves a note in the app's own storage (" + saved.status + ")");
  const found = async () => ((await (await api("/search?q=" + marker)).json()) as string[]).length === 1;
  check(await found(), "Finds the note again");

  const status = await (await api("/update")).json() as { canRun?: boolean; current?: string };
  check(status.canRun === true, "The app can update itself (no GitHub)");
  const run = await api("/update/run", { method: "POST" });
  const runBody = await run.text();
  check(run.ok, "Update now through the deployed installer works (" + run.status + " " + runBody.slice(0, 300) + ")");
  await sleep(5000);
  await waitFor(base + "/health", async res => res.ok, "The app answers after updating itself", 60);
  check(await found(), "The note is still there after the update");
  const after = await (await api("/update")).json() as { current?: string };
  check(after.current === manifest.version || after.current === status.current, "Running version " + after.current);
} catch (e) {
  check(false, "Live install failed: " + (e instanceof Error ? e.message : String(e)));
} finally {
  await sleep(3000);
  stopTail();
  if (failures && events.length) gh("error", "App log: " + events.slice(-12).join(" %0A"));
  try { if (acct) await uninstall(cf, { accountId: acct, name }); console.log("Removed the test app"); }
  catch (e) { gh("error", "Couldn't remove the test app " + name + ": " + (e instanceof Error ? e.message : String(e))); failures++; }
}
if (!failures) gh("notice", "Install, sign-in, notes in app storage, self-update and clean-up all worked against real Cloudflare.");
console.log(failures ? `${failures} failed` : "All live checks passed");
process.exit(failures ? 1 : 0);
