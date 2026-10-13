// A stand-in browser push service (like Apple's, Google's or Mozilla's): records what it receives so tests
// can decrypt it the way a browser would. Paths listed in `gone` answer 410, like an expired subscription.
import http from "node:http";
import nodeCrypto from "node:crypto";

export async function startFakePush({ port = 0 } = {}) {
  const received = [], gone = new Set();
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const path = new URL(req.url, "http://x").pathname;
    if (gone.has(path)) { res.writeHead(410); return res.end(); }
    received.push({ path, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(201); res.end();
  });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, received, gone, close: () => new Promise(r => server.close(r)) };
}

/** Decrypt an aes128gcm web push body as the receiving browser does (RFC 8291), using Node's crypto only. */
export function decryptPush(body, ecdh, authSecret) {
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen), sealed = body.subarray(21 + idlen);
  if (rs < 18 || idlen !== 65) throw new Error("bad header");
  const shared = ecdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(nodeCrypto.hkdfSync("sha256", shared, authSecret, info, 32));
  const cek = Buffer.from(nodeCrypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(nodeCrypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = nodeCrypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  // Strip padding back to the last-record delimiter (0x02).
  let end = plain.length - 1; while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error("missing last-record delimiter");
  return plain.subarray(0, end).toString("utf8");
}
