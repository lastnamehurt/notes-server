import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeCloudflare } from "./support/fake-cloudflare.mjs";
import { AlreadyInstalled, Cloudflare, checkAccount, friendly, install, replaceKey, uninstall, update, type Bundle, type Manifest } from "../src/cloudflare-deploy.ts";

const TOKEN = "cf-test-token";
const manifest = (migrations: Manifest["migrations"], dos: Manifest["durable_objects"], version = "2026.10.12.5"): Manifest => ({
  version, main_module: "index.js", modules: [{ name: "index.js", type: "application/javascript+module" }, { name: "abc-app.html", type: "text/plain" }],
  compatibility_date: "2026-09-01", compatibility_flags: ["nodejs_compat"], kv: ["OAUTH_KV"], durable_objects: dos, migrations, crons: ["7 * * * *"]
});
const v1: Bundle = { manifest: manifest([{ tag: "v1-reminders", new_sqlite_classes: ["ReminderScheduler"] }], [{ name: "REMINDERS", class_name: "ReminderScheduler" }], "2026.10.1"),
  files: new Map([["index.js", "export default {}"], ["abc-app.html", "<p>v1</p>"]]) };
const v2: Bundle = { manifest: manifest([{ tag: "v1-reminders", new_sqlite_classes: ["ReminderScheduler"] }, { tag: "v2-app-notes", new_sqlite_classes: ["NotesStore"] }],
  [{ name: "REMINDERS", class_name: "ReminderScheduler" }, { name: "NOTES", class_name: "NotesStore" }]),
  files: new Map([["index.js", "export default { v: 2 }"], ["abc-app.html", "<p>v2</p>"]]) };
const opts = { password: "a-long-password-1", token: TOKEN, installerUrl: "https://daybook-installer.example.workers.dev" };

test("first install on a brand-new account: picks the address, sets up storage, uploads, turns it on", async () => {
  const cf = await startFakeCloudflare({ token: TOKEN });
  try {
    const api = new Cloudflare(TOKEN, cf.url);
    const before = await checkAccount(api);
    assert.deepEqual(before, { accountId: "acc-1", accountName: "jane.doe@example.com's Account", subdomain: null, existing: null });
    await assert.rejects(install(api, v2, opts), /Pick an address/, "a new account needs an address");
    await assert.rejects(install(api, v2, { ...opts, subdomain: "taken" }), /Someone already has taken\.workers\.dev/);
    await assert.rejects(install(api, v2, { ...opts, subdomain: "jane", password: "short" }), /at least 12/);

    const r = await install(api, v2, { ...opts, subdomain: "jane" });
    assert.equal(r.url, "https://daybook.jane.workers.dev");
    const s = cf.state.scripts.get("daybook");
    assert.equal(s.tag, "v2-app-notes", "both storage migrations applied on a fresh install");
    assert.deepEqual(s.lastMetadata.migrations, { new_tag: "v2-app-notes", steps: [{ new_sqlite_classes: ["ReminderScheduler"] }, { new_sqlite_classes: ["NotesStore"] }] });
    const by = Object.fromEntries(s.bindings.map((b: any) => [b.name, b]));
    assert.equal(by.PASSWORD.type, "secret_text"); assert.equal(by.PASSWORD.text, opts.password);
    assert.equal(by.CF_API_TOKEN.type, "secret_text"); assert.equal(by.CF_API_TOKEN.text, TOKEN);
    assert.equal(by.CF_ACCOUNT_ID.text, "acc-1"); assert.equal(by.DAYBOOK_SCRIPT.text, "daybook"); assert.equal(by.DAYBOOK_INSTALLER.text, opts.installerUrl);
    assert.equal(cf.state.kv.get(by.OAUTH_KV.namespace_id), "daybook-oauth");
    assert.equal(by.REMINDERS.class_name, "ReminderScheduler"); assert.equal(by.NOTES.class_name, "NotesStore");
    assert.equal(s.modules.get("index.js").type, "application/javascript+module");
    assert.equal(s.modules.get("abc-app.html").text, "<p>v2</p>");
    assert.equal(s.workersDev, true, "workers.dev address turned on");
    assert.deepEqual(s.crons, ["7 * * * *"]);
    assert.equal(s.compatibility_date, "2026-09-01");

    await assert.rejects(install(api, v2, { ...opts, subdomain: "jane" }), (e: unknown) => e instanceof AlreadyInstalled && e.url === "https://daybook.jane.workers.dev");
    assert.equal((await checkAccount(api)).existing, "https://daybook.jane.workers.dev");
  } finally { await cf.close(); }
});

test("an account that already has a workers.dev address keeps it; a half-finished attempt reuses its storage", async () => {
  const cf = await startFakeCloudflare({ token: TOKEN, subdomain: "courtney" });
  try {
    cf.state.kv.set("kv-old", "daybook-oauth");
    const r = await install(new Cloudflare(TOKEN, cf.url), v2, { ...opts, subdomain: "ignored" });
    assert.equal(r.url, "https://daybook.courtney.workers.dev");
    assert.equal(cf.state.kv.size, 1);
    assert.equal(cf.state.scripts.get("daybook").bindings.find((b: any) => b.name === "OAUTH_KV").namespace_id, "kv-old");
  } finally { await cf.close(); }
});

test("updating keeps the password, key, settings and storage, and adds only the new storage", async () => {
  const cf = await startFakeCloudflare({ token: TOKEN, subdomain: "jane" });
  try {
    const api = new Cloudflare(TOKEN, cf.url);
    await install(api, v1, opts);
    assert.equal(cf.state.scripts.get("daybook").tag, "v1-reminders");
    const r = await update(api, v2, { accountId: "acc-1" });
    assert.equal(r.version, "2026.10.12.5");
    const s = cf.state.scripts.get("daybook");
    assert.deepEqual(s.lastMetadata.migrations, { old_tag: "v1-reminders", new_tag: "v2-app-notes", steps: [{ new_sqlite_classes: ["NotesStore"] }] });
    const by = Object.fromEntries(s.bindings.map((b: any) => [b.name, b]));
    assert.equal(by.PASSWORD.text, opts.password, "password kept");
    assert.equal(by.CF_API_TOKEN.text, TOKEN, "key kept");
    assert.ok(by.OAUTH_KV && by.DAYBOOK_INSTALLER && by.NOTES && by.REMINDERS);
    assert.equal(s.modules.get("abc-app.html").text, "<p>v2</p>");
    assert.equal(s.workersDev, true);

    await update(api, v2, { accountId: "acc-1" });
    assert.equal(cf.state.scripts.get("daybook").lastMetadata.migrations, undefined, "nothing to migrate the second time");
    assert.equal(cf.state.scripts.get("daybook").uploads, 3);

    await replaceKey(api, { accountId: "acc-1", token: "new-key" });
    assert.equal(cf.state.scripts.get("daybook").bindings.find((b: any) => b.name === "CF_API_TOKEN").text, "new-key");
    await assert.rejects(update(api, v2, { accountId: "acc-1", name: "nope" }), /no app called nope/);

    await uninstall(api, { accountId: "acc-1", name: "daybook" });
    assert.equal(cf.state.scripts.size, 0); assert.equal(cf.state.kv.size, 0);
  } finally { await cf.close(); }
});

test("a wrong key gets a plain explanation", async () => {
  const cf = await startFakeCloudflare({ token: TOKEN });
  try {
    const e = await checkAccount(new Cloudflare("wrong", cf.url)).catch(x => x);
    assert.match(friendly(e), /didn't accept that key/);
  } finally { await cf.close(); }
});
