// Signed links for the "Done" button on reminder notifications. The phone has no
// OAuth token, so the link carries an HMAC (keyed by MCP_BEARER_TOKEN) over its payload.

export interface DoneAction { note: string; text: string; at?: number; }

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signAction(secret: string, action: DoneAction): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ n: action.note, t: action.text, ...(action.at ? { a: action.at } : {}) })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode("done:" + payload)));
  return payload + "." + b64url(sig);
}

export async function verifyAction(secret: string, token: string): Promise<DoneAction | null> {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await key(secret), unb64url(sig), enc.encode("done:" + payload));
    if (!ok) return null;
    const { n, t, a } = JSON.parse(new TextDecoder().decode(unb64url(payload)));
    if (typeof n !== "string" || typeof t !== "string") return null;
    return typeof a === "number" ? { note: n, text: t, at: a } : { note: n, text: t };
  } catch { return null; }
}

/** Session cookie value "<expiry ms>.<hmac>"; valid until expiry. */
export async function signSession(secret: string, expires: number): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode("session:" + expires)));
  return expires + "." + b64url(sig);
}

export async function verifySession(secret: string, value: string, now = Date.now()): Promise<boolean> {
  const [exp, sig] = value.split(".");
  if (!/^\d+$/.test(exp ?? "") || !sig || +exp < now) return false;
  try { return await crypto.subtle.verify("HMAC", await key(secret), unb64url(sig), enc.encode("session:" + exp)); }
  catch { return false; }
}

/** Constant-time comparison of two secrets. */
export async function equalSecret(actual: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([actual, expected].map(v => crypto.subtle.digest("SHA-256", encoder.encode(v))));
  return Array.from(new Uint8Array(a)).every((v, i) => v === new Uint8Array(b)[i]);
}
