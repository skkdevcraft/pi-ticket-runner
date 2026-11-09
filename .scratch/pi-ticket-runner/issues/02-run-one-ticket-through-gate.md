# 02: Execute one runnable ticket through the completion gate

**What to build:** `/ticket-runner start <ticket-folder>` selects the first runnable ticket and runs it end-to-end in a fresh persistent child session. The child is asked to implement the ticket through the installed `implement` skill, then receives one completion-gate prompt. The run succeeds only when the gate answers `COMPLETE` and the ticket file's status is no longer runnable. This is the tracer bullet for ticket execution; sequential continuation, locking, git checks, interruption, and the live TUI arrive in later tickets.

**Blocked by:** 01 (Ticket inventory and read-only listing)

**Status:** ready-for-agent

- [ ] `start` validates the folder and ticket statuses before creating a session, and reports `Nothing to run` without creating one when no ticket is runnable.
- [ ] The runner verifies that a command named `skill:implement` from a skill source is discoverable; if not, it stops with a descriptive error before prompting, never falling back to a plain message.
- [ ] The first runnable ticket is selected automatically, with no selection dialog or confirmation.
- [ ] The child session is fresh and persistent, uses the main project's working directory, model, and thinking level, keeps default coding tools, and filters only this extension out of resource loading.
- [ ] The child is prompted with `/skill:implement <ticket-reference>`, where the reference is the ticket path relative to the project root; the implementation prompt is awaited until the run settles.
- [ ] After the implementation prompt settles, one completion-gate prompt is sent to the same child, interpolating the configured runnable statuses and naming the repository's completed value.
- [ ] The gate result is read from the final assistant message as the last case-insensitive `STATUS:` line, tolerating emphasis and code fences but not unknown values; missing, contradictory, or unrecognized results stop the run.
- [ ] `COMPLETE` alone does not advance the run: the ticket file is re-read and the run stops unless its status is no longer in `runnableStatuses`.
- [ ] The runner never writes a ticket status and never treats the gate's self-assessment as independent verification.
- [ ] The child is disposed without deleting its persisted session history, and the outcome is reported in the main session.
- [ ] A `TicketSession` port isolates session creation, prompting, aborting, subscribing, final-assistant-text access, and disposal; gate outcomes and failure paths are tested against a fake implementation.
