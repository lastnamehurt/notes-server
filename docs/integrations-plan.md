# Integrations plan

Status: proposal. Principle: the AI assistant is the main way in. Daybook builds only the integrations that must arrive on time without the user asking.

## Shipped today

- **Awareness:** the three-deferrals rule, an inbox (dismiss, snooze, mute), preferences, delivery by web push.
- **Reminders and briefings:** `@schedule` reminders with a Done button; optional morning and evening briefings; weekly review (on request and on Sundays).
- **Notes and tasks:** tagged daily logs, goal notes, task priorities, in-app day calendar.
- **Apple Reminders:** two-way sync through an iPhone Shortcut.
- **Assistants:** Claude and ChatGPT (confirmed, OAuth); Cursor install link.
- **Platform:** Cloudflare hosting and updates; optional GitHub storage and sign-in; web push, with ntfy and Pushover kept as fallbacks.
- **Diagnostics:** `check_health`.

## Build in Daybook

1. **Calendar via ICS link.** Works with Google, Outlook and iCloud without sign-in setup. Feeds briefings and the "event soon, task unfinished" rule. Uses the existing `calendar.changed` contract.
2. **Finish Apple Reminders.** Separate imported changes from user actions to prevent loops.
3. **Quick capture.** iPhone Shortcut and share sheet: "Save to Daybook" from any app, plus Siri.
4. **Email-in address.** Forwarded email becomes an inbox note (Cloudflare Email Routing).

## Assistant connections

5. Claude, ChatGPT and Cursor (existing). Copy-paste setup for Claude Code, Codex and Gemini CLI (`aidev` work, branch `feat/daybook`, not yet pushed).

## Leave to the assistant's own connectors

Gmail, Slack, GitHub, Todoist, Linear, Notion, health apps. The assistant reads these when asked and saves what matters into Daybook.

## Not planned yet

- GitHub PR and CI status (`github.status` contract exists; no adapter).
- Task-manager sync (Todoist, Linear, Jira, Asana).
