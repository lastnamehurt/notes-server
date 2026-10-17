// Settings → Shortcuts: one secret for every Daybook Shortcut, hidden until asked for, and replaceable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startAwarenessWorker, password, shortcutToken } from '../support/awareness-worker.mjs';

const workers = [];
async function signedIn(options) {
  const worker = await startAwarenessWorker(options);
  workers.push(worker);
  const login = await fetch(worker.base + '/app/login', { method: 'POST',
    headers: { Origin: worker.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: password }) });
  assert.equal(login.status, 204);
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  const call = (path, method = 'GET', body) => fetch(worker.base + '/app/api' + path, { method,
    headers: { Cookie: cookie, Origin: worker.base, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  await call('/setup', 'POST', { storage: 'app', timezone: 'UTC', ntfyTopic: 'shortcuts-secret-test-topic' });
  const tap = token => fetch(worker.base + '/app/shortcuts/signal', { method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'payment', amount: 1 }) });
  return { worker, call, tap };
}
after(async () => { for (const w of workers) await w.close(); });

test('a secret made in Settings is hidden by default, shown on request, and replacing it retires the old one', async () => {
  const { worker, call, tap } = await signedIn({ deployToken: false });
  let st = await (await call('/shortcuts')).json();
  assert.equal(st.hasSecret, false);
  assert.equal(st.syncUrl, worker.base + '/app/shortcuts/sync');
  assert.equal(st.signalUrl, worker.base + '/app/shortcuts/signal');
  assert.equal((await call('/shortcuts/secret')).status, 404);
  assert.equal((await call('/apple-sync/token', 'POST', {})).status, 200);
  st = await (await call('/shortcuts')).json();
  assert.equal(st.hasSecret, true);
  assert.ok(!JSON.stringify(st).includes('token'), 'the Shortcuts payload never carries the secret');
  const apple = await (await call('/apple-sync')).json();
  assert.equal(apple.hasToken, true);
  assert.equal(apple.token, undefined, 'Apple Reminders status no longer carries the secret');
  const first = (await (await call('/shortcuts/secret')).json()).token;
  assert.ok(first.length >= 32);
  assert.equal((await tap(first)).status, 200);
  await call('/apple-sync/token', 'POST', {});
  const second = (await (await call('/shortcuts/secret')).json()).token;
  assert.notEqual(second, first);
  assert.equal((await tap(first)).status, 401, 'the old secret stops working');
  assert.equal((await tap(second)).status, 200, 'the new one works');
  assert.equal((await fetch(worker.base + '/app/api/shortcuts/secret')).status, 401, 'signed-out requests are refused');
});

test('a secret set on the deployment is readable by the owner but cannot be replaced from Settings', async () => {
  const { call } = await signedIn();
  const st = await (await call('/shortcuts')).json();
  assert.deepEqual([st.hasSecret, st.fromDeploy], [true, true]);
  assert.equal((await (await call('/shortcuts/secret')).json()).token, shortcutToken);
  assert.equal((await call('/apple-sync/token', 'POST', {})).status, 409);
});
