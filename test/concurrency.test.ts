import { test } from "node:test";
import assert from "node:assert/strict";
import { GithubNotes, type Env } from "../src/github.ts";

test("stale editor revision is rejected before any write", async () => {
  const original = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "PUT") { writes++; return new Response("{}", { status: 200 }); }
    return Response.json({ type: "file", encoding: "base64", content: btoa("# latest\\n"), sha: "new-sha" });
  }) as typeof fetch;
  try {
    const notes = new GithubNotes({ GITHUB_TOKEN: "t", NOTES_REPO: "me/notes" } as Env);
    await assert.rejects(notes.update("inbox/a.md", "# stale", "old-sha"), /changed since it was opened/);
    assert.equal(writes, 0);
    await notes.update("inbox/a.md", "# current", "new-sha");
    assert.equal(writes, 1);
  } finally { globalThis.fetch = original; }
});

test("GitHub conflict on a racing write is propagated", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => init?.method === "PUT"
    ? new Response("{}", { status: 409 })
    : Response.json({ type: "file", encoding: "base64", content: btoa("# latest\\n"), sha: "same" })) as typeof fetch;
  try {
    const notes = new GithubNotes({ GITHUB_TOKEN: "t", NOTES_REPO: "me/notes" } as Env);
    await assert.rejects(notes.update("inbox/a.md", "# edited", "same"), /GitHub conflict/);
  } finally { globalThis.fetch = original; }
});

test("commitFiles writes all notes in one fast-forward-only commit, and maps a moved branch to a conflict", async () => {
  const original = globalThis.fetch;
  const calls: { method: string; path: string; body: any }[] = [];
  let refStatus = 200;
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname.replace("/repos/me/notes", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path, body });
    if (path === "/git/commits/" + "a".repeat(40)) return Response.json({ tree: { sha: "base-tree" } });
    if (path === "/git/trees") return Response.json({ sha: "new-tree" });
    if (path === "/git/commits") return Response.json({ sha: "b".repeat(40) });
    if (path === "/git/refs/heads/main") return new Response("{}", { status: refStatus });
    if (path === "/git/ref/heads/main") return Response.json({ object: { sha: "a".repeat(40) } });
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  try {
    const notes = new GithubNotes({ GITHUB_TOKEN: "t", NOTES_REPO: "me/notes" } as Env);
    assert.equal(await notes.headSha(), "a".repeat(40));
    const files = new Map([["inbox/a.md", "- [ ] One ^aaaaaa"], ["journal/log/2026-10-11.md", "# Log\n\n- 10:00 ✓ One #done\n"]]);
    assert.equal(await notes.commitFiles("a".repeat(40), files, "notes: sync"), "b".repeat(40));
    const tree = calls.find(c => c.path === "/git/trees")!.body;
    assert.equal(tree.base_tree, "base-tree");
    assert.deepEqual(tree.tree.map((t: any) => [t.path, t.content]), [["inbox/a.md", "- [ ] One ^aaaaaa\n"], ["journal/log/2026-10-11.md", "# Log\n\n- 10:00 ✓ One #done\n"]]);
    assert.deepEqual(calls.find(c => c.path === "/git/commits")!.body.parents, ["a".repeat(40)]);
    const ref = calls.find(c => c.path === "/git/refs/heads/main")!;
    assert.deepEqual([ref.method, ref.body], ["PATCH", { sha: "b".repeat(40), force: false }]);
    refStatus = 422;
    await assert.rejects(notes.commitFiles("a".repeat(40), files, "notes: sync"), /GitHub conflict/);
    await assert.rejects(notes.commitFiles("a".repeat(40), new Map([["../x.md", "x"]]), "m"), /Invalid note path/);
  } finally { globalThis.fetch = original; }
});
