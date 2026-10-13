// Web push: notifications straight to the phone or computer that turned them on, with no extra app.
// iPhone (iOS 16.4+, from the Home Screen app), Android, and desktop browsers all accept these.
//
// Standards: payload encryption RFC 8291 (aes128gcm, RFC 8188) and sender identification RFC 8292 (VAPID).
// Everything runs on the Worker's built-in WebCrypto: no libraries, no outside service besides the
// browser's own push service (Apple, Google or Mozilla), which only ever sees encrypted payloads.

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export interface Subscription extends PushSubscriptionJSON {
  /** "iPhone", "Android phone", "Mac"…, shown in Settings. */
  device: string;
  added: number;
}
export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url (what browsers call applicationServerKey). */
  publicKey: string;
  privateJwk: JsonWebKey;
}
export interface WebPushState { vapid?: VapidKeys; subscriptions: Subscription[] }

export interface PushMessage {
  title: string;
  body: string;
  /** Opened when the notification is tapped. */
  url?: string;
  /** Signed "mark done" link; becomes a Done button where the device supports buttons. */
  done?: string;
  /** Replaces an earlier notification with the same tag. */
  tag?: string;
}

const enc = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64url(s: string): Bytes {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer;
  return { publicKey: b64url(raw), privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey };
}

/** VAPID Authorization header for one push service (RFC 8292). */
export async function vapidHeader(vapid: VapidKeys, endpoint: string, subject: string, now = Date.now()): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, concat(enc.encode(header + "." + claims)));
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${vapid.publicKey}`;
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** Encrypt a payload for one subscription (RFC 8291). Returns the request body. */
export async function encryptPayload(sub: PushSubscriptionJSON, payload: Uint8Array,
  test?: { salt: Bytes; keyPair: CryptoKeyPair }): Promise<Bytes> {
  const uaPublic = fromB64url(sub.keys.p256dh), authSecret = fromB64url(sub.keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error("Bad subscription keys");
  const local = test?.keyPair ?? await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as EcdhKeyDeriveParams, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = test?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, concat(enc.encode("Content-Encoding: aes128gcm\0")), 16);
  const nonce = await hkdf(salt, ikm, concat(enc.encode("Content-Encoding: nonce\0")), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // One record: the payload, then the 0x02 "last record" delimiter.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, sealed);
}

export type SendResult = { delivered: number; gone: string[]; errors: string[] };

/**
 * Send one message to every subscription. A subscription the push service says no longer exists
 * (404/410) is reported in `gone` so the caller can forget it.
 */
export async function sendWebPush(state: WebPushState, message: PushMessage, subject: string,
  options: { ttl?: number; urgency?: "high" | "normal" } = {}): Promise<SendResult> {
  const result: SendResult = { delivered: 0, gone: [], errors: [] };
  if (!state.vapid || !state.subscriptions.length) return result;
  const body = concat(enc.encode(JSON.stringify(message)));
  await Promise.all(state.subscriptions.map(async sub => {
    try {
      const res = await fetch(sub.endpoint, {
        method: "POST",
        headers: {
          "Authorization": await vapidHeader(state.vapid!, sub.endpoint, subject),
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          "TTL": String(options.ttl ?? 24 * 3600),
          "Urgency": options.urgency ?? "high"
        },
        body: await encryptPayload(sub, body)
      });
      if (res.ok) result.delivered++;
      else if (res.status === 404 || res.status === 410) result.gone.push(sub.endpoint);
      else result.errors.push(`${sub.device}: push service said ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`.trim());
    } catch (e) {
      result.errors.push(`${sub.device}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }));
  return result;
}

/** Only real push services, over HTTPS. (Tests point at a local stand-in through PUSH_ALLOW_HTTP.) */
export function validEndpoint(endpoint: string, allowHttp = false): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" || (allowHttp && u.protocol === "http:");
  } catch { return false; }
}

/** "iPhone", "Android phone", "Mac", "Windows PC"… from a browser's user agent. */
export function deviceName(ua: string): string {
  if (/iPad/.test(ua)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Linux/.test(ua)) return "Linux computer";
  return "This device";
}
