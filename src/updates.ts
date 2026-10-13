// "Is there a newer Daybook?" Each copy of the app compares its own VERSION with the one published in the
// original repository. Notify only: nothing is installed automatically, because code from elsewhere running
// unreviewed on someone's own server would undercut "only you can see your notes".
import { VERSION, VERSION_NOTE } from "./version";

export const DEFAULT_UPSTREAM = "lastnamehurt/notes-server";

export interface UpdateStatus {
  current: string;
  latest?: string;
  note?: string;
  available: boolean;
  /** GitHub page for this copy's "Update Daybook" button, when known. */
  updateUrl?: string;
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

type UpdateEnv = { DAYBOOK_UPSTREAM?: string; DAYBOOK_REPO?: string; GITHUB_TOKEN?: string; GITHUB_API_URL?: string; DAYBOOK_VERSION_URL?: string };

let ownRepo: { at: number; repo?: string } | undefined;
/**
 * This copy's own code repository, for a direct link to its "Update Daybook" button. Set DAYBOOK_REPO, or it's
 * found with the GitHub connection: Deploy to Cloudflare names the copy after the original ("notes-server") by default.
 */
async function findOwnRepo(env: UpdateEnv, upstream: string): Promise<string | undefined> {
  if (env.DAYBOOK_REPO?.trim()) return env.DAYBOOK_REPO.trim();
  if (!env.GITHUB_TOKEN) return undefined;
  if (ownRepo && Date.now() - ownRepo.at < 24 * 3600 * 1000) return ownRepo.repo;
  const api = env.GITHUB_API_URL || "https://api.github.com";
  const headers = { "Authorization": "Bearer " + env.GITHUB_TOKEN, "Accept": "application/vnd.github+json", "User-Agent": "daybook" };
  let repo: string | undefined;
  try {
    const user = await fetch(api + "/user", { headers });
    if (user.ok) {
      const { login } = await user.json<{ login: string }>();
      const guess = `${login}/${upstream.split("/")[1]}`;
      if (guess.toLowerCase() !== upstream.toLowerCase() && (await fetch(`${api}/repos/${guess}/contents/src/version.ts`, { headers })).ok) repo = guess;
    }
  } catch { /* fall back to the guide's steps */ }
  ownRepo = { at: Date.now(), repo };
  return repo;
}

export async function checkForUpdate(env: UpdateEnv): Promise<UpdateStatus> {
  const upstream = env.DAYBOOK_UPSTREAM?.trim() || DEFAULT_UPSTREAM;
  if (!cache || Date.now() - cache.at > TTL_MS) {
    try {
      const url = env.DAYBOOK_VERSION_URL?.trim() || `https://raw.githubusercontent.com/${upstream}/main/src/version.ts`;
      const res = await fetch(url, { headers: { "User-Agent": "daybook" } });
      const parsed = res.ok ? parseVersionFile(await res.text()) : {};
      cache = { at: Date.now(), latest: parsed.version, note: parsed.note };
    } catch {
      cache = { at: Date.now() - TTL_MS + 600_000 }; // try again in 10 minutes
    }
  }
  const available = Boolean(cache.latest && newer(cache.latest, VERSION));
  const repo = available ? await findOwnRepo(env, upstream) : undefined;
  return {
    current: VERSION, latest: cache.latest, note: available ? cache.note : VERSION_NOTE, available,
    ...(repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? { updateUrl: `https://github.com/${repo}/actions/workflows/update-daybook.yml` } : {})
  };
}
