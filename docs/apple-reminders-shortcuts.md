# Apple Reminders integration (iPhone Shortcuts)

This integration is **opt-in**. The Worker never connects to iCloud, and your notes stay in your private GitHub repository.

## 1. Configure the read-only feed

In Cloudflare Workers > your Daybook Worker > Settings > Variables and Secrets, add an **encrypted secret** named `SHORTCUTS_TOKEN` containing a randomly generated value of at least 32 characters. Do not reuse your Daybook login password or GitHub token.

The endpoint is:

```
GET https://personal-notes-mcp.clhurt1.workers.dev/app/shortcuts/tasks
Authorization: Bearer YOUR_SHORTCUTS_TOKEN
```

Response: `{ "version":1, "timezone":"America/Los_Angeles", "tasks":[{"id":"inbox/example.md:2","title":"Call airline","priority":"do","dueAt":"2026-10-15T06:00:00.000Z","repeating":false,"sourceNote":"inbox/example.md"}] }`.

The feed is read-only and lists **open** Markdown checkboxes. `dueAt` is null if there is no one-off date. Recurring schedules are flagged `repeating: true` but do not yet map to native repeat rules.

## 2. Build the iPhone Shortcut

1. Open **Shortcuts** on your iPhone and create a shortcut called **Sync Daybook Tasks**.
2. Add **URL** with the endpoint above, then **Get Contents of URL**. Set Method **GET** and add the header `Authorization` = `Bearer <your secret>`.
3. Add **Get Dictionary from Input** and **Get Dictionary Value** for key `tasks`.
4. Add **Find Reminders** with filter List is **Daybook**. Create the **Daybook** list in Apple Reminders first.
5. For each task in the feed, compare its `id` to the ID marker in the Notes field of existing Daybook reminders (format `daybook-id:<id>`). If found, skip creation. If not found, use **Add New Reminder** with title, list Daybook, Notes containing that marker, and the `dueAt` date when present.
6. Test by running the shortcut twice. The second run should not create duplicates. Check that the displayed reminder time is correct in your time zone.

**Important:** Shortcuts action names and available filters vary by iOS release. If a Notes-field filter is unavailable, iterate through the found reminders and compare the Notes field. Do not use title-only deduplication: different tasks may have identical titles.

## 3. Automate and limitations

In Shortcuts > Automation, create a personal automation to run **Sync Daybook Tasks** at a chosen time of day. Configure it to run without asking if available. This is **scheduled polling**, not immediate sync.

Current limitations:
- The ID is based on note path and line number; inserting or moving Markdown lines changes it. A durable task identifier is needed before this can safely be considered production-grade.
- No update, deletion, or completion reconciliation is implemented; only new reminders are created.
- The Shortcut is not packaged as an importable signed iCloud Shortcut. These steps must be configured on your iPhone.
- Recurring Daybook reminders need a separate mapping to Apple Reminders repeat rules.
- Do not turn off ntfy until task delivery, deduplication, and edits are verified.

## Privacy

The Shortcut stores its read-only token locally in its actions. Anyone with that token can read task titles, priorities and due dates. Keep it private, and rotate it in Cloudflare if exposed.
