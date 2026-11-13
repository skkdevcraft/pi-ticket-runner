# Herdr pane activity is reported by the parent ticket run

Status: accepted

A ticket run is the work a Herdr pane is doing, so the parent extension reports
the pane's `idle`/`working` state and display metadata for the whole run through
a small `HerdrActivity` port. Child sessions cannot report for themselves: each
is a separate `AgentSession` with its own print-mode extension runner and event
bus, Herdr gives a pane one lifecycle authority, and the managed
`herdr-agent-state.ts` is overwritten by Herdr. Reporting from the parent keeps
the seam in one place and leaves the runner and child sessions unchanged.

## Considered Options

- **Let child sessions report.** Rejected: children run headless, have isolated
  extension runtimes and event buses, and would contend with each other and the
  root integration for one pane's authority.
- **Patch or bridge `herdr-agent-state.ts`.** Rejected: the file is managed and
  overwritten by Herdr, and the only bus event it consumes is `herdr:blocked`,
  which cannot express `working`.
- **Run each child in its own Herdr pane.** Rejected: that replaces the
  in-process session-frame design, and Herdr has no subagent concept.
- **Report from the parent.** Chosen: the parent already sees every run
  milestone and owns the root session reference.

## Consequences

- The adapter reports under `source=ticket-runner`, so it takes the pane's
  lifecycle authority for the duration of the run; `herdr:pi` reclaims it on its
  next `agent_start`. Root session identity rides on every state report so Herdr
  restore still targets the user's session.
- Herdr stays optional: without `HERDR_ENV`, `HERDR_PANE_ID`, and
  `HERDR_BIN_PATH` the port is a no-op.
- Display metadata is best effort and can linger after a hard kill. Semantic
  state is unaffected because state reports are not TTL'd.
