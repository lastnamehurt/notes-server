# Daybook: tap to pay and errands

Daybook can count what you spend with Apple Pay in stores. It can also count bar payments as drinks, and ask you about big payments. To do this, a Shortcut on your iPhone sends Daybook a message each time you pay.

The Shortcut sends three things: the **amount**, the **card name** and a **kind of place**, for example `coffee` or `bar`. It does not send the store's name. It does not send your location.

Daybook counts only Apple Pay payments in stores, when you hold your iPhone or Apple Watch near the reader. It does not count these:

- Card swipes
- Payments in apps or on websites
- Cash
- Bills and other scheduled payments

---

# Part 1: Count Apple Pay payments

## Step 1: Turn it on in Daybook

1. In Daybook, go to **Today → Spending**.
2. Scroll down to **Tap to pay and errands**.
3. Select **Count my Apple Pay payments**. Targets are optional. Changes save automatically.
4. Go to **Settings → Shortcuts**. Keep this page open. You need two things from it:
   - **Address:** the **Tap to pay** address. It ends in `/app/shortcuts/signal`.
   - **Secret:** a password that only your phone knows. All your Daybook Shortcuts use the same secret. To see it, tap **Show**. To copy it, tap **Copy**. If you do not have a secret, tap **Make my Shortcut secret**.

Daybook can also send you suggestions, for example "Was this planned?". For suggestions, **Awareness** must be on, and **Pause suggestions** must be off. You find these settings in **Today → Suggestions**.

## Step 2: Make the Shortcut

There are two ways to make the Shortcut. With a Mac, it is faster.

### With a Mac (recommended)

1. On your Mac, open Terminal. Go to your copy of this repository.
2. Run this command:

   ```sh
   bash scripts/make-tap-shortcut.sh
   ```

3. When the script asks, paste the **Address** and the **Secret**.
4. The script makes a file named **Daybook Tap.shortcut**. Double-click it. Then click **Add Shortcut**. The Shortcut syncs to your iPhone through iCloud.
5. On your iPhone, open the **Shortcuts** app. Then:
   1. Tap **Automation**, then tap **+**.
   2. Tap **Wallet**.
   3. Select your payment cards. Do not select boarding passes, store cards or other passes.
   4. Select **Run Immediately**. Tap **Next**.
   5. Select **Daybook Tap** from your Shortcuts.
6. If you have an older Wallet automation for Daybook, delete it. Swipe left on it and tap **Delete**. If you keep two, Daybook counts each payment two times.

The Shortcut finds the kind of place from words in the store's name, for example "espresso" or "tavern". This happens on your iPhone. The kinds are `bar`, `coffee`, `food`, `gas`, `grocery`, `parking` and `other`. The first kind that matches is used. For example, "TeKu Tavern + Cafe" is a `bar`. Smoke, vape and cannabis shops are `other`. To change the words, edit the `RULES` list at the top of the script. Then run the script again.

The kind is a guess. If it is wrong, go to **Today → Spending** and tap the payment. Then select the correct kind. Daybook also corrects the `#drink` or `#food` line in your log.

If the script says that signing failed, make sure of these things. Then run the script again.

- You are signed in to iCloud on the Mac.
- The Mac is connected to the internet.
- You opened the Shortcuts app on the Mac one time.

### On the iPhone only

These steps are for iOS 26.

**Make the automation**

1. Open the **Shortcuts** app. Tap **Automation**, then tap **+**.
2. Tap **Wallet**. In iOS 17, this item has the name **Transaction**.
3. Select only your payment cards. Do not select boarding passes, store cards or other passes. These have no amount, and Daybook does not accept them.
4. Keep **Any** for categories and merchants.
5. Select **Run Immediately**. Tap **Next**.
6. Tap **Create New Shortcut**.

**How to select a detail of the payment.** Some steps below say *Shortcut Input → Amount*. To do this, tap the field and select **Shortcut Input**. A blue *Shortcut Input* item shows. Tap it, then select **Amount** from the list. Do the same for **Merchant** and **Card or Pass**.

**Add the action**

1. Tap **Add Action**. Search for **Get Contents of URL** and add it.
2. Tap the blue URL field. Paste the **Address**.
3. Tap **›** on the action to see more options. Then set these:
   - **Method:** **POST**
   - **Headers:** tap **Add new header**. For the key, type `Authorization`. For the value, type `Bearer`, a space, and then paste the **Secret**.
   - **Request Body:** **JSON**. Add two **Text** fields:
     - `kind`: type `payment`
     - `amount`: select *Shortcut Input → Amount*
4. Tap **Done**.

Go to Step 3 and test the Shortcut. When it works, you can add the extra steps below.

**Optional: add the kind of place, the card name and a payment ID**

Add these actions **above** Get Contents of URL. To move an action, drag it.

1. Add a **Text** action. Type `other`. Then add **Set Variable**. Name the variable **Kind**, and set it to the Text.
2. Add an **If** action: *Shortcut Input → Merchant* **contains** `bar`. In the If, add **Set Variable**: set **Kind** to a new **Text** `bar`. For other words, add **Otherwise If**. For example: `pub`, `tavern`, `brewing` and `taproom` give `bar`. `coffee` and `cafe` give `coffee`. The store's name stays on your iPhone.
3. Add **Format Date**: *Current Date*, **Custom** format `yyyyMMdd-HHmmss`. Then add **Set Variable**. Name it **TapId**.

Then, in the JSON of Get Contents of URL, add three more **Text** fields:

- `card`: select *Shortcut Input → Card or Pass*. With the card name, you can leave out a work card.
- `category`: select the **Kind** variable.
- `id`: select the **TapId** variable. If the Shortcut sends the same payment again, Daybook counts it only one time.

To see a message after each payment, add these at the end: **Get Dictionary Value** `message` from *Contents of URL*, then **Show Notification**. The message looks like this: "Today $24.50 across 3 · this week $112.00".

## Step 3: Test the Shortcut

1. If you used the Mac script, open **Daybook Tap** in the Shortcuts app and check it:
   - The **Match** action uses **Merchant**. It must not use all of *Shortcut Input*.
   - **Get Contents of URL** uses **POST**. It has an `Authorization` header that starts with `Bearer`. Its JSON has `kind`, `amount`, `card` and `category`.
2. Pay with Apple Pay in a store.
3. In Daybook, go to **Today → Spending**. Today's total includes the payment.
4. Look at the line under the total:
   - **Shortcut works** means that the payment came in.
   - If there is a problem, a box tells you what to fix.

## Kinds of place

The Spending page shows this week's total for each kind, for example "gas $38.10 · food $16.40 · coffee $9.75".

In **Tap to pay and errands**, **Kinds of place** tells Daybook what to do with each kind:

- `drink`: adds a `#drink` line to your log. It also counts toward your weekly limit for bar payments.
- `food`: adds a `#food` line to your log.
- `none`: counts only toward spending.

A kind that is not in the list counts only toward spending.

## Privacy

- **What Daybook keeps:** the amount, the currency, the card name, the kind of place and the time. Daybook keeps each payment for 90 days. To delete all payments, tap **Delete all payments**.
- **What Daybook never gets:** the store's name and your location.
- **Lock screen:** suggestion notifications do not show amounts. To show amounts, clear **Do not show amounts on the lock screen**.
- **Cards to leave out:** Daybook ignores payments with these cards, for example a work card.

## If something does not work

Look at **Today → Spending**. It tells you what happened to the last payment. The table below shows the replies that the Shortcut can get.

| Reply | What to do |
| --- | --- |
| `401 Unauthorized` | The secret is not correct. In the `Authorization` header, type `Bearer`, a space, then the secret from **Settings → Shortcuts**. |
| `404 Shortcut sync is not configured` | You do not have a secret. Make one in **Settings → Shortcuts**. |
| `reason: "off"` | Counting is off. In **Today → Spending**, select **Count my Apple Pay payments**. |
| `reason: "duplicate"` | The Shortcut sent the same payment two times. Daybook counted it one time. You do not need to do anything. |
| `Send the amount, like 12.50` | No amount came in. Set the `amount` field to *Shortcut Input → Amount*. This also happens if you selected a pass that is not a payment card. |

---

# Part 2: Errand reminders when you park (optional)

Add a kind of place to a task. When you park near that kind of place, your iPhone shows the task.

```
- [ ] Buy batteries @at:grocery
- [ ] Pick up prescription @at:pharmacy @2026-10-20
```

You can put the tag anywhere in the task. It works with dates and priorities. Use one word for each kind of place. You can use letters, numbers and dashes, for example `grocery`, `pharmacy`, `hardware` or `post-office`.

**Daybook does not get your location.** Your iPhone finds what is near you. Then it sends Daybook only the kinds of place, for example `grocery`. Daybook sends back the tasks for those places. Your iPhone shows them.

## Step 1: Turn it on

1. In Daybook, go to **Today → Spending**.
2. In **Tap to pay and errands**, select **Remind me of errands when I park**. The change saves automatically.

This Shortcut uses the same address and secret as tap to pay. You find them in **Settings → Shortcuts**.

## Step 2: Make the Shortcut

1. Open the **Shortcuts** app. Tap **Automation**, then tap **+**.
2. Tap **CarPlay**, then **Disconnects**. If your car does not have CarPlay, tap **Bluetooth**, select your car, then **Disconnects**.
3. Select **Run Immediately**.
4. Add **Get Current Location**.
5. Do these steps for each kind of place that you use in tasks. Start with `grocery`:
   1. Add **Search Local Businesses**. Search for `grocery store` near *Current Location*.
   2. Add **Get Item from List**. Select *First Item*.
   3. Add **Get Distance** from *Current Location* to that business.
   4. Add **If** *Distance* **is less than** `0.15` (miles). In the If, add **Add to Variable**: add `grocery` to a variable named *Places*.
6. Add **If** *Places* **has any value**. In this If, add these actions:
   1. **Get Contents of URL**: **POST** to the same address. Add the header `Authorization`: `Bearer`, a space, then the secret. Set **Request Body** to **JSON** with two **Text** fields:
      - `kind`: type `parked`
      - `places`: select the *Places* variable
   2. **Get Dictionary Value**: get `message` from the result.
   3. **If** *message* **has any value**: add **Show Notification** with *message*.

The notification looks like this: "Near grocery: Buy batteries, Coffee filters". If no task matches, nothing shows.

## Limits

- The Shortcut runs only when your iPhone disconnects from your car. It does not run when you walk.
- The nearest store is not always the store that you go to. If you park near a grocery store, the Shortcut shows your grocery tasks.
- Daybook does not keep a record of where or when you park.
