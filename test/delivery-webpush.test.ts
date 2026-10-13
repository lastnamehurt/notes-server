import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import nodeCrypto from "node:crypto";
import { sendPush, sendNotice } from "../src/reminders.ts";
import { generateVapidKeys, b64url } from "../src/web-push.ts";
import { startFakePush, decryptPush } from "./support/fake-push.mjs";

async function fakeNtfy() {
  const got: string[] = [];
  const server = http.createServer(async (req, res) => { let b = ""; for await (const c of req) b += c; got.push(b); res.writeHead(200); res.end("{}"); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, got, close: () => new Promise(r => server.close(r)) };
}
const device = (endpoint: string) => {
  const ecdh = nodeCrypto.createECDH("prime256v1"); ecdh.generateKeys(); const auth = nodeCrypto.randomBytes(16);
  return { ecdh, auth, sub: { endpoint, keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(auth) }, device: "iPhone", added: 1 } };
};
const reminder = { note: "inbox/meds.md", text: "Take meds", at: Date.UTC(2026, 9, 13, 15) };

test("with a device on, reminders go there and not to ntfy too", async () => {
  const push = await startFakePush(), ntfy = await fakeNtfy();
  try {
    const phone = device(push.url + "/p");
    const env = { NTFY_TOPIC: "notes-abcdefghijklmnopqrst", NTFY_SERVER: ntfy.url, MCP_BEARER_TOKEN: "secret", PUBLIC_URL: "https://daybook.jane.workers.dev",
      WEB_PUSH: { vapid: await generateVapidKeys(), subscriptions: [phone.sub] } };
    await sendPush(env, reminder);
    assert.equal(ntfy.got.length, 0, "ntfy not used");
    const msg = JSON.parse(decryptPush(push.received[0].body, phone.ecdh, phone.auth));
    assert.equal(msg.body, "Take meds");
    assert.equal(msg.url, "https://daybook.jane.workers.dev/app#today");
    assert.match(msg.done, /^https:\/\/daybook\.jane\.workers\.dev\/done\?a=/);
    await sendNotice(env, { title: "Good morning", message: "2 things today", url: "https://daybook.jane.workers.dev/app#today" });
    assert.equal(JSON.parse(decryptPush(push.received[1].body, phone.ecdh, phone.auth)).title, "Good morning");
    assert.equal(ntfy.got.length, 0);
  } finally { await push.close(); await ntfy.close(); }
});

test("if every device has expired, the app forgets them and falls back to ntfy", async () => {
  const push = await startFakePush(), ntfy = await fakeNtfy();
  try {
    push.gone.add("/old");
    const old = device(push.url + "/old");
    const env = { NTFY_TOPIC: "notes-abcdefghijklmnopqrst", NTFY_SERVER: ntfy.url, WEB_PUSH: { vapid: await generateVapidKeys(), subscriptions: [old.sub] } };
    let pruned: string[] = [];
    await sendPush(env, reminder, undefined, { prune: async g => { pruned = g; } });
    assert.deepEqual(pruned, [push.url + "/old"]);
    assert.equal(ntfy.got.length, 1);
    assert.match(ntfy.got[0], /Take meds/);
  } finally { await push.close(); await ntfy.close(); }
});

test("with nothing set up, the error says how to turn notifications on", async () => {
  await assert.rejects(sendPush({}, reminder), /Turn on notifications/);
  const push = await startFakePush();
  try {
    push.gone.add("/old");
    await assert.rejects(sendPush({ WEB_PUSH: { vapid: await generateVapidKeys(), subscriptions: [device(push.url + "/old").sub] } }, reminder), /turned off on every device/);
  } finally { await push.close(); }
});
