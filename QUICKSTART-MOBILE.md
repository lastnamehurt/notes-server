# Quickstart on your phone

This is for when your notes app is already set up and you want to start using it from your phone. If you still need to set it up, follow [README.md](README.md) first.

You'll need:

- Your app's address, something like `https://personal-notes-mcp.yourname.workers.dev`
- The password you chose during setup

## 1. Open the app and sign in

1. Open your app's address in Safari (iPhone) or Chrome (Android).
2. Enter the password you chose during setup (the same one Claude asks for). Once your notes are set up you can also use **Sign in with GitHub** under the password box: open the GitHub page it shows, enter the code, and approve, with the GitHub account that owns your notes.

After 10 wrong passwords in 15 minutes the app locks for a while. Wait 15 minutes and try again.

## 2. Add it to your home screen

- **iPhone:** tap **Share**, then **Add to Home Screen**.
- **Android:** tap **⋮**, then **Add to Home screen**.

It opens like an app from now on.

## 3. Learn the tabs

| Tab | What it's for |
|-----|---------------|
| **Today** | Your focus for the day, what you've logged, and reminders that are due. Tap a log entry to edit or delete it. |
| **Journal** | Your daily activities and reflections, day by day. |
| **Tasks** | Everything you need to do. Tasks with a date or time remind you. |
| **Memory** | Everything you've saved, grouped by folder. Search is at the top. |
| **Settings** | Time zone, where notes are saved, phone notifications, daily briefings and connecting an assistant. |

On a bigger screen you'll also see **Logs** and **Goals**.

## 4. Try it

- **Log something:** type `oatmeal and coffee #food` in the box at the bottom of Today and send it. Tags like `#food`, `#drink`, `#med`, `#exercise`, `#sleep` and `#mood` keep your log easy to scan.
- **Add a task or reminder:** on **Tasks**, tap **+ Add task**. Give it a day and time to be reminded, once or on the days you choose.
- **Save a note:** on **Memory**, tap **+ New**.
- **Tick something off:** tap **Done** on a due reminder. It's recorded in today's log and stops repeating for that time.

## 5. Get phone notifications (optional)

1. Install the free [ntfy](https://ntfy.sh) app and open it once. On Android, tap **Subscribe in ntfy** on the **Settings** tab. On iPhone, copy the name shown there, then in ntfy tap **+**, paste it and tap **Subscribe**.
2. In **Settings**, tap **Save and finish**, then **Send test notification**.
3. If it doesn't arrive, ntfy may be busy. Try again later, or switch to [Pushover](https://pushover.net) (a paid app) under *Use Pushover instead*.

## 6. Connect Claude (optional)

This lets Claude read and write your notes, so you can say "Remind me to drink water at 3pm" or "Log: burrito and a beer".

1. In a browser, open [claude.ai](https://claude.ai) and go to **Settings → Connectors**.
2. Choose **Add custom connector**. Name it **Daybook** and paste your app's address with `/mcp` on the end.
3. A sign-in page opens. Enter your password and tap **Allow**.

Connectors belong to the Claude account you're signed into, so do this with your personal account, not a work one.

## If something goes wrong

- **Forgot the password:** sign in with GitHub instead. To set a new password, open your Worker in the [Cloudflare dashboard](https://dash.cloudflare.com), go to **Settings → Variables and Secrets**, edit **MCP_BEARER_TOKEN** (or **PASSWORD** if there's no MCP_BEARER_TOKEN), and save. Then reconnect Claude, which still asks for the password.
- **Changed your mind about reminders or time zone:** open **Settings**.
- **Reminders are late or missing:** check **Tasks** for the time, then check that notifications are on in [ntfy](https://ntfy.sh).

For the details behind any of this, see [TECHNICAL.md](TECHNICAL.md).
