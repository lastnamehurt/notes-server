# Daybook Signals: Shortcuts for tap to pay and parking

Daybook can track what you spend when you tap Apple Pay, log bar tabs as drinks, and ask about big purchases. An iPhone Shortcuts automation tells Daybook about each tap. It sends **the amount, the card's name and a kind of place** (like `bar` or `coffee`). The store's name stays on your phone, and your location is never used.

It covers taps with Apple Pay only. Physical-card swipes, online purchases, cash and scheduled payments (rent, bills) are not included, so the totals show what you chose to spend that day.

## 1. Turn it on in Daybook

1. Open Daybook → **Today → Suggestions**, scroll to **Signals: tap to pay and parked**.
2. Check **Turn on the tap-to-pay signal**. Set any targets you want (all optional) and save.
3. Open **Set up the Shortcut** on the same card. It shows the two things your Shortcut needs to talk to Daybook:
   - **Address**: where the Shortcut sends each tap (ends in `/app/shortcuts/signal`).
   - **Secret**: a password so only your phone can send taps. If you already set up Apple Reminders sync, it's the same secret and is shown here. Otherwise tap **Make my Shortcut secret**.

   You'll paste both into the Shortcut in step 2.4, so keep this card open or copy them into a note.

Suggestions (big purchase, drink goal, spending targets) also need **Awareness** on and not paused.

## 2. Build the Shortcut

Written for iOS 26. Build the simple version first, check that it works, then add the extras.

### The trigger

1. **Shortcuts** app → **Automation** tab → **+**.
2. Tap **Wallet** ("When I tap a Wallet Card or Pass"). In iOS 17 this was called **Transaction**.
3. Select **only your payment cards**. Leave boarding passes, store cards and other passes off: they have no amount, and Daybook rejects those taps. The screen title shows how many you picked ("When I tap any of 2 Wallet passes or payment cards").
4. Leave categories and merchants on *Any*.
5. Choose **Run Immediately** (so it doesn't ask each time) and tap **Next**.
6. On the next screen, tap the first tile, **Create New Shortcut**. (Ignore the suggestions like "Add Row to Top or Bottom of Table".)

**Picking a property of Shortcut Input:** where a step says *Shortcut Input → Amount* (or *Merchant*, or *Card or Pass*), tap the field, choose **Shortcut Input**, then tap the blue *Shortcut Input* bubble that appears and pick the property from its list.

### Simple version: one action

1. **Add Action** → search **Get Contents of URL** → add it.
2. Tap the blue URL placeholder and paste the **Address** from step 1.3.
3. Tap the **›** on the action to show its options:
   - **Method:** **POST**
   - **Headers:** **Add new header**. Key `Authorization`, value `Bearer ` (with the space) followed by the **Secret** from step 1.3.
   - **Request Body:** **JSON**. Add two **Text** fields:
     - `kind`: type `payment`
     - `amount`: *Shortcut Input → Amount*
4. Tap **Done**.

Now go to **3. Try it** below. Come back here once a tap shows up in Daybook.

### Full version: card name, bar detection, no double counting

Open the automation again and add these **above** Get Contents of URL (drag to reorder):

1. **Text**: type `other`. Then **Set Variable**, named **Kind**, set to that Text.
2. **If** *Shortcut Input → Merchant* **contains** `bar` → inside it, **Set Variable** *Kind* to a new **Text** `bar`. Add **Otherwise If** branches for the words your usual spots use: `pub`, `tavern`, `brewing`, `taproom` → `bar`; `coffee`, `cafe` → `coffee`. The matching happens on your phone; the merchant's name is never sent.
3. **Format Date**: *Current Date*, **Custom** format `yyyyMMdd-HHmmss`. Then **Set Variable** **TapId** to it.

Then add three more **Text** fields to the JSON body of Get Contents of URL:

- `card`: *Shortcut Input → Card or Pass* (the card's name, so you can leave a work card out)
- `category`: the **Kind** variable
- `id`: the **TapId** variable (so a retried tap is counted once)

Optional, at the end: **Get Dictionary Value** `message` from *Contents of URL* → **Show Notification** with it. It reads like "Today $24.50 across 3 · this week $112.00".

## 3. Try it

Tap Apple Pay anywhere. In Daybook, the **Signals: tap to pay and parked** card shows today's total. A tap whose kind is mapped to `drink` adds a `#drink` line to today's log.

## What each kind of place does

In the settings card, **Kinds of place** maps each `category` your Shortcut sends:

- `drink`: logs `#drink` and counts toward your weekly bar-tab goal
- `food`: logs `#food`
- `none`: counts toward spending only

Any kind not listed only counts toward spending.

## Privacy

- Stored: amount, currency, card name, kind of place, time. Kept 90 days; **Erase stored taps** removes them all.
- Never stored or sent: the store's name, your location.
- Suggestion notifications leave out amounts unless you uncheck **Keep amounts off the lock screen**.
- Cards listed under **Cards to leave out** (a work card, say) are ignored entirely.

## Troubleshooting

| Result | Meaning |
| --- | --- |
| `401 Unauthorized` | The `Authorization` header doesn't match your Shortcut secret. |
| `404 Shortcut sync is not configured` | Make a Shortcut secret first (step 1.3). |
| `reason: "off"` | Turn on the tap-to-pay signal in Daybook. |
| `reason: "duplicate"` | The same tap was sent twice; it was counted once. |
| `Send the amount, like 12.50` | The `amount` field was empty: pick *Amount* from Shortcut Input. Also happens when a non-payment pass (boarding pass, store card) is selected in the trigger. |

---

# Parked: errands near where you stop

Tag a task with a kind of place, and Daybook tells you about it when you park near one:

```
- [ ] Buy batteries @at:grocery
- [ ] Pick up prescription @at:pharmacy @2026-10-20
```

The tag can sit anywhere in the task and works with dates and priorities. Use one word per kind of place (letters, digits, dashes): `grocery`, `pharmacy`, `hardware`, `post-office`.

**Nothing about where you are is stored or sent.** Your phone looks up what's nearby; Daybook only receives the kinds of place it found and answers with the matching tasks. Your Shortcut shows the notification.

## 1. Turn it on

Daybook → **Today → Suggestions** → **Signals: tap to pay and parked** → check **Turn on the parked signal** and save. It uses the same address and Shortcut secret as tap to pay.

## 2. Build the Shortcut

Shortcuts → **Automation** → **+** → **CarPlay** → **Disconnects** (or **Bluetooth** → your car → **Disconnects** if you don't use CarPlay) → **Run Immediately**.

1. **Get Current Location**.
2. For each kind of place you tag tasks with (start with `grocery`):
   1. **Search Local Businesses** for `grocery store` near *Current Location*.
   2. **Get Item from List** → *First Item*.
   3. **Get Distance** from *Current Location* to that business.
   4. **If** *Distance* **is less than** `0.15` (miles) → **Add** `grocery` **to Variable** *Places*.
3. **If** *Places* **has any value**:
   - **Get Contents of URL** → POST to the same address, header `Authorization: Bearer <secret>`, JSON body:
     - `kind` (Text): `parked`
     - `places` (Text): *Places* (a list or comma-separated text both work)
   - **Get Dictionary Value** `message` from the result.
   - **If** *message* **has any value** → **Show Notification** with *message*.

The reply looks like `Near grocery: Buy batteries, Coffee filters`. When no tagged tasks match, `message` is empty and nothing is shown.

## Limits

- It only runs when your phone disconnects from the car, so walking trips don't trigger it.
- "Nearest business" can be wrong: parking beside a grocery store you're not going into will still match.
- The parked signal is stateless: Daybook keeps no record of where or when you parked.
