# Daybook AI communications and scheduled-task layer

**Status:** Architecture and product requirements — proposed, not implemented.  
**Scope:** Daybook's existing Cloudflare Worker, Durable Object reminder scheduler, private GitHub Markdown notes, MCP tools, ntfy/Pushover, and planned one-way Apple Reminders sync.

## 1. Product intent

Make Daybook a proactive personal assistant without relying on an LLM for correct timing or state transitions. The **deterministic scheduler** owns task deadlines, recurring rules, retries and delivery. An optional **AI communications layer** explains priorities, produces contextual briefings, and interprets user requests into validated commands. **ntfy** remains an outbound notification channel for briefings and intelligent follow-ups; Apple Reminders provides native task notifications and task-list UI.

Initial use cases:
- Morning agenda and evening wrap-up with due/overdue tasks, priorities, upcoming appointments if an authorized calendar source exists, and unfinished commitments.
- Event-driven notifications for newly urgent tasks, upcoming deadlines, and overdue follow-ups.
- Weekly reviews using existing `src/weekly-review.ts` data, with optional AI interpretation.
- Conversational capture: “Remind me to review my spending every Friday at 6 PM,” followed by structured validation, confirmation when ambiguous, and creation through existing Daybook tools.
- Suggested rescheduling or task decomposition, **never automatic task mutation without user authorization**.

## 2. Existing system and integration points

- `src/reminders.ts`: `ReminderScheduler` Durable Object; push dispatch through `sendPush`, supporting ntfy or Pushover.
- `src/core.ts`: `scheduler`, `scheduleNote`, `rescan`, `completeReminder`, settings.
- `src/reminder-parse.ts`: date, time, repeat and timezone parsing.
- `src/priorities.ts`: Markdown checkbox tasks and Eisenhower priorities.
- `src/weekly-review.ts`: deterministic weekly review construction.
- `src/index.ts`: authenticated MCP operations; `src/web.ts`: authenticated mobile web application.
- `src/github.ts`: private repository storage. GitHub is durable content storage, **not a high-frequency scheduling queue**.

Do not create a second competing scheduler. Extend the existing Durable Object with a versioned schedule registry and dispatch ledger, or use a separate Durable Object for briefing orchestration only if isolation is justified. Keep per-user state isolated; no global cross-user task context.

## 3. Architecture

```text
User / Daybook UI / MCP
          |
          v
Authenticated Daybook API -> private GitHub notes (source of truth)
          |
          v
Task parser + deterministic scheduler (Durable Object)
          |
          +----> Apple Reminders one-way task sync (separate, opt-in)
          |
          +----> Briefing/event job queue + idempotency ledger
                              |
                     Context builder (allowlisted)
                              |
                  +-----------+------------+
                  |                        |
           Template renderer         Optional LLM provider
                  |                        |
                  +-----------+------------+
                              |
                      Output validation
                              |
                    ntfy / Pushover adapter
                              |
                       Deep link to Daybook
                              |
                      Authenticated conversation
```

**Key separation:** AI cannot decide whether an alarm is due or whether a job has been delivered. If the model fails, deterministic notifications still work.

## 4. Scheduled jobs and delivery semantics

Define a persisted job with: `jobId`, `ownerId` (or isolated deployment key), `kind`, `schedule`, `timezone`, `enabled`, `nextRunAt`, `lastRunAt`, `lastResult`, `revision`, `deliveryChannel`, `quietHours`, `createdAt`, `updatedAt`.

Job kinds:
- `morning_brief`: opt-in, user-configured time; recommended default 08:00 local.
- `evening_review`: opt-in, user-configured time; recommended default 19:00 local.
- `weekly_review`: reuse current deterministic Sunday review and avoid duplicate sends.
- `deadline_nudge`: configurable offsets, e.g. 24 hours or 1 hour before deadline; no redundant alert if Apple Reminders already covers the same task unless opted in.
- `overdue_digest`: batch overdue items rather than sending one notification per item.
- `follow_up`: one-time, explicitly approved check-in tied to a task or project.

Use the Durable Object alarm mechanism for wakeups and persist job state. Calculate future occurrences in the user's IANA timezone and define DST behavior (skip nonexistent wall times; choose one occurrence for repeated wall times). Use a delivery key `ownerId:jobId:scheduledOccurrence` to prevent duplicate dispatch. Record attempt count, status, provider response, and next retry. Retry transient errors with capped exponential backoff; dead-letter permanent failures for diagnostics. Exactly-once provider delivery cannot be guaranteed; provide **effectively-once** behavior with deduplication, bounded retries and visible status.

When a schedule is edited or disabled, invalidate old pending occurrences. Honor quiet hours except user-designated critical reminders; no AI-generated “emergency” classification.

## 5. AI communications service

Optional model adapter behind a feature flag, with a provider-neutral interface:
- Input: explicit job intent, timezone, current time, compact authorized task summary, relevant deadlines, recent opt-in context, user communication preferences.
- Output: validated structured JSON such as `{headline, summary, items:[{taskId, reason, suggestedAction}], deepLink}`. Renderer controls final notification format and length.
- No unrestricted repository dump, raw secrets, GitHub tokens, credentials, or unrelated private notes sent to the model.
- Enforce input size, maximum output tokens, model allowlist, request timeout, monthly cost budget and rate limits.
- Treat Markdown note content as **untrusted data**. Ignore prompt-injection instructions embedded in notes; model has no direct tools for mutation or external messaging.
- If inference fails, times out, exceeds budget or returns invalid output, send a deterministic template (or skip optional AI-only suggestions), with diagnostic status.
- Do not imply LLM-generated facts are verified; include source task IDs and deep links in UI.
- Configure data retention and provider privacy policy explicitly before enabling; AI defaults **off**.

Context builder should prioritize open tasks due soon, priority:do, recently changed tasks, and user-selected project scopes. Avoid making health, finance, or relationship inferences from journal entries without specific opt-in.

## 6. Conversation and user actions

ntfy is **one-way transport**, not a two-way chat API. A push opens a signed or ordinary HTTPS **Daybook deep link**; authentication is required before showing private content or executing actions. A short-lived notification token may identify the intended conversation, but must not authorize mutation on its own.

Daybook conversation UI (future) supports:
- Natural language -> typed intent -> parser/validator -> proposed action -> confirmation if ambiguous or destructive -> authenticated Daybook API/MCP operation.
- Allowed operations: create/update/reschedule task, set priority, mark complete, snooze, create briefing schedule, opt out.
- Separate read and write permissions; log actor, intent, validation, outcome and timestamp without storing raw sensitive prompts by default.
- Clarify ambiguous dates (“next Friday”), timezone, recurrence, and affected task.
- Idempotency keys for repeated messages/taps; optimistic concurrency for GitHub Markdown writes; conflict response instead of silent overwrite.
- No background AI action that independently marks tasks done, sends third-party messages, or modifies unrelated notes.

Example interaction:
1. ntfy: “Daybook morning: 3 due today; 1 priority:do. Review plan.”
2. Tap -> Daybook /app with the agenda context (after authentication).
3. User: “Move the flight task to tomorrow at 9.”
4. Daybook identifies the task, shows a proposed edit, applies after confirmation and reindexes scheduled reminders.

## 7. Channel routing and coexistence with Apple Reminders

| Event | Default channel | Notes |
| --- | --- | --- |
| Single task due | Apple Reminders when verified; otherwise existing ntfy/Pushover | Avoid dual alerts unless explicitly enabled |
| Morning/evening digest | ntfy | Deep link to Daybook |
| Weekly AI review | ntfy | Optional AI summary; deterministic fallback |
| AI follow-up suggestion | ntfy, opt-in | Rate-limited and actionable |
| Sync error or missing permissions | Daybook status; optional ntfy | Do not leak task contents into error alerts |

Keep `sendPush` behavior backward-compatible during migration. Channel preferences are per user, per event type. Disabling ntfy for task reminders **must not** disable ntfy briefings. If Apple Reminders sync is stale or unverified, do not silently suppress critical due-date alerts.

## 8. Privacy, security and operational safeguards

- Private GitHub repositories remain source of truth. Worker secrets stay in Cloudflare secrets; no model-facing tokens.
- Authenticated, scoped API for notification settings, job CRUD, job status, preview, and conversational actions.
- Notification payloads can appear on a lock screen: default to discreet previews and allow title-only/redacted modes.
- Separate device subscription credentials and revocation where feasible; never embed long-lived bearer credentials in deep links.
- Per-user timezone, locale, quiet hours, notification budget, and AI opt-in.
- Rate-limit briefings and nudges (configurable daily maximum), coalesce related notifications, and provide pause/snooze.
- Track job execution and provider delivery metadata, but minimize logging of task/journal text.
- Explicit retention period and deletion controls for conversation history and model inputs.
- Do not let a malicious note trigger arbitrary tool calls or data exfiltration.

## 9. APIs and data contracts (proposed)

- `GET /app/api/communications/settings` — channel preferences, quiet hours, AI opt-in, budgets.
- `PUT /app/api/communications/settings` — validate and save settings.
- `GET /app/api/communications/jobs` — schedules and last outcomes.
- `POST /app/api/communications/jobs` — create a schedule with idempotency key.
- `PATCH /app/api/communications/jobs/:id` — pause, resume, reschedule.
- `POST /app/api/communications/preview` — deterministic preview without dispatch.
- `POST /app/api/communications/test` — explicit test delivery, rate-limited.
- `POST /app/api/assistant/interpret` — structured proposed action, read-only until confirmation.
- `POST /app/api/assistant/execute` — authenticated confirmed action with revision guard.
- `GET /app/api/communications/history` — delivery attempts and errors.

All write endpoints require same-origin/session/CSRF defenses and input validation. The proposed routes are not currently implemented.

## 10. Phased delivery

**Phase 0 — baseline:** Inventory existing reminder/weekly-review jobs, define channel routing and notification privacy defaults. Add tests for current dispatch before refactoring.

**Phase 1 — deterministic briefings:** Durable Object schedule registry, morning/evening digest builder, ntfy adapter, quiet hours, deduplication, retries, settings UI, manual preview/test. No LLM required.

**Phase 2 — optional AI narration:** Provider abstraction, allowlisted context builder, structured output validation, spend caps, deterministic fallback, explicit opt-in.

**Phase 3 — conversational assistant:** Daybook mobile chat/deep links, structured intents, confirmation, task CRUD through existing APIs, audit and conflict handling.

**Phase 4 — Apple Reminders routing:** Deduplicate task due alerts between Apple and ntfy based on verified sync health; keep ntfy for briefings and conversations.

## 11. Acceptance criteria

1. Scheduled morning brief fires at configured local time and no more than once per occurrence under retries/restarts.
2. DST spring/fall transitions and timezone changes do not produce duplicate or missed daily digests.
3. An ntfy outage causes bounded retries and visible failure status, without dropping task state.
4. Model outage, invalid output, disabled AI, or exceeded budget never blocks deterministic scheduled reminders.
5. Two simultaneous settings changes are revision-safe; disabling a schedule prevents future dispatch.
6. Quiet hours and notification caps are enforced; lock-screen previews respect privacy settings.
7. Each notification deep link opens the correct Daybook context after authentication; link alone cannot modify data.
8. Note prompt-injection attempts cannot trigger arbitrary actions, leak credentials, or change notification recipients.
9. Daybook task due alerts are not duplicated across Apple Reminders and ntfy unless explicitly opted in.
10. AI-generated proposed task edits require validated, authenticated execution and conflict-safe persistence.
11. Setup for a new consumer uses their own private repository and isolated schedule state.
12. Existing ntfy/Pushover reminder flows and weekly reviews remain functional throughout migration.

## 12. Decisions to confirm

- Whether Daybook should ship with deterministic briefings enabled or opt-in only (recommend opt-in).
- Preferred LLM provider, privacy/retention terms, and per-user monthly spend ceiling.
- Whether briefings may summarize journal logs by default (recommend no).
- Default notification times, quiet hours, and maximum daily nudges.
- Consumer deployment model: dedicated Worker per consumer vs shared multi-tenant service. Do not assume shared state is safe.
- Conversation storage/retention and whether AI chat must be accessible through MCP as well as the mobile UI.

**Non-goals for first release:** autonomous decision-making, continuous AI polling, direct ntfy replies, two-way Apple Reminders sync, and removing existing notification providers.
