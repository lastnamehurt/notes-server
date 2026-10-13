# Daybook Awareness: five-user pilot and acceptance plan

**Status:** proposed; not launched. Do not turn on push or invite users without approval.

## Eligibility and consent

Recruit five adult volunteers with separate private Daybook installations. Explain that Awareness suggestions are experimental, opt-in, and stored in each user's own Durable Object. Participation must not require notifications: start with inbox-only mode, and request explicit consent separately before testing proactive pushes. Do not collect note contents, task titles, account tokens, location, or personal identifiers in pilot reports.

## Sequence

1. **Baseline (days 1–2):** confirm setup, task capture, inbox rendering, existing reminders/briefings, and notification permission denial on iPhone and desktop. Confirm Awareness is off by default.
2. **Inbox pilot (days 3–5):** volunteers enable inbox-only Awareness, create and postpone tasks, inspect the explanation, dismiss and snooze. Record whether any suggestions actually appear; currently some producer wiring remains unfinished.
3. **Optional push (days 6–7):** only with explicit opt-in, verify quiet hours, two-per-day budget, cooldown, delivery on one device, denied permission, offline provider and retry ambiguity. Never require push participation.
4. **Exit:** users can pause, disable, erase Awareness history, and keep notes/reminders. Ask for usefulness feedback and whether suggestions were distracting.

## Metrics (aggregate counts only)

| Metric | Definition | Pilot target |
| --- | --- | --- |
| Setup completion | Volunteers reaching private Daybook inbox / 5 | 5/5 |
| Awareness opt-in clarity | Users who correctly understand that push is optional / 5 | 5/5 |
| Relevance | Helpful suggestions / all rated suggestions | ≥70% |
| False or stale suggestions | Suggestions about completed, changed, or irrelevant tasks / all shown | ≤5% |
| Duplicate pushes | Same candidate delivered more than once per user | 0 |
| Quiet-hours violations | Push received during configured quiet hours | 0 |
| Push budget violations | More than configured daily limit | 0 |
| Inbox reliability | Successful loads / attempted loads | ≥99% |
| Reminder regression | Existing reminder/briefing delivery failures caused by Awareness | 0 |
| Erasure | Test user can delete Awareness data without deleting notes | 5/5 |

Capture only counts, error categories, browser/device family and optional free-text feedback after volunteers redact private content. Do not centralize raw note or task data.

## Test matrix and rollout gates

- Automated: `npx playwright test test/e2e/awareness.spec.ts` covers 390×844 mobile inbox, settings, dismissals, permission denial, and errors using in-memory API responses.
- Existing `npm test`, `npm run typecheck`, `npm run check:html` and reminder/briefing tests must pass.
- Before real pilot: add a Worker-backed end-to-end flow for both GitHub and Durable Object storage, actual event → candidate → inbox production, provider failure/duplicate handling, and mobile Safari/manual testing.
- **Stop rollout** for unexpected push without opt-in, cross-owner data exposure, duplicate delivery, quiet-hour violation, or loss of reminders. Roll back Awareness delivery without altering stored notes.

## Exit decision

Go only if all privacy and delivery gates pass, all five participants can disable the feature, and relevance meets the target. Otherwise document failure modes and repeat with inbox-only mode.
