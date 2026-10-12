# Daybook briefings and the AI layer

**Status:** Phase 1 (deterministic morning and evening briefings) and the AI read/configure tools are built. Later phases are proposals.

## 1. What this is for

Daybook should tell you what matters at the start and end of the day without you opening it, and an AI assistant should be able to talk you through it. The rule from the original proposal still holds: **timing and state are deterministic; AI only explains and proposes.** If no AI is connected, everything here still works.

## 2. What changed from the original proposal, and why

The first version of this spec proposed an AI communications service inside the Worker: an LLM provider abstraction, a spend budget, an intent parser, a confirmation flow, a chat UI, a job registry with CRUD, a dead-letter queue and ten new endpoints. Most of that is replaced by something Daybook already has.

| Original proposal | What we do instead | Why |
|---|---|---|
| LLM provider inside the Worker, with model allowlist, spend caps and output validation | The **connected assistant** (Claude or any MCP client) is the AI layer. The Worker exposes read-only data through `prepare_briefing`, like `prepare_weekly_review` already does | No API key or bill on the Worker, no provider to maintain, and note content never reaches a model that holds write tools on the server side |
| In-app conversational assistant: natural language → intent → confirmation → task edit | Already exists: you ask Claude, Claude calls Daybook's MCP tools, and your client shows each tool call for approval | Rebuilding chat, intent parsing and confirmation would duplicate a working path |
| Job registry with CRUD, revisions per job, delivery channel per job | Two fixed briefings (morning, evening) in one settings object with a revision number | One person, two digests. A registry is worth it only once there are many job types |
| Separate `deadline_nudge` and `overdue_digest` jobs | Folded into the briefings: overdue is a section of both | Fewer notifications, which was itself a goal of the spec |
| Quiet hours | Not built | Every send is one the owner scheduled. Quiet hours matter once the system sends things on its own initiative |
| `ownerId`, per-user budgets, cross-user isolation | One deployment per person (the existing model) | Isolation comes from separate Workers and repositories, not from code paths |
| Dead-letter queue and delivery history endpoint | Last result per briefing (sent, skipped, failed with reason), shown in Settings | Enough to see what happened; a queue needs a reader |
| ntfy as the briefing channel | Whichever provider is configured: Pushover or ntfy | Owners use either; the reminder sender already handles both |
| Apple Reminders as one-way, two-way out of scope | Two-way sync exists separately (PR #58); routing of task alerts is left to that work | Avoids coupling this change to an unmerged branch |

## 3. Phase 1: deterministic briefings (built)

**What each briefing says** (`src/briefing.ts`, pure and tested):

- **Morning:** overdue one-off tasks, everything due today with times (including each occurrence of repeating tasks), and `@priority:do` tasks not already listed.
- **Evening:** how many things were marked done today (from the day's log), what's still open today, overdue items, and tomorrow.
- A day with nothing to report sends nothing.
- Lists are capped at four items with "+N more", titles at 60 characters, and the whole message stays under Pushover's 1,024-character limit.
- **Lock-screen privacy:** `preview: "counts"` sends only numbers ("2 overdue · 3 due today"). The default is `"full"`, matching how reminders already show their text.
- Journal entries are never summarized. Only task lines, reminders, done marks and `✓` log lines are read.

**When it goes out** (`src/reminders.ts`, the existing scheduler Durable Object, so there is still one scheduler):

- The next send time for each enabled briefing is stored, and the Durable Object alarm wakes for whichever comes first: a reminder or a briefing.
- Times are local wall-clock times in `NOTES_TIMEZONE`. Across DST, a time in the hour clocks skip goes out an hour later (2:30am becomes 3:30am), and a time in the repeated hour sends once.
- **Effectively once per day:** a "sent" mark per briefing per local date is recorded after the push provider accepts it, so retries and restarts never resend.
- **Retries:** a failed send retries every 5 minutes, up to 6 tries, then gives up for that day with the reason recorded.
- A briefing more than two hours late (the Worker was asleep or failing) is skipped rather than sent at an odd hour.
- Turning a briefing off, or changing its time, replaces its pending send.
- Briefings run after reminders in the same alarm, and their failures are caught separately, so they can never block or delay a reminder.

**Settings** live in the Durable Object with a revision number. A save with a stale revision is refused (409), so two open tabs can't overwrite each other.

**Interfaces:**

- App, Settings → **Daily briefings**: on/off and time for each, lock-screen preview choice, Save, **Preview** (builds it now from live notes without sending) and **Send test** (at most one a minute).
- Web API (session-authenticated, same-origin): `GET /app/api/briefings`, `PUT /app/api/briefings` with `{ settings, revision }`, `POST /app/api/briefings/preview` and `POST /app/api/briefings/test` with `{ kind }`.
- MCP: `prepare_briefing` (read-only digest for the assistant to narrate) and `configure_briefings` (turn on or off, set times, set preview).

The weekly review now sends through the same shared notification sender as briefings instead of its own copy of the Pushover and ntfy code. Its schedule and content are unchanged.

## 4. The AI layer: the connected assistant

When you ask Claude "what's on today?", it calls `prepare_briefing` and narrates the result. "Move the flight task to tomorrow at 9" goes through the existing note tools, with your client's approval step. Rules carried over from the original spec:

- Tool descriptions tell the assistant that task text is data, not instructions.
- `prepare_briefing` is read-only. Nothing is stored unless you ask.
- The Worker never calls a model, so a model outage can't affect any scheduled send.

A morning narration can be automated with an assistant's own scheduling (for example a scheduled task in Claude that calls `prepare_briefing` each morning) without adding anything to the Worker.

## 5. Later phases (proposals)

- **Task alert routing with Apple Reminders.** Once two-way sync is merged and has run reliably, add a setting to send task alerts through Apple Reminders only, falling back to push if the last successful sync is older than a day. Keep briefings on push.
- **Early deadline nudges.** If wanted, an optional "remind me N hours before" per task, written in the task line so it stays in the notes.
- **Quiet hours,** if the system ever starts sending things the owner didn't schedule.

## 6. Acceptance criteria (Phase 1)

1. A briefing goes out at its local time, at most once per local date, across retries and restarts. *(scheduler tests)*
2. DST changes neither duplicate nor skip a day. *(briefing tests)*
3. A provider outage retries, then records a visible failure; it never affects reminders. *(scheduler tests)*
4. Disabling a briefing stops its pending send; a stale settings save is refused. *(scheduler tests; `npm run test:briefings-ui`)*
5. Counts-only mode keeps task titles out of the notification. *(briefing and scheduler tests; `npm run test:briefings-ui`)*
6. Tapping the notification opens Daybook's Today screen after sign-in; the link carries no credentials. *(`npm run test:briefings-ui`)*
7. With no AI connected, everything above works unchanged.
8. Existing reminders and the weekly review keep working. *(full test suite, MCP acceptance)*
