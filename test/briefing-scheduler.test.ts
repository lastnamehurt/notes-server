// Runs the real ReminderScheduler Durable Object against in-memory storage, with GitHub and Pushover mocked.
// Needs: tsx --import ./test/support/register-cloudflare.mjs
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ReminderScheduler } from "../src/reminders.ts";
import { GithubNotes } from "../src/github.ts";
import { zonedTime, localStamp } from "../src/reminder-parse.ts";

const TZ = "America/Los_Angeles";
const at = (y: number, m: number, d: number, h: number, mi = 0) => zonedTime(y, m, d, h, mi, TZ);
const local = (ms: number) => { const s = localStamp(ms, TZ); return s.date + " " + s.time; };

class FakeStorage {
  map = new Map<string, any>(); alarm: number | null = null;
  async get(k: string) { return structuredClone(this.map.get(k)); }
  async put(k: string | Record<string, any>, v?: any) {
    if (typeof k === "string") this.map.set(k, structuredClone(v)); else for (const [a, b] of Object.entries(k)) this.map.set(a, structuredClone(b));
  }
  async delete(k: string | string[]) { for (const x of Array.isArray(k) ? k : [k]) this.map.delete(x); }
  async list({ prefix = "" } = {}) { return new Map([...this.map].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))); }
  async setAlarm(t: number) { this.alarm = t; }
  async getAlarm() { return this.alarm; }
  async deleteAlarm() { this.alarm = null; }
}

let clock = 0, notes: { name: string; content: string }[] = [], pushes: { title: string; message: string; url: string | null }[] = [];
let pushFails = 0, githubFails = false;
const realNow = Date.now, realFetch = globalThis.fetch, realAll = GithubNotes.prototype.all;

beforeEach(() => {
  pushes = []; pushFails = 0; githubFails = false;
  notes = [{ name: "inbox/errands.md", content: "- [ ] Call airline @2026-10-12 9am\n- [ ] Book hotel @priority:do\n" }];
  Date.now = () => clock;
  GithubNotes.prototype.all = async function () { if (githubFails) throw new Error("GitHub request failed (503)"); return notes; };
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    if (pushFails > 0) { pushFails--; return new Response("down", { status: 503 }); }
    const form = new URLSearchParams(String(init.body));
    pushes.push({ title: form.get("title")!, message: form.get("message")!, url: form.get("url") });
    return Response.json({ status: 1 });
  }) as typeof fetch;
});
afterEach(() => { Date.now = realNow; globalThis.fetch = realFetch; GithubNotes.prototype.all = realAll; });

function scheduler() {
  const storage = new FakeStorage();
  const env = { NOTES_TIMEZONE: TZ, PUSHOVER_TOKEN: "t", PUSHOVER_USER: "u", GITHUB_TOKEN: "g", NOTES_REPO: "me/notes", PUBLIC_URL: "https://daybook.test" };
  const s = new (ReminderScheduler as any)({ storage }, env) as ReminderScheduler;
  return { s, storage };
}
const runAlarmAt = async (s: ReminderScheduler, ms: number) => { clock = ms; await s.alarm(); };

test("a morning briefing goes out once at its local time, then moves to tomorrow", async () => {
  const { s, storage } = scheduler();
  clock = at(2026, 10, 11, 21);
  const state = await s.setBriefings({ morning: { enabled: true, time: "07:30" } }, 0);
  assert.equal(state.settings.revision, 1);
  assert.equal(local(state.next.morning!), "2026-10-12 07:30");
  assert.equal(storage.alarm, state.next.morning, "the alarm wakes for it");

  await runAlarmAt(s, at(2026, 10, 12, 7, 30));
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, "Good morning · Mon, Oct 12");
  assert.equal(pushes[0].message, "Today (1): 9am Call airline\nDo now (1): Book hotel");
  assert.equal(pushes[0].url, "https://daybook.test/app#today");
  const after = await s.getBriefings();
  assert.equal(after.status.morning!.result, "sent");
  assert.equal(local(after.next.morning!), "2026-10-13 07:30");

  // A second wake-up the same morning (restart, retry) doesn't send again.
  await storage.put("brief:next:morning", at(2026, 10, 12, 7, 31));
  await runAlarmAt(s, at(2026, 10, 12, 7, 31));
  assert.equal(pushes.length, 1);
});

test("a failed send retries every few minutes, then gives up for the day", async () => {
  const { s } = scheduler();
  clock = at(2026, 10, 12, 6);
  await s.setBriefings({ morning: { enabled: true, time: "08:00" } }, 0);
  pushFails = 1;
  await runAlarmAt(s, at(2026, 10, 12, 8));
  let st = await s.getBriefings();
  assert.deepEqual([st.status.morning!.result, local(st.next.morning!)], ["failed", "2026-10-12 08:05"]);
  assert.match(st.status.morning!.detail!, /Will retry: Pushover returned 503/);
  await runAlarmAt(s, at(2026, 10, 12, 8, 5));
  assert.equal(pushes.length, 1, "the retry sent it");
  assert.equal((await s.getBriefings()).status.morning!.result, "sent");

  const { s: s2 } = scheduler();
  clock = at(2026, 10, 12, 6);
  await s2.setBriefings({ morning: { enabled: true, time: "08:00" } }, 0);
  pushFails = 99;
  for (let i = 0; i < 6; i++) await runAlarmAt(s2, at(2026, 10, 12, 8, i * 5));
  st = await s2.getBriefings();
  assert.equal(st.status.morning!.result, "failed");
  assert.match(st.status.morning!.detail!, /Gave up after 6 tries/);
  assert.equal(local(st.next.morning!), "2026-10-13 08:00");
});

test("a briefing hours late is skipped, and an empty day sends nothing", async () => {
  const { s } = scheduler();
  clock = at(2026, 10, 12, 6);
  await s.setBriefings({ morning: { enabled: true, time: "08:00" }, evening: { enabled: true, time: "19:00" } }, 0);
  await runAlarmAt(s, at(2026, 10, 12, 11));
  let st = await s.getBriefings();
  assert.deepEqual([st.status.morning!.result, st.status.morning!.detail], ["skipped", "Missed its time by over two hours"]);
  assert.equal(pushes.length, 0);

  notes = [{ name: "inbox/a.md", content: "- [ ] Someday idea\n" }];
  await runAlarmAt(s, at(2026, 10, 12, 19));
  st = await s.getBriefings();
  assert.deepEqual([st.status.evening!.result, st.status.evening!.detail], ["skipped", "Nothing to report"]);
  assert.equal(pushes.length, 0);
});

test("turning a briefing off cancels its pending send; stale revisions are refused", async () => {
  const { s, storage } = scheduler();
  clock = at(2026, 10, 12, 6);
  await s.setBriefings({ morning: { enabled: true, time: "08:00" } }, 0);
  await assert.rejects(s.setBriefings({ morning: { enabled: false } }, 0), /changed elsewhere/);
  const off = await s.setBriefings({ morning: { enabled: false } }, 1);
  assert.equal(off.next.morning, undefined);
  assert.equal(storage.alarm, null);
  await runAlarmAt(s, at(2026, 10, 12, 8));
  assert.equal(pushes.length, 0);
});

test("counts-only preview keeps titles off the lock screen", async () => {
  const { s } = scheduler();
  clock = at(2026, 10, 12, 6);
  await s.setBriefings({ morning: { enabled: true, time: "08:00" }, preview: "counts" }, 0);
  await runAlarmAt(s, at(2026, 10, 12, 8));
  assert.equal(pushes[0].message, "1 due today · 1 do now");
});

test("a briefing failure never stops reminders from going out", async () => {
  const { s } = scheduler();
  clock = at(2026, 10, 12, 6);
  await s.setBriefings({ morning: { enabled: true, time: "08:00" } }, 0);
  await s.setNote("inbox/meds.md", [{ note: "inbox/meds.md", text: "Take meds", at: at(2026, 10, 12, 8) }]);
  githubFails = true;
  await runAlarmAt(s, at(2026, 10, 12, 8));
  assert.deepEqual(pushes.map(p => p.title), ["Reminder"]);
  assert.match((await s.getBriefings()).status.morning!.detail!, /Will retry: GitHub request failed \(503\)/);
});

test("test sends are limited to one a minute", async () => {
  const { s } = scheduler();
  clock = at(2026, 10, 12, 10);
  const b = await s.testBriefing("evening");
  assert.equal(b.kind, "evening");
  assert.equal(pushes.length, 1);
  await assert.rejects(s.testBriefing("morning"), /Wait a minute/);
  clock += 61_000;
  await s.testBriefing("morning");
  assert.equal(pushes.length, 2);
});
