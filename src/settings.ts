// Settings chosen in the app's setup page, stored in this server's own Durable Object (so they live only in
// the owner's Cloudflare account). Values set on the deployment itself (secrets or variables) always win,
// so a server configured the original way ignores these entirely.

import type { Env } from "./github";

export interface Settings {
  githubToken?: string;
  notesRepo?: string;
  notesBranch?: string;
  timezone?: string;
  ntfyTopic?: string;
  pushoverUser?: string;
  pushoverToken?: string;
}

const pick = (deployed: string | undefined, chosen: string | undefined) => (deployed?.trim() ? deployed : chosen || undefined);

/** Env with setup-page settings filling anything the deployment didn't set. */
export function applySettings<E extends Env>(env: E, s: Settings | undefined): E {
  if (!s) return env;
  const out: E = { ...env };
  out.GITHUB_TOKEN = pick(env.GITHUB_TOKEN, s.githubToken) as string;
  out.NOTES_REPO = pick(env.NOTES_REPO, s.notesRepo) as string;
  out.NOTES_BRANCH = pick(env.NOTES_BRANCH, s.notesBranch);
  out.NOTES_TIMEZONE = pick(env.NOTES_TIMEZONE, s.timezone);
  // Push providers are chosen as a set so a deployed ntfy topic and a chosen Pushover key don't mix.
  if (!env.NTFY_TOPIC && !(env.PUSHOVER_TOKEN && env.PUSHOVER_USER)) {
    out.NTFY_TOPIC = s.ntfyTopic || undefined;
    out.PUSHOVER_USER = s.pushoverUser || undefined;
    out.PUSHOVER_TOKEN = s.pushoverToken || undefined;
  }
  return out;
}

/** True when the deployment itself provides the notes repository, so the setup page has nothing to do. */
export const deployConfigured = (env: Env) => Boolean(env.GITHUB_TOKEN?.trim() && env.NOTES_REPO?.trim());

/** True once notes can be read and written. */
export const notesConfigured = (env: Env) => Boolean(env.GITHUB_TOKEN?.trim() && env.NOTES_REPO?.trim());
