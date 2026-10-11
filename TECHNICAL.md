# Notes server: technical notes

This Cloudflare Worker provides ten MCP tools backed by GitHub's Contents API. It does not require a filesystem or Git executable. The existing Python CLI and local MCP server remain unchanged.

## Authentication

`/mcp` is protected by OAuth 2.1 (Cloudflare's `workers-oauth-provider`, client ID metadata documents). When Claude connects, the Worker's `/authorize` page asks for the owner's password (`MCP_BEARER_TOKEN`) and issues a token. OAuth discovery metadata is built from the Worker's own URL. The phone app at `/app` uses the same password and a signed session cookie.

## Set up

**To install your own copy, follow [README.md](README.md).** The Deploy to Cloudflare form asks only for `PASSWORD` (the owner's password; the server treats it as `MCP_BEARER_TOKEN` when that isn't set). `/` redirects to `/app`. Everything else is chosen in the app's setup page at `/app`, which checks the GitHub key, refuses public repositories, initialises an empty repository with a README, and generates an ntfy topic. Those choices are stored in the `global` Durable Object (`src/settings.ts`), so they stay in the owner's Cloudflare account.

Settings set on the deployment (secrets or variables) always take priority over setup-page settings, and when the deployment names `GITHUB_TOKEN` and `NOTES_REPO` the setup page is disabled. A terminal install is still possible: `npm install && npm run setup` stores everything as secrets.

Wrong passwords on `/app` and the Claude sign-in page share a limit of 10 per 15 minutes.

Nothing owner-specific is in this repository, so one copy of the code serves any number of owners, each with their own Cloudflare account and private notes repository:

| Setting | Where | Notes |
|---|---|---|
| `NOTES_REPO` | setup page, secret or dashboard variable | `owner/repo` of the private notes repository (must have a `main` branch) |
| `GITHUB_TOKEN` | setup page or secret | fine-grained token, that repository only, Contents read/write |
| `MCP_BEARER_TOKEN` | secret | the owner's password for the connector sign-in page and `/app` |
| `NOTES_TIMEZONE` | setup page, secret or variable | IANA zone; default `America/Los_Angeles` |
| `NOTES_BRANCH` | variable | default `main` |
| `PUBLIC_URL` | variable | optional; defaults to the host requests arrive on. Set it if the Worker has more than one hostname |
| `PUSHOVER_USER`, `PUSHOVER_TOKEN` / `NTFY_TOPIC` | secret | phone notifications, see below |

`wrangler.jsonc` sets `keep_vars: true`, so variables added in the dashboard survive deploys, and the `OAUTH_KV` namespace has no id: Wrangler reuses the namespace already bound to a deployed Worker, or creates one on a first deploy. OAuth discovery metadata and reminder Done links are built from the Worker's own origin.

## Phone reminders

Any unchecked task line with an `@date` in a note becomes a push notification:

```markdown
- [ ] Renew car registration @2026-10-14 9am
- [ ] Call the shop @2026-10-14 5:30pm
- [ ] Pay invoice @2026-10-16            (no time = 9am)
- [ ] Take meds @daily 8am, 8pm          (repeating)
- [ ] Stretch @weekdays 7am              (also @weekends, @mon,wed,fri)
```

Times are in `NOTES_TIMEZONE` (default `America/Los_Angeles`) and may be listed with commas. Checking the box (`[x]`), deleting the line, or deleting the note stops the reminder; one-off times already past are ignored, so editing an old note never re-fires it. Repeating reminders reschedule themselves after each notification.

Each notification has a **Done** button. It POSTs to `/done` with a link signed by `MCP_BEARER_TOKEN` (HMAC), and the Worker records `✓ <text> #done` in that day's log. Rotating `MCP_BEARER_TOKEN` invalidates buttons on notifications already sent.

How it works: `save_note`/`update_note` parse the note and store upcoming reminders in a single `ReminderScheduler` Durable Object, which sets an alarm for the next one and posts it to [Pushover](https://pushover.net) or [ntfy](https://ntfy.sh) when it fires (failed sends retry every 5 minutes; `list_reminders` reports the last failure). An hourly cron rescans the whole notes repository so edits made outside the Worker (the Python CLI, GitHub's web editor) are picked up; `sync_notes` does the same rescan on demand. `list_reminders` shows what's scheduled. The server's MCP instructions tell Claude the syntax and to offer saving action items as reminders.

Setup:

**Pushover (recommended):** install Pushover on your phone ($4.99 one-time per platform after a 30-day trial), copy your User Key from pushover.net, create an Application to get an API token, then:

```
npx wrangler secret put PUSHOVER_USER
npx wrangler secret put PUSHOVER_TOKEN
```

Notifications carry a "Mark done" link that opens a confirm page and logs the item. Pushover is used whenever both secrets are set.

**ntfy (fallback):** subscribe the ntfy app to a long, unguessable topic and `npx wrangler secret put NTFY_TOPIC`. Optional: `NTFY_SERVER` (self-hosted) and `NTFY_TOKEN`. Note that anonymous publishing to ntfy.sh from Cloudflare shares a per-IP daily quota and can fail with 429.

Then call `sync_notes` once to schedule reminders already in your notes.

## Logs and goals

- `log` appends a timestamped line to `journal/log/YYYY-MM-DD.md` (one note per day, lines kept in time order), e.g. `- 12:40 burrito and a beer #food #drink`. Optional `date` and `time` backfill earlier items. `get_logs` returns the last N days.
- The `goals` category holds one note per goal (why, measure, target date, next steps as reminder lines, progress entries).
- The MCP server instructions tell Claude the formats and to log food, drinks, medication, exercise, sleep and mood when they come up, offer reminders for action items, and use goals plus logs for check-ins.
- Daily logs are skipped by the reminder rescan. `search_notes` still reads every note and stops at 300, which logs will reach in under a year; an index is the next step there.

## Web app

Open `https://<worker>/app` on your phone and unlock it with your `MCP_BEARER_TOKEN` (the same key the connector's sign-in page asks for). In Safari, Share then Add to Home Screen makes it an app icon.

- **Today**: a time rail of today's log with a line for the current time, today's reminders below it with a Done button, and a box at the bottom for logging, with tag chips.
- **Notes**: notes grouped by folder, search, new note, and an editor with a Read view where you can tick checkboxes (ticking a reminder stops it) and an Edit view for the Markdown.
- **Goals**: each goal note with its target date, a step meter and the next open step.
- **Reminders**: everything scheduled, grouped by day.

The session is an HMAC-signed, HttpOnly, `SameSite=Strict` cookie (30 days) scoped to `/app`; writes also require a same-origin `Origin` header. Rotating `MCP_BEARER_TOKEN` signs everyone out. The page is a single file, `src/app.html`, served with a strict Content-Security-Policy.

`GITHUB_API_URL` exists only so the Worker can be run locally against a fake GitHub; leave it unset in production.

## Security

Never deploy without both secrets. Protect the bearer token like a password. For broad AI client support and delegated access, implement OAuth before connecting ChatGPT. The Python secret scanner is not shared with this adapter; both implementations perform only basic checks. For more reliable secret protection, add GitHub push protection and robust content validation.

## Notes

- GitHub API updates are atomic and use blob SHAs for optimistic concurrency.
- `sync_notes` rescans notes to rebuild reminders; changes are committed directly to GitHub, and local clients still run `note sync`.
- Search reads up to 300 Markdown files and can be slow; an index is recommended for larger stores.
- No deployment was performed by this PR. Deployment requires your Cloudflare account authentication and GitHub token.
