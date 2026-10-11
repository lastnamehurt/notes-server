import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { applySettings, deployConfigured, notesConfigured } from "../src/settings.ts";
import { listRepos, prepareRepo } from "../src/setup.ts";
import { GithubNotes, type Env } from "../src/github.ts";

const API = "https://fake-github.test";
const KEY = "github_pat_" + "a".repeat(40);
type Repo = { private: boolean; files: Map<string, string>; canWrite: boolean };
let repos: Record<string, Repo>;

beforeEach(() => {
  repos = {
    "jane/notes": { private: true, files: new Map(), canWrite: true },
    "jane/site": { private: false, files: new Map([["index.md", "x"]]), canWrite: true },
    "jane/readonly": { private: true, files: new Map(), canWrite: false }
  };
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const auth = String((init.headers as Record<string, string>)?.Authorization ?? "");
    if (auth !== "Bearer " + KEY) return new Response("{}", { status: 401 });
    const p = url.pathname, method = init.method ?? "GET";
    if (p === "/user") return Response.json({ login: "jane" });
    if (p === "/user/repos") return Response.json(Object.entries(repos).map(([full_name, r]) => ({ full_name, private: r.private })));
    const m = /^\/repos\/(\w+\/[\w.-]+)(?:\/(git\/trees|contents)\/(.+))?$/.exec(p);
    const repo = m && repos[m[1]];
    if (!repo) return new Response("{}", { status: 404 });
    if (!m![2]) return Response.json({ private: repo.private, default_branch: repo.files.size ? "main" : "main" });
    if (m![2] === "git/trees") return repo.files.size
      ? Response.json({ truncated: false, tree: [...repo.files.keys()].map(path => ({ path, type: "blob" })) })
      : new Response(JSON.stringify({ message: "Git Repository is empty." }), { status: 409 });
    if (method === "PUT") {
      if (!repo.canWrite) return new Response("{}", { status: 403 });
      repo.files.set(decodeURIComponent(m![3]), atob(JSON.parse(String(init.body)).content));
      return Response.json({});
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
});

const env = { GITHUB_API_URL: API };

test("a valid key lists repositories; bad keys get plain-language errors", async () => {
  const { login, repos: list } = await listRepos(env, KEY);
  assert.equal(login, "jane");
  assert.deepEqual(list.map(r => r.fullName), ["jane/notes", "jane/site", "jane/readonly"]);
  await assert.rejects(listRepos(env, "not a key"), /starts with github_pat_/);
  await assert.rejects(listRepos(env, "github_pat_" + "b".repeat(40)), /didn't accept that key/);
});

test("an empty repository is initialised so notes can be saved", async () => {
  const r = await prepareRepo(env, KEY, "jane/notes");
  assert.deepEqual(r, { branch: "main", initialized: true });
  assert.match(repos["jane/notes"].files.get("README.md")!, /^# Notes/);
  assert.deepEqual(await prepareRepo(env, KEY, "jane/notes"), { branch: "main", initialized: false }, "second run leaves it alone");
});

test("public, unreachable and read-only repositories are refused", async () => {
  await assert.rejects(prepareRepo(env, KEY, "jane/site"), /is public/);
  await assert.rejects(prepareRepo(env, KEY, "jane/missing"), /can't see jane\/missing/);
  await assert.rejects(prepareRepo(env, KEY, "jane/readonly"), /not save to it/);
  await assert.rejects(prepareRepo(env, KEY, "not a repo"), /Pick a repository/);
});

test("listing an empty repository gives no notes instead of an error", async () => {
  const notes = new GithubNotes({ GITHUB_API_URL: API, GITHUB_TOKEN: KEY, NOTES_REPO: "jane/notes" } as Env);
  assert.deepEqual(await notes.list(), []);
});

test("deployment settings win over setup-page settings", () => {
  const chosen = { githubToken: "chosen-token", notesRepo: "jane/notes", timezone: "Europe/London", ntfyTopic: "topic-from-setup-0123456789" };
  const blank = applySettings({ MCP_BEARER_TOKEN: "pw" } as Env, chosen);
  assert.equal(blank.NOTES_REPO, "jane/notes");
  assert.equal(blank.GITHUB_TOKEN, "chosen-token");
  assert.equal(blank.NOTES_TIMEZONE, "Europe/London");
  assert.equal(blank.NTFY_TOPIC, "topic-from-setup-0123456789");
  assert.ok(notesConfigured(blank) && !deployConfigured({ MCP_BEARER_TOKEN: "pw" } as Env));

  const deployed = { GITHUB_TOKEN: "deploy-token", NOTES_REPO: "owner/notes-data", NOTES_TIMEZONE: "America/Los_Angeles",
    PUSHOVER_TOKEN: "app", PUSHOVER_USER: "me" } as Env;
  const merged = applySettings(deployed, chosen);
  assert.equal(merged.NOTES_REPO, "owner/notes-data");
  assert.equal(merged.GITHUB_TOKEN, "deploy-token");
  assert.equal(merged.NOTES_TIMEZONE, "America/Los_Angeles");
  assert.equal(merged.NTFY_TOPIC, undefined, "a deployed push provider isn't mixed with a chosen one");
  assert.ok(deployConfigured(deployed));
});
