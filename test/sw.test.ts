// The service worker (src/sw.txt), run with a stand-in for the browser's service worker environment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function load() {
  const listeners: Record<string, (e: any) => void> = {};
  const shown: { title: string; options: any }[] = [], fetched: { url: string; init: any }[] = [], opened: string[] = [];
  const windows: any[] = [];
  const self = {
    location: { origin: "https://daybook.jane.workers.dev" },
    addEventListener: (type: string, fn: (e: any) => void) => { listeners[type] = fn; },
    skipWaiting: () => {},
    registration: { showNotification: async (title: string, options: any) => { shown.push({ title, options }); } },
    clients: { claim: async () => {}, matchAll: async () => windows, openWindow: async (url: string) => { opened.push(url); } }
  };
  let fetchOk = true;
  const sandbox = { self, URL, JSON, String, Boolean, Error,
    fetch: async (url: string, init: any) => { fetched.push({ url, init }); return { ok: fetchOk }; } };
  vm.runInNewContext(readFileSync(new URL("../src/sw.txt", import.meta.url), "utf8"), sandbox);
  const fire = async (type: string, event: any) => {
    let wait: Promise<unknown> = Promise.resolve();
    listeners[type]({ ...event, waitUntil: (p: Promise<unknown>) => { wait = p; } });
    await wait;
  };
  return { fire, shown, fetched, opened, windows, setFetchOk: (v: boolean) => { fetchOk = v; } };
}
const pushEvent = (data: unknown) => ({ data: { json: () => data, text: () => JSON.stringify(data) } });

test("a reminder shows as a notification, with Done where there's a done link", async () => {
  const sw = load();
  await sw.fire("push", pushEvent({ title: "Reminder", body: "Take meds", url: "https://daybook.jane.workers.dev/app#today", done: "https://daybook.jane.workers.dev/done?a=x", tag: "r-1" }));
  assert.equal(sw.shown[0].title, "Reminder");
  assert.equal(sw.shown[0].options.body, "Take meds");
  assert.equal(sw.shown[0].options.tag, "r-1");
  assert.deepEqual(JSON.parse(JSON.stringify(sw.shown[0].options.actions)), [{ action: "done", title: "Done" }]);
  await sw.fire("push", pushEvent({ title: "Good morning", body: "3 things today" }));
  assert.equal(sw.shown[1].options.actions, undefined, "no Done on briefings");
});

test("tapping Done marks it done without opening anything; tapping the notification opens Today", async () => {
  const sw = load();
  const data = { url: "https://daybook.jane.workers.dev/app#today", done: "https://daybook.jane.workers.dev/done?a=x" };
  await sw.fire("notificationclick", { action: "done", notification: { data, close: () => {} } });
  assert.deepEqual(sw.fetched.map(f => [f.url, f.init.method]), [["https://daybook.jane.workers.dev/done?a=x", "POST"]]);
  assert.deepEqual(sw.opened, []);
  await sw.fire("notificationclick", { action: "", notification: { data, close: () => {} } });
  assert.deepEqual(sw.opened, ["https://daybook.jane.workers.dev/app#today"]);
});

test("an open Daybook window is reused; a failed Done opens the confirm page instead", async () => {
  const sw = load();
  let focused = false, went = "";
  sw.windows.push({ url: "https://daybook.jane.workers.dev/app#notes", navigate: async (u: string) => { went = u; }, focus: async () => { focused = true; } });
  await sw.fire("notificationclick", { action: "", notification: { data: { url: "/app#today" }, close: () => {} } });
  assert.equal(went, "https://daybook.jane.workers.dev/app#today"); assert.ok(focused); assert.deepEqual(sw.opened, []);
  const sw2 = load(); sw2.setFetchOk(false);
  await sw2.fire("notificationclick", { action: "done", notification: { data: { done: "https://daybook.jane.workers.dev/done?a=y" }, close: () => {} } });
  assert.deepEqual(sw2.opened, ["https://daybook.jane.workers.dev/done?a=y"]);
});
