import { test } from "node:test";
import assert from "node:assert/strict";
import { addTask, addReminder } from "../src/core.ts";
import type { Env } from "../src/github.ts";

/** A fake notes repository behind GitHub's contents and tree APIs. */
function fakeGithub(files: Record<string, string>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const path = decodeURIComponent(new URL(String(input)).pathname.replace("/repos/me/notes", ""));
    if (path.startsWith("/git/trees/")) return Response.json({ truncated: false, tree: Object.keys(files).map(p => ({ path: p, type: "blob" })) });
    const m = /^\/contents\/(.+)$/.exec(path);
    if (m && (!init?.method || init.method === "GET")) {
      if (!(m[1] in files)) return new Response("{}", { status: 404 });
      return Response.json({ type: "file", encoding: "base64", content: Buffer.from(files[m[1]]).toString("base64"), sha: "s-" + m[1] });
    }
    if (m && init?.method === "PUT") { files[m[1]] = Buffer.from(JSON.parse(String(init.body)).content, "base64").toString("utf8"); return Response.json({}); }
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}
const env = { GITHUB_TOKEN: "t", NOTES_REPO: "me/notes", NOTES_TIMEZONE: "America/Los_Angeles",
  REMINDERS: { idFromName: () => "id", get: () => ({ setNote: async (_n: string, r: unknown[]) => r }) } } as unknown as Env;

test("tasks collect in one inbox Tasks note, created on first use", async () => {
  const files: Record<string, string> = { "inbox/2026-10-01-groceries.md": "# Groceries\n" };
  const restore = fakeGithub(files);
  try {
    const first = await addTask(env, { text: "Buy stamps" });
    assert.match(first.name, /^inbox\/\d{4}-\d{2}-\d{2}-tasks\.md$/);
    assert.equal(files[first.name], "# Tasks\n\n- [ ] Buy stamps\n");
    const second = await addTask(env, { text: "Dentist", schedule: "2099-01-05 14:30", priority: "plan" });
    assert.equal(second.name, first.name, "the second task goes in the same note");
    assert.match(files[first.name], /^# Tasks\n\n- \[ \] Buy stamps\n- \[ \] Dentist @2099-01-05 14:30 @priority:plan \^[a-z0-9]{6}\n$/, "a dated task gets an ID");
    assert.deepEqual((second as any).reminders?.length, 1, "a dated task becomes a reminder");
  } finally { restore(); }
});

test("an existing Reminders note is reused, and a named note gets the task", async () => {
  const files: Record<string, string> = { "inbox/2026-09-01-reminders.md": "# Reminders\n\n- [ ] Old one @2099-01-01\n\nNotes below\n", "projects/2026-09-02-move.md": "# Move\n" };
  const restore = fakeGithub(files);
  try {
    await addTask(env, { text: "Pay bill", schedule: "weekdays 09:00" });
    assert.match(files["inbox/2026-09-01-reminders.md"], /^# Reminders\n\n- \[ \] Old one @2099-01-01\n- \[ \] Pay bill @weekdays 09:00 \^[a-z0-9]{6}\n\nNotes below\n$/, "added after the last task, before other text");
    await addTask(env, { text: "Book movers", note: "projects/2026-09-02-move.md", priority: "do" });
    assert.equal(files["projects/2026-09-02-move.md"], "# Move\n- [ ] Book movers @priority:do\n");
  } finally { restore(); }
});

test("bad input gets a plain-language error", async () => {
  const restore = fakeGithub({});
  try {
    await assert.rejects(addTask(env, { text: "  " }), /Say what needs doing/);
    await assert.rejects(addTask(env, { text: "Call mom @2099-01-01 9am" }), /Use the date and time options/);
    await assert.rejects(addTask(env, { text: "Call mom", schedule: "someday soon" }), /Couldn't read that date/);
    await assert.rejects(addTask(env, { text: "Call mom", schedule: "2001-01-01 09:00" }), /already passed/);
    await assert.rejects(addTask(env, { text: "Call mom", priority: "urgent" }), /Unknown priority/);
    await assert.rejects(addReminder(env, { text: "Call mom", schedule: "" }), /Couldn't read that date/);
  } finally { restore(); }
});

test("an @ that isn't a schedule is fine in task text", async () => {
  const files: Record<string, string> = {};
  const restore = fakeGithub(files);
  try {
    const r = await addTask(env, { text: "Email sam@example.com about @home" });
    assert.match(files[r.name], /- \[ \] Email sam@example\.com about @home\n/);
  } finally { restore(); }
});
