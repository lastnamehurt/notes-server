# Awareness security, privacy and rollout gate

**Status: NO-GO.** This review is not permission to deploy. Owner signoff is required before enabling Awareness for users.

## Findings

| Area | Evidence / risk | Gate |
| --- | --- | --- |
| Tenant isolation | Inbox and feedback use owner-prefixed keys, but most live endpoints operate on a single `local` owner; cross-tenant HTTP/MCP authorization needs integration testing. | Block multi-tenant rollout until authenticated cross-owner attempts are rejected. |
| Consent | Preferences default to disabled, inbox-only, with external sources off. Pure scoring does not grant permission. | Block until all candidate producers and push paths enforce source consent at runtime, including revocation. |
| Data export and deletion | History has owner-local erase/prune. Awareness export completeness, all source-specific replay keys and automatic retention require verification. | Block until export/delete inventory and tests cover every persisted Awareness key, including external integrations. |
| Security | GitHub signature verification and replay helpers exist, but endpoint integration, atomic replay, secret handling and repo allowlist are outstanding. | Do not enable external ingestion until those gaps close. |
| Accessibility | Mobile inbox exists, but keyboard, screen-reader announcements, contrast, focus order, reduced motion and iPhone VoiceOver have not been audited end-to-end. | Block public release pending manual and automated accessibility checks. |
| Metrics | Collect aggregate, privacy-safe opt-in, dismiss, snooze, delivery-success/failure and false-positive rates. No note titles, text, addresses, location or credentials. | Define measurement window and thresholds before pilot. |
| Rollback | Existing `enabled=false` / `paused=true` preferences provide user opt-out; operator-wide kill switch and queued-push drain not verified. | Require a tested operator rollback procedure that disables producers and delivery without affecting reminders or briefings. |
| Reliability | Candidate pipeline, evidence retrieval, feedback ranking and adapters are partially integrated. | Require end-to-end tests on both Cloudflare DO and GitHub-backed note storage. |

## Verification matrix before release

1. **Authorization:** Alice cannot list, read, act on, or delete Bob's inbox, events, feedback, preferences or evidence; malformed owner IDs fail closed.
2. **Consent:** Default, paused, revoked, muted and disconnected source states cannot create new externally sourced suggestions or push notifications.
3. **Delivery:** Quiet hours, daily budget, cooldown, dedupe, stale candidates and disabled push all hold under concurrent requests.
4. **Privacy:** Export and delete are complete and idempotent; expired data is pruned; logs and push previews contain no private note contents.
5. **Compatibility:** Both note storage modes; reminders, Apple sync, calendar, weekly briefings and MCP continue working when Awareness is disabled.
6. **Accessibility:** Mobile viewport, screen-reader labels, keyboard actions, focus recovery, status announcements and error states are validated.
7. **Operations:** Opt-in five-user pilot, measured false positives, rollback rehearsal, incident contact and explicit owner signoff.

## Proposed staged rollout (not approved)

- **Stage 0:** Keep disabled by default; close outstanding runtime integration/security findings and validate CI, E2E and accessibility.
- **Stage 1:** With explicit owner approval, invite five consenting pilot users; inbox only, no external sources or proactive pushes.
- **Stage 2:** Evaluate the pilot for seven days against `docs/awareness-five-user-pilot.md`; stop if privacy, reliability or notification quality regress.
- **Stage 3:** Consider opt-in push only after quiet-hour, budget, delivery and rollback tests; external sources require separate security approval.

## Required signoff record

Owner: **pending**  
Approved commit / build: **pending**  
Approved stage and audience: **pending**  
Verification results and evidence: **pending**  
Rollback operator and rehearsal: **pending**  
Decision: **NO-GO until all fields are completed and the owner explicitly approves.**

This document makes no repository/deployment setting changes and enables no monitoring.
