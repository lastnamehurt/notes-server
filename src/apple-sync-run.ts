// One Apple Reminders sync run: read the notes at the branch's latest commit, plan with planSync(),
// write every Markdown change as a single commit, then save the new base. See apple-sync.ts.

import { splitTaskId, newTaskId, withTaskId } from "./task-id";
import { taskDeferrals, type TaskDeferral } from "./awareness-deferrals";
import { localStamp, DEFAULT_TIMEZONE } from "./reminder-parse";
import { LOG_PREFIX, logPath, insertLogLine } from "./log";
import { localDate } from "./github";
import {
  parseTaskLine, daybookItem, planSync, normalizeReminder, editTaskLine, newTaskLine, doneKey,
  type Action, type Base, type DaybookItem, type SyncState
} from "./apple-sync";

export const MAX_REMINDERS = 2000;
const LOCK_MS = 120_000;
const INBOX_NOTE = /^inbox\/(?:\d{4}-\d{2}-\d{2}-)?reminders(?:-\d+)?\.md$/;

/** What a run needs from GitHub. GithubNotes provides it. */
export interface SyncNotes {
  headSha(): Promise<string | null>;
  snapshotAt(commitSha: string): Promise<Map<string, string>>;
  commitFiles(parent: string, files: Map<string, string>, message: string): Promise<string>;
}
/** What a run needs from the scheduler Durable Object. */
export interface SyncScheduler {
  syncBase(): Promise<Record<string, unknown>>;
  putSyncBase(base: Record<string, unknown>): Promise<void>;
  syncStart(runId: string, lockMs: number): Promise<{ status: "go" | "busy" | "replay"; response?: unknown }>;
  syncFinish(runId: string, response: unknown | null): Promise<void>;
  doneSince(since: number): Promise<{ note: string; text: string; at: number }[]>;
  markDone(note: string, text: string, at: number): Promise<void>;
}

export interface SyncResponse {
  version: 1; runId: string; actions: Action[];
  summary: { reminders: number; created: number; updated: number; deleted: number; tagged: number; daybookChanges: number; conflicts: number };
}

/** A failure the Shortcut should show as-is (with this HTTP status). */
export class SyncError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export interface SyncOptions {
  notes: SyncNotes; scheduler: SyncScheduler; timeZone?: string;
  /** Builds the link written into each reminder, e.g. https://…/app#task/<id>. */ url: (id: string) => string;
  /** Called for each note the run changed, so its phone reminders are rescheduled. */ noteChanged?: (name: string, content: string) => Promise<unknown>;
  /** Best-effort post-commit capture of genuine Apple-originated postponements. */
  deferralsCommitted?: (changes: { id: string; taskId: string; fromDueAt: string; toDueAt: string }[]) => Promise<unknown>;
  now?: number;
}

export async function runAppleSync(body: unknown, o: SyncOptions): Promise<SyncResponse> {
  const timeZone = o.timeZone || DEFAULT_TIMEZONE;
  if (!body || typeof body !== "object" || !Array.isArray((body as any).reminders))
    throw new SyncError("Send a JSON object with a \"reminders\" list", 400);
  const rawList = (body as any).reminders as unknown[];
  if (rawList.length > MAX_REMINDERS) throw new SyncError(`Too many reminders in one sync (limit ${MAX_REMINDERS})`, 413);
  const givenRun = (body as any).runId;
  if (givenRun !== undefined && (typeof givenRun !== "string" || !/^[\w-]{8,100}$/.test(givenRun)))
    throw new SyncError("runId must be 8-100 letters, digits, - or _", 400);
  const runId: string = givenRun ?? crypto.randomUUID();
  const apple = rawList.map((r, i) => normalizeReminder(r && typeof r === "object" ? r as Record<string, unknown> : {},
    typeof (r as any)?.index === "number" ? (r as any).index : i, timeZone));

  const started = await o.scheduler.syncStart(runId, LOCK_MS);
  if (started.status === "replay") return started.response as SyncResponse;
  if (started.status === "busy") throw new SyncError("Another sync is running. Try again in a minute.", 409);
  try {
    const response = await syncOnce(runId, apple, timeZone, o);
    await o.scheduler.syncFinish(runId, response);
    return response;
  } catch (e) {
    await o.scheduler.syncFinish(runId, null);
    throw e;
  }
}

async function syncOnce(runId: string, apple: ReturnType<typeof normalizeReminder>[], timeZone: string, o: SyncOptions): Promise<SyncResponse> {
  const base = await o.scheduler.syncBase() as Base;
  for (let attempt = 1; ; attempt++) {
    const now = o.now ?? Date.now();
    const head = await o.notes.headSha();
    const files = head ? await o.notes.snapshotAt(head) : new Map<string, string>();
    const done = new Set((await o.scheduler.doneSince(now - 3 * 86_400_000)).map(d => doneKey(d.note, d.text, d.at)));

    // Read every task line (daily logs never hold tasks). Give an ID to open tasks worth syncing that lack one.
    const daybook: DaybookItem[] = [];
    const seen = new Set<string>();
    const assign = new Map<string, { raw: string; id: string }[]>();
    const allIds = new Set<string>();
    for (const [name, content] of files) {
      if (name.startsWith(LOG_PREFIX)) continue;
      for (const raw of content.split("\n")) { const id = splitTaskId(raw).id; if (id) allIds.add(id); }
    }
    for (const [name, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      if (name.startsWith(LOG_PREFIX)) continue;
      for (const raw of content.split("\n")) {
        const t = parseTaskLine(raw, timeZone);
        if (!t) continue;
        let id = t.id;
        const worthSyncing = !t.checked && (t.schedule !== null || t.priority !== "inbox");
        if (id && seen.has(id)) {
          // A copied line repeats an ID: the first one keeps it, a copy worth syncing gets its own.
          if (!worthSyncing) continue;
          id = null;
        }
        if (!id) {
          if (!worthSyncing) continue;
          id = newTaskId(allIds);
          allIds.add(id);
          assign.set(name, [...(assign.get(name) ?? []), { raw, id }]);
        }
        seen.add(id);
        daybook.push(daybookItem(name, { ...t, id }, timeZone, now, done));
      }
    }

    const inboxNote = [...files.keys()].filter(n => INBOX_NOTE.test(n)).sort().reverse()[0]
      ?? "inbox/" + localDate(timeZone, new Date(now)) + "-reminders.md";
    const plan = planSync({ daybook, apple, base, timeZone, inboxNote, url: o.url, takenIds: allIds });

    // Safety: a read that silently came back empty must not wipe the Apple list.
    const deletes = plan.actions.filter(a => a.op === "delete").length;
    const synced = Object.keys(base).length;
    if (deletes > 5 && deletes > synced / 2)
      throw new SyncError(`Refusing to delete ${deletes} of ${synced} synced reminders in one run. If you really removed them, delete them in Apple Reminders too.`, 409);

    // Build the new note contents.
    const changed = new Map<string, string>();
    const lines = (name: string) => (changed.get(name) ?? files.get(name) ?? "").split("\n");
    const lost = new Set<string>();
    for (const [name, list] of assign) {
      const ls = lines(name);
      for (const { raw, id } of list) {
        const i = ls.indexOf(raw);
        if (i < 0) { lost.add(id); continue; }
        ls[i] = withTaskId(raw, id);
      }
      changed.set(name, ls.join("\n"));
    }
    const edits = new Map<string, { id: string; set: Partial<SyncState> }[]>();
    for (const e of plan.edits) edits.set(e.note, [...(edits.get(e.note) ?? []), e]);
    for (const [name, list] of edits) {
      const ls = lines(name);
      for (const { id, set } of list) {
        const i = ls.findIndex(l => splitTaskId(l).id === id);
        if (i >= 0) ls[i] = editTaskLine(ls[i], set, timeZone);
      }
      changed.set(name, ls.join("\n"));
    }
    if (plan.added.length) {
      const existing = changed.get(inboxNote) ?? files.get(inboxNote);
      const add = plan.added.map(a => newTaskLine(a.id, a.state));
      if (existing === undefined) changed.set(inboxNote, "# Reminders\n\n" + add.join("\n") + "\n");
      else {
        const ls = existing.trimEnd().split("\n");
        let at = ls.length;
        for (let i = ls.length - 1; i >= 0; i--) if (parseTaskLine(ls[i], timeZone)) { at = i + 1; break; }
        ls.splice(at, 0, ...add);
        changed.set(inboxNote, ls.join("\n") + "\n");
      }
    }
    // Completions and conflicts go in today's log, in the same commit.
    const stamp = localStamp(now, timeZone);
    const entries = [...plan.completions.map(c => "✓ " + c.title + " #done"), ...plan.logs];
    if (entries.length) {
      const name = logPath(stamp.date);
      let content: string | null = changed.get(name) ?? files.get(name) ?? null;
      for (const entry of entries) content = insertLogLine(content, stamp.date, `- ${stamp.time} ${entry.replace(/\s*\n+\s*/g, " ")}`);
      changed.set(name, content!);
    }
    for (const [name, content] of [...changed]) if (content === files.get(name)) changed.delete(name);

    // An ID that couldn't be written (the line changed under us) must not reach Apple this run.
    const actions = plan.actions.filter(a => !(a.op === "create" && lost.has(a.taskId)));
    for (const id of lost) delete plan.base[id];

    if (changed.size) {
      if (!head) throw new SyncError("Your notes repository is empty. Save one note in Daybook first.", 409);
      try {
        await o.notes.commitFiles(head, changed, `notes: sync with Apple Reminders (${changed.size} file${changed.size === 1 ? "" : "s"})`);
      } catch (e) {
        // Someone else changed the notes since we read them: read again and re-plan.
        if (e instanceof Error && e.message.startsWith("GitHub conflict") && attempt < 3) continue;
        throw e;
      }
    }
    // Diff the successfully committed note contents, not Apple actions. This
    // excludes Daybook-to-Apple echoes, ID assignment and failed/retried commits.
    // Stable IDs dedupe a replay even if syncFinish fails after capture.
    if (o.deferralsCommitted && changed.size) {
      try {
        const transitions: { name: string; change: TaskDeferral }[] = [];
        for (const [name, content] of changed) {
          if (name.startsWith(LOG_PREFIX)) continue;
          for (const change of taskDeferrals(files.get(name) ?? "", content, timeZone))
            transitions.push({ name, change });
        }
        if (transitions.length) {
          const events = await Promise.all(transitions.map(async ({ name, change }) => {
            const bytes = new TextEncoder().encode(name + "\u0000" + change.taskId + "\u0000" + change.fromDueAt + "\u0000" + change.toDueAt);
            const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
              .map(b => b.toString(16).padStart(2, "0")).join("");
            return { ...change, id: "defer-" + hash.slice(0, 40) };
          }));
          await o.deferralsCommitted(events);
        }
      } catch (e) {
        // Awareness must never turn a committed sync into a retryable failure.
        console.warn("Apple sync Awareness capture failed", e instanceof Error ? e.message : "unknown");
      }
    }
    for (const c of plan.completions) if (c.at !== null) await o.scheduler.markDone(c.note, c.title, c.at);
    for (const [name, content] of changed) if (!name.startsWith(LOG_PREFIX)) await o.noteChanged?.(name, content);
    await o.scheduler.putSyncBase(plan.base);

    const count = (op: Action["op"]) => actions.filter(a => a.op === op).length;
    return {
      version: 1, runId, actions,
      summary: {
        reminders: apple.length, created: count("create"), updated: count("update"), deleted: count("delete"), tagged: count("tag"),
        daybookChanges: [...assign.values()].reduce((n, l) => n + l.length, 0) - lost.size + plan.edits.length + plan.added.length,
        conflicts: plan.logs.filter(l => l.includes("#sync-conflict")).length
      }
    };
  }
}
