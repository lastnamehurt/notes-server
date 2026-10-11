// In-memory stand-in for the parts of GitHub's REST API the server uses: contents, trees and the
// repository tarball. One repository, "me/notes", readable with token "test-token".
import http from "node:http";
import { gzipSync } from "node:zlib";

const TOKEN = "Bearer test-token";
const files = new Map(); // path -> { content (base64), sha }
let seq = 0;

function tarGz(entries) {
  const enc = new TextEncoder();
  const blocks = [];
  for (const [path, text] of entries) {
    const body = Buffer.from(text, "base64");
    const h = new Uint8Array(512);
    const put = (s, at) => h.set(enc.encode(s), at);
    const full = "me-notes-abc/" + path;
    const cut = full.length > 100 ? full.lastIndexOf("/", 154) : -1;
    put(cut > 0 ? full.slice(cut + 1) : full, 0);
    if (cut > 0) put(full.slice(0, cut), 345);
    put("0000644\0", 100); put("0000000\0", 108); put("0000000\0", 116);
    put(body.length.toString(8).padStart(11, "0") + "\0", 124); put("00000000000\0", 136);
    put("        ", 148); h[156] = 48; put("ustar\0", 257); put("00", 263);
    let sum = 0; for (const b of h) sum += b;
    put(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, body, new Uint8Array((512 - (body.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  return gzipSync(Buffer.concat(blocks.map(b => Buffer.from(b))));
}

export function startFakeGithub(port) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const url = new URL(req.url, "http://x");
    const send = (status, obj, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(obj ?? {})); };
    calls.push(req.method + " " + url.pathname);
    if (req.headers.authorization !== TOKEN) return send(401, { message: "Bad credentials" });
    const m = /^\/repos\/me\/notes\/(contents|git\/trees|tarball)\/(.+)$/.exec(url.pathname);
    if (!m) return send(404, { message: "Not Found" });
    if (m[1] === "git/trees") return send(200, { truncated: false, tree: [...files.keys()].map(path => ({ path, type: "blob" })) });
    if (m[1] === "tarball") { const gz = tarGz([...files].map(([p, f]) => [p, f.content])); res.writeHead(200, { "content-type": "application/x-gzip", "content-length": gz.length }); return res.end(gz); }
    const path = decodeURIComponent(m[2]);
    const existing = files.get(path);
    if (req.method === "GET") return existing ? send(200, { type: "file", encoding: "base64", content: existing.content, sha: existing.sha }) : send(404, { message: "Not Found" });
    const b = JSON.parse(body || "{}");
    if (req.method === "PUT") {
      if (existing ? b.sha !== existing.sha : b.sha) return send(409, { message: "conflict" });
      files.set(path, { content: b.content, sha: "s" + ++seq });
      return send(existing ? 200 : 201, { content: { path } });
    }
    if (req.method === "DELETE") { if (!existing) return send(404, {}); files.delete(path); return send(200, {}); }
    send(405, {});
  });
  return new Promise(resolve => server.listen(port, "127.0.0.1", () => resolve({ server, files, calls })));
}
