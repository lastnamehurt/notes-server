# Notes server: technical notes

This Cloudflare Worker provides eleven MCP tools backed by GitHub's Contents API. It does not require a filesystem or Git executable. This repository also ships the Bash `note` / `notes` CLI and its Python browsing/local MCP backend; see [CLI.md](CLI.md). The CLI works with a local clone of the same private notes repository.

## Authentication

`/mcp` is protected by OAuth 2.1 (Cloudflare's `workers-oauth-provider`, client ID metadata documents). When Claude connects, the Worker's `/authorize` page asks for the owner's password (`MCP_BEARER_TOKEN`) and issues a token. OAuth discovery metadata is built from the Worker's own URL. The phone app at `/app` uses the same password and a signed session cookie.

## Set up

**To install your own copy, follow [README.md](README.md).** The Deploy to Cloudflare form asks only for `PASSWORD` (the owner's password; the server treats it as `MCP_BEARER_TOKEN` when that isn't set). `/` redirects to `/app`. Everything else is chosen in the app's setup page at `/app`. **Connect GitHub** uses GitHub's OAuth device flow: the person enters a short code at github.com/login/device, and the token (scope `repo`) goes from GitHub straight to their own Worker, never to the OAuth app's owner. Device flow needs only the public client ID (`DEFAULT_GITHUB_CLIENT_ID` in `src/setup.ts`, overridable with `GITHUB_CLIENT_ID`), so every copy of the server can share one registered app; deleting that app would revoke everyone's tokens. After connecting, the server uses a private `notes` repository, or creates one (`my-notes` if `notes` is public). A fine-grained access key can be pasted instead. Either way the setup page refuses public repositories, initialises an empty repository with a README, and generates an ntfy topic. Those choices are stored in the `global` Durable Object (`src/settings.ts`), so they stay in the owner's Cloudflare account.

Settings set on the deployment (secrets or variables) always take priority over setup-page settings, and when the deployment names `GITHUB_TOKEN` and `NOTES_REPO` the setup page is disabled. A terminal install is still possible: `npm install && npm run setup` stores everything as secrets.

Wrong passwords on `/app` and the Claude sign-in page share a limit of 10 per 15 minutes.

Nothing owner-specific is in this repository, so one copy of the code serves any number of owners, each with their own Cloudflare account and private notes repository:

| Setting | Where | Notes |
|---|---|---|
| `NOTES_REPO` | setup page, secret or dashboard variable | `owner/repo` of the private notes repository (must have a `main` branch) |
| `GITHUB_TOKEN` | setup page or secret | fine-grained token, that repository only, Contents read/write |
| `MCP_BEARER_TOKEN` | secret | the owner's password for the connector sign-in page, and the `/app` password fallback |
| `NOTES_TIMEZONE` | setup page, secret or variable | IANA zone; default `America/Los_Angeles` |
| `NOTES_BRANCH` | variable | default `main` |
| `PUBLIC_URL` | variable | optional; defaults to the host requests arrive on. Set it if the Worker has more than one hostname |
| `PUSHOVER_USER`, `PUSHOVER_TOKEN` / `NTFY_TOPIC` | secret | deprecated phone notifications (still delivered when no device has notifications on), see below |

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

How it works: `save_note`/`update_note` parse the note and store upcoming reminders in a single `ReminderScheduler` Durable Object, which sets an alarm for the next one and sends it when it fires (failed sends retry every 5 minutes; `list_reminders` reports the last failure). An hourly cron rescans the whole notes repository so edits made outside the Worker (the local CLI, GitHub's web editor) are picked up; `sync_notes` does the same rescan on demand. `list_reminders` shows what's scheduled. The server's MCP instructions tell Claude the syntax and to offer saving action items as reminders.

**Notifications (web push).** Each phone or computer turns them on in **Settings → Turn on notifications**. The app registers its service worker (`/app/sw.js`, scope `/app`), subscribes with the browser's push service using the app's own VAPID key, and stores the subscription in the `ReminderScheduler` (`webpush` key, separate from settings so saving settings never drops a device). Reminders, briefings and the weekly review are sent from the Worker to each device's push service, encrypted per RFC 8291 (aes128gcm) and signed per RFC 8292 (VAPID); `src/web-push.ts` does this with WebCrypto only. Expired subscriptions (404/410) are forgotten automatically. On iPhone this needs iOS 16.4+ and the Home Screen app. Android, desktop Chrome/Edge/Firefox and Safari on a Mac work in the browser. Where the device shows notification buttons (Android, desktop) there's a **Done** button; tapping a notification opens Today.

**Apple Reminders.** Tasks synced to Apple Reminders by the Shortcut ([docs/apple-reminders-shortcuts.md](docs/apple-reminders-shortcuts.md)) are alerted by Reminders, not by push, while the last sync is under 36 hours old. Settings → Shortcuts holds every Shortcut's address and the one secret they share (hidden until Show or Copy; `GET /app/api/shortcuts/secret` returns it to the signed-in owner, including a `SHORTCUTS_TOKEN` set on the deployment, which Settings can't replace). Settings → Apple Reminders shows the last sync and switches to getting both alerts.

**ntfy and Pushover (deprecated).** No longer offered in setup. Existing setups keep working: they're used only when no device has notifications on, so nobody gets everything twice after switching. Settings shows them under an "older option" with a box to stop using them. Configured as before with `NTFY_TOPIC` (optional `NTFY_SERVER`, `NTFY_TOKEN`) or `PUSHOVER_USER` + `PUSHOVER_TOKEN`.

Then call `sync_notes` once to schedule reminders already in your notes.

## Logs and goals

- `log` appends a timestamped line to `journal/log/YYYY-MM-DD.md` (one note per day, lines kept in time order), e.g. `- 12:40 burrito and a beer #food #drink`. Optional `date` and `time` backfill earlier items. `get_logs` returns the last N days.
- The `goals` category holds one note per goal (why, measure, target date, next steps as reminder lines, progress entries).
- The MCP server instructions tell Claude the formats and to log food, drinks, medication, exercise, sleep and mood when they come up, offer reminders for action items, and use goals plus logs for check-ins.
- Daily logs are skipped by the reminder rescan. Search, logs and goals read the repository as one archive, so they have no note-count limit.

## Web app

Open `https://<worker>/app` on your phone. The lock screen offers one sign-in method: the password (`MCP_BEARER_TOKEN`) until notes are set up, then GitHub, using the account that owns the notes. `GET /app/login/info` reports which one applies. The password still works on `/app` as a fallback. In Safari, Share then Add to Home Screen makes it an app icon.

- **Today**: a time rail of today's log with a line for the current time. Reminders due today sit on the same rail; ones that already went off stay as "Due" until you tap Done. Tap any log entry to change its text or time, or delete it. The box at the bottom logs with tag chips, and "Now" can be changed to log something from earlier.
- **Navigation**: three tabs (Today, Tasks, Notes) and a Settings gear. Goals sit under Tasks; Journal and Logs under Notes; Suggestions (Awareness) is linked from Today. Each section shows a small switcher for its pages.
- **Notes**: notes grouped by folder, search, and new note. A note opens in a read view: tap it (or Edit) to change the title and text, tap a checkbox or its text to tick it, and use Add reminder for timed items. Leaving with unsaved changes asks first.
- **Goals**: each goal with its target date, a step meter and the next step, which you can tick from the list. New goal is a short form (goal, why, measure, target date, first step); a goal's page has Add update for dated progress notes.
- **Reminders**: everything scheduled, grouped by day, with Done and New reminder (once, or repeating on chosen days).
- **Setup** (only when the deployment doesn't set the notes repository): notes repository, access key, time zone and phone notifications.

**Done** means the same everywhere (the app, the notification button, or Claude's `complete_reminder` tool): it logs `✓ <text> #done`, stops that occurrence from notifying, and ticks a one-off's box in its note. Each occurrence is tracked separately, so finishing an 8am item doesn't affect the 8pm one with the same text. With no push provider configured, reminders still go off in the app; there's just no push.

The session is an HMAC-signed, HttpOnly, `SameSite=Strict` cookie (30 days) scoped to `/app`; writes also require a same-origin `Origin` header. Rotating `MCP_BEARER_TOKEN` signs everyone out. The page is a single file, `src/app.html`, served with a strict Content-Security-Policy.

`GITHUB_API_URL` exists only so the Worker can be run locally against a fake GitHub; leave it unset in production.

## Security

Never deploy without both secrets. Protect the bearer token like a password. Claude connects over OAuth 2.1 (see the authentication section above). ChatGPT and other clients have not been tested against this server. The Python secret scanner is not shared with this adapter; both implementations perform only basic checks. For more reliable secret protection, add GitHub push protection and robust content validation.

## Notes

- GitHub API updates are atomic and use blob SHAs for optimistic concurrency.
- `sync_notes` rescans notes to rebuild reminders; changes are committed directly to GitHub, and local clients still run `note sync`.
- Search, the reminder rescan, log views and goals read the whole repository as one gzipped archive (`src/snapshot.ts`): one GitHub call plus a redirect, whatever the number of notes. That keeps every request well under Cloudflare's limit of 50 outside calls per request on the free plan. Repositories over 50 MB are refused.

## Deploying

- A push to `main` deploys automatically. The `Checks` workflow runs typecheck, unit tests, a dry-run deploy and the MCP acceptance test; if they pass, its `deploy` job runs `wrangler deploy` for the `personal-notes-mcp` Worker. Pull requests never deploy.
- The job needs two repository secrets: `CLOUDFLARE_API_TOKEN` (a token with Workers Scripts: Edit and Workers KV Storage: Edit on the account) and `CLOUDFLARE_ACCOUNT_ID`. If the token expires or is revoked, the deploy job fails and the last deployed version keeps serving. Create a new token in Cloudflare and replace the secret.
- Deploys run one at a time (the `deploy-production` concurrency group), so two merges never deploy together.
- `keep_vars` keeps dashboard variables and secrets through a deploy, and the migration in `wrangler.jsonc` applies on the next deploy.
- Don't connect Cloudflare Workers Builds to this Worker. A second deploy source can overwrite it with older code. Check the Worker's **Settings → Builds** in the dashboard.

## Tests

- `npm test`: unit tests (reminder parsing, logs, signed links, setup, archive reading at 600+ notes).
- `npm run test:mcp`: MCP acceptance test. Starts the Worker with `wrangler dev` against a stand-in GitHub and does what Claude does: OAuth discovery, client registration, password sign-in with PKCE, token exchange and refresh, `initialize`, `tools/list`, then save, read, update, search, list, log and delete a note, plus search, logs and rescan over 800 notes with one GitHub call each. Claude registers via a client metadata document rather than dynamic registration; `ALLOW_CLIENT_REGISTRATION=true` turns registration on for this test only. Both run in CI.

## Where notes are stored

New installs keep notes in the app's own storage: `NotesStore`, a SQLite-backed Durable Object (`src/app-notes.ts`, binding `NOTES`). `AppNotes` has the same interface and error messages as `GithubNotes`, and `notesFor(env)` (`src/storage.ts`) picks one from `NOTES_STORAGE`, which comes from the setup page's choice. A version number stands in for a commit, so Apple Reminders sync gets the same consistent read-then-write as on GitHub.

- A deployment that sets `GITHUB_TOKEN` and `NOTES_REPO` always uses GitHub; the setup page's storage choice is ignored.
- Installs set up with GitHub before storage choices existed have no `storage` setting and stay on GitHub.
- **Download all my notes** (`GET /app/api/export`) returns a zip of every note from either storage (`src/zip.ts`).
- **Move my notes to GitHub** copies every note into a new private `daybook-notes` repository as one commit, checks they all arrived, then switches storage. The copy in app storage is left in place.
- The `note` CLI and Obsidian-style editing need GitHub storage.

`npm run test:app-storage` covers setup with no GitHub, every MCP note tool on app storage, 200+ notes, the zip, and the move.

## Installer

`installer/` is a separate Worker (`daybook-installer`) that sets up Daybook in someone's own Cloudflare account with an API token they create from a pre-filled link (Workers Scripts edit, Workers KV edit, Account Settings read). No GitHub, terminal or Wrangler is involved. The logic lives in `src/cloudflare-deploy.ts` and is shared with the app:

- **Install** (`POST /api/install`): picks or creates the account's workers.dev subdomain, creates the `daybook-oauth` KV namespace, uploads the app (multipart, with the Durable Object bindings and every storage migration from `wrangler.jsonc`), turns on the workers.dev address and sets the hourly cron. The password is stored as the `PASSWORD` secret. The token is stored only in the person's own app, as the `CF_API_TOKEN` secret, along with `CF_ACCOUNT_ID`, `DAYBOOK_SCRIPT` and `DAYBOOK_INSTALLER`.
- **Update now** in an installer-made app downloads `/bundle/manifest.json` and the modules from the installer, then re-uploads itself with `keep_bindings` (secrets, variables, KV), applying only the storage migrations after its current tag.
- **Update it** (`POST /api/update`): for an app that's already installed (for example, after its key was deleted). It updates the app and gives it the new key.
- The installer never stores or logs tokens. CI builds the bundle (`npm run build:bundle`) and deploys the installer right after the app, so both always carry the same version.

Tests: `test/cloudflare-deploy.test.ts` (against a stand-in Cloudflare API), `npm run test:installer` (browser walk-through, plus the app updating itself), and the **Installer live test** workflow, which installs, uses, self-updates and removes a throwaway app in the real account.
