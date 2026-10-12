# Apple Reminders ↔ Daybook: two-way sync requirements

**Status:** Future phase; specification only. One-way Daybook → Apple Reminders remains the first release. Do not disable ntfy until notification coverage is verified. This document does not imply that iOS integration or two-way sync is implemented.

## Goals and scope

- Keep private GitHub Markdown notes as the durable Daybook task store.
- Support create, edit, reschedule, complete, and reopen from either Daybook or Apple Reminders.
- Sync titles, notes, due dates and times, priorities, completion state, and supported recurrence rules.
- Preserve local timezone and daylight-saving semantics; avoid silent date shifts.
- No third-party task-sync service, public notes repository, or transfer of GitHub credentials to Apple Reminders.
- Support iPhone and Apple Watch through Apple's native Reminders app.

## Architecture decision

The Cloudflare Worker cannot directly invoke Apple's on-device EventKit APIs. A native iOS companion using EventKit is the recommended long-term two-way sync agent, with explicit Reminders permission. A Shortcuts-only proof of concept may implement limited polling, but **do not promise reliable background two-way reconciliation or immediate sync with Shortcuts**. Research and verify iOS background execution constraints before choosing the final transport.

Daybook must expose an authenticated, least-privilege sync API; the device agent reads a change feed, applies mutations to Apple Reminders, reads local changes, and posts them back. Device credentials must be revocable and distinct from the main Daybook password/GitHub token. Use HTTPS; do not put secrets in URLs or logs.

## Identity and mapping

- Add a persistent opaque `taskId` to each task. **Do not use `notePath:lineNumber` as the durable ID**: inserting or moving lines changes it.
- Define an unobtrusive, backward-compatible Markdown ID representation and migration strategy for existing tasks. Avoid changing user-visible task titles.
- Maintain a mapping `taskId ↔ calendarItemIdentifier` per Apple Reminders account/list/device, with an additional app-owned marker when feasible. EventKit identifiers may change; design recovery using the marker, not titles alone.
- Never deduplicate solely by title, due date, or line number. Distinct tasks can have identical titles.
- On reinstall, lost local state, or device migration, reconcile existing reminders before creating anything.

## Sync protocol

- Versioned schema: taskId, revision/ETag, updatedAt, origin/device ID, title, body, due date/time, timezone, priority, completedAt, recurrence, deletion/tombstone status.
- Read API: paginated incremental changes using an opaque cursor; include tombstones and stable ordering. Cursor expiration triggers safe full reconciliation.
- Write API: idempotent batch upserts/completions/deletions with operation IDs and per-task expected revisions (optimistic concurrency). Return per-item outcomes and new revisions.
- Authenticate, authorize and rate-limit both endpoints. Reject unknown task IDs or stale revisions without silently overwriting.
- Ensure GitHub Markdown writes preserve unrelated edits and existing formatting. Retry conflicts by rereading the current SHA and reconciling, not blind overwrites.
- Explicit initial-sync direction: Daybook wins when connecting a new Reminders list; do not import unrelated personal reminders. Only synchronize the dedicated Daybook list.

## Conflict and lifecycle policy

- Acknowledge every applied revision so an echoed update is not treated as a new user edit; prevent sync loops.
- If only one side changed, propagate it. If both changed since the last shared revision, flag a conflict and preserve both values; never silently discard changes.
- Completion and reopening are first-class state transitions. Record the originating side and timestamp; define behavior when a task is completed on one side and edited on the other.
- Deletions require tombstones and a retention window. Do not immediately erase Daybook tasks because an Apple reminder disappears or permission is revoked.
- Support edits, task moves between notes, recurring occurrences, and reminder-list changes without creating duplicates.
- Recurrence: explicitly map supported Daybook rules to EventKit recurrence; unsupported schedules remain in Daybook and show a clear sync warning. Distinguish series edits from one-occurrence completion.
- Preserve all-day dates vs timed due dates, locale, timezone and DST transitions.

## Security and privacy

- Ask for Reminders access only when enabling sync; provide disconnect and revoke flows.
- Sync only the dedicated Daybook list, with user confirmation before destructive operations.
- Encrypt device-held credentials in Keychain. Minimize task content in diagnostic logs; never log tokens.
- Define revocation, lost-device recovery, data export, and deletion behavior.
- The Worker remains the only GitHub writer; never distribute the GitHub PAT to the device.
- Explicitly disclose that synced tasks become subject to the user's Apple/iCloud Reminders settings and retention.

## Reliability and user experience

- Surface last successful sync, pending changes, failures, conflicts and permission status.
- Retry network failures with exponential backoff; apply changes idempotently after interruptions.
- Work offline with a local queue, then reconcile on reconnect.
- Document iOS background scheduling limitations; provide manual **Sync now**.
- Provide a safe dry-run/preview before initial reconciliation, plus a pause-sync control.
- Monitor delivery latency, duplicates, conflicts, and failed writes without recording task content.

## Acceptance tests / release gates

1. Initial import: 100+ Daybook tasks produce exactly one Apple reminder each, even after repeated runs and device restart.
2. Same-title tasks remain distinct; moving Markdown lines/notes does not change task identity.
3. Create, edit, reschedule, complete and reopen on **both** sides converge without echo loops.
4. Simultaneous edits raise a visible conflict without data loss.
5. Offline edits, rate limits, expired tokens, GitHub SHA conflicts, and interrupted batches recover without duplicates.
6. All-day and timed tasks preserve local time across DST boundaries and timezone changes.
7. Recurring series and occurrence completion behave according to documented rules.
8. Revoked Reminders permission or disconnected device does not delete Daybook tasks.
9. Reinstall/reconnect maps existing reminders instead of duplicating them.
10. Private notes, auth tokens and unrelated Apple Reminders lists are not exposed or modified.

## Phased rollout

- **Phase 1 (current):** One-way Daybook → Apple Reminders, deduplication, due dates, scheduled/manual sync and tests.
- **Phase 2:** Persistent task IDs, authenticated incremental API, sync mapping and conflict-safe writes.
- **Phase 3:** Native iOS EventKit companion with permission flow, bidirectional edits/completion and reconciliation.
- **Phase 4:** Reliability soak test and user-approved retirement of ntfy for covered task alerts; retain alternative notification path for non-task alerts if needed.

## Open decisions before implementation

- Whether an iOS companion is acceptable for two-way sync, or limited Shortcuts functionality is preferred.
- Conflict-resolution UI and policy for simultaneous changes.
- Whether tasks created directly in the dedicated Apple Reminders list should be imported into Daybook automatically.
- How recurring tasks map to completed instances and series-level edits.
- Whether a separate per-device sync token is required for multiple devices (recommended).
