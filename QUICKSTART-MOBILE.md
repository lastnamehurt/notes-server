# Quickstart on your phone

This is for when your notes app is already set up and you want to start using it from your phone. If you still need to set it up, follow [README.md](README.md) first.

You'll need:

- Your app's address, something like `https://personal-notes-mcp.yourname.workers.dev`
- The password you chose during setup

## 1. Open the app and sign in

1. Open your app's address in Safari (iPhone) or Chrome (Android).
2. Enter your password and submit it.

After 10 wrong passwords in 15 minutes the app locks for a while. Wait 15 minutes and try again.

## 2. Add it to your home screen

- **iPhone:** tap **Share**, then **Add to Home Screen**.
- **Android:** tap **⋮**, then **Add to Home screen**.

It opens like an app from now on.

## 3. Learn the five tabs

| Tab | What it's for |
|-----|---------------|
| **Today** | Today's log, plus reminders that are due. Tap a log entry to edit or delete it. |
| **Notes** | Your notes, grouped by folder. Search is at the top. |
| **Goals** | Each goal with its target date and next step. Tick a step off from the list. |
| **Reminders** | Everything scheduled, grouped by day. |
| **Setup** | Time zone, notes location, and phone notifications. |

## 4. Try it

- **Log something:** type `oatmeal and coffee #food` in the box at the bottom of Today and send it. Tags like `#food`, `#drink`, `#med`, `#exercise`, `#sleep` and `#mood` keep your log easy to scan.
- **Set a reminder:** on **Reminders**, tap **New reminder**. Pick once, or repeat on the days you choose.
- **Save a note:** on **Notes**, tap **New note**.
- **Tick something off:** tap **Done** on a due reminder. It's recorded in today's log and stops repeating for that time.

## 5. Get phone notifications (optional)

1. Install the free [ntfy](https://ntfy.sh) app and subscribe to the topic shown on the **Setup** tab. ntfy's [phone guide](https://docs.ntfy.sh/subscribe/phone/) shows how.
2. In **Setup**, tap **Save and finish**, then **Send test notification**.
3. If it doesn't arrive, ntfy may be busy. Try again later, or switch to [Pushover](https://pushover.net) (a paid app) under *Use Pushover instead*.

## 6. Connect Claude (optional)

This lets Claude read and write your notes, so you can say "Remind me to drink water at 3pm" or "Log: burrito and a beer".

1. In a browser, open [claude.ai](https://claude.ai) and go to **Settings → Connectors**.
2. Choose **Add custom connector**. Name it **Notes** and paste your app's address with `/mcp` on the end.
3. A sign-in page opens. Enter your password and tap **Allow**.

Connectors belong to the Claude account you're signed into, so do this with your personal account, not a work one.

## If something goes wrong

- **Forgot the password:** in the [Cloudflare dashboard](https://dash.cloudflare.com), open your Worker, go to **Settings → Variables and Secrets**, edit **PASSWORD**, and save. Then reconnect Claude.
- **Changed your mind about reminders or time zone:** open **Setup**.
- **Reminders are late or missing:** check **Reminders** for the time, then check that notifications are on in [ntfy](https://ntfy.sh).

For the details behind any of this, see [TECHNICAL.md](TECHNICAL.md).
