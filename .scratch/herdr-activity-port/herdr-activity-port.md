# HerdrActivity port

Status: ready-for-agent

Make an active ticket run visible to Herdr. While `/ticket-runner start` is
running, the Herdr pane should show the agent `pi` as `working`, name the ticket
being processed, and return to `idle` when the run stops. Herdr must remain an
optional integration: outside Herdr nothing changes, and a Herdr failure never
affects a run.

## Context

- `herdr-agent-state.ts` is installed and overwritten by Herdr at
  `~/.pi/agent/extensions/herdr-agent-state.ts`. It only reports the root TUI
  session (`ctx.mode === "tui"`) and is not ours to edit.
- Every child session created by `src/sessions.ts` is a separate `AgentSession`
  with its own extension runner in mode `"print"` and its own `EventBus`
  (`DefaultResourceLoader` creates one when none is passed). Child sessions
  therefore cannot report themselves and the parent cannot emit into their bus.
- Herdr models **one agent per pane with one lifecycle authority**. A report
  from a new source takes the pane's authority from the previous source.
  `pane.report_metadata` is the sanctioned display-only channel that does not
  take authority.
- During a run the root session is idle: `src/command.ts` blocks ordinary main
  session prompts and the run is detached from the command handler. Herdr would
  otherwise show `idle` for the whole run.

## Decision

Add a small port in the parent extension, fed by the existing `RunObserver` in
`src/command.ts`, with one Herdr-specific adapter behind it.

- The port speaks in ticket-run terms. The adapter owns the Herdr env gate, the
  CLI invocation, the `seq` contract, authority handoff, metadata, and error
  swallowing.
- Use `HERDR_BIN_PATH` and the documented `herdr pane report-agent` /
  `herdr pane report-metadata` CLI. Do not copy the socket protocol from
  `herdr-agent-state.ts`; the CLI is the portable, documented interface and a
  run sends only a handful of requests.
- Report semantic state under a new source, `ticket-runner`, with agent name
  `pi`. Taking authority for the run is deliberate: a run is the pane's work.
  The root integration reclaims the pane on its next `agent_start`.
- Do not report from child sessions, and do not change child resource loading.

## Interface

New module `src/herdr-activity.ts`.

```ts
import type { Ticket } from "./tickets.ts";

/** What the Herdr seam needs to know about the active ticket run. */
export interface HerdrActivitySnapshot {
  /** Ticket being implemented or verified. */
  readonly ticket: Pick<Ticket, "id" | "title">;
  /** Tickets still in a runnable status, including this one. */
  readonly remainingRunnable: number;
  /** Which half of the ticket attempt is running. */
  readonly phase: "implementing" | "verifying";
}

/**
 * Herdr pane activity for one ticket run.
 *
 * The first `update` reports the pane `working`; every `update` refreshes the
 * display metadata. `idle` reports `idle`, clears the metadata, and closes the
 * port. Both methods are synchronous and best effort: they never throw and
 * never block the run.
 */
export interface HerdrActivity {
  update(activity: HerdrActivitySnapshot): void;
  idle(): void;
}

export interface HerdrActivityOptions {
  /** Root Pi session, attached to herdr reports for session restore. */
  readonly session: {
    readonly id?: string | undefined;
    readonly path?: string | undefined;
  };
  /** Environment holding Herdr's injected variables. Default: `process.env`. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Command seam for tests. Default: `execFile` on `HERDR_BIN_PATH`. */
  readonly run?: ((args: readonly string[]) => Promise<void>) | undefined;
}

export type HerdrActivityFactory = (options: HerdrActivityOptions) => HerdrActivity;

export function createHerdrActivity(options: HerdrActivityOptions): HerdrActivity;
```

`createHerdrActivity` always returns an adapter. When Herdr is not available it
returns a no-op adapter, so callers never branch on the environment.

## Enablement

An adapter is live only when all of these are non-empty in the supplied
environment:

- `HERDR_ENV === "1"`
- `HERDR_PANE_ID`
- `HERDR_BIN_PATH`

Otherwise every method is a no-op and no process is spawned. Nothing is read
from the environment after the factory call.

## Commands

Constants: `source = "ticket-runner"`, `agent = "pi"`, `pane = HERDR_PANE_ID`,
`bin = HERDR_BIN_PATH`.

The first accepted `update` sends state, then metadata:

```text
<bin> pane report-agent <pane> --source ticket-runner --agent pi \
  --state working --seq <n> [--agent-session-path <path>]
```

`--agent-session-path` is preferred; fall back to `--agent-session-id`, and
omit both when the root session has neither. The session reference is constant
for a run and is attached to every state report.

Every `update` then sends metadata:

```text
<bin> pane report-metadata <pane> --source ticket-runner --agent pi --seq <n> \
  --title "<id> <title>" \
  --state-label working="<implementing|verifying> <id>" \
  --token ticket=<id> --token remaining=<n> --token phase=<implementing|verifying>
```

`idle` sends state, then clears metadata:

```text
<bin> pane report-agent <pane> --source ticket-runner --agent pi \
  --state idle --seq <n> [session ref]

<bin> pane report-metadata <pane> --source ticket-runner --agent pi --seq <n> \
  --clear-title --clear-state-labels \
  --clear-token ticket --clear-token remaining --clear-token phase
```

Notes:

- `--agent pi` guards the presentation fields against the pane's agent label.
  Do not set `--applies-to-source`: during a run this adapter *is* the
  authority.
- Do not set `display_agent`. The title, state label, and tokens carry the
  ticket identity; renaming the agent adds noise and one more field to clear.
- Titles and labels are capped at 80 characters by Herdr. Pass them as single
  argv entries through `execFile`, never through a shell, so ticket titles need
  no quoting.
- No TTL. A crash mid-run can leave the title until the next report or pane
  close; a TTL would also blank a legitimate long ticket mid-run. State is
  still correct because `report-agent` is not TTL'd.

## Invariants

1. **Never throws.** A failing or missing Herdr command is swallowed. A run must
   succeed exactly as it would without Herdr.
2. **Never blocks.** `update` and `idle` return synchronously. Requests are
   spawned and forgotten with a short timeout (1500 ms, `SIGKILL`); no awaiting,
   no retry, no logging into the ticket transcript.
3. **Working once.** Only the first accepted `update` reports `working`.
   Subsequent updates send metadata only and leave the state alone.
4. **Idle is terminal.** After `idle`, the adapter is closed: later `update`
   calls are ignored, so a late milestone can never report `working` again.
   `idle` is idempotent.
5. **No stray idle.** `idle` before any accepted `update` spawns nothing. A run
   that stops before its first ticket (preflight, cancellation, `nothing-to-run`)
   must not overwrite the root integration's state.
6. **Ordered within a call.** State is reported before metadata on the first
   `update`; state is reported before metadata is cleared on `idle`.
7. **Strictly increasing `seq`.** A module-level counter starts at
   `Date.now() * 1000` and increments for every state and metadata request, so
   it is monotonic across adapters in one process and across reloads. Herdr
   drops reports with a lower `seq`, which keeps a racing clear or refresh
   correct.

## Wiring

Changes in `src/command.ts`:

1. Add `herdrActivity?: HerdrActivityFactory` to `RegisterCommandOptions`;
   default to `createHerdrActivity` in `runStart`.
2. Add a `setHerdr(activity: HerdrActivity | undefined)` hook alongside the
   existing `setFooter` / `setFrames` hooks, so shutdown can reach the adapter.
3. In `runStart`, create the adapter after the inventory loads and before the
   `try` around `runTickets`, from
   `ctx.sessionManager.getSessionFile()` and `getSessionId()`.
4. Drive it from the existing observer:
   - `ticketStarted(ticket, remainingRunnable)` →
     `update({ ticket, remainingRunnable, phase: "implementing" })`.
   - `gateStarted(ticket)` → `update(...)` with `phase: "verifying"` and the
     last `remainingRunnable` seen by the observer.
5. Call `idle()` first in the `finally` of `runStart`, and also from the
   existing `session_shutdown` handler through the stored adapter, before
   cancelling the run. Both paths are idempotent.
6. Clear the stored adapter after teardown like the footer and frames.

No changes to `src/runner.ts` or `src/sessions.ts`: the port is a parent-side
observer, and child sessions stay unaware of Herdr.

## Tests

`tests/herdr-activity.test.ts`, using an injected `run` that records argv:

- Any missing env variable (including `HERDR_ENV` not `"1"`) → no requests.
- First `update` → one `report-agent working` with pane, source, agent, `seq`,
  and session path, then one `report-metadata` with the expected title, state
  label, and tokens.
- Second `update` → metadata only; no second `working`.
- `idle` → `report-agent idle` then the metadata clear flags; a later `update`
  spawns nothing; a second `idle` spawns nothing.
- `idle` with no prior `update` → no requests.
- `seq` strictly increases across state and metadata requests.
- Session path wins over id; id is used when there is no path; both absent is
  allowed.
- A `run` that rejects, or throws synchronously, is swallowed; no unhandled
  rejection and no throw from `update`/`idle`.

`tests/command.test.ts` additions, with an injected fake factory:

- `finished`, `stopped`, `session-error`, and `nothing-to-run` outcomes all end
  with `idle` (and `nothing-to-run` sends no `update`, hence a no-op idle).
- `gateStarted` updates the phase.
- `session_shutdown` calls `idle` before cancelling.
- A `start` with a missing implement skill runs the `finally` path (`idle` is
  a no-op because no ticket was reported), the thrown error is unchanged, and
  nothing is spawned.

## Acceptance

- In Herdr, `herdr agent list` shows `pi` as `working` for the duration of a run,
  the pane title/label names the current ticket, and the pane returns to `idle`
  after finish, stop, gate failure, error, or quit.
- Outside Herdr (or in headless modes), no process is spawned and all tests
  still pass.
- `npm test` and `npm run typecheck` pass.

## Out of scope

- Per-child agents in Herdr. Herdr has no subagent concept; the alternative is
  one Herdr pane per child, which would replace the in-process session-frame
  design.
- `blocked`. Children run headless (`mode: "print"`), so no approval UI reaches
  the pane. Add `blocked(message)` to the port only if children gain a
  herdr-visible decision surface.
- A progress fraction (`2/5`) in metadata. `RunObserver.ticketStarted` exposes
  only `remainingRunnable`; a total would require `runTickets` to report the
  initial runnable count. Use `remaining=<n>` for now.
- Editing `herdr-agent-state.ts` or emitting a `pi.events` bridge for upstream
  Herdr. A future upstream change could let Herdr subscribe to run activity
  natively; it would replace the adapter, not the port.

## Risks

- While `ticket-runner` holds the pane, the session reference and resume command
  stored by `herdr:pi` are not authoritative. The adapter reports the root
  session path/id on every state request so restore still targets the user's
  session. `herdr:pi` reclaims authority on its next `agent_start`; until then
  the pane shows `pi` idle, which is visually identical to the normal state.
- A hard kill mid-run leaves display metadata behind. It is cosmetic and is
  replaced or cleared on the next run or pane close.

## Domain docs

This decision is recorded in `docs/adr/0001-herdr-pane-activity.md`, and
**Pane activity** is defined in `GLOSSARY.md`. `HerdrActivity` itself is a port
name, not a ticket-runner domain term.
