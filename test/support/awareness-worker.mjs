// Real local workerd + SQLite Durable Objects. Only the push provider is simulated.
// Temporary config/state never touch .dev.vars, wrangler.jsonc, or deployed resources.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../..', import.meta.url));
export const password = 'awareness-local-test-password';
export const shortcutToken = 'awareness-local-shortcut-token-123456789';
const listen = async server => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
};
/** `deployToken: false` leaves SHORTCUTS_TOKEN unset, so the Shortcut secret is made in Settings. */
export async function startAwarenessWorker({ deployToken = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'daybook-awareness-'));
  const pushes = [];
  let providerFails = false, child, log = '';
  const provider = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    pushes.push({ body, headers: req.headers, path: req.url });
    // Drop the response after receiving the request: delivery may have happened.
    if (providerFails === 'disconnect') return res.destroy();
    res.writeHead(providerFails ? 503 : 200); res.end('{}');
  });
  const pushPort = await listen(provider);
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const config = join(dir, 'wrangler.json');
  writeFileSync(config, JSON.stringify({
    name: 'awareness-integration', main: join(root, 'src/index.ts'),
    compatibility_date: '2026-09-01', compatibility_flags: ['nodejs_compat'],
    kv_namespaces: [{ binding: 'OAUTH_KV', id: 'local-only' }],
    durable_objects: { bindings: [
      { name: 'REMINDERS', class_name: 'ReminderScheduler' },
      { name: 'NOTES', class_name: 'NotesStore' }
    ] },
    migrations: [{ tag: 'test-only', new_sqlite_classes: ['ReminderScheduler', 'NotesStore'] }],
    vars: { PASSWORD: password, ...(deployToken ? { SHORTCUTS_TOKEN: shortcutToken } : {}), ALLOW_CLIENT_REGISTRATION: 'true',
      NTFY_SERVER: `http://127.0.0.1:${pushPort}`, PUBLIC_URL: base }
  }));
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited; clearTimeout(kill); child = undefined;
  }
  async function start() {
    child = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev', '--local', '--config', config,
      '--persist-to', join(dir, 'state'), '--port', String(port), '--ip', '127.0.0.1'],
    { cwd: dir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
    for (let n = 0; n < 120; n++) {
      if (child.exitCode !== null) throw new Error(`Worker exited: ${log.slice(-4000)}`);
      try { if ((await fetch(base + '/health', { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`Worker did not start: ${log.slice(-4000)}`);
  }
  const close = async () => {
    await stop();
    await new Promise(resolve => provider.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  };
  try { await start(); } catch (e) { await close(); throw e; }
  return { base, pushes, failProvider: value => { providerFails = value; },
    restart: async () => { await stop(); await start(); }, close };
}

export async function connectMcp(base) {
  const redirect = 'http://127.0.0.1:9/callback';
  const meta = await (await fetch(base + '/.well-known/oauth-authorization-server')).json();
  const reg = await (await fetch(meta.registration_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Awareness integration', redirect_uris: [redirect],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] })
  })).json();
  const verifier = randomBytes(32).toString('base64url');
  const auth = new URL(meta.authorization_endpoint);
  Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect,
    scope: 'notes:read notes:write', state: 'awareness-test', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', resource: base + '/mcp' }).forEach(([k,v]) => auth.searchParams.set(k,v));
  const page = await fetch(auth);
  const html = await page.text();
  const approved = await fetch(base + '/authorize', { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base,
      Cookie: page.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') },
    body: new URLSearchParams({ handle: /name="handle" value="([^"]+)"/.exec(html)[1],
      scope: /name="scope" value="([^"]*)"/.exec(html)?.[1] ?? '', password, decision: 'approve' }) });
  assert.equal(approved.status, 302);
  const token = await (await fetch(meta.token_endpoint, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
      grant_type: 'authorization_code', code: new URL(approved.headers.get('location')).searchParams.get('code'),
      redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier, resource: base + '/mcp' }) })).json();
  assert.ok(token.access_token);
  let id = 0, session;
  async function rpc(method, params) {
    const response = await fetch(base + '/mcp', { method: 'POST', headers: {
      Authorization: 'Bearer ' + token.access_token, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18',
      ...(session ? { 'Mcp-Session-Id': session } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    assert.equal(response.status, 200);
    session = response.headers.get('mcp-session-id') || session;
    const text = await response.text();
    const data = JSON.parse(response.headers.get('content-type').includes('text/event-stream')
      ? text.split('\n').filter(line => line.startsWith('data:')).at(-1).slice(5) : text);
    assert.equal(data.error, undefined);
    return data.result;
  }
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'awareness', version: '1' } });
  return async (name, args) => {
    const result = await rpc('tools/call', { name, arguments: args });
    const text = result.content[0].text;
    return { error: Boolean(result.isError), data: result.isError ? text : JSON.parse(text) };
  };
}
