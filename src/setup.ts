// GitHub checks behind the app's setup page: is the access key valid, which repositories can it see,
// and is the chosen one private and writable. Errors are written for someone who isn't technical.

export interface RepoChoice { fullName: string; private: boolean; }

type GhEnv = { GITHUB_API_URL?: string };

async function gh(env: GhEnv, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch((env.GITHUB_API_URL || "https://api.github.com") + path, {
    ...init,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": "Bearer " + token.trim(),
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "personal-notes-mcp",
      ...init.headers
    }
  });
}

// Fine-grained and classic personal access tokens, and OAuth tokens from "Connect GitHub".
const KEY_FORMAT = /^(github_pat_|ghp_|gho_)[A-Za-z0-9_]{20,}$/;

/** Repositories the access key can see, newest first. */
export async function listRepos(env: GhEnv, token: string): Promise<{ login: string; repos: RepoChoice[] }> {
  if (!KEY_FORMAT.test(token.trim())) throw new Error("That doesn't look like a GitHub access key. It starts with github_pat_. Copy it again from GitHub.");
  const user = await gh(env, token, "/user");
  if (user.status === 401) throw new Error("GitHub didn't accept that key. It may have been copied only partly; copy it again.");
  if (!user.ok) throw new Error(`GitHub isn't answering right now (${user.status}). Try again in a minute.`);
  const { login } = await user.json<{ login: string }>();
  const res = await gh(env, token, "/user/repos?per_page=100&sort=created&direction=desc");
  if (!res.ok) throw new Error(`Couldn't list your repositories (${res.status}). Try again in a minute.`);
  const repos = (await res.json<{ full_name: string; private: boolean }[]>()).map(r => ({ fullName: r.full_name, private: r.private }));
  return { login, repos };
}

/**
 * Check the repository is private and the key can write to it. An empty repository (created without a README)
 * gets a README, which creates its first branch and proves the key can write.
 */
export async function prepareRepo(env: GhEnv, token: string, repo: string): Promise<{ branch: string; initialized: boolean }> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Pick a repository from the list.");
  const meta = await gh(env, token, "/repos/" + repo);
  if (meta.status === 404) throw new Error(`Your access key can't see ${repo}. On GitHub, edit the key and add this repository under "Repository access".`);
  if (!meta.ok) throw new Error(`GitHub isn't answering right now (${meta.status}). Try again in a minute.`);
  const info = await meta.json<{ private: boolean; default_branch?: string; permissions?: { push?: boolean } }>();
  if (!info.private) throw new Error(`${repo} is public, so anyone could read your notes. On GitHub, open the repository's Settings and make it private, or pick another.`);
  if (info.permissions && info.permissions.push === false) throw new Error(`Your access key can read ${repo} but not save to it. Edit the key on GitHub and set Contents to "Read and write".`);
  const branch = info.default_branch || "main";

  const tree = await gh(env, token, `/repos/${repo}/git/trees/${encodeURIComponent(branch)}`);
  if (tree.ok) return { branch, initialized: false };
  if (tree.status !== 409 && tree.status !== 404) throw new Error(`GitHub isn't answering right now (${tree.status}). Try again in a minute.`);

  // Empty repository: the first file creates the default branch.
  const readme = "# Notes\n\nPrivate notes kept by my notes server. Each folder is a kind of note; daily logs are in journal/log.\n";
  const put = await gh(env, token, `/repos/${repo}/contents/README.md`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Set up notes", content: btoa(readme) })
  });
  if (put.status === 403 || put.status === 404)
    throw new Error(`Your access key can read ${repo} but not save to it. Edit the key on GitHub and set Contents to "Read and write".`);
  if (!put.ok) throw new Error(`Couldn't set up ${repo} (${put.status}). Try again in a minute.`);
  const created = await gh(env, token, "/repos/" + repo);
  const after = created.ok ? (await created.json<{ default_branch?: string }>()).default_branch : undefined;
  return { branch: after || branch, initialized: true };
}

/* ---------- Connect GitHub: OAuth device flow ----------
 * The person taps Connect, enters a short code at github.com/login/device and approves. GitHub then gives
 * the token to this server only (the OAuth app's owner never sees it). Device flow needs only the app's
 * public client ID, no client secret, so each copy of this server can share one registered app.
 */

/** Public client ID of the "Notes server" OAuth app (device flow enabled). Override with GITHUB_CLIENT_ID. */
export const DEFAULT_GITHUB_CLIENT_ID = "Ov23li3YrfKrPKDz7Bwq";
export const githubClientId = (env: { GITHUB_CLIENT_ID?: string }) => env.GITHUB_CLIENT_ID?.trim() || DEFAULT_GITHUB_CLIENT_ID;

type LoginEnv = GhEnv & { GITHUB_CLIENT_ID?: string; GITHUB_LOGIN_URL?: string };
const loginUrl = (env: LoginEnv) => (env.GITHUB_LOGIN_URL || "https://github.com").replace(/\/+$/, "");

async function login(env: LoginEnv, path: string, params: Record<string, string>): Promise<Record<string, any>> {
  const res = await fetch(loginUrl(env) + path, {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "personal-notes-mcp" },
    body: new URLSearchParams(params)
  });
  if (!res.ok) throw new Error(`GitHub isn't answering right now (${res.status}). Try again in a minute.`);
  return res.json();
}

export interface DeviceStart { deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresAt: number; }

/** `scope` defaults to "repo" for connecting notes; pass "" to sign in with an identity-only token. */
export async function startDeviceFlow(env: LoginEnv, scope = "repo"): Promise<DeviceStart> {
  const clientId = githubClientId(env);
  if (!clientId) throw new Error("Connect GitHub isn't available on this server. Use an access key instead.");
  const r = await login(env, "/login/device/code", { client_id: clientId, scope });
  if (r.error) throw new Error(r.error === "device_flow_disabled"
    ? "Connect GitHub isn't switched on for this server. Use an access key instead."
    : "GitHub couldn't start connecting (" + r.error + "). Try again, or use an access key instead.");
  return { deviceCode: r.device_code, userCode: r.user_code, verificationUri: r.verification_uri || "https://github.com/login/device",
    interval: Math.max(5, Number(r.interval) || 5), expiresAt: Date.now() + (Number(r.expires_in) || 900) * 1000 };
}

export type DevicePoll = { state: "pending"; interval?: number } | { state: "done"; token: string } | { state: "failed"; message: string };

export async function pollDeviceFlow(env: LoginEnv, deviceCode: string): Promise<DevicePoll> {
  const r = await login(env, "/login/oauth/access_token", {
    client_id: githubClientId(env), device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code"
  });
  if (r.access_token) return { state: "done", token: r.access_token };
  switch (r.error) {
    case "authorization_pending": return { state: "pending" };
    case "slow_down": return { state: "pending", interval: Number(r.interval) || 10 };
    case "expired_token": return { state: "failed", message: "The code expired. Tap Connect GitHub to get a new one." };
    case "access_denied": return { state: "failed", message: "GitHub says you chose Cancel. Tap Connect GitHub to try again." };
    default: return { state: "failed", message: "Couldn't connect (" + (r.error || "unknown") + "). Tap Connect GitHub to try again." };
  }
}

/** The GitHub login behind a token. Used to check who signed in; the token is not kept. */
export async function githubLogin(env: GhEnv, token: string): Promise<string> {
  const user = await gh(env, token, "/user");
  if (!user.ok) throw new Error(`GitHub isn't answering right now (${user.status}). Try again in a minute.`);
  return (await user.json<{ login: string }>()).login;
}

/** Whether a GitHub login owns the notes repository ("owner/name"). Case-insensitive, as GitHub logins are. */
export function ownsNotesRepo(login: string, notesRepo: string | undefined): boolean {
  const owner = notesRepo?.split("/")[0];
  return Boolean(owner) && login.trim().toLowerCase() === owner!.toLowerCase();
}

/** Find or create a private repository for notes: "notes", or the next free name if "notes" is taken by a public one. */
export async function ensureNotesRepo(env: GhEnv, token: string): Promise<{ repo: string; created: boolean }> {
  const user = await gh(env, token, "/user");
  if (!user.ok) throw new Error(`GitHub isn't answering right now (${user.status}). Try again in a minute.`);
  const { login: owner } = await user.json<{ login: string }>();
  for (const name of ["notes", "my-notes", "private-notes"]) {
    const existing = await gh(env, token, `/repos/${owner}/${name}`);
    if (existing.ok) {
      if ((await existing.json<{ private: boolean }>()).private) return { repo: `${owner}/${name}`, created: false };
      continue;
    }
    if (existing.status !== 404) throw new Error(`GitHub isn't answering right now (${existing.status}). Try again in a minute.`);
    const made = await gh(env, token, "/user/repos", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, private: true, auto_init: true, description: "My private notes" })
    });
    if (made.ok) return { repo: `${owner}/${name}`, created: true };
    if (made.status !== 422) throw new Error(`Couldn't create your notes repository (${made.status}). Try again in a minute.`);
  }
  throw new Error("Couldn't find a free name for your notes repository. Use an access key instead.");
}
