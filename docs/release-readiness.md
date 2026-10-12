# Release readiness — notes-server

## Verified (2026-10-11)
- PR #24 was merged; both PR GitHub Actions runs completed successfully.
- Cloudflare account contains Worker `personal-notes-mcp`, with an active 100% deployment.
- Required Cloudflare secrets `GITHUB_TOKEN` and `MCP_BEARER_TOKEN` exist (values were not accessed).
- Local Worker MCP acceptance suite covers OAuth PKCE, token refresh, tool discovery, note CRUD, reminders, scale, mobile web login, backup export and restore safeguards.

## Release blockers / unverified
- [ ] Compare production deployment artifact to current `main` commit. Worker deployment timestamps alone cannot establish commit identity.
- [ ] Authenticate to production and verify `/app/api/health` reports GitHub connectivity and reminder status.
- [ ] Test backup export and restore into a **separate empty private notes repository**. Never restore into the owner's live notes.
- [ ] Test clean install with a second account: deploy, set secrets, configure GitHub, authenticate and create/read/update/delete a note.
- [ ] Validate real ChatGPT and Claude MCP OAuth handshakes and tool use on iPhone, plus web editor. Local protocol simulation is not a substitute.
- [ ] Confirm security: unauthorized backup/restore/health rejected, GitHub repo remains private, OAuth tokens can be revoked, and no notes leak into logs.
- [ ] Confirm reminder delivery with a real notification channel; receipt/retry unit tests do not verify provider delivery.

## Go / no-go
**NO-GO for external onboarding until all release blockers are checked.** No active users allows breaking changes but does not remove the need for real-client and recovery verification.

## Production smoke sequence (non-destructive)
1. Open `https://personal-notes-mcp.clhurt1.workers.dev/app` and sign in.
2. From the authenticated browser, check the health endpoint and confirm GitHub is `ok`.
3. Export a backup, store it securely, and confirm JSON format/version.
4. Do not run restore on the live notes repository; use a separate test deployment/repository.
5. Connect each target MCP client and verify read/write with a disposable note, then delete it.
6. Inspect Cloudflare logs for errors and sensitive content, without copying tokens or note bodies into issue reports.
