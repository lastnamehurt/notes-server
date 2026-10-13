# Awareness integration tests

Run `npm ci`, `npx playwright install chromium`, then `npm run test:awareness`.
Set `CHROMIUM_PATH` to use an existing Chromium installation if needed.
The dedicated Awareness integration workflow also runs this suite on pull requests.

The suite starts the actual Daybook Worker in local workerd, with SQLite-backed
ReminderScheduler and NotesStore objects and real OAuth/PKCE MCP requests. A mobile
Chromium page loads the real app and saves consent through the real API. Apple
Reminders is simulated at the iPhone Shortcut HTTP boundary: snapshots, returned
actions, replayed run IDs, and due-date changes. It does not automate an iPhone or
exercise Apple's native permissions dialog. The notes backend tested here is app
storage; the existing MCP acceptance suite separately covers the GitHub backend.

Each run uses random local ports and a private temporary config and persistence
directory. It neither reads nor overwrites `.dev.vars` or `.wrangler/state`, and
never deploys. A local notification sink records delivery requests, acknowledges
successful sends, or drops its response after receipt to simulate uncertain delivery.
The suite closes its servers and removes its state after completion. Tests run in
sequence to follow one installation through consent changes and a process restart;
a second fresh installation verifies isolation.

Coverage:

- Session, same-origin, Shortcut bearer and MCP authentication; rejected preferences
  leave the previous settings intact.
- Awareness off, pause, Daybook source off, Apple source off, and Apple-only consent.
- Connected postponements across web, MCP and Apple create one inbox item with three
  distinct evidence IDs; replay, echoes and unchanged writes do not duplicate it.
- Concurrent web/MCP edits accept one revision; a failed edit contributes no evidence.
- Mobile consent saves without asking for notification permission.
- Inbox/digest modes, quiet hours, zero daily budget, source revocation, missing push
  configuration, snooze, mute, dismissal and cooldown prevent delivery.
- Concurrent delivery attempts contact the provider once. Both acknowledged and
  uncertain sends keep their reservations through a full Worker process restart.
- Preferences, note data, inbox actions and notification history survive restart.
  Separate installations cannot read each other's data. Notification bodies and
  history do not expose the private task title.

Native Daybook deferral metadata remains available while Awareness is off, as before;
rules require current consent. Apple-originated metadata is captured only while
Awareness and the Apple source are enabled and unpaused. Rule evaluation excludes
any currently disabled source, and delivery rechecks the provenance of native
three-deferral suggestions. Historical Apple events from older versions that were
incorrectly labelled Daybook cannot be reliably reclassified.
