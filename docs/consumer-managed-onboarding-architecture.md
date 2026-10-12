# Daybook Consumer Onboarding and Managed Architecture

Status: Proposed specification, documentation only. Existing self-hosted GitHub + Cloudflare mode must remain supported.

## Product objective
Consumers should sign in on iPhone, capture their first note, and optionally connect an AI assistant without seeing GitHub, Cloudflare, repository names, Worker deployments, access tokens, or MCP configuration.
Target: first note in under three minutes. Basic note-taking must work without connecting an AI or enabling notifications.

## Product modes
| Mode | Identity | Storage | Hosting |
| --- | --- | --- | --- |
| Managed default | Daybook account (email link, passkey, or Apple where supported) | Daybook-managed isolated storage | Daybook-operated infrastructure |
| Advanced self-hosted | Existing setup | User-owned private GitHub repo | User-owned Worker |
| Optional BYO GitHub (future) | Daybook identity plus authorized GitHub OAuth | User-owned private repo | Managed service |

GitHub repo creation requires the user's explicit GitHub authorization. No silent repository creation or hidden GitHub account. Managed storage is required for truly GitHub-free onboarding. Do not promise end-to-end encryption while the server must read content for search, reminders, and MCP.

## Consumer journey
1. Open Daybook on mobile and select Continue with Apple, email sign-in link, or passkey.
2. Verify identity; atomically provision an isolated tenant and storage namespace.
3. Land directly in Capture / Today / Journal / Tasks and create a note.
4. Ask for timezone when first scheduling a reminder, prefilled and editable.
5. Offer optional notifications, with privacy-preserving lock-screen previews.
6. Offer Connect your AI as a separate guided flow showing only verified ChatGPT, Claude, or Gemini integration options supported by that client/device.
7. Settings exposes sessions, connected assistants, export, deletion, and advanced self-hosting.
Errors must be consumer-readable; retain unsent drafts and expose sync state.

## Current architecture and refactoring boundary
Current code uses src/github.ts (GithubNotes), src/setup.ts (GitHub setup), src/settings.ts (deployment or setup settings), src/web.ts (mobile API), src/index.ts (MCP), src/reminders.ts (Durable Object scheduler), and wrangler.jsonc (Worker bindings).
Extract domain logic from GithubNotes into a NotesStore interface supporting get, list with pagination, put with expectedVersion, delete with expectedVersion, and tenant scoping. Note records include opaque ID, path, Markdown content, version, createdAt and updatedAt.
Implement GitHubNotesStore as a compatibility adapter around existing GithubNotes SHA behavior, and ManagedNotesStore backed by D1 for tenant/note metadata and indexes, with R2 for blobs or archives only if needed. Define an atomic or recoverable D1/R2 write protocol. Preserve Markdown portability and stable task IDs.
Every managed request must derive tenant ID from authenticated session/grant, never from untrusted client input. Every database query, object key, cache, search index, scheduler alarm, and notification subscription must be tenant-isolated.
Existing scheduler uses a global Durable Object name in the single-user deployment. Managed mode must use tenant-specific scheduler identities and authorization boundaries, not a shared global state object.

## Managed service components
- Identity: verified email/passkeys/Sign in with Apple via a vetted provider; Secure HttpOnly cookies, CSRF protection, rotation, recovery, session revocation, and rate limits.
- Tenant API: notes, logs, journals, tasks, reminders, search, settings, import/export and deletion.
- Storage: D1 tenant metadata and revisions, optional R2 content and encrypted backups; conflict-safe writes.
- Scheduler: deterministic Durable Objects, tenant-specific alarms, retry/deduplication ledger, timezone handling, push adapter.
- MCP gateway: standard remote OAuth authorization code + PKCE, validated redirect URIs, scoped read/write grants, revocation and per-client audit.
- Notifications: opt-in managed push, ntfy or native web push as feasible; consumers must not configure ntfy topics to start using the product.
- Observability: tenant-scoped errors, quotas, cost, backup/restore status, and incident alerts without logging private note content.

## AI assistant connection
Connect your AI must be a guided, optional onboarding step, not a prerequisite. The consumer authorizes an assistant via OAuth and reviews granular permissions (notes:read, notes:write, tasks:read, tasks:write, logs:write, reminders:manage). Start read-only where possible. Support client-specific discovery and actual mobile compatibility tests before advertising one-tap connections. Expose revocation, last-access time, and consent history. No GitHub PAT or long-lived MCP bearer secret shown to consumers.

## Privacy and data ownership
Private by default; transport encryption and at-rest encryption; no claim of E2EE unless independently designed and implemented. Separate tenant keys where appropriate, secret management, cross-tenant access tests, prompt-injection defenses, export throttling, and least-privilege access. Clearly publish subprocessors, retention periods, backup deletion window, and incident response. AI context access is separately opt-in.
Export a versioned portable archive of Markdown notes, logs, journals, tasks/reminder metadata, attachments if supported, and a checksum manifest. Import validates paths, collisions, IDs, timestamps, size limits and revisions with dry-run preview. Support self-hosted-to-managed migration with source left untouched until user authorizes changes, and managed-to-self-hosted export. Account deletion revokes grants/subscriptions and removes tenant data under a published SLA.

## Proposed APIs (not implemented)
- GET /v1/me and account sessions / revocation
- GET/PUT/DELETE /v1/notes and paginated listing with version/ETag preconditions
- GET/POST/PATCH /v1/reminders and journal/log endpoints
- GET/DELETE /v1/integrations for grants and scopes
- POST /v1/exports, GET /v1/exports/:id, POST /v1/imports/preview, POST /v1/imports
- POST /v1/account/deletion
- OAuth metadata, /authorize, /token, and tenant-aware MCP endpoint
All write operations require auth, CSRF protection where applicable, validation, rate limits, idempotency keys, and optimistic concurrency.

## Delivery phases
0. Audit GithubNotes call sites, current OAuth/MCP compatibility, scheduler state, backups and threat model. Agree on storage and identity contracts.
1. Introduce NotesStore and GitHub compatibility adapter; add contract tests without breaking existing self-hosted deployment.
2. Build managed tenant storage, auth, scheduler isolation, backup/restore, quotas and cross-tenant security tests.
3. Build consumer mobile onboarding, empty-state capture, account recovery, notification preferences, export and deletion.
4. Build scoped remote MCP OAuth connection and revocation; validate supported assistants on real mobile and desktop clients.
5. Ship opt-in beta with guided migration, observability, cost monitoring, privacy policies, restore drills and incident playbooks.

## Acceptance criteria
1. New iPhone user creates first note without GitHub/Cloudflare setup.
2. Interrupted sign-up resumes without duplicate tenant.
3. Cross-tenant reads, writes, search, exports, MCP access and push delivery are denied.
4. Existing GitHub self-hosted tests remain green.
5. Logs populate daily journals on both storage backends without duplicate data.
6. Reminders survive retries, restarts, timezone changes and push outages.
7. Export and restore preserve content, metadata and stable task IDs.
8. Revoked AI grants fail immediately.
9. Account deletion and backup retention are observable and documented.
10. Session revocation works and conflicting edits cannot silently overwrite data.
11. Lock-screen notification previews are discreet by default.
12. Each advertised assistant connection is tested on supported devices.

## Open decisions
Managed D1-only vs D1+R2; auth provider; domain; storage regions; retention and encryption policy; consumer push strategy; pricing and quotas; attachments; BYO GitHub availability; operational support and compliance.

Non-goals for this documentation PR: implementing code, deploying infrastructure, changing existing repository/Worker configuration, or migrating real consumer data.