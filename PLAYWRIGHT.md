# Replayable browser acceptance tests

The browser suite is read-only by default. It tests desktop Chromium, iPhone WebKit, and Android Chromium, plus API privacy, origin protection, OAuth discovery, and the web app manifest.

## Run locally against an existing test installation

```bash
npm ci
npx playwright install chromium webkit
NOTES_BASE_URL=https://YOUR-TEST-WORKER.workers.dev npm run test:e2e
```

Optional read-only authenticated check:

```bash
NOTES_BASE_URL=https://YOUR-TEST-WORKER.workers.dev NOTES_TEST_PASSWORD=your-password npm run test:e2e
```

**Do not run write tests against a personal notes repository.** Create a dedicated test Worker and test-only private GitHub repository first:

```bash
NOTES_BASE_URL=https://YOUR-TEST-WORKER.workers.dev \
NOTES_TEST_PASSWORD=your-password NOTES_ALLOW_WRITES=1 npm run test:e2e
```

## Replay/debug

```bash
npm run test:e2e -- --last-failed --headed
npx playwright show-report
npm run test:e2e -- --trace on
```

GitHub Actions runs unauthenticated smoke tests against a local Wrangler Worker for every PR and `main` push. `workflow_dispatch` accepts a test Worker URL. Authenticated and destructive tests are intentionally skipped unless explicitly enabled, and credentials are never embedded in the workflow. Failed runs retain traces/screenshots/video as artifacts.

## Limits

This is browser and HTTP smoke coverage, not an end-to-end proof of OAuth token exchange or MCP `tools/call`. Those need a separate synthetic MCP client, ideally using a disposable deployed Worker with GitHub OAuth/test accounts.
