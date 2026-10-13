// End-to-end simulation: several sync runs against an in-memory notes repo, scheduler and Apple
// Reminders list that applies the returned actions the way the iPhone Shortcut does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAppleSync, SyncError, type SyncNotes, type SyncScheduler, type SyncResponse } from "../src/apple-sync-run.ts";
import { parseReminders, zonedTime } from "../src/reminder-parse.ts";
import { tasksFromNotes } from "../src/priorities.ts";

const TZ = "America/Los_Angeles";
const NOW = zonedTime(2026, 10, 11, 10, 0, TZ); // Sun Oct 11 2026, 10:00 local

class FakeRepo implements SyncNotes {
  commits: Map<string, string>[] = [];
  failNextCommit = false;
  emptyReads = false;
  constructor(files: Record<string, string>) { this.commits.push(new Map(Object.entries(files))); }
  get head() { return this.commits.length.toString(16).padStart(40, "0"); }
  get files() { return this.commits[this.commits.length - 1]; }
  async headSha() { return this.head; }
  async snapshotAt(sha: string) {
    assert.equal(sha, this.head);
    return this.emptyReads ? new Map<string, string>() : new Map(this.files);
  }
  async commitFiles(parent: string, files: Map<string, string>) {
    if (this.failNextCommit) { this.failNextCommit = false; this.edit("inbox/other.md", "# Someone else\n"); throw new Error("GitHub conflict; refresh and retry"); }
    if (parent !== this.head) throw new Error("GitHub conflict; refresh and retry");
    this.commits.push(new Map([...this.files, ...[...files].map(([k, v]) => [k, v.trimEnd() + "\n"] as [string, string])]));
    return this.head;
  }
  /** A change made in Daybook between runs. */
  edit(name: string, content: string) { this.commits.push(new Map([...this.files, [name, content]])); }
}

class FakeScheduler implements SyncScheduler {
  store = new Map<string, any>();
  done: { note: string; text: string; at: number }[] = [];
  async syncBase() { return Object.fromEntries([...this.store].filter(([k]) => k.startsWith("b:")).map(([k, v]) => [k.slice(2), v])); }
  async putSyncBase(base: Record<string, unknown>) {
    for (const k of [...this.store.keys()]) if (k.startsWith("b:")) this.store.delete(k);
    for (const [id, v] of Object.entries(base)) this.store.set("b:" + id, structuredClone(v));
  }
  async syncStart(runId: string) {
    if (this.store.has("run:" + runId)) return { status: "replay" as const, response: this.store.get("run:" + runId) };
    if (this.store.get("lock") && this.store.get("lock") !== runId) return { status: "busy" as const };
    this.store.set("lock", runId);
    return { status: "go" as const };
  }
  async syncFinish(runId: string, response: unknown) {
    if (response !== null) this.store.set("run:" + runId, structuredClone(response));
    if (this.store.get("lock") === runId) this.store.delete("lock");
  }
  async doneSince() { return this.done; }
  async markDone(note: string, text: string, at: number) { this.done.push({ note, text, at }); }
}

interface Rem { taskId: string | null; title: string; due: string | null; allDay: boolean; completed: boolean; priority: string; }
/** Apple Reminders' Daybook list, plus the Shortcut's two jobs: snapshot it, apply actions to it. */
class FakeApple {
  list: Rem[] = [];
  snapshot() {
    return this.list.map((r, index) => ({ index, url: r.taskId ? "https://d.test/app#task/" + r.taskId : "", title: r.title,
      due: r.due ?? "", allDay: r.allDay, completed: r.completed, priority: r.priority[0].toUpperCase() + r.priority.slice(1) }));
  }
  apply(res: SyncResponse) {
    const gone = new Set<number>();
    for (const a of res.actions) {
      if (a.op === "create") this.list.push({ taskId: a.taskId, title: a.title, due: a.due, allDay: a.allDay, completed: a.completed, priority: a.priority });
      else if (a.op === "update") Object.assign(this.list[a.index], { title: a.title, due: a.due, allDay: a.allDay, completed: a.completed, priority: a.priority });
      else if (a.op === "tag") this.list[a.index].taskId = a.taskId;
      else gone.add(a.index);
    }
    this.list = this.list.filter((_, i) => !gone.has(i));
  }
  find(title: string) { return this.list.find(r => r.title === title)!; }
}

function setup(files: Record<string, string>, deferralsCommitted?: (events: {id:string;taskId:string;fromDueAt:string;toDueAt:string}[])=>Promise<unknown>) {
  const repo = new FakeRepo(files), sched = new FakeScheduler(), apple = new FakeApple();
  const changedNotes: string[] = [];
  let n = 0;
  const sync = async (runId = "run-" + String(++n).padStart(4, "0"), now = NOW) => {
    const res = await runAppleSync({ runId, reminders: apple.snapshot() }, {
      notes: repo, scheduler: sched, timeZone: TZ, now, url: id => "https://d.test/app#task/" + id,
      noteChanged: async name => { changedNotes.push(name); }, deferralsCommitted
    });
    apple.apply(res);
    return res;
  };
  return { repo, sched, apple, sync, changedNotes };
}

const TASKS = [
  "# Errands", "",
  "- [ ] Call airline @2026-10-15 9am",
  "- [ ] Take meds @daily 8am, 8pm",
  "- [ ] Book flights @priority:plan",
  "- [ ] Pay bill @2026-10-16",
  "- [ ] Just a thought",
  "- [x] Old thing @2026-10-01"
].join("\n") + "\n";

test("full two-way sync across several runs", async () => {
  const { repo, sched, apple, sync, changedNotes } = setup({ "inbox/errands.md": TASKS, "journal/log/2026-10-10.md": "# Log 2026-10-10\n\n- 09:00 coffee #drink\n" });

  // Run 1: IDs are written in one commit and in-scope tasks are created in Apple.
  const r1 = await sync();
  assert.equal(repo.commits.length, 2);
  assert.deepEqual(r1.summary, { reminders: 0, created: 4, updated: 0, deleted: 0, tagged: 0, daybookChanges: 4, conflicts: 0 });
  const errands = repo.files.get("inbox/errands.md")!;
  assert.match(errands, /^- \[ \] Call airline @2026-10-15 9am \^[a-z0-9]{6}$/m);
  assert.match(errands, /^- \[ \] Just a thought$/m, "out of scope: untouched");
  assert.match(errands, /^- \[x\] Old thing @2026-10-01$/m, "completed: untouched");
  assert.deepEqual(changedNotes, ["inbox/errands.md"]);
  assert.deepEqual(apple.list.map(r => [r.title, r.due, r.priority]), [
    ["Call airline", "2026-10-15T09:00:00-07:00", "none"],
    ["Take meds", "2026-10-11T08:00:00-07:00", "none"],
    ["Book flights", null, "medium"],
    ["Pay bill", "2026-10-16", "none"]
  ]);
  // Reminders and priorities still read the same with IDs on every line.
  assert.deepEqual(parseReminders("n", errands, TZ, NOW).map(r => r.text), parseReminders("n", TASKS, TZ, NOW).map(r => r.text));
  assert.deepEqual(tasksFromNotes([{ name: "n", content: errands }]).map(t => t.text), tasksFromNotes([{ name: "n", content: TASKS }]).map(t => t.text));

  // Run 2: nothing changed anywhere, so nothing happens and nothing is committed.
  const r2 = await sync();
  assert.deepEqual(r2.actions, []);
  assert.equal(repo.commits.length, 2);

  // In Apple: complete the airline call, retitle the bill, finish this morning's meds, add a new reminder.
  apple.find("Call airline").completed = true;
  apple.find("Pay bill").title = "Pay electric bill";
  apple.find("Take meds").completed = true;
  apple.list.push({ taskId: null, title: "Buy milk", due: "2026-10-12T17:30:00-07:00", allDay: false, completed: false, priority: "high" });
  const r3 = await sync();
  assert.equal(repo.commits.length, 3, "all Daybook changes land in one commit");
  const after = repo.files.get("inbox/errands.md")!;
  assert.match(after, /^- \[x\] Call airline @2026-10-15 9am \^/m);
  assert.match(after, /^- \[ \] Pay electric bill @2026-10-16 \^/m);
  assert.match(after, /^- \[ \] Take meds @daily 8am, 8pm \^/m, "a repeating task is never ticked");
  const inbox = [...repo.files.keys()].find(k => /^inbox\/2026-10-11-reminders\.md$/.test(k))!;
  assert.match(repo.files.get(inbox)!, /^# Reminders\n\n- \[ \] Buy milk @2026-10-12 5:30pm @priority:do \^[a-z0-9]{6}\n$/);
  const log = repo.files.get("journal/log/2026-10-11.md")!;
  assert.match(log, /- 10:00 ✓ Call airline #done/);
  assert.match(log, /- 10:00 ✓ Take meds #done/);
  assert.deepEqual(sched.done.map(d => d.text).sort(), ["Call airline", "Take meds"]);
  assert.equal(r3.summary.tagged, 1);
  assert.ok(apple.find("Buy milk").taskId, "new reminder got its ID");
  assert.deepEqual([apple.find("Take meds").completed, apple.find("Take meds").due], [false, "2026-10-11T20:00:00-07:00"], "meds moved on to 8pm and reopened");

  // Run 4: settled.
  const r4 = await sync();
  assert.deepEqual(r4.actions, []);
  assert.equal(repo.commits.length, 3);

  // In Daybook: move the flights task to a date, delete the bill. Apple follows.
  const moved = repo.files.get("inbox/errands.md")!
    .replace(/^- \[ \] Book flights @priority:plan (\^\w+)$/m, "- [ ] Book flights @2026-10-20 18:00 @priority:plan $1")
    .replace(/^- \[ \] Pay electric bill.*\n/m, "");
  repo.edit("inbox/errands.md", moved);
  const r5 = await sync();
  assert.deepEqual(r5.summary, { reminders: 5, created: 0, updated: 1, deleted: 1, tagged: 0, daybookChanges: 0, conflicts: 0 });
  assert.equal(apple.find("Book flights").due, "2026-10-20T18:00:00-07:00");
  assert.equal(apple.list.find(r => r.title.includes("bill")), undefined);

  // Someone edits a note while a run is in flight: the commit is refused, the run re-reads and succeeds.
  apple.find("Buy milk").title = "Buy oat milk";
  repo.failNextCommit = true;
  const before = repo.commits.length;
  await sync();
  assert.equal(repo.commits.length, before + 2, "the other edit, then this run's commit on top of it");
  assert.match(repo.files.get(inbox)!, /- \[ \] Buy oat milk /);
  assert.equal(repo.files.get("inbox/other.md"), "# Someone else\n", "the other edit is kept");

  // Deleting a reminder in Apple keeps the task in Daybook and logs it.
  apple.list = apple.list.filter(r => r.title !== "Book flights");
  await sync();
  assert.match(repo.files.get("inbox/errands.md")!, /^- \[ \] Book flights @2026-10-20 18:00 @priority:plan \^/m);
  assert.match(repo.files.get("journal/log/2026-10-11.md")!, /"Book flights" was removed from Apple Reminders.*#removed-in-reminders/);
  assert.deepEqual((await sync()).actions, [], "and it stays out of Apple until changed in Daybook");
});

test("replay and busy lock on the same scheduler", async () => {
  const repo = new FakeRepo({ "inbox/a.md": "- [ ] Call airline @2026-10-15 9am\n" });
  const sched = new FakeScheduler();
  const opts = { notes: repo, scheduler: sched, timeZone: TZ, now: NOW, url: (id: string) => id };
  const first = await runAppleSync({ runId: "run-aaaa1", reminders: [] }, opts);
  const replay = await runAppleSync({ runId: "run-aaaa1", reminders: [] }, opts);
  assert.deepEqual(replay, first);
  assert.equal(repo.commits.length, 2, "the replay committed nothing");
  sched.store.set("lock", "run-other");
  await assert.rejects(runAppleSync({ runId: "run-bbbb2", reminders: [] }, opts), (e: unknown) => e instanceof SyncError && e.status === 409);
});

test("a read that comes back empty can't wipe the Apple list", async () => {
  const lines = Array.from({ length: 8 }, (_, i) => `- [ ] Task ${i} @2026-10-2${i} 9am`).join("\n") + "\n";
  const { repo, apple, sync } = setup({ "inbox/a.md": lines });
  await sync();
  assert.equal(apple.list.length, 8);
  repo.emptyReads = true;
  await assert.rejects(sync(), /Refusing to delete 8 of 8/);
  assert.equal(apple.list.length, 8);
});

test("bad input is rejected with a clear message", async () => {
  const opts = { notes: new FakeRepo({}), scheduler: new FakeScheduler(), timeZone: TZ, url: (id: string) => id };
  await assert.rejects(runAppleSync({ nope: 1 }, opts), /"reminders" list/);
  await assert.rejects(runAppleSync({ runId: "x", reminders: [] }, opts), /runId/);
  await assert.rejects(runAppleSync({ reminders: Array(2001).fill({}) }, opts), (e: unknown) => e instanceof SyncError && e.status === 413);
});

test("Apple postponements emit only committed transitions, not replays, echoes or conflicts", async () => {
  const captured: {id:string;taskId:string;fromDueAt:string;toDueAt:string}[] = [];
  const {repo,apple,sync} = setup({"inbox/tasks.md":"# Tasks\n\n- [ ] Renew @2026-10-15 9am ^abcd\n"}, async events=>{captured.push(...events);});
  await sync();
  assert.equal(captured.length,0,"initial Daybook-to-Apple sync is not a postponement");
  const rem=apple.find("Renew");
  rem.due="2026-10-16T09:00:00-07:00";
  await sync();
  assert.equal(captured.length,1);
  const first=captured[0];
  assert.equal(first.taskId,"abcd");
  await sync();
  assert.equal(captured.length,1,"echo of same date is not counted");
  rem.due="2026-10-17T09:00:00-07:00";
  repo.failNextCommit=true;
  await sync();
  assert.equal(captured.length,2,"conflict retry only captures the committed transition");
  assert.notEqual(captured[1].id,first.id);
  rem.due="2026-10-18T09:00:00-07:00";
  await sync();
  assert.equal(captured.length,3);
  assert.equal(new Set(captured.map(e=>e.id)).size,3);
  assert.equal(captured[0].toDueAt,captured[1].fromDueAt);
  assert.equal(captured[1].toDueAt,captured[2].fromDueAt);
});
