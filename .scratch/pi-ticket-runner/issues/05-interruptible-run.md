# 05: Interruptible run via /ticket-runner stop

**What to build:** The user can stop an active run with `/ticket-runner stop`. The current child is aborted and awaited, the scheduler is prevented from starting another ticket, resources are cleaned up, the lock is released, and the interruption is reported with the remaining runnable count. Cancellation is race-safe and never falsely advances a ticket.

**Blocked by:** 04 (Repository execution lock and git safety)

**Status:** resolved

- [x] `/ticket-runner stop` sets the run's cancellation flag, aborts the active child, and awaits the abort.
- [x] Stopping prevents the scheduler from starting another ticket, including when cancellation arrives just after an awaited operation.
- [x] The child subscription is removed and the child is disposed without deleting its persisted session file.
- [x] The live widget and footer are cleared, the execution lock is released, and main-session input is unblocked.
- [x] The interruption is reported with the current ticket and the number of tickets still in the runnable set.
- [x] An interrupted ticket that remains runnable is eligible on the next `start`; the runner does not retry it, mark it complete, or auto-resume its session.
- [x] No `Esc` binding is introduced; the widget advertises only the stop command.
- [x] Cancellation before a ticket, during the implementation prompt, during the completion gate, and between tickets all stop the run without starting the next ticket or writing a ticket status.
- [x] Cancellation races and cleanup ordering are covered by tests against a fake `TicketSession`.
