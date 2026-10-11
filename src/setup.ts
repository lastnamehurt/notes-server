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

const KEY_FORMAT = /^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/;

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
