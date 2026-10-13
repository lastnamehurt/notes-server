import type { ReminderEnv, ReminderScheduler } from "./reminders";
import type { NotesStore } from "./app-notes";

export interface Env extends ReminderEnv {
  REMINDERS: DurableObjectNamespace<ReminderScheduler>;
  /** App storage for notes (see app-notes.ts); used when NOTES_STORAGE is "app". */
  NOTES?: DurableObjectNamespace<NotesStore>;
  /** "app" = notes in this app's own Cloudflare storage; otherwise GitHub (NOTES_REPO). Set from setup, per request. */
  NOTES_STORAGE?: "app" | "github";
  GITHUB_TOKEN: string;
  /** Override for tests only; defaults to https://api.github.com. */
  GITHUB_API_URL?: string;
  /** Overrides for tests, and for using a different "Connect GitHub" OAuth app. */
  GITHUB_LOGIN_URL?: string;
  GITHUB_CLIENT_ID?: string;
  /** Where to look for newer versions of this app (default lastnamehurt/notes-server), and this copy's own repository. */
  DAYBOOK_UPSTREAM?: string;
  DAYBOOK_REPO?: string;
  /** Tests only: where to read the newest published version file. */
  DAYBOOK_VERSION_URL?: string;
  /** Set by the installer: the app's own Cloudflare key, account, Worker name and where new versions come from. */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_API_URL?: string;
  DAYBOOK_SCRIPT?: string;
  DAYBOOK_INSTALLER?: string;
  /** What the owner likes to be called (Settings → Your name), for greetings. */
  OWNER_NAME?: string;
  /** "true" enables OAuth dynamic client registration (local MCP acceptance test only). */
  ALLOW_CLIENT_REGISTRATION?: string;
  MCP_BEARER_TOKEN: string;
  /** Separate secret for the Apple Reminders Shortcut: the task feed and two-way sync (Daybook tasks only). */
  SHORTCUTS_TOKEN?: string;
  /** Friendlier name for MCP_BEARER_TOKEN, used by the Deploy to Cloudflare form. */
  PASSWORD?: string;
  NOTES_REPO: string;
  /** Set per request: true when the deployment itself names the notes repository (the setup page then stays out of the way). */
  DEPLOY_CONFIGURED?: boolean;
  /** Defaults to "main". */
  NOTES_BRANCH?: string;
}
export const CATEGORIES = ["inbox","goals","projects","decisions","runbooks","reference","journal"] as const;
export type Category = typeof CATEGORIES[number];

export function validPath(path: string): boolean {
  return /^[a-z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)*\.md$/.test(path) &&
    CATEGORIES.some(c => path.startsWith(c + "/")) &&
    !path.split("/").some(s => s === "." || s === "..");
}
export function validateContent(content: string): void {
  if (!content.trim()) throw new Error("Note cannot be empty");
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|\b\d{3}-\d{2}-\d{4}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bAKIA[0-9A-Z]{16}\b/i.test(content))
    throw new Error("Potential secret or SSN detected");
}
/** Lowercase hyphenated slug from the note's first heading or first non-empty line. */
export function slugify(content: string): string {
  const first = content.split("\n").map(l => l.trim()).find(l => l.length > 0) ?? "";
  const slug = first.replace(/^#+\s*/, "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 60).replace(/-+$/, "");
  return slug || "note";
}
/** YYYY-MM-DD in the given IANA time zone. */
export function localDate(timeZone = "America/Los_Angeles", now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {timeZone, year:"numeric", month:"2-digit", day:"2-digit"}).format(now);
}
function encodePath(path: string): string { return path.split("/").map(encodeURIComponent).join("/"); }
function base64Encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function base64Decode(s: string): string {
  const binary = atob(s.replace(/\s/g,""));
  return new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
}
import { readTarGz } from "./snapshot";

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

export class GithubNotes {
  /** Whole-repository read, shared by everything in one request (see snapshot()). */
  private snap?: Promise<Map<string, string>>;

  constructor(private env: Env) {
    if (!env.NOTES_REPO || !env.GITHUB_TOKEN) throw new Error("Notes aren't set up yet. Open this server's /app page in a browser and finish setup.");
    if (!/^[\w.-]+\/[\w.-]+$/.test(env.NOTES_REPO.trim())) throw new Error("Invalid NOTES_REPO: use owner/repo");
  }
  private get branch(): string { return this.env.NOTES_BRANCH?.trim() || "main"; }
  private async api(path: string, init: RequestInit = {}): Promise<any> {
    const response = await fetch((this.env.GITHUB_API_URL || "https://api.github.com") + "/repos/" + this.env.NOTES_REPO.trim() + path, {
      ...init,
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + this.env.GITHUB_TOKEN,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "personal-notes-mcp",
        ...init.headers
      }
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error("GitHub no longer accepts the connection to your notes. Open the app's Setup and reconnect GitHub, or if your GitHub token is set in Cloudflare, replace it there.");
      if (response.status === 403) throw new Error("GitHub refused access to your notes repository. Check that it is still private and that your GitHub connection can read and write it, then reconnect GitHub in Setup (or update the token in Cloudflare).");
      if (response.status === 404) throw new Error("Note or notes repository not found");
      if (response.status === 409 || response.status === 422) throw new Error("GitHub conflict; refresh and retry");
      throw new Error("GitHub request failed (" + response.status + ")");
    }
    return response.json();
  }
  private path(name: string): string {
    if (!validPath(name)) throw new Error("Invalid note path");
    return "/contents/" + encodePath(name);
  }
  async get(name: string): Promise<{content:string;sha:string}> {
    const obj = await this.api(this.path(name) + "?ref=" + encodeURIComponent(this.branch));
    if (obj.type !== "file" || obj.encoding !== "base64") throw new Error("Not a Markdown file");
    return {content:base64Decode(obj.content),sha:obj.sha};
  }
  async put(name: string, content: string, sha?: string): Promise<string> {
    validateContent(content);
    this.snap = undefined;
    await this.api(this.path(name), {
      method:"PUT",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({message:"notes: " + (sha ? "update " : "add ") + name,
        content:base64Encode(content.trimEnd()+"\n"),branch:this.branch,...(sha?{sha}:{})})
    });
    return name;
  }
  async save(content: string, category: Category): Promise<string> {
    if (!CATEGORIES.includes(category)) throw new Error("Unknown category");
    validateContent(content);
    const base = category + "/" + localDate(this.env.NOTES_TIMEZONE) + "-" + slugify(content);
    for (let n = 1; n <= 50; n++) {
      const name = base + (n === 1 ? "" : "-" + n) + ".md";
      if (await this.exists(name)) continue;
      return this.put(name,content);
    }
    throw new Error("Too many notes with the same name today");
  }
  private async exists(name: string): Promise<boolean> {
    try { await this.get(name); return true; }
    catch (e) { if (e instanceof Error && e.message.startsWith("Note or notes repository not found")) return false; throw e; }
  }
  async update(name:string, content:string, expectedSha?:string):Promise<string> {
    const {sha} = await this.get(name);
    if (expectedSha !== undefined && sha !== expectedSha) throw new Error("Note changed since it was opened; reload before saving");
    return this.put(name,content,sha);
  }
  async delete(name:string):Promise<string> {
    const {sha} = await this.get(name);
    this.snap = undefined;
    await this.api(this.path(name), {method:"DELETE",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({message:"notes: delete " + name,sha,branch:this.branch})});
    return name;
  }
  async list():Promise<string[]> {
    let tree;
    try { tree = await this.api("/git/trees/" + encodeURIComponent(this.branch) + "?recursive=1"); }
    // An empty repository (no commits yet) answers 409: there are simply no notes.
    catch (e) { if (e instanceof Error && e.message.startsWith("GitHub conflict")) return []; throw e; }
    if (tree.truncated) throw new Error("Repository tree truncated; refusing incomplete results");
    return (tree.tree as {path:string;type:string}[])
      .filter(e=>e.type==="blob" && validPath(e.path)).map(e=>e.path).sort().reverse();
  }
  /**
   * Every note's content, read in one go as a gzipped archive (one API call and one redirect), so
   * search, scans and log views cost the same few outside calls whether there are 10 notes or 10,000.
   */
  async snapshot():Promise<Map<string,string>> {
    this.snap ??= this.archive(this.branch);
    try { return await this.snap; } catch (e) { this.snap = undefined; throw e; }
  }
  /** Every note exactly as of one commit (no caching lag, unlike the branch archive). */
  snapshotAt(commitSha:string):Promise<Map<string,string>> {
    if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error("Invalid commit");
    return this.archive(commitSha);
  }
  private archive(ref:string):Promise<Map<string,string>> {
    return (async () => {
      const response = await fetch((this.env.GITHUB_API_URL || "https://api.github.com") + "/repos/" + this.env.NOTES_REPO.trim() + "/tarball/" + encodeURIComponent(ref), {
        headers: { "Authorization": "Bearer " + this.env.GITHUB_TOKEN, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "personal-notes-mcp" }
      });
      // GitHub can return 404 for inaccessible private repositories or missing branches.
      // Never silently present an access failure as an empty collection of notes.
      if (response.status === 404) throw new Error("Notes archive unavailable; verify private repository access and configured branch");
      if (response.status === 409) return new Map();
      if (!response.ok || !response.body) throw new Error("GitHub request failed (" + response.status + ")");
      if (Number(response.headers.get("Content-Length") || 0) > MAX_ARCHIVE_BYTES) throw new Error("Notes repository is too large to read at once");
      const files = await readTarGz(response.body);
      const notes = new Map<string,string>();
      for (const [path, content] of files) if (validPath(path)) notes.set(path, content);
      return notes;
    })();
  }
  /** The branch's latest commit, or null for an empty repository. */
  async headSha():Promise<string|null> {
    try { return (await this.api("/git/ref/heads/" + encodeURIComponent(this.branch))).object.sha; }
    catch (e) { if (e instanceof Error && /^(GitHub conflict|Note or notes repository not found)/.test(e.message)) return null; throw e; }
  }
  /**
   * Write several notes as one commit on top of `parent`. The branch only moves if it still points at
   * `parent`; otherwise GitHub refuses and this throws "GitHub conflict", so the caller can re-read and retry.
   */
  async commitFiles(parent:string, files:Map<string,string>, message:string):Promise<string> {
    for (const [name, content] of files) { if (!validPath(name)) throw new Error("Invalid note path"); validateContent(content); }
    const json = (body:unknown):RequestInit => ({method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const { tree } = await this.api("/git/commits/" + parent);
    const next = await this.api("/git/trees", json({ base_tree: tree.sha,
      tree: [...files].map(([path, content]) => ({ path, mode: "100644", type: "blob", content: content.trimEnd() + "\n" })) }));
    const commit = await this.api("/git/commits", json({ message, tree: next.sha, parents: [parent] }));
    await this.api("/git/refs/heads/" + encodeURIComponent(this.branch), { ...json({ sha: commit.sha, force: false }), method: "PATCH" });
    this.snap = undefined;
    return commit.sha;
  }
  /** Notes with their content, newest name first; optionally only under `prefix`, or skipping `skipPrefix`. */
  async all(skipPrefix?:string, prefix?:string):Promise<{name:string;content:string}[]> {
    const snap = await this.snapshot();
    return [...snap.keys()].filter(n=>(!skipPrefix||!n.startsWith(skipPrefix)) && (!prefix||n.startsWith(prefix)))
      .sort().reverse().map(name=>({name,content:snap.get(name)!}));
  }
  async search(query:string):Promise<string[]> {
    const terms=query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    return (await this.all()).filter(({name,content})=>{
      const hay=(name+" "+content).toLocaleLowerCase();
      return terms.every(t=>hay.includes(t));
    }).map(n=>n.name);
  }
}
