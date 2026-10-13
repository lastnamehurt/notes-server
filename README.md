# Daybook — Your own private notes app

Ask Claude to remember things, set reminders that buzz your phone, and log meals, meds and moods. Everything is saved to **your own private space**: nobody else can read it, including whoever sent you this link.

It's free, takes about 10 minutes, and needs no coding. You'll tap through a few pages; this page tells you exactly what to tap.

This repository also includes the **`note` / `notes` command-line client** for your local notes clone. See [CLI installation and usage](CLI.md).

**[🌐 Daybook website](https://lastnamehurt.github.io/notes-server/)** · **[🚀 Install Daybook](https://daybook-installer.clhurt1.workers.dev)**

## What you need

- A phone or computer with a web browser
- Claude (the free plan works)
- About 10 minutes

You'll make one free account along the way: **Cloudflare**, which runs your app. It doesn't ask for a credit card. No GitHub account is needed.

## Step 1: Install your app

Open the **[Daybook installer](https://daybook-installer.clhurt1.workers.dev)** and follow its three steps:

1. **Make a free Cloudflare account** (or skip if you have one). Confirm your email.
2. **Give Daybook a key to your account.** Tap **Create my key**, scroll down, tap **Continue to summary**, then **Create Token**, and copy the key into the installer. (The button fills in exactly what's needed.)
3. **Choose your address and a password** (at least 12 characters; save it in your phone's password manager), then tap **Install Daybook**.

When it says **You're done**, tap **Open my app** and bookmark the page.

<details><summary>Prefer to keep a copy of the code in your own GitHub? (the original way)</summary>

Make free accounts at [github.com/signup](https://github.com/signup) and [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up), make up a password, then tap:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lastnamehurt/notes-server)

Allow it to connect GitHub, paste your password where it asks for **PASSWORD**, tap **Create and deploy**, then **Visit**. Updates for copies made this way go through GitHub (see [Updating](#updating)).
</details>

## Step 2: Finish setup in your app

Enter your password on the page that opened.

The app walks you through the rest:

1. **Choose where your notes live.** Keep the default, **In this app**: nothing else to set up. Or pick **In my GitHub, as files** if you want history, Obsidian or the `note` command line; then tap **Connect GitHub**, **Copy code and open GitHub**, paste the code, tap **Continue** and **Authorize**, and come back.
2. **Check your time zone.**
3. **Turn on phone reminders** (optional): tap **Turn on notifications** and allow them. No extra app. On iPhone, add Daybook to your Home Screen first (Step 4) and do this from the Home Screen app; it needs iOS 16.4 or newer.

When it says **You're set up**, it shows your Claude connection address and buttons, and how to add the app to your home screen.

## Step 3: Connect Claude

1. In Claude, open **Settings → Connectors** and choose **Add custom connector**.
2. Name it **Daybook** and paste the address the app showed you (it ends in `/mcp`).
3. A sign-in page opens. Enter your password and tap **Allow**.

Using ChatGPT or Gemini instead? See [docs/ai-assistants.md](docs/ai-assistants.md) for what's supported.

Try it: *"Remind me to drink water at 3pm"*, *"Log: oatmeal and coffee"*, or *"Save a note: gift ideas for mom"*.

## Step 4: Put the app on your home screen

Open your app's address on your phone (the page you bookmarked).

- **iPhone:** tap **Share**, then **Add to Home Screen**.
- **Android:** tap **⋮**, then **Add to Home screen**.

For a quick tour of the app on your phone, see [QUICKSTART-MOBILE.md](QUICKSTART-MOBILE.md).

## Updating

When a new version is out, your app shows **An update is available** on Today and in **Settings**. Nothing changes until you choose to update: tap **Update now**. Your app installs the new version itself and reloads in a moment. Your notes, password and settings stay as they are.

If **Update now** says your app's Cloudflare key no longer works (for example, you deleted it), open the [installer](https://daybook-installer.clhurt1.workers.dev), make a new key, and tap **Update it**.

Made your copy with the Deploy to Cloudflare button instead? **Update now** starts the update in your copy on GitHub (it asks once which repository is yours) and the app reloads when it's live, in about three minutes. If your notes are kept in the app, tap **Open Update Daybook**, then **Run workflow** and the green **Run workflow** button. If GitHub asks you to enable workflows the first time, tap the button to enable them.

## Good to know

- **Who can see my notes?** Only you. Kept in the app, they're stored in your own Cloudflare account; kept on GitHub, they're Markdown files in your own private repository. Either way, your own app reads them to answer you and Claude. They're not end-to-end encrypted, and the person who shared this with you has no access to either account.
- **What does the installer's key do?** It lets the installer set up your app, and lets your app install updates when you tap **Update now**. It only covers apps and their storage in your Cloudflare account. The installer passes it straight to Cloudflare and doesn't keep it; your app keeps a copy in your own account. You can delete it any time in Cloudflare (**My Profile → API Tokens**); your app keeps working, it just can't update itself until you make a new one in the installer and tap **Update it**.
- **Can I get my notes out?** Yes. In **Settings**, tap **Download all my notes** for a zip of your notes as Markdown (.md) files, in the same folders, any time.
- **Can I move them to GitHub later?** Yes. In **Settings**, open **Move my notes to GitHub** and connect your GitHub. Every note is copied into a new private repository called **daybook-notes**, and saved there from then on.
- **What does Connect GitHub give the app?** GitHub shows it as access to your repositories, because GitHub's sign-in can't be limited to one. Daybook only ever reads and writes your notes repository, and the key is kept in your own Cloudflare account, not by anyone else. If you have other private repositories you'd rather keep out of reach, use **Use an access key instead** and give the key access to your notes repository only.
- **Connect GitHub depends on a small GitHub app called "Notes server".** If that app were ever removed, the app would ask you to connect again; your notes stay safe in your repository. You can see or revoke its access any time in GitHub → Settings → Applications.
- **Forgot your password?** Set a new one in Cloudflare: open **Workers & Pages**, tap your app (**daybook**), then **Settings → Variables and Secrets**, edit **PASSWORD** (or **MCP_BEARER_TOKEN** if you have one), and save. Then reconnect Claude. If your notes are on GitHub, you can also open the app with **Sign in with GitHub** under the password box.
- **Typed the wrong password too many times?** Wait 15 minutes; the app locks briefly to stop guessing.
- **Change reminders or time zone later:** open the app and tap **Settings**.
- **Not getting notifications?** Open the app's **Settings** on that phone and tap **Send test notification**. If it says notifications aren't on, tap **Turn on notifications**. On iPhone, use the Daybook app on your Home Screen (not a Safari tab), and check **iPhone Settings → Notifications → Daybook**. Each phone or computer turns them on separately.
- **Used ntfy or Pushover before?** They still work, but they're no longer offered for new setups. Turn on notifications on your phone in **Settings**; reminders then go there instead, and you can untick ntfy or Pushover under the older option.

## For the technically curious

How it works, settings and security: [TECHNICAL.md](TECHNICAL.md).
