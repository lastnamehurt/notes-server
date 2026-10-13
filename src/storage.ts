// Where an app's notes live: in its own Cloudflare storage ("app", the default for new installs) or as files in a
// GitHub repository ("github", for people who want plain files, history, the note CLI or Obsidian).
import { GithubNotes, type Env } from "./github";
import { AppNotes } from "./app-notes";

export type Notes = GithubNotes | AppNotes;

export const usesAppStorage = (env: Env) => env.NOTES_STORAGE === "app";

export function notesFor(env: Env): Notes {
  return usesAppStorage(env) ? new AppNotes(env) : new GithubNotes(env);
}
