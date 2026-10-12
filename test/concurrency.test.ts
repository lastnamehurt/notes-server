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
