import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { readTarGz, untar } from "../src/snapshot.ts";
import { GithubNotes, type Env } from "../src/github.ts";
import { recentLogs } from "../src/log.ts";

const fixture = (name: string) => new Response(readFileSync(new URL("./fixtures/" + name, import.meta.url))).body!;

/** Minimal ustar writer for test archives. */
function tarGz(files: Record<string, string>, top = "owner-notes-abc/"): Uint8Array {
  const enc = new TextEncoder();
  const blocks: Uint8Array[] = [];
  for (const [path, text] of Object.entries(files)) {
    const body = enc.encode(text);
    const h = new Uint8Array(512);
    const put = (s: string, at: number) => h.set(enc.encode(s), at);
    const full = top + path;
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
  const tar = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let o = 0; for (const b of blocks) { tar.set(b, o); o += b.length; }
  return new Uint8Array(gzipSync(tar));
}

test("reads a GitHub-style archive (git archive, PAX headers, long paths, UTF-8)", async () => {
  const files = await readTarGz(fixture("github-archive.tar.gz"));
  assert.equal(files.get("inbox/2026-10-11-groceries.md"), "# Groceries\neggs and Ünïcödé ✓\n");
  assert.equal(files.get("journal/log/2026-10-11.md"), "# Log 2026-10-11\n\n- 08:00 tea #drink\n");
  const long = [...files.keys()].find(k => k.endsWith("long-path-note.md"))!;
  assert.ok(long.startsWith("reference/" + "a".repeat(120) + "/"), "path over 100 characters survives");
  assert.equal(files.get(long), "deep note marker-long\n");
  assert.ok(![...files.keys()].some(k => k.startsWith("owner-notes")), "top folder removed");
});

test("reads GNU long names", async () => {
  const files = await readTarGz(fixture("gnu-longname.tar.gz"));
  assert.equal(files.get("projects/" + "b".repeat(130) + ".md"), "# long gnu\n");
  assert.equal(files.get("inbox/2026-10-11-a.md"), "# A\n");
});

test("untar ignores directories and stops at the end marker", () => {
  const tar = new Uint8Array(1024);
  assert.equal(untar(tar).size, 0);
});

// The point of the snapshot: a big repository costs a couple of outside calls, not one per note.
test("600 notes: search, scans and 90 days of logs stay within a handful of GitHub calls", async () => {
  const files: Record<string, string> = { "README.md": "# readme" };
  for (let i = 0; i < 400; i++) files[`inbox/2026-01-01-note-${i}.md`] = `# Note ${i}\nbody ${i}${i === 377 ? " needle-xyz" : ""}\n`;
  const day = (n: number) => new Date(Date.UTC(2026, 9, 11) - n * 86_400_000).toISOString().slice(0, 10);
  for (let n = 0; n < 200; n++) files[`journal/log/${day(n)}.md`] = `# Log ${day(n)}\n\n- 08:00 tea #drink\n`;
  files["goals/2026-10-01-run.md"] = "# Run\n- [ ] Shoes @2027-01-01 9am\n";
  const archive = tarGz(files);
  let calls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls++;
    const url = String(input);
    assert.match(url, /\/repos\/me\/notes\/tarball\/main$/, "only the archive is fetched: " + url);
    return new Response(archive, { headers: { "Content-Length": String(archive.length) } });
  }) as typeof fetch;
  const notes = new GithubNotes({ GITHUB_API_URL: "https://api.test", GITHUB_TOKEN: "t", NOTES_REPO: "me/notes" } as Env);

  assert.deepEqual(await notes.search("needle-xyz"), ["inbox/2026-01-01-note-377.md"]);
  assert.equal((await notes.search("note")).length, 400);
  assert.equal((await notes.all("journal/log/")).length, 401, "README skipped, logs skipped");
  assert.equal((await notes.all(undefined, "goals/")).length, 1);
  const logs = await recentLogs(notes, 90, "UTC", Date.UTC(2026, 9, 11, 12));
  assert.equal(logs.length, 90);
  assert.equal(logs[0].date, "2026-10-11", "newest first");
  assert.equal(calls, 1, "one archive read shared by everything in the request");

  await assert.rejects(notes.put("inbox/x.md", ""), /empty/);
  const fresh = new GithubNotes({ GITHUB_API_URL: "https://api.test", GITHUB_TOKEN: "t", NOTES_REPO: "me/notes" } as Env);
  await fresh.search("x");
  assert.equal(calls, 2, "a new request reads a fresh archive");
});

test("an empty repository has no notes", async () => {
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
  const notes = new GithubNotes({ GITHUB_TOKEN: "t", NOTES_REPO: "me/notes" } as Env);
  assert.deepEqual(await notes.search("anything"), []);
  assert.deepEqual(await notes.all(), []);
});
