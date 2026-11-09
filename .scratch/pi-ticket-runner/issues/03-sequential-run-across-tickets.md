# 03: Sequential run across all runnable tickets

**What to build:** A single `start` invocation executes every runnable ticket in numeric order, one at a time, automatically skipping non-runnable tickets. Each ticket gets a fresh persistent session and must pass the completion gate plus a persisted status change before the run advances. The run stops on gate failure, a still-runnable status, session error, or reaching the per-ticket turn limit. Adds `/ticket-runner status` and concise progress reporting.

**Blocked by:** 02 (Execute one runnable ticket through the completion gate)

**Status:** ready-for-agent

- [ ] Tickets execute in ascending numeric order and every non-runnable ticket is skipped automatically.
- [ ] The ticket status is re-read from disk before each ticket and after each gate; the runner never relies on run state cached from an earlier invocation.
- [ ] Only one child session runs at a time, and each ticket receives a fresh persistent session with no inherited conversation context.
- [ ] The next ticket starts only after the previous ticket's gate returned `COMPLETE` and its persisted status is no longer runnable.
- [ ] `INCOMPLETE`, `BLOCKED`, a malformed gate answer, a still-runnable status after `COMPLETE`, and child-session errors each stop the run with a clear reason.
- [ ] Turns are counted from `turn_end` events during the implementation prompt only; reaching `maxTurnsPerTicket` aborts the child, skips the completion gate, and stops the run.
- [ ] Each child is unsubscribed and disposed between tickets without deleting its session file, and the next ticket is shown between tickets.
- [ ] Progress messages are injected as custom messages with display enabled and turn triggering disabled, and report each ticket's new status, the next ticket, and the remaining runnable count.
- [ ] The final summary distinguishes tickets that ran from tickets that were skipped and names the skip reasons.
- [ ] `/ticket-runner status` shows the active run's folder, current ticket, remaining runnable count, and session file; with no active run it re-reads the last-used folder when one exists and otherwise reports `No run active.`
- [ ] No run log, completion database, or execution-history file is written.
- [ ] Sequential ordering, skipping, gate failure, status verification, turn limits, and status reporting are covered by tests against a fake `TicketSession`.
