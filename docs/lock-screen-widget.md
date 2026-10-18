# Daybook on your lock screen

This widget shows Daybook on your iPhone lock screen, without opening the app:

```
$10.44 today · $43.14 week
2 in inbox
8:30am coffee
```

- **Line 1:** what you spent today and this week (from tap to pay).
- **Line 2:** how many notes in your inbox you have not sorted yet.
- **Line 3:** the last thing that you logged today.

Tasks are not in the widget. To see tasks on the lock screen, [sync them to Apple Reminders](apple-reminders-shortcuts.md) and add the Reminders widget.

The widget uses **Scriptable**, a free app. Daybook is a web app, and iOS lets only installed apps put widgets on the lock screen.

## Step 1: Get the address and the secret

1. In Daybook, go to **Settings → Shortcuts**.
2. Copy the **Lock screen widget** address.
3. Tap **Copy** next to the secret. This is the same secret that your other Daybook Shortcuts use.

## Step 2: Add the script to Scriptable

1. Install [Scriptable](https://apps.apple.com/app/scriptable/id1405459188) from the App Store.
2. On your iPhone, open [daybook-widget.js](../scripts/daybook-widget.js). Tap **Raw**. Select all the text and copy it.
3. In Scriptable, tap **+**. Paste the text. Tap the title at the top and name the script **Daybook**. Tap **Done**.
4. Tap the **Daybook** script to run it. Paste the address and the secret. Tap **Save**.

The address and the secret are kept in the iPhone Keychain. They are not in the script.

## Step 3: Add the widget to the lock screen

1. Lock your iPhone. Touch and hold the lock screen. Tap **Customize**, then tap the lock screen.
2. Tap the widget area below the clock. Find **Scriptable** and select the wide widget.
3. Tap the new widget. For **Script**, select **Daybook**.
4. Tap **Done**.

You can also add Scriptable to the line above the clock. That place shows one line only: the spending line.

The small round widget shows the percent of your daily target, or today's total if you have no target.

## How often it changes

iOS decides when widgets refresh. Usually it is every 15 to 30 minutes, and less often when the battery is low. To see new numbers now, tap the widget. It opens the Spending page.

## Privacy

- The widget can only **read** a summary. It cannot change anything in Daybook.
- If you selected **Do not show amounts on the lock screen** (**Today → Spending**), the widget shows percents of your targets, not amounts.
- The widget never shows a store name. Daybook does not keep store names.
- Anyone who can see your lock screen can see the widget.

## If something does not work

| The widget shows | What to do |
| --- | --- |
| `open Scriptable to set up` | Run the **Daybook** script in Scriptable. Paste the address and the secret. |
| `The secret is not correct` | Copy the secret again from **Settings → Shortcuts**. Run the script and tap **Change address or secret**. |
| `Spending is off` | In **Today → Spending**, select **Count my Apple Pay payments**. |
| Old numbers | iOS has not refreshed the widget yet. Tap it, or wait a few minutes. |
