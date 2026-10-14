# Apple Reminders two-way sync (iPhone Shortcuts)

Daybook tasks show up in a **Daybook** list in Apple Reminders, and changes flow both ways: check something off on your iPhone or Apple Watch, retitle or reschedule it, or add a new reminder to the list, and Daybook picks it up. Change a task in Daybook and the reminder follows.

It's opt-in, free, and needs no app: one Shortcut on your iPhone does the syncing. The Worker never connects to iCloud, and your notes stay in your private GitHub repository. How it works is in [apple-reminders-two-way-sync.md](apple-reminders-two-way-sync.md).

**What syncs:** open tasks that have a date, a repeat schedule or a priority. Plain tasks without any of those stay in Daybook only. Reminders you add to the Daybook list in Apple Reminders go into your inbox's Reminders note.

**What doesn't:** subtasks, flags, tags, images and location alerts in Apple Reminders. Nothing in your other Reminders lists is ever read or changed.

## 1. Get the sync address and secret

In Daybook, open **Settings** (the gear) → **Apple Reminders** and tap **Make my Shortcut secret**. Copy the sync address and the secret shown there; you'll paste both into the Shortcut. Don't reuse your Daybook password or GitHub token.

The secret only reaches Daybook tasks (`/app/shortcuts/sync` and `/app/shortcuts/tasks`). **Make a new secret** in the same place cuts off the old one immediately. If your deployment sets an encrypted `SHORTCUTS_TOKEN` secret in Cloudflare (at least 32 characters), that one is used instead and Settings says so.

## 2. Create the list

In **Reminders**, create a list named exactly **Daybook**.

## 3. Build the Shortcut

In **Shortcuts**, tap **+** and name it **Sync Daybook**. Replace `https://YOUR-WORKER/app/shortcuts/sync` with the sync address from step 1 and `YOUR-SECRET` with the secret.

Shortcuts action names shift a little between iOS versions. Search the action list for the word in bold if a name doesn't match exactly.

**Read the list**

1. **Find Reminders** → filter *List* is *Daybook*. Leave out any *Is Completed* filter so finished reminders are included. Sort by *Creation Date*. Then **Set Variable** `Found` to the result.
2. **Repeat with Each** item in `Found`. Inside the repeat, add a **Dictionary** with these keys:
   - `index` (Number): **Calculate** *Repeat Index* − 1
   - `title` (Text): *Repeat Item* → Title
   - `url` (Text): *Repeat Item* → URL
   - `notes` (Text): *Repeat Item* → Notes
   - `due` (Text): **Format Date** *Repeat Item → Due Date*, Date Format *ISO 8601*, *Include Time* on
   - `completed` (Boolean): *Repeat Item* → Is Completed
   - `priority` (Text): *Repeat Item* → Priority

   After **End Repeat**, **Set Variable** `Snapshot` to *Repeat Results*.

**Send it**

3. **Format Date** *Current Date* as *Unix timestamp*, then **Text** `sync-` followed by that value. **Set Variable** `RunID`. This lets the Worker recognize a retried request so nothing is applied twice.
4. **Get Contents of URL** `https://YOUR-WORKER/app/shortcuts/sync`
   - Method **POST**
   - Headers: `Authorization` = `Bearer YOUR-SECRET`
   - Request Body **JSON**: `runId` (Text) = `RunID`, `reminders` (Array) = `Snapshot`
5. **Get Dictionary Value** `actions` from the result.

**Apply what comes back**

6. **Repeat with Each** item in the actions. Inside it, **Get Dictionary Value** `op` from *Repeat Item*, then an **If** for each value:
   - **`create`**: **Add New Reminder** with Title = `title`, List = *Daybook*, URL = `url`, Priority = `priority`. If `due` isn't empty, set the alert/due date to **Get Dates from Input** of `due`.
   - **`update`**: **Get Item from List** `Found` at index `index` + 1 (use **Calculate**). Then set that reminder's Title = `title`, Priority = `priority`, Is Completed = `completed`, and Due Date = `due` (or remove the due date when `due` is empty).
   - **`delete`**: **Get Item from List** as above, then **Remove Reminders**.
   - **`tag`**: **Get Item from List** as above, then set its URL to `url`.
7. Optional: **Show Notification** with the result's `summary` while you're testing.

Each `url` looks like `https://YOUR-WORKER/app#task/t7k2q`. It's how the Worker recognizes the reminder later, and tapping it opens the task in Daybook. Don't edit it. If your iOS version can't set a reminder's URL from Shortcuts, put `daybook:` followed by the `taskId` value in the Notes field instead; the Worker reads either.

When `allDay` is true, `due` is a plain date (`2026-10-16`). If your iOS version insists on a time, that's fine: a date-only Daybook task and the same date at 9am count as the same.

## 4. Test it

1. Run **Sync Daybook**. Your dated and prioritized Daybook tasks appear in the Daybook list. In Daybook, those task lines now end with a short ID like `^t7k2q`. Leave it there: it's how a task keeps its reminder when you move or retitle it.
2. Run it again. The summary should show `created: 0, updated: 0`. Nothing is duplicated.
3. Check a reminder off, run the Shortcut, and confirm the task is ticked in Daybook and logged as done.
4. Add a reminder to the Daybook list, run the Shortcut, and find it in your inbox's Reminders note.

## 5. Make it automatic

In **Shortcuts → Automation → +**:

- **App** → *Reminders* → **Is Closed** → *Run Immediately* → **Sync Daybook**. Checking something off and leaving Reminders syncs it within seconds.
- **Time of Day**, a few times a day (for example 7am, noon and 6pm) → *Run Immediately* → **Sync Daybook**. This picks up changes you made in Daybook.

You can also add **Sync Daybook** to your Home Screen, or tap **Sync now** in Daybook's Settings, to sync on demand. Checking something off on Apple Watch reaches your phone through iCloud and syncs on the next run.

## Who sends the alert

Once a task is in the Daybook list, Apple Reminders alerts you for it and Daybook skips its own notification, so you don't get two. Daybook counts a task as "in Reminders" only after the Shortcut has reported it back, so a reminder is never silenced before it exists on your phone. If the Shortcut hasn't synced for 36 hours, Daybook sends its own notifications again for everything. To get both alerts anyway, choose **Reminders and Daybook notifications** in Settings → Apple Reminders.

## How changes are resolved

- A change on one side is copied to the other on the next run.
- If the same field changed on both sides between runs, **Daybook wins**, and the Apple Reminders value is saved in that day's log with `#sync-conflict`, so nothing is lost.
- **Repeating tasks** appear as their next occurrence. Check it off and the reminder moves on to the following one. Change the schedule itself in Daybook; a new time set in Reminders is reset.
- **Deleting a reminder never deletes the Daybook task.** The task stops syncing and the log notes it with `#removed-in-reminders`. Change the task in Daybook to send it back.
- **Deleting a task in Daybook** removes its reminder.
- Completions from Apple Reminders are logged as `✓ <task> #done`, the same as the Done button on a notification.

## Limits

- Not instant: Daybook-side changes reach your phone at the next automation or manual run.
- If more than half of your synced reminders would be deleted in one run, the sync stops and asks you to check. This protects the list if the notes ever come back empty.
- A one-off task with several times (`@2026-10-15 9am, 5pm`) shows its first time in Reminders.

## Privacy

The Shortcut keeps the secret inside its actions on your phone. Anyone with it can read and change your Daybook **tasks** (not your other notes), so keep it private and rotate it in Cloudflare if it's exposed. Synced task titles and dates are also stored in iCloud under your Apple account's Reminders settings.

## Read-only feed

`GET /app/shortcuts/tasks` (same secret) still returns open tasks as JSON, for anyone who wants a one-way export without two-way sync.
