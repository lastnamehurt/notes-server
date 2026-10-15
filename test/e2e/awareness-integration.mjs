import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { startAwarenessWorker, connectMcp, password, shortcutToken } from '../support/awareness-worker.mjs';

let worker, cookie, mcp, browser;
const defaults = { enabled: false, paused: false, mode: 'inbox',
  sources: { daybook: true, appleReminders: false, calendar: false, github: false },
  quietHours: { start: '22:00', end: '08:00' }, dailyPushBudget: 2 };
async function request(path, method = 'GET', body, headers = {}) {
  return fetch(worker.base + '/app/api' + path, { method,
    headers: { Cookie: cookie, Origin: worker.base, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function api(path, method = 'GET', body) {
  const response = await request(path, method, body);
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}
const preferences = patch => api('/awareness/preferences', 'PUT', { ...structuredClone(defaults), ...patch });
const content = (id, day) => `# Private task\n- [ ] Private title @2099-01-${String(day).padStart(2, '0')} 9am ^${id}\n`;
async function create(id) {
  const result = await api('/note', 'POST', { content: content(id, 1), category: 'inbox' });
  return result.name;
}
async function webMove(name, id, day) {
  const current = await api('/note?name=' + encodeURIComponent(name));
  return api('/note', 'PUT', { name, content: content(id, day), sha: current.sha });
}
async function mcpMove(name, id, day) {
  const current = await api('/note?name=' + encodeURIComponent(name));
  const result = await mcp('update_note', { name, content: content(id, day), expected_sha: current.sha });
  assert.equal(result.error, false, JSON.stringify(result));
}
async function sync(runId, reminders) {
  const response = await fetch(worker.base + '/app/shortcuts/sync', { method: 'POST',
    headers: { Authorization: 'Bearer ' + shortcutToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, reminders }) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}
function appleList(result) {
  return result.actions.filter(a => a.op === 'create').map((a, index) => ({
    index, url: worker.base + '/app#task/' + a.taskId, title: a.title,
    due: a.due ?? '', allDay: a.allDay, completed: a.completed, priority: 'None' }));
}
async function candidate(id) { return api('/awareness/item?id=three-deferrals-' + id); }
async function hasCandidate(id) {
  return (await request('/awareness/item?id=three-deferrals-' + id)).status === 200;
}
async function threeMoves(id) {
  const name = await create(id);
  for (let day = 2; day <= 4; day++) await webMove(name, id, day);
  return candidate(id);
}
// A one-minute quiet interval twelve hours from now avoids wall-clock-dependent sends.
function outsideQuiet() {
  const minute = (new Date().getUTCHours() * 60 + new Date().getUTCMinutes() + 720) % 1440;
  const hhmm = m => `${String(Math.floor((m % 1440) / 60)).padStart(2,'0')}:${String(m % 60).padStart(2,'0')}`;
  return { start: hhmm(minute), end: hhmm(minute + 1) };
}
async function initialize() {
  worker = await startAwarenessWorker();
  const login = await fetch(worker.base + '/app/login', { method: 'POST',
    headers: { Origin: worker.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: password }) });
  assert.equal(login.status, 204);
  cookie = login.headers.getSetCookie()[0].split(';')[0];
  await api('/setup', 'POST', { storage: 'app', timezone: 'UTC', ntfyTopic: 'awareness-local-test-topic' });
  mcp = await connectMcp(worker.base);
}
before(initialize);
after(async () => { await browser?.close(); await worker?.close(); });

test('Awareness routes reject anonymous and cross-origin writes; invalid consent is atomic', async () => {
  const response = await fetch(worker.base + '/app/api/awareness/preferences');
  assert.equal(response.status, 401);
  assert.equal((await request('/awareness/preferences', 'PUT', defaults, { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await request('/awareness/preferences', 'PUT', { ...defaults, dailyPushBudget: 3 })).status, 400);
  assert.deepEqual(await api('/awareness/preferences'), defaults);
  assert.equal((await fetch(worker.base + '/app/shortcuts/sync', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: 'unauthorized', reminders: [] }) })).status, 401);
  assert.equal((await fetch(worker.base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
});

test('default off, pause and Daybook source consent gate real committed web/MCP transitions', async () => {
  for (const [id, patch] of [['off1', {}], ['pause1', { enabled: true, paused: true }],
    ['source1', { enabled: true, sources: { ...defaults.sources, daybook: false } }]]) {
    await preferences(patch);
    const name = await create(id);
    await webMove(name, id, 2); await mcpMove(name, id, 3); await webMove(name, id, 4);
    assert.equal(await hasCandidate(id), false, id);
  }
  assert.equal(worker.pushes.length, 0);
});

test('Apple source opt-out does not create suggestions from Apple-originated moves', async () => {
  await preferences({ enabled: true }); // Daybook on, Apple off.
  await create('appleoff');
  const reminders = appleList(await sync('apple-off-initial', []));
  const reminder = reminders.find(r => r.url.endsWith('/appleoff'));
  for (let day = 2; day <= 4; day++) {
    reminder.due = `2099-01-0${day}T09:00:00Z`;
    await sync('apple-off-move-' + day, reminders);
  }
  assert.equal(await hasCandidate('appleoff'), false, 'Apple consent must be independent of Daybook consent');
  await preferences({ enabled: true, sources: { ...defaults.sources, appleReminders: true } });
  reminder.due = '2099-01-05T09:00:00Z';
  await sync('apple-enabled-move', reminders);
  assert.equal(await hasCandidate('appleoff'), false, 'moves made without Apple consent were not retained');
  assert.equal(worker.pushes.length, 0);
});

test('Apple-only consent generates suggestions and revocation blocks their delivery', async () => {
  await preferences({ enabled: true, sources: { ...defaults.sources, daybook: false, appleReminders: true } });
  await create('appleon');
  const reminders = appleList(await sync('apple-on-initial', []));
  const reminder = reminders.find(r => r.url.endsWith('/appleon'));
  for (let day = 2; day <= 4; day++) {
    reminder.due = `2099-01-0${day}T09:00:00Z`;
    await sync('apple-on-move-' + day, reminders);
  }
  const item = await candidate('appleon');
  assert.equal(item.candidate.evidenceEventIds.length, 3);
  await preferences({ enabled: true, mode: 'proactive', quietHours: outsideQuiet(),
    sources: { ...defaults.sources, appleReminders: false } });
  assert.equal((await api('/awareness/deliver', 'POST', { id: item.candidate.id })).reason, 'source-not-authorized');
  assert.equal(worker.pushes.length, 0);
});

test('web → MCP → Apple produces one persisted inbox suggestion; replay and echoes do not duplicate', async () => {
  await preferences({ enabled: true, sources: { ...defaults.sources, appleReminders: true } });
  const name = await create('mixed1');
  await webMove(name, 'mixed1', 2);
  await mcpMove(name, 'mixed1', 3);
  const reminders = appleList(await sync('mixed-initial', []));
  const reminder = reminders.find(r => r.url.endsWith('/mixed1'));
  reminder.due = '2099-01-04T09:00:00Z';
  const committed = await sync('mixed-postpone', reminders);
  const item = await candidate('mixed1');
  assert.equal(item.candidate.evidenceEventIds.length, 3);
  assert.equal(new Set(item.candidate.evidenceEventIds).size, 3);
  assert.deepEqual(await sync('mixed-postpone', reminders), committed);
  await sync('mixed-echo-run', reminders);
  await mcpMove(name, 'mixed1', 4);
  assert.deepEqual(await candidate('mixed1'), item);
  assert.equal(worker.pushes.length, 0, 'ingestion never sends a notification');
  // Do not resurrect a dismissed suggestion when more evidence arrives.
  await api('/awareness/action', 'POST', { id: item.candidate.id, action: 'dismiss' });
  await webMove(name, 'mixed1', 5);
  assert.equal((await candidate('mixed1')).state, 'dismissed');
});

test('concurrent web/MCP writes accept one version and only the committed change is evidence', async () => {
  await preferences({ enabled: true });
  const name = await create('race1');
  const current = await api('/note?name=' + encodeURIComponent(name));
  const [web, tool] = await Promise.all([
    request('/note', 'PUT', { name, sha: current.sha, content: content('race1', 2) }),
    mcp('update_note', { name, expected_sha: current.sha, content: content('race1', 2) })
  ]);
  assert.equal(Number(web.ok) + Number(!tool.error), 1);
  await webMove(name, 'race1', 3);
  assert.equal(await hasCandidate('race1'), false, 'failed write cannot count as third deferral');
  await mcpMove(name, 'race1', 4);
  assert.equal((await candidate('race1')).candidate.evidenceEventIds.length, 3);
});

test('tasks without an Apple Reminders ID are tagged on save and their postponements count', async () => {
  await preferences({ enabled: true });
  const plain = day => `# Untagged task\n- [ ] Untagged title @2099-02-${String(day).padStart(2, '0')} 9am\n`;
  const { name } = await api('/note', 'POST', { content: plain(1), category: 'inbox' });
  let saved = await api('/note?name=' + encodeURIComponent(name));
  const id = /\^([a-z0-9]{6})$/m.exec(saved.content)?.[1];
  assert.ok(id, 'a new scheduled task gets an ID: ' + saved.content);
  // An editor that drops the ID, an MCP rewrite that drops it, then an edit that keeps it.
  await api('/note', 'PUT', { name, content: plain(2), sha: saved.sha });
  saved = await api('/note?name=' + encodeURIComponent(name));
  assert.match(saved.content, new RegExp('\\^' + id + '$', 'm'), 'the dropped ID comes back');
  const result = await mcp('update_note', { name, content: plain(3), expected_sha: saved.sha });
  assert.equal(result.error, false, JSON.stringify(result));
  saved = await api('/note?name=' + encodeURIComponent(name));
  await api('/note', 'PUT', { name, content: plain(4).trimEnd() + ' ^' + id + '\n', sha: saved.sha });
  assert.equal((await candidate(id)).candidate.evidenceEventIds.length, 3);
});

test('the hourly scan nudges a task overdue two days, names it only in the app, and retires it once moved', async () => {
  await preferences({ enabled: true });
  const day = offset => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const note = date => `# Overdue\n- [ ] Renew overdue passport @${date} 9am\n`;
  const { name } = await api('/note', 'POST', { content: note(day(-3)), category: 'inbox' });
  await mcp('sync_notes', {});
  let inbox = await api('/awareness/inbox');
  const item = inbox.items.find(i => i.candidate.ruleId === 'task-overdue');
  assert.ok(item, JSON.stringify(inbox));
  assert.equal(item.task.title, 'Renew overdue passport');
  assert.equal(item.task.note, name);
  assert.ok(!JSON.stringify(item.candidate).includes('passport'), 'the stored suggestion never holds the title');
  await mcp('sync_notes', {});
  assert.equal((await api('/awareness/inbox')).items.filter(i => i.candidate.ruleId === 'task-overdue').length, 1, 'no repeat nudge');
  // Give it a new date: the nudge is retired.
  const saved = await api('/note?name=' + encodeURIComponent(name));
  await api('/note', 'PUT', { name, content: saved.content.replace(day(-3), day(3)), sha: saved.sha });
  await mcp('sync_notes', {});
  inbox = await api('/awareness/inbox');
  assert.equal(inbox.items.filter(i => i.candidate.ruleId === 'task-overdue').length, 0);
});

test('digest mode counts waiting suggestions in the morning briefing', async () => {
  await preferences({ enabled: true, mode: 'digest' });
  const day = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10);
  await api('/note', 'POST', { content: `# Digest\n- [ ] Digest overdue task @${day} 9am\n`, category: 'inbox' });
  await mcp('sync_notes', {});
  const briefing = await mcp('prepare_briefing', { kind: 'morning' });
  assert.equal(briefing.error, false, JSON.stringify(briefing));
  assert.match(JSON.stringify(briefing), /new suggestion/);
  await preferences({ enabled: true, mode: 'inbox' });
  assert.doesNotMatch(JSON.stringify(await mcp('prepare_briefing', { kind: 'morning' })), /new suggestion/);
});

test('tap-to-pay signal: off by default, logs a bar tab, asks about big purchases, idempotent, ignores chosen cards', async () => {
  const signal = (body, token = shortcutToken) => fetch(worker.base + '/app/shortcuts/signal', { method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await signal({ amount: 5 }, 'wrong-token-wrong-token-wrong-token')).status, 401);
  let r = await (await signal({ kind: 'payment', amount: 5, id: 'sig-off-0001' })).json();
  assert.equal(r.recorded, false);
  assert.equal(r.reason, 'off');
  const settings = await api('/signals/settings');
  assert.equal(settings.payment.enabled, false);
  await api('/signals/settings', 'PUT', { ...settings, payment: { ...settings.payment, enabled: true, ignoredCards: ['Work Card'] }, hideAmounts: true });
  await preferences({ enabled: true });
  r = await (await signal({ kind: 'payment', amount: '$9.50', category: 'Bar', card: 'Personal', merchant: 'Hidden Bar Name', id: 'sig-bar-0001' })).json();
  assert.equal(r.recorded, true, JSON.stringify(r));
  assert.match(r.message, /Today \$9\.50 across 1/);
  // A retry of the same tap changes nothing.
  r = await (await signal({ kind: 'payment', amount: '$9.50', category: 'Bar', card: 'Personal', id: 'sig-bar-0001' })).json();
  assert.equal(r.reason, 'duplicate');
  await (await signal({ kind: 'payment', amount: 400, card: 'Work Card', id: 'sig-work-0001' })).json();
  await (await signal({ kind: 'payment', amount: 210, category: 'Electronics', card: 'Personal', id: 'sig-big-0001' })).json();
  const spend = await api('/signals/spend');
  assert.equal(spend.today, 219.5);
  assert.equal(spend.todayCount, 2);
  assert.equal(spend.drinksThisWeek, 1);
  const big = (await api('/awareness/inbox')).items.find(i => i.candidate.ruleId === 'payment-big-purchase');
  assert.ok(big, 'big purchase suggestion');
  assert.doesNotMatch(big.candidate.reason, /\$/, 'hidden amounts');
  const notes = await api('/notes');
  const logName = notes.find(n => n.startsWith('journal/log/'));
  const log = await api('/note?name=' + encodeURIComponent(logName));
  assert.match(log.content, /Tap to pay: bar #drink #spend/);
  assert.doesNotMatch(JSON.stringify(log.content), /Hidden Bar Name/);
  assert.equal((await api('/signals/erase', 'POST', {})).deleted, 3);
  assert.equal((await api('/signals/spend')).todayCount, 0);
  await api('/signals/settings', 'PUT', settings);
});

test('mobile browser uses real API; consent saves without requesting notification permission', async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addCookies([{ name: 'notes_session', value: cookie.slice(cookie.indexOf('=') + 1), url: worker.base + '/app' }]);
  await context.addInitScript(() => {
    window.permissionRequests = 0;
    Notification.requestPermission = async () => { window.permissionRequests++; return 'denied'; };
  });
  await context.route('https://fonts.**', route => route.abort());
  const page = await context.newPage();
  await page.goto(worker.base + '/app#awareness');
  await page.getByLabel('Enable Awareness').waitFor();
  await page.getByLabel('Enable Awareness').uncheck();
  await page.getByRole('button', { name: 'Save Awareness settings' }).click();
  await page.getByText('Awareness settings saved', { exact: true }).waitFor();
  assert.equal((await api('/awareness/preferences')).enabled, false);
  assert.equal(await page.evaluate(() => window.permissionRequests), 0);
  await context.close();
});

test('notification policies suppress opt-out, pause, inbox, digest, quiet hours, cap and user actions', async () => {
  await preferences({ enabled: true });
  const item = await threeMoves('policy1');
  const deliver = () => api('/awareness/deliver', 'POST', { id: item.candidate.id });
  const policies = [
    [{ enabled: false }, 'disabled-or-paused'], [{ enabled: true, paused: true }, 'disabled-or-paused'],
    [{ enabled: true }, 'inbox-only'], [{ enabled: true, mode: 'digest' }, 'digest-mode'],
    [{ enabled: true, mode: 'proactive', quietHours: { start: '00:00', end: '23:59' } }, 'quiet-hours'],
    [{ enabled: true, mode: 'proactive', quietHours: outsideQuiet(), dailyPushBudget: 0 }, 'daily-cap']
  ];
  // The 23:59 UTC edge uses the other wrapping interval.
  if (new Date().getUTCHours() === 23 && new Date().getUTCMinutes() === 59)
    policies[4][0].quietHours = { start: '23:58', end: '23:57' };
  for (const [patch, reason] of policies) {
    await preferences(patch); assert.equal((await deliver()).reason, reason);
  }
  await preferences({ enabled: true, mode: 'proactive', quietHours: outsideQuiet(), sources: { ...defaults.sources, daybook: false } });
  assert.equal((await deliver()).reason, 'source-not-authorized');
  await preferences({ enabled: true, mode: 'proactive', quietHours: outsideQuiet() });
  await api('/setup', 'POST', { storage: 'app', timezone: 'UTC', ntfyTopic: '' });
  assert.equal((await deliver()).reason, 'push-not-configured');
  await api('/setup', 'POST', { storage: 'app', timezone: 'UTC', ntfyTopic: 'awareness-local-test-topic' });
  await api('/awareness/action', 'POST', { id: item.candidate.id, action: 'snooze', until: new Date(Date.now() + 3600000).toISOString() });
  assert.equal((await deliver()).reason, 'stale');
  await api('/awareness/action', 'POST', { id: item.candidate.id, action: 'mute' });
  assert.equal((await deliver()).reason, 'dismissed-or-muted');
  assert.equal(worker.pushes.length, 0);
});

test('concurrent delivery reserves once; provider failure and restart cannot resend', async () => {
  await preferences({ enabled: true });
  const first = await threeMoves('push1');
  const second = await threeMoves('push2');
  await preferences({ enabled: true, mode: 'proactive', quietHours: outsideQuiet() });
  worker.failProvider('disconnect');
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    api('/awareness/deliver', 'POST', { id: first.candidate.id })));
  assert.equal(results.filter(r => r.reason === 'delivery-unconfirmed').length, 1);
  assert.equal(results.filter(r => r.reason === 'already-delivered').length, 4);
  assert.equal(worker.pushes.length, 1);
  assert.equal((await api('/awareness/deliver', 'POST', { id: second.candidate.id })).reason, 'cooldown');
  const prefs = await api('/awareness/preferences');
  const notes = await api('/notes');
  const savedNote = await api('/note?name=' + encodeURIComponent(notes[0]));
  const savedInbox = await api('/awareness/inbox');
  const history = await api('/awareness/history');
  assert.ok(JSON.stringify(history).includes('delivery-unconfirmed'));
  assert.ok(!JSON.stringify(history).includes('Private title'));
  assert.ok(!worker.pushes[0].body.includes('Private title'));
  worker.failProvider(false);
  await worker.restart();
  assert.deepEqual(await api('/awareness/preferences'), prefs);
  assert.deepEqual(await api('/notes'), notes);
  assert.deepEqual(await api('/note?name=' + encodeURIComponent(notes[0])), savedNote);
  assert.deepEqual(await api('/awareness/inbox'), savedInbox);
  assert.deepEqual(await api('/awareness/history'), history);
  assert.equal((await candidate('mixed1')).state, 'dismissed');
  assert.equal((await candidate('policy1')).state, 'muted');
  assert.equal((await api('/awareness/deliver', 'POST', { id: first.candidate.id })).reason, 'already-delivered');
  assert.equal((await api('/awareness/deliver', 'POST', { id: second.candidate.id })).reason, 'cooldown');
  assert.equal(worker.pushes.length, 1);
  const freshMcp = await connectMcp(worker.base);
  assert.equal((await freshMcp('list_notes', {})).error, false);
});

// A second installation proves storage isolation despite identical DO instance names.
test('proactive mode pushes a new suggestion without an explicit deliver request (#95)', async () => {
  // Fresh installation: earlier scenarios used up today's cooldown on the shared one.
  await worker.close();
  await initialize();
  const before = worker.pushes.length;
  // Inbox-only (the default): a new suggestion stays in the app.
  await preferences({ enabled: true });
  await threeMoves('autoinbox');
  assert.equal(worker.pushes.length, before);
  // Proactive: the next new suggestion is pushed as soon as it's created, once.
  await preferences({ enabled: true, mode: 'proactive', quietHours: outsideQuiet() });
  const item = await threeMoves('autopush');
  assert.equal(worker.pushes.length, before + 1);
  assert.match(worker.pushes.at(-1).headers.click, /#awareness$/);
  assert.ok(!worker.pushes.at(-1).body.includes('Private title'));
  assert.equal((await api('/awareness/deliver', 'POST', { id: item.candidate.id })).reason, 'already-delivered');
  // Quiet hours hold the next one back instead of sending it.
  await preferences({ enabled: true, mode: 'proactive', quietHours: { start: '00:00', end: '23:59' } });
  await threeMoves('autoquiet');
  assert.equal(worker.pushes.length, before + 1);
});

test('successful delivery acknowledges once and another installation cannot read prior data', async () => {
  await worker.close();
  await initialize();
  assert.deepEqual(await api('/awareness/preferences'), defaults);
  assert.deepEqual(await api('/notes'), []);
  assert.deepEqual((await api('/awareness/inbox')).items, []);
  assert.equal(await hasCandidate('mixed1'), false);
  await preferences({ enabled: true });
  const items = [await threeMoves('success1'), await threeMoves('success2')];
  await preferences({ enabled: true, mode: 'proactive', quietHours: outsideQuiet() });
  const results = await Promise.all(items.map(item => api('/awareness/deliver', 'POST', { id: item.candidate.id })));
  assert.equal(results.filter(result => result.status === 'sent').length, 1);
  assert.equal(results.filter(result => result.reason === 'cooldown').length, 1);
  const item = items[results.findIndex(result => result.status === 'sent')];
  assert.equal(worker.pushes.length, 1);
  assert.match(worker.pushes[0].headers.click, /#awareness$/);
  assert.ok(!worker.pushes[0].body.includes('Private title'));
  assert.equal((await api('/awareness/deliver', 'POST', { id: item.candidate.id })).reason, 'already-delivered');
  const history = await api('/awareness/history');
  assert.ok(JSON.stringify(history).includes('sent'));
  await worker.restart();
  assert.deepEqual(await api('/awareness/history'), history);
  assert.equal((await api('/awareness/deliver', 'POST', { id: item.candidate.id })).reason, 'already-delivered');
  assert.equal(worker.pushes.length, 1);
});
