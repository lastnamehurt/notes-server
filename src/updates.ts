// "Is there a newer Daybook?" Each copy of the app compares its own VERSION with the one published in the
// original repository. Nothing is installed automatically, because code from elsewhere running unreviewed on
// someone's own server would undercut "only you can see your notes". The owner taps Update now, which starts
// the Update Daybook workflow in their own copy (or opens it, when the app has no GitHub connection).
import { VERSION, VERSION_NOTE } from "./version";
import { Cloudflare, CF_API, fetchBundle, friendly, update } from "./cloudflare-deploy";

export const DEFAULT_UPSTREAM = "lastnamehurt/notes-server";

export interface UpdateStatus {
  current: string;
  latest?: string;
  note?: string;
  available: boolean;
  /** GitHub page for this copy's "Update Daybook" button, when known. */
  updateUrl?: string;
  /** This copy's code repository ("owner/name"), when known. */
  repo?: string;
  /** True when the app can start the update itself (it knows the repo and has a GitHub connection). */
  canRun?: boolean;
}

/** "owner/name" from "owner/name", "github.com/owner/name" or a full GitHub address; undefined otherwise. */
export function parseRepo(input: string): string | undefined {
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/.exec(input.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** Compare "2026.10.12" / "2026.10.12.2" numerically. */
export function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export function parseVersionFile(text: string): { version?: string; note?: string } {
  const version = /export const VERSION = "([\d.]+)"/.exec(text)?.[1];
  const note = /export const VERSION_NOTE = "((?:[^"\\]|\\.)*)"/.exec(text)?.[1]?.replace(/\\"/g, '"');
  return { version, note };
}

let cache: { at: number; latest?: string; note?: string } | undefined;
const TTL_MS = 6 * 3600 * 1000;

type UpdateEnv = {
  DAYBOOK_UPSTREAM?: string; DAYBOOK_REPO?: string; GITHUB_TOKEN?: string; GITHUB_API_URL?: string; DAYBOOK_VERSION_URL?: string; NOTES_REPO?: string;
  CF_API_TOKEN?: string; CF_ACCOUNT_ID?: string; CF_API_URL?: string; DAYBOOK_SCRIPT?: string; DAYBOOK_INSTALLER?: string;
};
/** Apps made by the installer update themselves through Cloudflare; no GitHub involved. */
export const selfUpdating = (env: UpdateEnv) => Boolean(env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.DAYBOOK_INSTALLER);
const ghHeaders = (token: string) => ({ "Authorization": "Bearer " + token, "Accept": "application/vnd.github+json", "User-Agent": "daybook" });

/** Forget the found repository (after the owner names it in Settings). */
export function resetOwnRepo() { ownRepo = undefined; }

let ownRepo: { at: number; repo?: string } | undefined;
/**
 * This copy's own code repository, for a direct link to its "Update Daybook" button. Set DAYBOOK_REPO, or it's
 * found with the GitHub connection: Deploy to Cloudflare names the copy after the original ("notes-server") by default.
 */
async function findOwnRepo(env: UpdateEnv, upstream: string): Promise<string | undefined> {
  if (env.DAYBOOK_REPO?.trim()) return parseRepo(env.DAYBOOK_REPO);
  if (!env.GITHUB_TOKEN) return undefined;
  if (ownRepo && Date.now() - ownRepo.at < 24 * 3600 * 1000) return ownRepo.repo;
  const api = env.GITHUB_API_URL || "https://api.github.com";
  const headers = ghHeaders(env.GITHUB_TOKEN);
  const isCopy = async (repo: string) => (await fetch(`${api}/repos/${repo}/contents/.github/workflows/update-daybook.yml`, { headers })).ok;
  let repo: string | undefined;
  try {
    // Most copies keep the original's name; otherwise look through the account's repositories for one with
    // the Update Daybook workflow (a few likely names first, so this stays within a handful of requests).
    const user = await fetch(api + "/user", { headers });
    if (user.ok) {
      const { login } = await user.json<{ login: string }>();
      const guess = `${login}/${upstream.split("/")[1]}`;
      if (guess.toLowerCase() !== upstream.toLowerCase() && await isCopy(guess)) repo = guess;
    }
    if (!repo) {
      const list = await fetch(api + "/user/repos?per_page=100&sort=updated&affiliation=owner", { headers });
      if (list.ok) {
        const skip = new Set([upstream.toLowerCase(), (env.NOTES_REPO || "").toLowerCase()]);
        const names = (await list.json<{ full_name: string }[]>()).map(r => r.full_name).filter(n => !skip.has(n.toLowerCase()));
        const likely = names.filter(n => /daybook|notes-?server|notes-?mcp/i.test(n)).slice(0, 5);
        for (const n of likely) if (await isCopy(n)) { repo = n; break; }
      }
    }
  } catch { /* fall back to asking in Settings */ }
  ownRepo = { at: Date.now(), repo };
  return repo;
}

/** Start the Update Daybook workflow in this copy's repository. */
export async function runUpdate(env: UpdateEnv): Promise<{ runsUrl?: string; version?: string }> {
  if (selfUpdating(env)) {
    try {
      const bundle = await fetchBundle(env.DAYBOOK_INSTALLER!);
      return await update(new Cloudflare(env.CF_API_TOKEN!, env.CF_API_URL || CF_API), bundle, { accountId: env.CF_ACCOUNT_ID!, name: env.DAYBOOK_SCRIPT });
    } catch (e) {
      const message = friendly(e);
      throw new Error(/didn't accept that key|permissions/.test(message)
        ? `Your app's Cloudflare key no longer works, so it can't update itself. Open ${env.DAYBOOK_INSTALLER!.replace(/\/+$/, "")}, make a new key and tap Update it.`
        : message);
    }
  }
  const repo = await findOwnRepo(env, env.DAYBOOK_UPSTREAM?.trim() || DEFAULT_UPSTREAM);
  if (!repo) throw new Error("Tell the app which GitHub repository is your copy of Daybook first.");
  if (!env.GITHUB_TOKEN) throw new Error("This app isn't connected to GitHub, so it can't start the update. Use Open Update Daybook instead.");
  const api = env.GITHUB_API_URL || "https://api.github.com";
  const headers = ghHeaders(env.GITHUB_TOKEN);
  const runsUrl = `https://github.com/${repo}/actions/workflows/update-daybook.yml`;
  const info = await fetch(`${api}/repos/${repo}`, { headers });
  if (!info.ok) throw new Error(`Couldn't open ${repo} with your GitHub connection. Check the name in Settings → Updates.`);
  const { default_branch } = await info.json<{ default_branch: string }>();
  const res = await fetch(`${api}/repos/${repo}/actions/workflows/update-daybook.yml/dispatches`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ ref: default_branch || "main" })
  });
  if (res.status === 204 || res.ok) return { runsUrl };
  if (res.status === 404) throw new Error(`${repo} doesn't have the Update Daybook workflow yet. Follow How to update once to get it.`);
  if (res.status === 403 || res.status === 422)
    throw new Error("GitHub needs you to turn on workflows for your copy once. Tap Open Update Daybook, enable workflows, then try again.");
  throw new Error(`GitHub didn't start the update (${res.status}). Try again, or use Open Update Daybook.`);
}

export async function checkForUpdate(env: UpdateEnv): Promise<UpdateStatus> {
  const upstream = env.DAYBOOK_UPSTREAM?.trim() || DEFAULT_UPSTREAM;
  if (!cache || Date.now() - cache.at > TTL_MS) {
    try {
      // Installer-made apps update from the installer's bundle, so ask it which version it has.
      const fromInstaller = !env.DAYBOOK_VERSION_URL?.trim() && selfUpdating(env);
      const url = env.DAYBOOK_VERSION_URL?.trim()
        || (fromInstaller ? env.DAYBOOK_INSTALLER!.replace(/\/+$/, "") + "/bundle/manifest.json" : `https://raw.githubusercontent.com/${upstream}/main/src/version.ts`);
      const res = await fetch(url, { headers: { "User-Agent": "daybook" } });
      const text = res.ok ? await res.text() : "";
      const parsed = !res.ok ? {} : text.trimStart().startsWith("{")
        ? (({ version, note }) => ({ version, note }))(JSON.parse(text) as { version?: string; note?: string })
        : parseVersionFile(text);
      cache = { at: Date.now(), latest: parsed.version, note: parsed.note };
    } catch {
      cache = { at: Date.now() - TTL_MS + 600_000 }; // try again in 10 minutes
    }
  }
  const available = Boolean(cache.latest && newer(cache.latest, VERSION));
  if (selfUpdating(env)) return { current: VERSION, latest: cache.latest, note: available ? cache.note : VERSION_NOTE, available, canRun: true };
  const repo = available ? await findOwnRepo(env, upstream) : undefined;
  return {
    current: VERSION, latest: cache.latest, note: available ? cache.note : VERSION_NOTE, available,
    ...(repo && /^[\w.-]+\/[\w.-]+$/.test(repo)
      ? { repo, updateUrl: `https://github.com/${repo}/actions/workflows/update-daybook.yml`, canRun: Boolean(env.GITHUB_TOKEN) } : {})
  };
}
