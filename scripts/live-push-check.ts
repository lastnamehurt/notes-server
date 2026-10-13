// Do the real push services accept Daybook's sender identity (VAPID) and message format? Sends to a made-up
// device on Apple's, Google's and Mozilla's push services: a bad signature is refused as a sender problem
// (401/403), a good one only as an unknown device (400/404/410). Run by the Installer live test workflow.
import { encryptPayload, generateVapidKeys, vapidHeader, b64url } from "../src/web-push";

const gh = (kind: "notice" | "error", msg: string) => console.log(`::${kind} title=Push services::${msg.replace(/\r?\n/g, " ")}`);
const vapid = await generateVapidKeys();
const device = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
const keys = { p256dh: b64url(await crypto.subtle.exportKey("raw", device.publicKey) as ArrayBuffer), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) };
const services = {
  Apple: "https://web.push.apple.com/QGm5Zm9vYmFyYmF6cXV4ZGF5Ym9va3Rlc3Q",
  Google: "https://fcm.googleapis.com/fcm/send/dDaybookTestToken:APA91bH" + "x".repeat(120),
  Mozilla: "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABdaybooktest" + "A".repeat(80)
};
let failures = 0;
for (const [name, endpoint] of Object.entries(services)) {
  const res = await fetch(endpoint, { method: "POST", headers: {
    Authorization: await vapidHeader(vapid, endpoint, "https://daybook-installer.clhurt1.workers.dev"),
    "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "60", Urgency: "high"
  }, body: await encryptPayload({ endpoint, keys }, new TextEncoder().encode('{"title":"test"}')) });
  const text = (await res.text()).slice(0, 300).replace(/\s+/g, " ");
  const senderRejected = res.status === 401 || res.status === 403 || /jwt|vapid|authorization|crypto-key|encryption|encoding/i.test(text);
  console.log(`${name}: ${res.status} ${text}`);
  if (senderRejected) { failures++; gh("error", `${name} rejected the sender or format: ${res.status} ${text}`); }
  else gh("notice", `${name} accepted the sender and format (only the made-up device was refused: ${res.status})`);
}
process.exit(failures ? 1 : 0);
