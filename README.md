# Your own notes app, connected to Claude

Ask Claude to remember things, set reminders that buzz your phone, and log meals, meds and moods. Everything is saved to **your own private space**: nobody else can read it, including whoever sent you this link.

It's free, takes about 15 minutes, and needs no coding. You'll tap through a few websites; this page tells you exactly what to tap.

## What you need

- A phone or computer with a web browser
- Claude (the free plan works)
- About 15 minutes

You'll make two free accounts along the way: **GitHub** (where your notes are saved, privately) and **Cloudflare** (which runs your app). Neither asks for a credit card.

## Step 1: Make your two accounts

1. Sign up at [github.com/signup](https://github.com/signup). Confirm your email.
2. Sign up at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up). Confirm your email.

## Step 2: Make up a password

Make up a password for your notes: at least 12 characters. Save it in your phone's password manager or somewhere safe. You'll type it to open your notes and to connect Claude.

## Step 3: Create your app

Tap this button:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lastnamehurt/notes-server)

1. Sign in to Cloudflare if it asks.
2. When it asks to connect **GitHub**, allow it. (Cloudflare saves a copy of the app in your GitHub; that's normal.)
3. Where it asks for **PASSWORD**, paste the password from Step 2.
4. Tap **Create and deploy** and wait a minute or two until it says it's done.
5. Tap **Visit** (or the address shown, like `https://personal-notes-mcp.yourname.workers.dev`). Bookmark the page it opens.

## Step 4: Finish setup in your app

Enter your password on the page that opened.

The app walks you through the rest:

1. **Connect your GitHub.** Tap **Connect GitHub**, then **Copy code and open GitHub**. On GitHub, paste the code, tap **Continue**, then **Authorize**. Come back to the app: it makes a private place for your notes by itself.
2. **Check your time zone.**
3. **Turn on phone reminders** with the free ntfy app (optional).

When it says **You're set up**, it shows the last two steps.

## Step 5: Connect Claude

1. In Claude, open **Settings → Connectors** and choose **Add custom connector**.
2. Name it **Notes** and paste the address the app showed you (it ends in `/mcp`).
3. A sign-in page opens. Enter your password and tap **Allow**.

Try it: *"Remind me to drink water at 3pm"*, *"Log: oatmeal and coffee"*, or *"Save a note: gift ideas for mom"*.

## Step 6: Put the app on your home screen

Open your app's address on your phone (the page you bookmarked).

- **iPhone:** tap **Share**, then **Add to Home Screen**.
- **Android:** tap **⋮**, then **Add to Home screen**.

## Good to know

- **Who can see my notes?** Only you. They live in your private GitHub repository, and the app runs in your own Cloudflare account. The person who shared this with you has no access to either.
- **Forgot your password?** Open the app and tap **Sign in with GitHub**, using the GitHub account that owns your notes. Claude still asks for the password, so to set a new one, open your Worker in Cloudflare → **Settings** → **Variables and Secrets**, edit **MCP_BEARER_TOKEN** (or **PASSWORD** if there's no MCP_BEARER_TOKEN), and save. Then reconnect Claude.
- **Typed the wrong password too many times?** Wait 15 minutes; the app locks briefly to stop guessing.
- **Change reminders or time zone later:** open the app and tap **Setup**.
- **Not getting notifications?** In the app's **Setup**, tap **Save and finish**, then **Send test notification**. If it never arrives, ntfy may be busy; switch to Pushover (a $5 app) under *Use Pushover instead*.

## For the technically curious

How it works, settings and security: [TECHNICAL.md](TECHNICAL.md).
