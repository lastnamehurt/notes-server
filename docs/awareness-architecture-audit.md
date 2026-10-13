# Awareness #86 — Existing architecture and integration audit

**Issue:** #86 · **Epic:** #85 · **Design:** #84  
**Audit basis:** `main` source inspection, 2026-10-13. No runtime changes.

## 1. Current runtime topology

| Concern | Implementation | Integration consequence |
|---|---|---|
| Entry point and scheduled jobs | `src/index.ts`, exported `fetch` and `scheduled` handlers | Hourly cron executes `rescan` and `runWeeklyReview`; proactive checks can be added only after accounting for job duration, concurrency and existing scheduling. |
| Cron definition | `wrangler.jsonc`, `triggers.crons: ["7 * * * *"]` | Existing hourly cadence is unsuitable for precise sub-hour interventions. Avoid silently changing the trigger. |
| Reminder state, alarms and delivery history | `src/reminders.ts`, `ReminderScheduler` Durable Object, global instance from `src/core.ts:scheduler` | Best candidate for serializing awareness state and scheduling initial evaluations; audit storage size and alarm contention before extending. |
| Reminder parsing and rescheduling | `src/core.ts:scheduleNote`, `rescan`, `src/reminder-parse.ts` | `scheduleNote` updates reminder schedule **after** note persistence; it catches scheduling errors and returns warnings. Do not treat scheduling success as proof that a note was saved, or vice versa. |
| Notification channels | `src/reminders.ts:sendPush`, `sendNotice`, web-push subscriptions; legacy ntfy/Pushover fallback | Reuse `sendNotice` for awareness rather than sending direct HTTP push. Separate inferred nudges from explicit reminders. |
| Briefings | `src/briefing.ts` and `ReminderScheduler` methods `setBriefings`, `runBriefings`, `alarm` | Morning/evening digest already provides deterministic summaries. Awareness should aggregate or suppress overlaps instead of generating duplicate pushes. |
| Storage abstraction | `src/storage.ts:notesFor` → `AppNotes` or `GithubNotes` | Both modes share a note interface, but do **not** share transaction semantics. Awareness state should not require a GitHub notes repo. |
| App note backend | `src/app-notes.ts:NotesStore` SQLite-backed Durable Object | Supports optimistic versioning; per-app instance and note content are separate from reminder scheduler state. |
| GitHub note backend | `src/github.ts:GithubNotes` | GitHub updates use blob SHA optimistic concurrency; CLI and web edits may bypass Worker write hooks. |
| Web app API | `src/web.ts`, `/app/api/*` router | Has existing authenticated routes for note/task writes, calendar, priorities, push, briefings, and Shortcuts. Add awareness endpoints behind the same auth and mutation checks. |
| Calendar editing | `src/web.ts` `POST /calendar/task` → `src/calendar.ts:editCalendarTask` → `notes.update` | Concrete hook for reschedule detection, but note edits can also reschedule tasks; hooking only this endpoint is insufficient. |
| Apple Reminders | `src/web.ts` `/app/shortcuts/sync`, `src/apple-sync-run.ts:runAppleSync`, `src/apple-sync.ts` | Shortcut snapshot sync uses run IDs, locks and replay protection; event generation must use committed changes, not replayed requests. |
| Stable task identity | `src/task-id.ts` `^id` suffix, `src/apple-sync.ts` | Some tasks lack stable IDs until sync; line numbers and task text are unsafe durable identity for awareness. |

## 2. Confirmed write paths / event hook map

| Source | Concrete path | Suggested event boundary |
|---|---|---|
| Web note creation | `src/web.ts` `POST /note` → `notes.save` → `scheduleNote` | After successful note save; optionally diff tasks. |
| Web note editing | `src/web.ts` `PUT /note` → `notes.update` → `scheduleNote` | Compare before/after task snapshots; only emit committed changes. |
| Web note deletion | `src/web.ts` `DELETE /note` → `notes.delete` → `scheduler.removeNote` | Invalidate candidates linked to deleted tasks/notes. |
| Calendar task edits | `src/web.ts` `POST /calendar/task` → `editCalendarTask` / `notes.update` | Detect schedule moved later; exclude priority-only and completion-only edits. |
| Priority changes | `src/web.ts` `POST /priorities` → `changeTaskPriority` / `notes.update` | Emit priority change only if needed; never count as deferral. |
| MCP note tools | `src/index.ts` `save_note`, `update_note`, `complete_reminder`, `add_task` | Centralize post-commit events rather than only instrumenting web handlers. |
| Completion | `src/core.ts:completeReminder`, scheduler `markDone`; calendar completion branch | Cancel pending candidate after completion; distinguish one repeating occurrence from entire task. |
| Apple sync | `src/apple-sync-run.ts:runAppleSync` → sync plan/commit and `noteChanged` callback | Only emit after successful commit, keyed by `runId` plus task transition; avoid round-trip echoes. |
| Out-of-band edits | `src/index.ts:scheduled` hourly `rescan` of notes | A reminder rescan alone does not record before/after task changes; needs a persisted snapshot/watermark if external edits should create awareness events. |

**Critical gap:** There is no generic event log and no authoritative `task.deferred` counter. The first rule cannot safely infer “three deferrals” from current task text alone. Track transitions from old to new due dates, preserve identity, and count only genuine postponements.

## 3. Existing timing and delivery semantics

- `ReminderScheduler.reschedule` chooses the earliest reminder/briefing time and sets a single Durable Object alarm. Any new awareness due time must participate in this minimum-time calculation, or it may not fire promptly.
- `ReminderScheduler.alarm` sends due reminders, records fired state, rolls repeating reminders forward, runs briefings, then reschedules. Awareness must not delay or break this flow; isolate errors.
- Reminder delivery has `deliveredKey` and retry behavior; do not reuse a reminder key for an awareness candidate. Define stable candidate dedupe and delivery keys.
- Web push is optional. In-app inbox must remain functional without any subscription. Legacy notification fallback should be explicitly evaluated before sending unsolicited awareness notices.
- The hourly cron is a reconciliation mechanism; avoid relying on it for timely prompts.

## 4. Recommended implementation seams

1. **Contracts (#87):** Pure `AwarenessEvent`, `Candidate`, `Decision` and transition classifier with schema validation. Preserve source, owner scope, idempotency key, task ID, old/new schedule and timestamps.
2. **Storage (#88):** Start with an owner-scoped awareness store in the existing scheduler Durable Object **if** storage/concurrency audit supports it; expose methods through RPC. Keep event and candidate persistence independent of note storage mode. Do not add bindings before review.
3. **Event capture (#89):** Prefer a shared, post-commit note-task diff helper invoked from web, MCP and Apple sync paths. Track reschedules from stable IDs, not line positions. For out-of-band GitHub changes, reconcile snapshots separately; do not count an initial import as a deferral.
4. **Rule (#90):** Count a deferral only when the same open task's due date moves later. Ensure completion, deletion, recurrence and sync replay suppress stale candidates.
5. **Inbox (#91–#92):** Persist candidates and expose authenticated endpoints. Push can wait until #95; no permission prompt needed for phase 1.
6. **Interruption policy (#94):** Reuse configured timezone, existing briefings and reminder priority; deterministic quiet hours, caps and cooldown before outbound notifications.

## 5. Risks / required design decisions

| Risk | Impact | Required mitigation |
|---|---|---|
| Tasks lack stable IDs outside Apple sync | Rename/reorder can masquerade as deferral or create duplicates | Adopt or lazily assign stable IDs, preserving Markdown compatibility; migration tests. |
| Writes occur in web, MCP, Shortcuts and outside Worker | Missing events or double counting | Post-commit hooks plus periodic reconciliation with durable snapshot and source dedupe. |
| `scheduleNote` returns warnings instead of throwing | False-positive event if used as write confirmation | Capture event after confirmed storage commit, separate scheduling status. |
| Repeating tasks and occurrence completion | A changed occurrence may be mistaken for whole-task postponement | Explicit occurrence identity and due-date semantics. |
| Single Durable Object alarm for reminders and briefings | Awareness evaluation may starve critical reminders | Time budget, bounded work, independent error handling, next-alarm calculation tests. |
| Hourly cron and alarm overlap | Duplicate candidate/delivery | Durable idempotency and delivery outbox; concurrency tests. |
| Different note storage modes | Behavioral divergence | Contract tests run against both AppNotes and GithubNotes. |
| Optional push and legacy fallbacks | Surprise unsolicited notifications | Default to inbox; outbound notifications require explicit awareness opt-in. |
| Sensitive personal notes in events/logs | Privacy leakage | Store references and bounded metadata, redact errors, configurable retention. |
| Existing CI auto-deploys `main` | Unreviewed runtime changes could deploy | Keep each implementation on PR branch; merge/deploy only after approval. |

## 6. Test map

- **Existing test entry points:** `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm run test:briefings-ui`, `npm run test:app-storage` (as documented), and MCP acceptance suite.
- **Key regression fixtures:** reminder rescheduling, calendar edits, Apple sync replay, briefing timing, web push delivery, note storage parity, and authenticated API.
- **New tests needed:** due-date transition classifier; stable task identity; replay/out-of-order dedupe; external reconciliation; alarm co-scheduling; completion/delete invalidation; push disabled; timezone/DST and duplicate suppression.
- **Audit validation:** Static inspection only; no tests executed for this documentation-only issue.

## 7. Decision log and next steps

- **Decision:** Reuse existing Durable Object, scheduler and notification abstractions where safe; avoid a second notification stack.
- **Decision:** Phase 1 should create inbox candidates without outbound push.
- **Decision:** Deferral detection requires actual historical transitions; no inferred counts from one note snapshot.
- **Needs confirmation in #87–#89:** task ID rollout, event store persistence/retention design, all mutation hooks, and treatment of external GitHub edits.
- **Next:** #87 typed contracts, then #88 storage and #89 post-commit event capture.

This audit does **not** introduce application behavior, Cloudflare bindings, migrations, or deployment changes.
