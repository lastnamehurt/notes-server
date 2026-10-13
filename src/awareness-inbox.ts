/** Owner-local Awareness inbox. No Zod runtime import or push delivery. */
export interface InboxCandidate {
  id: string; ownerId: string; ruleId: string; dedupeKey: string;
  reason: string; createdAt: string; expiresAt: string;
  evidenceEventIds: string[]; subjectRefs: { kind: string; id: string }[];
  suggestedActions: string[]; urgency: string;
}
export type InboxState = "active" | "dismissed" | "snoozed" | "muted";
export interface InboxEntry {
  candidate: InboxCandidate;
  state: InboxState;
  updatedAt: string;
  snoozedUntil?: string;
}
export interface InboxStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}
const prefix = (owner: string) => "awareness:inbox:" + encodeURIComponent(owner) + ":";
const key = (owner: string, id: string) => prefix(owner) + encodeURIComponent(id);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/;
const assertId = (value: string) => { if (!idPattern.test(value)) throw new Error("Invalid inbox identifier"); };
const date = (value: string) => { const ms = Date.parse(value); if (!Number.isFinite(ms)) throw new Error("Invalid inbox date"); return ms; };

export class AwarenessInbox {
  constructor(private readonly store: InboxStorage) {}

  async add(owner: string, candidate: InboxCandidate): Promise<{ inserted: boolean; entry: InboxEntry }> {
    assertId(owner); assertId(candidate.id); assertId(candidate.dedupeKey);
    if (candidate.ownerId !== owner || !candidate.ruleId || !candidate.reason ||
        candidate.reason.length > 500 || candidate.evidenceEventIds.length < 1 ||
        candidate.evidenceEventIds.length > 20 || date(candidate.expiresAt) <= date(candidate.createdAt)) {
      throw new Error("Invalid awareness candidate");
    }
    const existing = await this.store.get<InboxEntry>(key(owner, candidate.id));
    if (existing) return { inserted: false, entry: existing };
    const all = await this.store.list<InboxEntry>({ prefix: prefix(owner) });
    const same = [...all.values()].find(entry => entry.candidate.dedupeKey === candidate.dedupeKey);
    if (same) return { inserted: false, entry: same };
    const entry: InboxEntry = { candidate, state: "active", updatedAt: candidate.createdAt };
    await this.store.put(key(owner, candidate.id), entry);
    return { inserted: true, entry };
  }

  async get(owner: string, id: string): Promise<InboxEntry | null> {
    assertId(owner); assertId(id);
    return await this.store.get<InboxEntry>(key(owner, id)) ?? null;
  }

  async list(owner: string, options: { limit?: number; cursor?: string; now?: string } = {}) {
    assertId(owner);
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid inbox limit");
    if (options.cursor) assertId(options.cursor);
    const now = date(options.now ?? new Date().toISOString());
    const entries = [...(await this.store.list<InboxEntry>({ prefix: prefix(owner) })).values()]
      .filter(e => date(e.candidate.expiresAt) > now && e.state !== "dismissed" && e.state !== "muted" &&
        (e.state !== "snoozed" || (e.snoozedUntil && date(e.snoozedUntil) <= now)))
      .sort((a,b) => b.candidate.createdAt.localeCompare(a.candidate.createdAt) || b.candidate.id.localeCompare(a.candidate.id));
    const offset = options.cursor ? entries.findIndex(e => e.candidate.id === options.cursor) + 1 : 0;
    if (options.cursor && offset === 0) throw new Error("Invalid inbox cursor");
    const page = entries.slice(offset, offset + limit);
    return { items: page, nextCursor: entries[offset + limit]?.candidate.id ?? null };
  }

  async action(owner: string, id: string, action: "dismiss" | "snooze" | "mute", until?: string, now = new Date().toISOString()) {
    const entry = await this.get(owner, id);
    if (!entry) return null;
    if (date(entry.candidate.expiresAt) <= date(now)) throw new Error("Awareness item expired");
    if (action === "snooze" && (!until || date(until) <= date(now) || date(until) > date(now) + 30 * 86_400_000))
      throw new Error("Choose a snooze time within 30 days");
    const next: InboxEntry = { ...entry, state: action === "dismiss" ? "dismissed" : action === "mute" ? "muted" : "snoozed",
      updatedAt: now, ...(action === "snooze" ? { snoozedUntil: until } : {}) };
    if (action !== "snooze") delete next.snoozedUntil;
    await this.store.put(key(owner, id), next);
    return next;
  }
}
