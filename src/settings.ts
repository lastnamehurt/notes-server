// Settings chosen in the app's setup page, stored in this server's own Durable Object (so they live only in
// the owner's Cloudflare account). Values set on the deployment itself (secrets or variables) always win,
// so a server configured the original way ignores these entirely.

import type { Env } from "./github";
import type { WebPushState } from "./web-push";

export interface Settings {
  /** Where notes live: "app" (this app's own storage) or "github" (githubToken + notesRepo). */
  storage?: "app" | "github";
  githubToken?: string;
  notesRepo?: string;
  notesBranch?: string;
  timezone?: string;
  ntfyTopic?: string;
  pushoverUser?: string;
  pushoverToken?: string;
  /** What the owner likes to be called, for greetings (Today, briefings, Claude). */
  name?: string;
  /** This copy's code repository ("owner/name"), for Settings → Updates. */
  codeRepo?: string;
  /** Secret address for Daybook's tasks as a calendar feed (regenerate to revoke). */
  calendarToken?: string;
  /** Address of a calendar the owner subscribed to (read, not changed). */
  calendarFeed?: string;
  /** Devices with notifications on. Kept separately in the scheduler and only attached when settings are read. */
  webPush?: WebPushState;
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
  out.DAYBOOK_REPO = pick(env.DAYBOOK_REPO, s.codeRepo);
  out.OWNER_NAME = pick(env.OWNER_NAME, s.name);
  if (s.webPush) out.WEB_PUSH = s.webPush;
  // A deployment that names its repository always uses GitHub; otherwise the setup page's choice decides.
  if (!deployConfigured(env)) out.NOTES_STORAGE = s.storage === "app" ? "app" : s.notesRepo ? "github" : undefined;
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
export const notesConfigured = (env: Env) =>
  env.NOTES_STORAGE === "app" ? Boolean(env.NOTES) : Boolean(env.GITHUB_TOKEN?.trim() && env.NOTES_REPO?.trim());

/** A name as typed: trimmed, one line, at most 40 characters. Empty means "no name". */
export function cleanName(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) : "";
}
