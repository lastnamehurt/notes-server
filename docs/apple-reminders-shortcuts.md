# Daybook in Apple Reminders (optional)

This guide shows your Daybook tasks in Apple Reminders. You do not need it for phone reminders: tasks with a date already send a notification to your phone.

When you set it up, your tasks show in a Reminders list named **Daybook**. Changes go both ways:

- In Reminders, check off, rename or reschedule a task, or add a new reminder to the list. Daybook gets the change.
- In Daybook, change a task. The reminder changes too.

A Shortcut on your iPhone does the sync. You do not need another app. Daybook never connects to iCloud. For technical details, see [apple-reminders-two-way-sync.md](apple-reminders-two-way-sync.md).

**What syncs:** open tasks that have a date, a repeat schedule or a priority. Tasks without these stay only in Daybook. When you add a reminder to the Daybook list, it goes into the **Reminders** note in your Daybook inbox.

**What does not sync:** subtasks, flags, tags, images and location alerts. Daybook never reads or changes your other Reminders lists.

## Step 1: Get the address and the secret

1. In Daybook, go to **Settings → Shortcuts**.
2. If you do not have a secret, tap **Make my Shortcut secret**.
3. Copy the **Reminders sync** address. Then tap **Copy** next to the secret. You paste both into the Shortcut in Step 3.

All your Daybook Shortcuts use the same secret. Do not use your Daybook password or a GitHub token as the secret.

The secret gives access only to your Daybook tasks. If someone else sees it, tap **Make a new secret**. The old secret stops working immediately. If the secret is set in your Cloudflare account (`SHORTCUTS_TOKEN`), change it there.

## Step 2: Make the list

In the **Reminders** app, make a list. Name it **Daybook**.

## Step 3: Make the Shortcut

In the **Shortcuts** app, tap **+**. Name the Shortcut **Sync Daybook**.

In the steps below, replace `https://YOUR-DAYBOOK/app/shortcuts/sync` with your address from Step 1. Replace `YOUR-SECRET` with your secret.

Action names can be a little different in each iOS version. If you cannot find an action, search for the word in bold.

**Read the list**

1. Add **Find Reminders**. Set the filter *List* is *Daybook*. Do not add an *Is Completed* filter: the Shortcut must also find completed reminders. Sort by *Creation Date*. Then add **Set Variable**. Name it `Found`.
2. Add **Repeat with Each** item in `Found`. In the repeat, add a **Dictionary** with these keys:
   - `index` (Number): **Calculate** *Repeat Index* − 1
   - `title` (Text): *Repeat Item* → Title
   - `url` (Text): *Repeat Item* → URL
   - `notes` (Text): *Repeat Item* → Notes
   - `due` (Text): **Format Date** *Repeat Item → Due Date*. Use Date Format *ISO 8601*. Turn on *Include Time*.
   - `completed` (Boolean): *Repeat Item* → Is Completed
   - `priority` (Text): *Repeat Item* → Priority

   After **End Repeat**, add **Set Variable**. Name it `Snapshot`, and set it to *Repeat Results*.

**Send the list to Daybook**

3. Add **Format Date**: *Current Date* as *Unix timestamp*. Then add a **Text** action: `sync-` and that value. Then add **Set Variable**. Name it `RunID`. With this ID, Daybook does not apply the same sync two times.
4. Add **Get Contents of URL** with `https://YOUR-DAYBOOK/app/shortcuts/sync`:
   - **Method:** POST
   - **Headers:** `Authorization` = `Bearer YOUR-SECRET` (`Bearer`, a space, then the secret)
   - **Request Body:** JSON. Add `runId` (Text) = `RunID`, and `reminders` (Array) = `Snapshot`.
5. Add **Get Dictionary Value**. Get `actions` from the result.

**Do what Daybook sends back**

6. Add **Repeat with Each** item in the actions. In the repeat, add **Get Dictionary Value**: get `op` from *Repeat Item*. Then add an **If** for each value of `op`:
   - **`create`**: add **Add New Reminder**. Set Title = `title`, List = *Daybook*, URL = `url` and Priority = `priority`. If `due` is not empty, set the due date to **Get Dates from Input** of `due`.
   - **`update`**: add **Get Item from List**. Get the item from `Found` at index `index` + 1 (use **Calculate**). Then set Title = `title`, Priority = `priority`, Is Completed = `completed` and Due Date = `due`. If `due` is empty, remove the due date.
   - **`delete`**: get the item as for `update`. Then add **Remove Reminders**.
   - **`tag`**: get the item as for `update`. Then set its URL to `url`.
7. Optional: while you test, add **Show Notification** with `summary` from the result.

Each `url` looks like this: `https://YOUR-DAYBOOK/app#task/t7k2q`. Daybook uses it to find the reminder later. When you tap it, the task opens in Daybook. Do not change it. If your iOS version cannot set a reminder's URL, put `daybook:` and the `taskId` value in the Notes field. Daybook reads both.

If `allDay` is true, `due` is a date without a time, for example `2026-10-16`. If your iOS version must have a time, that is OK. Daybook treats a date and the same date at 9am as the same.

## Step 4: Test the Shortcut

1. Run **Sync Daybook**. Your Daybook tasks with a date or a priority show in the Daybook list. In Daybook, these tasks now end with a short ID, for example `^t7k2q`. Do not remove the ID. With it, a task keeps its reminder when you move or rename the task.
2. Run the Shortcut again. The summary shows `created: 0, updated: 0`. Nothing is added two times.
3. Check off a reminder. Run the Shortcut. In Daybook, the task is checked off, and your log shows it as done.
4. Add a reminder to the Daybook list. Run the Shortcut. Find the new task in the **Reminders** note in your Daybook inbox.

## Step 5: Make the sync automatic

In the **Shortcuts** app, tap **Automation**, then **+**. Make two automations:

- **App**: select *Reminders* and **Is Closed**. Select *Run Immediately*, then **Sync Daybook**. When you close Reminders, your changes sync in a few seconds.
- **Time of Day**: make one for each time, for example 7am, 12pm and 6pm. Select *Run Immediately*, then **Sync Daybook**. This gets the changes that you made in Daybook.

To sync at any time, add **Sync Daybook** to your Home Screen, or tap **Sync now** in Daybook (**Settings → Apple Reminders**). When you check off a task on your Apple Watch, the change goes to your iPhone through iCloud. It syncs at the next run.

## Who sends the alert

When a task is in the Daybook list, Apple Reminders sends the alert. Daybook does not send its own notification, so you do not get two. Daybook stops its notification only after the Shortcut confirms that the reminder is on your phone.

If the Shortcut does not sync for 36 hours, Daybook sends its own notifications again for all tasks. To get alerts from both, go to **Settings → Apple Reminders** and select **Reminders and Daybook notifications**.

## When both sides change

- A change on one side goes to the other side at the next run.
- If the same detail changed on both sides between runs, **Daybook's change is kept**. Daybook saves the Reminders value in that day's log with `#sync-conflict`. Nothing is lost.
- A **repeating task** shows as its next time. When you check it off, the reminder moves to the time after that. Change the schedule in Daybook. If you change the time in Reminders, Daybook changes it back.
- **When you delete a reminder, Daybook does not delete the task.** The task stops syncing, and the log shows `#removed-in-reminders`. To sync it again, change the task in Daybook.
- **When you delete a task in Daybook,** its reminder is deleted.
- When you complete a task in Reminders, the log shows `✓ <task> #done`. This is the same as the Done button on a notification.

## Limits

- The sync is not instant. Changes in Daybook get to your phone at the next run.
- If one run would delete more than half of your synced reminders, the sync stops and asks you to check. This keeps your list safe if your notes are empty because of a problem.
- If a one-time task has two or more times (`@2026-10-15 9am, 5pm`), Reminders shows only the first time.

## Privacy

The secret is in the Shortcut on your phone. A person with the secret can read and change your Daybook **tasks**, but not your other notes. Keep the secret private. If someone else sees it, make a new secret in **Settings → Shortcuts**. Reminders keeps synced task titles and dates in iCloud, in your Apple account.

## Task list for other tools

`GET /app/shortcuts/tasks`, with the same secret, gives your open tasks as JSON. Use it if you want a list of tasks without a two-way sync.
