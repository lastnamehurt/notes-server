# Daybook Awareness — Email and Location Feasibility

**Decision date:** 2026-10-13  
**Scope:** Feasibility assessment only. No provider connection, mailbox monitoring, location collection, or notifications are enabled by this document.

## Decision summary

| Source | Decision | Reason |
| --- | --- | --- |
| Email | **No-go for initial Awareness rollout** | Broad mailbox permissions, token lifecycle, provider verification and private-content processing are disproportionate to first-wave task reminders. Revisit only after the task-native pipeline and explicit consent are reliable. |
| Location | **No-go for background/location-triggered Awareness in mobile web/PWA** | iOS browser/PWA geolocation is foreground, permission-dependent and not a reliable background geofence service. Continuous location collection would add major privacy and battery concerns. |
| Foreground location check | **Conditional research only; not approved to ship** | A user-initiated, one-time coarse location lookup might be feasible through the browser Geolocation API, but only if a concrete user-facing feature justifies it and permission is requested in context. |

## Email providers and least privilege

### Gmail

- Gmail API read-only access would typically require the restricted `https://www.googleapis.com/auth/gmail.readonly` scope to inspect message contents. `gmail.metadata` is a narrower alternative for headers/labels, but is still restricted and cannot read message bodies. The `gmail.modify` and `mail.google.com` scopes are not appropriate for a passive Awareness source.
- A production OAuth integration would need a clearly identified OAuth client, authorization-code flow, refresh-token protection, revocation/disconnect behavior, minimal requested scope and potentially Google's restricted-scope verification/security-assessment requirements.
- Gmail push notifications use `users.watch` with Google Cloud Pub/Sub and periodic watch renewal; they are **not** a direct push channel to an iPhone PWA. Pub/Sub ingress must authenticate messages and de-duplicate history IDs.
- Even metadata can reveal senders, subjects, relationships and schedules. Do not transmit subjects, message bodies or sender addresses to an LLM or third-party notification provider by default.

### Microsoft 365 / Outlook

- Microsoft Graph `Mail.ReadBasic` is narrower than `Mail.Read` for basic message metadata; `Mail.Read` permits reading message contents. Avoid `Mail.ReadWrite` and `Mail.Send` for read-only Awareness.
- Delegated permissions, tenant/admin consent policy, refresh tokens and Graph change-notification subscriptions introduce significant operational and enterprise-policy complexity.
- Webhook subscription endpoints require validation and renewal; event delivery can be delayed or repeated. Treat notification receipt as a hint to re-fetch state with an authorized token, not as a trusted event body.

### Minimum acceptable email design (if revisited)

1. Explicit source-specific opt-in, off by default, and per-provider disconnect.
2. Prefer narrowly selected labels/folders or user-created rules rather than unrestricted inbox scanning.
3. Keep OAuth credentials in private server-side secrets/storage; never in app HTML, client-side storage, GitHub Markdown or logs.
4. Use encrypted token storage, credential rotation, authenticated webhooks, owner-scoped dedupe and 30-day-or-shorter event retention.
5. Never include message content or addresses in generic push previews; provide a clear explanation and delete-source-data control.
6. Verify each provider's current API permissions, approval requirements and webhook documentation before implementation; scopes and policies can change.

## Location: platform reality and privacy

- Browser Geolocation API requires HTTPS/secure context and an explicit browser/OS permission decision; denial must be a fully supported path.
- A foreground web page may call `navigator.geolocation.getCurrentPosition` following a clear user action. This does **not** provide dependable background geofencing when the iPhone is locked, the browser is suspended, or the PWA is closed.
- Service workers and Web Push cannot reliably request device location in the background. Push permission does not grant location permission.
- A native iOS app could use Core Location region monitoring under platform-specific permission, review and battery restrictions, but that is a separate product, consent and security decision.
- Avoid storing raw coordinates, location history, home/work inference or third-party location analytics. A one-time foreground check should ideally process locally, discard precise coordinates immediately, and explain the purpose before requesting permission.
- Denied, unavailable, inaccurate, timed-out and revoked permissions must not degrade notes, reminders, briefings or MCP.

## Threat model

| Risk | Mitigation required before reconsideration |
| --- | --- |
| Excessive mailbox access | Narrow scopes, selected folders, short retention, consent and disconnect |
| Leaked OAuth refresh tokens | Encrypted private storage, rotation, revocation, no client exposure |
| Forged/replayed provider callbacks | Signature or token verification, owner binding, replay barrier |
| Cross-user suggestion leakage | Owner-scoped storage and access checks; isolated tests |
| Sensitive push previews | Generic notifications without email content or location |
| Location tracking and inference | No background tracking, no location history, ephemeral foreground-only use |
| Sync loops / stale signals | Stable source IDs, idempotency, revalidation before suggesting |
| Unavailable APIs / revoked permission | Fail closed and preserve existing app behavior |

## Go/no-go gates

**Current decision: NO-GO for email and location ingestion.** No new runtime permissions or API endpoints should be introduced as part of issue #101.

Reconsider email only after: (a) task-native Awareness candidate production works end-to-end, (b) independent privacy review and provider policy verification, (c) scoped OAuth/token lifecycle and deletion design, (d) owner-isolated tests and an explicit pilot use case with measurable benefit.

Reconsider location only for a **user-initiated foreground** use case with a clear benefit, contextual permission request, no persistent coordinates, and successful denial/revocation tests. Background geofencing requires a separate native-app proposal.

## Acceptance and regression checks

- Documentation-only PR: no `src/`, Worker route, secrets, cron, deployment configuration or permission changes.
- Existing reminder, briefing, storage and MCP behavior stays unchanged by construction.
- Reviewer checks that scopes, platform limitations, opt-out/deletion, consent and risks are documented, and no external provider is called.
- Revalidate provider documentation immediately before any future implementation; this document is an architecture decision, not an assertion that credentials or provider access have been configured.
