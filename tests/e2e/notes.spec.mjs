import { test, expect } from '@playwright/test';

const password = process.env.NOTES_TEST_PASSWORD;
const writesEnabled = process.env.NOTES_ALLOW_WRITES === '1';

async function login(request, baseURL) {
  if (!password) throw new Error('Set NOTES_TEST_PASSWORD to run authenticated checks');
  const response = await request.post(`${baseURL}/app/login`, {
    headers: { Origin: new URL(baseURL).origin },
    data: { key: password },
  });
  expect(response.status(), 'login must succeed').toBe(204);
  const cookieHeader = response.headers()['set-cookie'];
  expect(cookieHeader, 'signed session cookie').toContain('notes_session=');
  return cookieHeader.split(';')[0];
}

async function call(request, baseURL, path, { method = 'GET', data, cookie } = {}) {
  return request.fetch(`${baseURL}${path}`, {
    method,
    ...(data !== undefined ? { data } : {}),
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== 'GET' ? { Origin: new URL(baseURL).origin } : {}),
    },
  });
}

test('root redirects to phone app', async ({ request, baseURL }) => {
  const response = await request.get(`${baseURL}/`, { maxRedirects: 0 });
  expect(response.status()).toBe(302);
  expect(response.headers().location).toMatch(/\/app$/);
});

test('health endpoint', async ({ request, baseURL }) => {
  const response = await request.get(`${baseURL}/health`);
  expect(response.status()).toBe(200);
  expect(await response.text()).toBe('ok');
});

test('unauthenticated API is private', async ({ request, baseURL }) => {
  const response = await call(request, baseURL, '/app/api/notes');
  expect(response.status()).toBe(401);
});

test('wrong-origin mutation is rejected', async ({ request, baseURL }) => {
  const response = await request.post(`${baseURL}/app/login`, {
    headers: { Origin: 'https://evil.example' }, data: { key: 'test-only' },
  });
  expect(response.status()).toBe(403);
});

test('lock screen shows one sign-in method: the password until notes are set up', async ({ page }) => {
  // Unauthenticated smoke runs have no notes repository, so the password is the only method offered.
  test.skip(Boolean(password), 'Notes are configured on the authenticated test Worker');
  await page.goto('/app');
  await expect(page.getByText('Enter the password you chose when you set up the app.')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toHaveCount(0);
});

test('GitHub sign-in is refused until notes are set up (unauthenticated smoke)', async ({ request, baseURL }) => {
  // Only valid while the test Worker has no notes repository configured; authenticated runs skip this.
  test.skip(Boolean(password), 'Notes are configured on the authenticated test Worker');
  const response = await request.post(`${baseURL}/app/login/github/start`, {
    headers: { Origin: new URL(baseURL).origin },
  });
  expect(response.status()).toBe(409);
  expect((await response.json()).error).toMatch(/password/i);
});

test('mobile web app loads and manifest is available', async ({ page, request, baseURL }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/app');
  await expect(page).toHaveTitle(/Day book/i);
  await expect(page.locator('body')).toBeVisible();
  const manifest = await request.get(`${baseURL}/app/manifest.webmanifest`);
  expect(manifest.ok()).toBeTruthy();
  expect(manifest.headers()['content-type']).toContain('manifest');
  expect(errors).toEqual([]);
});

test('OAuth discovery advertises this server, not another installation', async ({ request, baseURL }) => {
  const response = await request.get(`${baseURL}/.well-known/oauth-protected-resource/mcp`);
  expect(response.ok()).toBeTruthy();
  const metadata = await response.json();
  expect(metadata.resource).toBe(`${new URL(baseURL).origin}/mcp`);
  expect(metadata.authorization_servers).toContain(new URL(baseURL).origin);
});

test('app login and read-only notes API', async ({ request, baseURL }) => {
  test.skip(!password, 'Set NOTES_TEST_PASSWORD to run this test');
  const cookie = await login(request, baseURL);
  const config = await call(request, baseURL, '/app/api/config', { cookie });
  expect(config.ok()).toBeTruthy();
  const settings = await config.json();
  expect(typeof settings.configured).toBe('boolean');
  test.skip(!settings.configured, 'Complete first-run GitHub setup first');
  const notes = await call(request, baseURL, '/app/api/notes', { cookie });
  expect(notes.ok()).toBeTruthy();
  expect(Array.isArray(await notes.json())).toBeTruthy();
});

test('create, update, search, read, delete note (isolated test account only)', async ({ request, baseURL }) => {
  test.skip(!writesEnabled, 'Set NOTES_ALLOW_WRITES=1 ONLY against a dedicated test repo');
  const cookie = await login(request, baseURL);
  const marker = `pw-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let name;
  try {
    const create = await call(request, baseURL, '/app/api/note', {
      method: 'POST', cookie, data: { content: `# ${marker}\n\ninitial content`, category: 'inbox' },
    });
    expect(create.ok()).toBeTruthy();
    name = (await create.json()).name;
    expect(name).toMatch(/^inbox\/.+\.md$/);
    const encoded = encodeURIComponent(name);
    const read = await call(request, baseURL, `/app/api/note?name=${encoded}`, { cookie });
    expect(read.ok()).toBeTruthy();
    expect((await read.json()).content).toContain('initial content');
    const update = await call(request, baseURL, '/app/api/note', {
      method: 'PUT', cookie, data: { name, content: `# ${marker}\n\nupdated content` },
    });
    expect(update.ok()).toBeTruthy();
    const search = await call(request, baseURL, `/app/api/search?q=${encodeURIComponent(marker)}`, { cookie });
    expect(search.ok()).toBeTruthy();
    expect(await search.json()).toContain(name);
    const reread = await call(request, baseURL, `/app/api/note?name=${encoded}`, { cookie });
    expect((await reread.json()).content).toContain('updated content');
  } finally {
    if (name) {
      const deleted = await call(request, baseURL, `/app/api/note?name=${encodeURIComponent(name)}`, { method: 'DELETE', cookie });
      expect(deleted.ok(), 'test note must be cleaned up').toBeTruthy();
    }
  }
});
