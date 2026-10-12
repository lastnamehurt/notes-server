# Daybook: owner setup checklist

As of 2026-10-12. Everything from the October 11–12 changes (PRs #51 to #62) is merged and deployed. What's left is setup only the owner can do: a Cloudflare secret, an iPhone Shortcut, a few taps in Settings, and some decisions. Work top to bottom; the Apple Reminders section is the longest, about 20 minutes.

Tick items off here (edit the file) or in your own copy.

## 1. Check the site (2 minutes)

- [ ] Open Daybook on your phone and pull to refresh. If any screen is blank, close the tab and reopen it so the old cached page is dropped.
- [ ] On **Today**, check the timeline: dots sit on the line with space before each title.
- [ ] Open **Settings** and confirm there's a **Daily briefings** section below System diagnostics.

## 2. Set up Apple Reminders two-way sync (about 20 minutes)

The server side shipped in #58; nothing syncs until your phone has the Shortcut. Full steps: [apple-reminders-shortcuts.md](apple-reminders-shortcuts.md).

- [ ] **Cloudflare secret.** Workers & Pages → your Worker → Settings → Variables and Secrets. Check for an encrypted secret named `SHORTCUTS_TOKEN`; it may already exist from the one-way feed (#57). If not, add one with at least 32 random characters (on a Mac: `openssl rand -hex 24`). Don't reuse your Daybook password.
- [ ] **Reminders list.** In the Reminders app, create a list named exactly **Daybook**.
- [ ] **Remove the old Shortcut.** If you built "Sync Daybook Tasks" from the earlier one-way guide, delete it and its automation. It identifies tasks differently and would create duplicates.
- [ ] **Build the Shortcut.** Create **Sync Daybook** following the guide: read the list, send it to `/app/shortcuts/sync` with the secret, then apply the actions that come back. Action names vary by iOS version; search for the bolded word if one doesn't match.
- [ ] **Run it twice.** The first run creates your dated and prioritized tasks in the list. The second run's summary should show `created: 0, updated: 0`.
- [ ] **Test both directions.** Check a reminder off, run the Shortcut, and confirm the task is ticked in Daybook and logged as done. Then add a reminder in the list, run it, and find it in your inbox's Reminders note.
- [ ] **Automate it.** Shortcuts → Automation: one for "Reminders is closed" and two or three at fixed times of day, all set to Run Immediately.
- [ ] **Keep Pushover on** until it has run cleanly for a week or so. Until you decide, dated tasks will alert from both Pushover and Reminders.

Expect task lines in Daybook to gain short IDs like `^t7k2q` on the first sync. Leave them in place: they link each task to its reminder.

## 3. Turn on daily briefings (3 minutes)

Briefings shipped in #62 and are off by default.

- [ ] Settings → **Daily briefings**: switch on the morning briefing, the evening wrap-up, or both, and set their times.
- [ ] Choose what shows on the lock screen: task names, or counts only if others can see your phone.
- [ ] Tap **Save briefings**, then **Preview** to see today's digest without sending it.
- [ ] Tap **Send test** and confirm the notification arrives and opens Today when tapped. Tests are limited to one a minute.

You can also ask Claude: "turn on my morning briefing at 7:30".

## 4. Backfill your journal and refresh Claude (5 minutes)

Since #59, new log entries also appear in your daily journal notes, but older days don't until you backfill them.

- [ ] Logs → **Backfill journal history**: tap Preview, check the days listed, then confirm. It does 10 days per run, so repeat until the preview shows nothing left. Existing reflections are kept.
- [ ] In Claude, start a new chat and ask "what's on today?". It should use the new briefing tool. If Claude doesn't find it, disconnect and reconnect the Daybook connector so it picks up the two new tools (`prepare_briefing`, `configure_briefings`).

## 5. Decide and tidy up

None of these block anything; each needs a yes or no.

- [ ] **Pushover vs Apple Reminders for task alerts.** After the sync has run cleanly for a while, decide whether to keep both alerting. Briefings stay on Pushover either way.
- [ ] **Daylight-saving bug.** A reminder set between 2am and 3am on the spring-forward day fires an hour early. Next occurrence: March 14, 2027. Fix it?
- [ ] **Journal timing for synced completions.** Tasks completed in Apple Reminders reach the daily journal only when the next log entry that day is written. Make it immediate?
- [ ] **PR #15** (Gemini and Cursor docs) is still open with checks passing: merge or close it.
- [ ] **Old branches.** Seven branches predate these changes and aren't in main: `chore/port-qa-scripts`, `chore/qa-configurable-paths`, `ci/deploy-on-main`, `docs/ai-assistants-gemini-cursor`, `docs/mobile-quickstart-v2`, `feat/connect-assistant`, `feat/github-web-login`. Delete any that were squash-merged or abandoned.
- [ ] **Other people's copies.** Anyone running their own notes-server gets these changes when they redeploy. Everything new is opt-in, so there's nothing to set up unless they want Apple sync or briefings.

## Reference: what changed

Newest first.

| Change | What it does | Needs you |
| --- | --- | --- |
| #62 | Morning and evening briefings; Claude tools to narrate and configure them | Section 3 |
| #61 | Original AI scheduling spec (rewritten in #62) | No |
| #60 | Logs → Backfill journal history | Section 4 |
| #59 | New log entries also update the daily journal | Covered by #60 |
| Direct to main | Today timeline spacing fixed | No |
| #58 | Two-way Apple Reminders sync; task IDs | Section 2 |
| Direct to main | CI checks the app's page script for syntax errors | No |
| Direct to main | Fixed the blank page (a stray `\n` in the app script) | No |
| #57 | Read-only Shortcuts task feed (same secret as #58) | Section 2 |
| #56 | Managed setup shows as complete; "done" is no longer a log type | No |
| #55 | Reminders work on tasks with a priority tag | No |
| #51 to #54 | Today screen: new layout, overdue and due-today focus, 24-hour times | No |
