# Daybook Signals: tap-to-pay Shortcut

Daybook can track what you spend when you tap Apple Pay, log bar tabs as drinks, and ask about big purchases. An iPhone Shortcuts automation tells Daybook about each tap. It sends **the amount, the card's name and a kind of place** (like `bar` or `coffee`). The store's name stays on your phone, and your location is never used.

It covers taps with Apple Pay only. Physical-card swipes, online purchases, cash and scheduled payments (rent, bills) are not included, so the totals show what you chose to spend that day.

## 1. Turn it on in Daybook

1. Open Daybook → **Today → Suggestions**, scroll to **Tap-to-pay signal**.
2. Check **Turn on the tap-to-pay signal**. Set any targets you want (all optional) and save.
3. Open **Set up the Shortcut** and copy the address. It looks like `https://<your-daybook>/app/shortcuts/signal`.
4. You also need your **Shortcut secret**: Settings → Apple Reminders → *Make my Shortcut secret* (skip if you already made one for Apple Reminders sync; it's the same secret).

Suggestions (big purchase, drink goal, spending targets) also need **Awareness** on and not paused.

## 2. Build the Shortcut

In the **Shortcuts** app → **Automation** → **+** → **Transaction** (iOS 17 or later).

- **Cards:** choose the cards you want counted.
- Leave categories and merchants as *Any*.
- Choose **Run Immediately** (so it doesn't ask each time).

Then add these actions:

1. **Text** → type `other`. Rename the variable **Kind**.
2. **If** *Shortcut Input → Merchant* **contains** `bar` → **Set Variable** *Kind* to `bar`. Add more **Otherwise If** checks for the words your usual spots use (`pub`, `tavern`, `brewing`, `taproom` → `bar`; `coffee`, `cafe` → `coffee`; …). Matching happens on your phone; the merchant's name is not sent.
3. **Format Date** → *Current Date*, custom format `yyyyMMdd-HHmmss`. Rename it **TapId**.
4. **Get Contents of URL**
   - URL: the address from step 1.3
   - Method: **POST**
   - Headers: `Authorization` = `Bearer ` followed by your Shortcut secret
   - Request Body: **JSON**
     - `kind` (Text): `payment`
     - `amount` (Text): *Shortcut Input → Amount*
     - `card` (Text): *Shortcut Input → Name* (the card's name)
     - `category` (Text): *Kind*
     - `id` (Text): *TapId*
5. Optional: **Show Notification** with *Get Dictionary Value* `message` from the result. It reads like "Today $24.50 across 3 · this week $112.00".

## 3. Try it

Tap Apple Pay anywhere. In Daybook, the **Tap-to-pay signal** card shows today's total. A tap whose kind is mapped to `drink` adds a `#drink` line to today's log.

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
| `404 Shortcut sync is not configured` | Make a Shortcut secret first (step 1.4). |
| `reason: "off"` | Turn on the tap-to-pay signal in Daybook. |
| `reason: "duplicate"` | The same tap was sent twice; it was counted once. |
| `Send the amount, like 12.50` | The `amount` field was empty. Pick *Amount* from Shortcut Input. |
