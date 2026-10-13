import { test } from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { encryptPayload, generateVapidKeys, vapidHeader, sendWebPush, deviceName, validEndpoint, b64url, fromB64url } from "../src/web-push.ts";
import { startFakePush, decryptPush } from "./support/fake-push.mjs";

/** A browser's side of a subscription: its key pair and auth secret, made with Node's own crypto. */
function browserSubscription(endpoint = "https://push.example.net/abc") {
  const ecdh = nodeCrypto.createECDH("prime256v1"); ecdh.generateKeys();
  const auth = nodeCrypto.randomBytes(16);
  return { sub: { endpoint, keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(auth) } }, ecdh, auth };
}

test("payloads decrypt the way a browser decrypts them (RFC 8291, aes128gcm)", async () => {
  const { sub, ecdh, auth } = browserSubscription();
  const message = { title: "Reminder", body: "Take meds 💊", url: "/app#today", tag: "r1" };
  const body = await encryptPayload(sub, new TextEncoder().encode(JSON.stringify(message)));
  assert.deepEqual(JSON.parse(decryptPush(Buffer.from(body), ecdh, auth)), message);
  // Fresh salt and key each time, so the same message never looks the same twice.
  const again = await encryptPayload(sub, new TextEncoder().encode(JSON.stringify(message)));
  assert.notDeepEqual(Buffer.from(again).subarray(0, 16), Buffer.from(body).subarray(0, 16));
});

test("VAPID: the push service can check the signature with the app's public key (RFC 8292)", async () => {
  const vapid = await generateVapidKeys();
  assert.equal(fromB64url(vapid.publicKey).length, 65);
  const header = await vapidHeader(vapid, "https://web.push.apple.com/QF3k?x=1", "https://daybook.jane.workers.dev", Date.UTC(2026, 9, 12));
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
  assert.ok(m, header);
  assert.equal(m[4], vapid.publicKey);
  const claims = JSON.parse(Buffer.from(m[2], "base64url").toString());
  assert.deepEqual(claims, { aud: "https://web.push.apple.com", exp: Date.UTC(2026, 9, 12) / 1000 + 12 * 3600, sub: "https://daybook.jane.workers.dev" });
  const pub = nodeCrypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64url(fromB64url(vapid.publicKey).slice(1, 33)), y: b64url(fromB64url(vapid.publicKey).slice(33)) }, format: "jwk" });
  assert.ok(nodeCrypto.verify("sha256", Buffer.from(m[1] + "." + m[2]), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url")));
});

test("sends to every device, and reports ones the push service has forgotten", async () => {
  const push = await startFakePush();
  try {
    const vapid = await generateVapidKeys();
    const phone = browserSubscription(push.url + "/phone"), laptop = browserSubscription(push.url + "/laptop"), old = browserSubscription(push.url + "/gone");
    push.gone.add("/gone");
    const r = await sendWebPush({ vapid, subscriptions: [
      { ...phone.sub, device: "iPhone", added: 1 }, { ...laptop.sub, device: "Mac", added: 2 }, { ...old.sub, device: "Android phone", added: 3 }
    ] }, { title: "Reminder", body: "Call mom", done: "https://x/done?a=1" }, "https://daybook.jane.workers.dev");
    assert.equal(r.delivered, 2);
    assert.deepEqual(r.gone, [push.url + "/gone"]);
    assert.deepEqual(r.errors, []);
    const got = push.received.find(x => x.path === "/phone")!;
    assert.equal(got.headers["content-encoding"], "aes128gcm");
    assert.equal(got.headers.urgency, "high");
    assert.match(got.headers.authorization, /^vapid t=.+, k=/);
    assert.deepEqual(JSON.parse(decryptPush(got.body, phone.ecdh, phone.auth)), { title: "Reminder", body: "Call mom", done: "https://x/done?a=1" });
  } finally { await push.close(); }
});

test("device names and endpoint checks", () => {
  assert.equal(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15"), "iPhone");
  assert.equal(deviceName("Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36"), "Android phone");
  assert.equal(deviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15"), "Mac");
  assert.equal(validEndpoint("https://fcm.googleapis.com/fcm/send/x"), true);
  assert.equal(validEndpoint("http://127.0.0.1:1/x"), false);
  assert.equal(validEndpoint("http://127.0.0.1:1/x", true), true);
  assert.equal(validEndpoint("javascript:alert(1)", true), false);
});
