// Notes kept in the owner's own Cloudflare storage (a SQLite-backed Durable Object), for people who don't
// want a GitHub account. Same interface and error messages as GithubNotes, so the rest of the app doesn't
// care which one it's talking to. Every change bumps a version number, which stands in for a commit:
// headSha/snapshotAt/commitFiles give Apple Reminders sync the same consistent read-then-write it gets on GitHub.

import { DurableObject } from "cloudflare:workers";
import { CATEGORIES, localDate, slugify, validPath, validateContent, type Category, type Env } from "./github";

export const NOT_FOUND = "Note or notes repository not found";
export const CONFLICT = "GitHub conflict; refresh and retry";

/** Version numbers shaped like commit ids (40 hex characters), since sync code checks that shape. */
const versionId = (n: number) => n.toString(16).padStart(40, "0");

async function sha(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const normalize = (content: string) => content.trimEnd() + "\n";

type Row = { path: string; content: string; sha: string };
export type PutResult = { ok: true } | { ok: false; error: "conflict" | "missing" };

/** One instance ("notes") per app. Methods are called over Durable Object RPC. */
export class NotesStore extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS notes (path TEXT PRIMARY KEY, content TEXT NOT NULL, sha TEXT NOT NULL, updated INTEGER NOT NULL)");
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    });
  }
  private version(): number {
    const row = this.ctx.storage.sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'version'").toArray()[0];
    return row ? Number(row.value) : 0;
  }
  private bump(): number {
    const next = this.version() + 1;
    this.ctx.storage.sql.exec("INSERT INTO meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", next);
    return next;
  }
  async read(path: string): Promise<{ content: string; sha: string } | null> {
    const row = this.ctx.storage.sql.exec<Row>("SELECT content, sha FROM notes WHERE path = ?", path).toArray()[0];
    return row ? { content: row.content, sha: row.sha } : null;
  }
  /** Write one note. `expectedSha`: undefined = create only, string = must match the current version. */
  async write(path: string, content: string, newSha: string, expectedSha?: string): Promise<PutResult> {
    const current = await this.read(path);
    if (expectedSha === undefined && current) return { ok: false, error: "conflict" };
    if (expectedSha !== undefined && !current) return { ok: false, error: "missing" };
    if (expectedSha !== undefined && current && current.sha !== expectedSha) return { ok: false, error: "conflict" };
    this.ctx.storage.sql.exec("INSERT INTO notes (path, content, sha, updated) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET content = excluded.content, sha = excluded.sha, updated = excluded.updated",
      path, content, newSha, Date.now());
    this.bump();
    return { ok: true };
  }
  async remove(path: string, expectedSha: string): Promise<PutResult> {
    const current = await this.read(path);
    if (!current) return { ok: false, error: "missing" };
    if (current.sha !== expectedSha) return { ok: false, error: "conflict" };
    this.ctx.storage.sql.exec("DELETE FROM notes WHERE path = ?", path);
    this.bump();
    return { ok: true };
  }
  async paths(): Promise<string[]> {
    return this.ctx.storage.sql.exec<{ path: string }>("SELECT path FROM notes").toArray().map(r => r.path);
  }
  /** Every note plus the version it was read at. */
  async everything(): Promise<{ version: number; notes: [string, string][] }> {
    const notes = this.ctx.storage.sql.exec<Row>("SELECT path, content FROM notes").toArray().map(r => [r.path, r.content] as [string, string]);
    return { version: this.version(), notes };
  }
  async currentVersion(): Promise<number> { return this.version(); }
  /** Write several notes at once, only if nothing changed since `parent`. Returns the new version, or null on conflict. */
  async commit(parent: number, files: [string, string, string][]): Promise<number | null> {
    if (this.version() !== parent) return null;
    const now = Date.now();
    for (const [path, content, newSha] of files)
      this.ctx.storage.sql.exec("INSERT INTO notes (path, content, sha, updated) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET content = excluded.content, sha = excluded.sha, updated = excluded.updated",
        path, content, newSha, now);
    return this.bump();
  }
  async count(): Promise<number> {
    return Number(this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM notes").toArray()[0]?.n ?? 0);
  }
}

/** The same interface as GithubNotes, backed by NotesStore. */
export class AppNotes {
  private snap?: Promise<Map<string, string>>;
  constructor(private env: Env) {
    if (!env.NOTES) throw new Error("This app's storage isn't set up. Update the app, or connect GitHub in Settings.");
  }
  private get store() { return this.env.NOTES!.get(this.env.NOTES!.idFromName("notes")); }
  private checkPath(name: string) { if (!validPath(name)) throw new Error("Invalid note path"); }

  async get(name: string): Promise<{ content: string; sha: string }> {
    this.checkPath(name);
    const row = await this.store.read(name);
    if (!row) throw new Error(NOT_FOUND);
    return row;
  }
  async put(name: string, content: string, expected?: string): Promise<string> {
    this.checkPath(name);
    validateContent(content);
    const text = normalize(content);
    this.snap = undefined;
    const r = await this.store.write(name, text, await sha(text), expected);
    if (!r.ok) throw new Error(r.error === "missing" ? NOT_FOUND : CONFLICT);
    return name;
  }
  async save(content: string, category: Category): Promise<string> {
    if (!CATEGORIES.includes(category)) throw new Error("Unknown category");
    validateContent(content);
    const base = category + "/" + localDate(this.env.NOTES_TIMEZONE) + "-" + slugify(content);
    for (let n = 1; n <= 50; n++) {
      const name = base + (n === 1 ? "" : "-" + n) + ".md";
      if (await this.store.read(name)) continue;
      return this.put(name, content);
    }
    throw new Error("Too many notes with the same name today");
  }
  async update(name: string, content: string, expectedSha?: string): Promise<string> {
    const { sha: current } = await this.get(name);
    if (expectedSha !== undefined && current !== expectedSha) throw new Error("Note changed since it was opened; reload before saving");
    return this.put(name, content, current);
  }
  async delete(name: string): Promise<string> {
    const { sha: current } = await this.get(name);
    this.snap = undefined;
    const r = await this.store.remove(name, current);
    if (!r.ok) throw new Error(r.error === "missing" ? NOT_FOUND : CONFLICT);
    return name;
  }
  async list(): Promise<string[]> {
    return (await this.store.paths()).filter(validPath).sort().reverse();
  }
  async snapshot(): Promise<Map<string, string>> {
    this.snap ??= this.store.everything().then(e => new Map((e.notes as [string, string][]).filter(([p]) => validPath(p))));
    try { return await this.snap; } catch (e) { this.snap = undefined; throw e; }
  }
  async all(skipPrefix?: string, prefix?: string): Promise<{ name: string; content: string }[]> {
    const snap = await this.snapshot();
    return [...snap.keys()].filter(n => (!skipPrefix || !n.startsWith(skipPrefix)) && (!prefix || n.startsWith(prefix)))
      .sort().reverse().map(name => ({ name, content: snap.get(name)! }));
  }
  async search(query: string): Promise<string[]> {
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    return (await this.all()).filter(({ name, content }) => {
      const hay = (name + " " + content).toLocaleLowerCase();
      return terms.every(t => hay.includes(t));
    }).map(n => n.name);
  }
  // Apple Reminders sync: a version number stands in for a commit.
  async headSha(): Promise<string | null> { return versionId(await this.store.currentVersion()); }
  async snapshotAt(commitSha: string): Promise<Map<string, string>> {
    const e = await this.store.everything();
    if (versionId(e.version) !== commitSha) throw new Error(CONFLICT);
    return new Map((e.notes as [string, string][]).filter(([p]) => validPath(p)));
  }
  async commitFiles(parent: string, files: Map<string, string>, _message: string): Promise<string> {
    const rows: [string, string, string][] = [];
    for (const [name, content] of files) {
      this.checkPath(name); validateContent(content);
      const text = normalize(content);
      rows.push([name, text, await sha(text)]);
    }
    const next = await this.store.commit(parseInt(parent, 16), rows);
    if (next === null) throw new Error(CONFLICT);
    this.snap = undefined;
    return versionId(next);
  }
}
