# Isolated Daybook browser testing

Never use the personal-notes-mcp production Worker or your personal GitHub notes repository for tests.

## Provision (one time)

1. Create a **private**, disposable GitHub repository for test notes, e.g. `daybook-e2e-notes`, and a fine-grained token restricted to that repository's contents. Do not use the production notes repository.
2. Create a **new** Cloudflare Workers KV namespace for E2E OAuth and replace `REPLACE_WITH_DEDICATED_E2E_KV_ID` in `wrangler.e2e.jsonc` with its namespace ID. Never reuse production OAUTH_KV.
3. Run `npx wrangler deploy --config wrangler.e2e.jsonc`. This deploys a separate Worker named `daybook-e2e`, with its own Durable Object namespace. Do not copy production secrets.
4. Configure the new Worker with a unique E2E-only PASSWORD, a GitHub token for the disposable repo, NOTES_REPO pointing to the disposable repo, and PUBLIC_URL pointing to the new Worker URL. Complete its setup page independently.
5. Run `npx playwright install --with-deps` once on the test runner.
6. Set `NOTES_BASE_URL=https://daybook-e2e.<your-subdomain>.workers.dev` and `NOTES_E2E_PASSWORD=<staging-password>` in the runner's secret environment, then run `bash scripts/e2e-staging.sh`.

Tests create notes and tasks. Reset the disposable repository between runs as needed. Never commit tokens/passwords, and do not make the disposable repository public. The staging Worker should not send real push notifications.
