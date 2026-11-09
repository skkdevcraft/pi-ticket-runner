# 06: Live TUI progress and main-session input guard

**What to build:** While a ticket runs, the active child session streams into a bounded, throttled TUI widget above the editor, and the footer tracks progress. The widget shows the current ticket, recent assistant text, tool activity, the completion-gate phase, the next ticket between runs, and the stop hint. Ordinary main-session prompts are blocked during a run so a second agent cannot race the child, while extension commands keep working.

**Blocked by:** 05 (Interruptible run via /ticket-runner stop)

**Status:** ready-for-agent

- [ ] The active child session is subscribed to assistant text deltas, tool start/end, turn end, and settled events, and the subscription is removed before disposal.
- [ ] The widget renders at most six lines: a ticket header, up to three recent assistant text lines truncated to the terminal width, one current or most-recent tool line with `running`, `success`, or `error`, and the `/ticket-runner stop` interruption hint.
- [ ] During the completion gate the header identifies the verification phase and the body shows the gate's streamed output.
- [ ] Between tickets the widget renders the next ticket instead of clearing, so a long run never looks dead.
- [ ] Widget rendering is throttled to the configured interval, and only a bounded rolling text buffer is retained in the parent process; the full child transcript is never retained or rendered.
- [ ] The footer shows the remaining runnable count and current ticket, decrements only after the gate and persisted-status check both pass, and never claims a ticket is completed.
- [ ] The footer reflects finished, stopped, and failed runs and is cleared on teardown.
- [ ] Widget and footer are cleared when the run finishes, fails, is interrupted, and when the extension shuts down or reloads.
- [ ] While a run is active, ordinary main-session prompts are handled with a notice naming the active ticket and the stop command; extension commands and runner-injected messages are unaffected.
- [ ] Widget payloads, footer payloads, throttling, bounded buffering, gate-phase rendering, next-ticket rendering, input blocking, and teardown clearing are covered by tests.
