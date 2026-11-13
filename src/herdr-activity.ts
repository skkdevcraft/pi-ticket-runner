import { execFile } from "node:child_process";

import type { Ticket } from "./tickets.ts";

/** Herdr source id for reports made by a ticket run. */
const SOURCE = "ticket-runner";

/** Herdr agent label guarded by every presentation field. */
const AGENT = "pi";

/** Requests are fire-and-forget; a wedged Herdr must never hold a run open. */
const REQUEST_TIMEOUT_MS = 1500;

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

/** Options for {@link createHerdrActivity}. */
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

/**
 * Herdr drops a lower `seq`, so one process-wide counter keeps racing reports
 * ordered. Seeding it with the clock keeps it ahead of earlier processes.
 */
let sequence = Date.now() * 1000;

function nextSequence(): number {
  const value = sequence;
  sequence += 1;
  return value;
}

/**
 * Create pane activity for one run.
 *
 * Always returns an adapter: outside Herdr every method is a no-op, so callers
 * never branch on the environment. Nothing is read from the environment after
 * this call.
 */
export function createHerdrActivity(options: HerdrActivityOptions): HerdrActivity {
  const env = options.env ?? process.env;
  const pane = env.HERDR_PANE_ID;
  const bin = env.HERDR_BIN_PATH;

  if (env.HERDR_ENV !== "1" || !pane || !bin) return inactiveActivity();

  const sessionRef = sessionArguments(options.session);
  const run = options.run ?? execFileRunner(bin);

  let workingReported = false;
  let closed = false;

  const send = (args: readonly string[]): void => {
    try {
      void run(args).catch(() => {});
    } catch {
      // A missing or broken Herdr command must not disturb the run.
    }
  };

  /** The argv every request shares. */
  const base = (verb: string): string[] => [
    "pane",
    verb,
    pane,
    "--source",
    SOURCE,
    "--agent",
    AGENT,
  ];

  const stateArguments = (state: "working" | "idle"): string[] => [
    ...base("report-agent"),
    "--state",
    state,
    "--seq",
    String(nextSequence()),
    ...sessionRef,
  ];

  const metadataArguments = (activity: HerdrActivitySnapshot): string[] => {
    const { ticket, phase, remainingRunnable } = activity;
    return [
      ...base("report-metadata"),
      "--seq",
      String(nextSequence()),
      "--title",
      `${ticket.id} ${ticket.title}`,
      "--state-label",
      `working=${phase} ${ticket.id}`,
      "--token",
      `ticket=${ticket.id}`,
      "--token",
      `remaining=${remainingRunnable}`,
      "--token",
      `phase=${phase}`,
    ];
  };

  const clearArguments = (): string[] => [
    ...base("report-metadata"),
    "--seq",
    String(nextSequence()),
    "--clear-title",
    "--clear-state-labels",
    "--clear-token",
    "ticket",
    "--clear-token",
    "remaining",
    "--clear-token",
    "phase",
  ];

  return {
    update(activity) {
      if (closed) return;
      if (!workingReported) {
        workingReported = true;
        send(stateArguments("working"));
      }
      send(metadataArguments(activity));
    },
    idle() {
      if (closed) return;
      closed = true;
      // A run that stops before its first ticket must not overwrite the
      // root integration's state.
      if (!workingReported) return;
      send(stateArguments("idle"));
      send(clearArguments());
    },
  };
}

function inactiveActivity(): HerdrActivity {
  return {
    update() {},
    idle() {},
  };
}

function sessionArguments(session: HerdrActivityOptions["session"]): string[] {
  if (session.path) return ["--agent-session-path", session.path];
  if (session.id) return ["--agent-session-id", session.id];
  return [];
}

function execFileRunner(bin: string): (args: readonly string[]) => Promise<void> {
  return (args) =>
    new Promise((resolve) => {
      execFile(
        bin,
        [...args],
        { timeout: REQUEST_TIMEOUT_MS, killSignal: "SIGKILL" },
        () => resolve(),
      );
    });
}
