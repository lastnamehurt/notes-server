# Apple Reminders ↔ Daybook: two-way sync

**Status:** Phase 1 is built: a two-way sync driven by an iPhone Shortcut, with no native app, no Apple developer account and no new paid services. Setup steps are in [apple-reminders-shortcuts.md](apple-reminders-shortcuts.md). Keep the existing push notifications (Pushover or ntfy) on until it has run cleanly on your phone for a while.

## Why

Apple Reminders adds what Daybook's own push notifications can't: checking tasks off from Apple Watch, Siri ("remind me to…"), the lock screen, and location-based reminders. Daybook stays the place notes and tasks live.

## Goals and scope

- Private GitHub Markdown stays the durable task store. The Worker stays the only GitHub writer.
- Two-way: create, edit title, reschedule, complete and reopen from **either** side.
- Only one dedicated Apple Reminders list (**Daybook**) is synced. Other lists are never read or changed.
- Costs nothing to run, and anyone who deploys their own notes-server copy can set it up with only the iPhone Shortcuts app.
- Not real time. Changes sync each time the Shortcut runs (see Triggers).

## Architecture: thin Shortcut, smart Worker

Shortcuts can read and change reminders but is painful for logic. So the Shortcut only **sends a snapshot and applies a list of actions**; all comparison and conflict handling happens in the Worker, where it can be tested.

One sync run:

1. The Shortcut finds every reminder in the Daybook list (open and completed) and posts a snapshot to `POST /app/shortcuts/sync`.
2. The Worker does a three-way compare per task: Daybook now, Apple now, and the **base** (the state both sides agreed on after the last run).
3. The Worker writes every Daybook change from the run (new IDs, Apple-side edits, new tasks, log entries) as **one commit** on top of the commit it read, saves the new base, and returns an action list. If the notes changed in the meantime, GitHub refuses the commit and the run re-reads and re-plans (up to three times).
4. The Shortcut applies the actions: create, update, delete or tag.

Full snapshots instead of an incremental change feed are deliberate. A personal list is at most a few hundred tasks, and the Worker already reads all notes as one archive, so a full compare is cheap and can't drift.

### Snapshot (Shortcut → Worker)

```json
{ "version": 1, "runId": "uuid", "reminders": [
  { "index": 0, "taskId": "t7k2q", "title": "Call airline", "due": "2026-10-15T09:00:00-07:00",
    "allDay": false, "completed": false, "priority": "high" }
] }
```

`taskId` is read from the reminder's marker (below); it is null for reminders created in Apple Reminders that Daybook hasn't seen yet. `index` is the reminder's position in the Shortcut's list for this run, so the Worker can refer back to new reminders.

### Actions (Worker → Shortcut)

```json
{ "version": 1, "runId": "sync-1791790301", "actions": [
  { "op": "create", "taskId": "a91fz2", "url": "https://<worker>/app#task/a91fz2", "title": "Pay rent",
    "due": "2026-11-01", "allDay": true, "priority": "high", "completed": false },
  { "op": "update", "index": 0, "taskId": "t7k2q", "title": "Call airline about seats",
    "due": "2026-10-16T14:00:00-07:00", "allDay": false, "priority": "none", "completed": false },
  { "op": "delete", "index": 4, "taskId": "d2r5w" },
  { "op": "tag", "index": 3, "taskId": "e8h1k", "url": "https://<worker>/app#task/e8h1k" }
], "summary": { "reminders": 5, "created": 1, "updated": 1, "deleted": 1, "tagged": 1, "daybookChanges": 2, "conflicts": 0 } }
```

`index` points back into the list the Shortcut sent, so it never has to search. `update` always carries the reminder's full state (completing and reopening are just `completed`), which keeps the Shortcut to one code path. `tag` writes the marker onto a reminder that was created in Apple Reminders, so it matches on every later run.

## Identity

- Each synced task gets a short persistent ID at the end of its line: `- [ ] Call airline @2026-10-15 9am ^t7k2q`. This is the block-ID convention Obsidian uses: it survives moving lines or notes and doesn't change the title.
- **Every parser must strip the `^id` token first,** the same way `@priority:` is stripped today. Otherwise the reminder regex reads it as part of the time and silently drops the reminder.
- IDs are assigned lazily: the first sync adds IDs to open tasks that lack one, in a single commit that changes nothing else on those lines.
- The Apple side carries the ID in the reminder's **URL** field as `https://<worker>/app#task/t7k2q`, which also makes the reminder open the task in Daybook. If an iOS version can't set the URL from Shortcuts, fall back to a `daybook:t7k2q` line in the Notes field.
- Never match by title, date or line number. Two tasks can share a title.

## Base state

The Worker stores the last agreed state per task (title, due, completed, priority, note) in the existing reminder scheduler Durable Object, under `sync:` keys. It's strongly consistent, unlike KV, and costs nothing extra. The same object holds a two-minute lock so overlapping runs can't interleave, and remembers each `runId`'s response for a day so a retried request gets the same answer instead of applying twice. Losing the base is safe: the next run treats both sides as changed and Daybook wins, without duplicating anything.

## Merge rules

Per field, comparing each side against the base:

| Daybook | Apple | Result |
|---|---|---|
| unchanged | unchanged | nothing |
| changed | unchanged | push to Apple |
| unchanged | changed | write to Markdown |
| changed | changed, same value | nothing |
| changed | changed, different | **Daybook wins**; Apple's value is saved to that day's log as `#sync-conflict` so nothing is lost |

Lifecycle:

- **New in Daybook** (open, with a date, repeat schedule or priority) → gets an ID, then `create` in Apple.
- **New in Apple** (no marker) → new task appended to the `inbox` note, then `tag` it.
- **Completed in Apple** → runs the same path as `complete_reminder` (logs it, ticks a one-off's box).
- **Reopened on either side** → unchecks the other side.
- **Deleted in Daybook** → `delete` in Apple.
- **Deleted in Apple** → the Daybook task is **never** deleted. It stops syncing and gets a `#removed-in-reminders` log entry; changing it in Daybook sends it back. Clearing a reminder that is done on both sides is routine and isn't logged.
- **Repeating tasks** sync as their **current occurrence** only: the latest one that already went off and isn't done (so it shows as overdue), otherwise the next one. Older missed occurrences roll off. Completing it in Apple marks that occurrence done in the scheduler, and the same run moves the reminder to the following occurrence and reopens it. The repeat rule is never written from Apple; a new time set there is reset. No recurrence-rule mapping is needed.
- **Priority:** do ↔ high, plan ↔ medium, delegate and someday → low, none ↔ inbox. An Apple change to "low" keeps the existing Daybook value if it was already delegate or someday.
- **All-day vs timed:** a Daybook task with a date and no time is an all-day reminder, and the reverse. A date-only task and the same date at 9am count as equal, because some iOS versions can only store a reminder's date with a time. Times are interpreted in `NOTES_TIMEZONE`, so DST changes don't shift them.

Echo loops can't happen: after a run, the base equals both sides, so the next run sees no change.

## API and security

- `POST /app/shortcuts/sync`, authenticated with the existing separate `SHORTCUTS_TOKEN`, upgraded from read-only to read-write for the Daybook list only. It can never reach other notes, settings or the GitHub token.
- Each request carries a `runId`. Replaying the same `runId` returns the same actions without applying changes twice.
- Markdown writes go in one commit that only moves the branch if nothing else changed it (`force: false`); on conflict the run re-reads, never overwrites.
- If a run would delete more than half of the synced reminders (and more than five), it stops with an error instead. This protects the Apple list if the notes ever read back empty.
- Rotating `SHORTCUTS_TOKEN` in Cloudflare revokes the Shortcut immediately.
- Synced task titles and dates become subject to the user's iCloud settings and retention; say so in the setup guide.

## Triggers

Shortcuts personal automations, set to run without asking:

- **When the Reminders app is closed.** Checking something off and leaving the app syncs it within seconds.
- **A few fixed times a day** (for example 7am, noon, 6pm) to pick up Daybook-side changes.
- **Sync now:** a button in Daybook Settings and a home-screen icon, both opening `shortcuts://run-shortcut?name=Sync%20Daybook`.

Watch check-offs reach the phone through iCloud and sync on the next phone run.

## Known limits

- Not real time: Daybook-side edits reach Apple on the next trigger.
- Shortcuts' Reminders actions vary between iOS versions; the setup guide must name the tested version.
- A Shortcut can't be shipped as a signed, auto-updating app; each user builds or imports it once.
- Subtasks, flags, tags, images and location triggers in Apple Reminders are not synced back.

## Acceptance tests

1. 100+ Daybook tasks produce exactly one reminder each, including after running the Shortcut twice in a row.
2. Same-title tasks stay distinct. Moving a task between lines or notes keeps its reminder.
3. Create, retitle, reschedule, complete and reopen on **each** side reach the other side within one run, and a second run makes no changes.
4. Editing the same task on both sides between runs keeps Daybook's value and logs Apple's as `#sync-conflict`.
5. Deleting a reminder in Apple never deletes the Daybook task.
6. A repeating task's reminder moves to the next occurrence after being completed in Apple.
7. All-day and timed tasks keep their local time across a DST change.
8. A replayed `runId` changes nothing. A GitHub SHA conflict mid-run recovers without duplicates.
9. Reminders in other Apple lists are never read or changed.
10. Existing reminder notifications and MCP tools still parse every task line after IDs are added.

## Phases

- **Phase 1 (built):** task IDs and parser updates (`src/task-id.ts`); the merge engine (`src/apple-sync.ts`) and run (`src/apple-sync-run.ts`) behind `POST /app/shortcuts/sync`; the Shortcut setup guide. The read-only feed stays available.
- **Phase 2 (only if Phase 1 falls short):** a native iOS EventKit companion for background sync. It needs a $99/yr Apple Developer account, TestFlight or 7-day re-signing, and ongoing Xcode upkeep, and other self-hosters couldn't install it without that. The same sync endpoint serves it unchanged.
- **Phase 3:** after a few weeks of clean runs, decide whether task reminders can rely on Apple Reminders alone, keeping push notifications for non-task alerts.

## Decisions

- **Scope:** open tasks with a date, a repeat schedule or a priority. Plain tasks stay in Daybook only.
- **New reminders from Apple** go into the inbox's Reminders note (the same note "add reminder" uses), created if needed.
