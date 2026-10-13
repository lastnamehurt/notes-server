import { test } from "node:test";
import assert from "node:assert/strict";
import { applySettings, notesConfigured } from "../src/settings.ts";
import type { Env } from "../src/github.ts";

const store = {} as Env["NOTES"];
const base = { MCP_BEARER_TOKEN: "pw", NOTES: store } as unknown as Env;

test("a deployment that names its repository always stays on GitHub", () => {
  const deployed = { ...base, GITHUB_TOKEN: "t", NOTES_REPO: "court/notes-data" } as Env;
  const env = applySettings(deployed, { storage: "app" });
  assert.notEqual(env.NOTES_STORAGE, "app");
  assert.equal(env.NOTES_REPO, "court/notes-data");
  assert.ok(notesConfigured(env));
});

test("setup choices pick the storage", () => {
  assert.equal(applySettings(base, { storage: "app" }).NOTES_STORAGE, "app");
  assert.ok(notesConfigured(applySettings(base, { storage: "app" })));
  const gh = applySettings(base, { storage: "github", githubToken: "gho_x", notesRepo: "jane/notes" });
  assert.equal(gh.NOTES_STORAGE, "github"); assert.equal(gh.NOTES_REPO, "jane/notes"); assert.ok(notesConfigured(gh));
  // Installs set up with GitHub before storage choices existed have no "storage" field.
  assert.equal(applySettings(base, { githubToken: "gho_x", notesRepo: "jane/notes" }).NOTES_STORAGE, "github");
  assert.ok(!notesConfigured(applySettings(base, {})), "nothing chosen yet means setup isn't finished");
  assert.ok(!notesConfigured(applySettings({ ...base, NOTES: undefined } as Env, { storage: "app" })), "app storage needs the storage binding");
});
