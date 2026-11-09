import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import type { TicketRunnerConfig } from "./config.ts";
import { errorMessage, TicketRunnerError } from "./errors.ts";
import {
  buildCompletionGatePrompt,
  COMPLETED_STATUS,
  parseGateResult,
  type GateStatus,
} from "./gate.ts";
import type { TicketRunState } from "./run-state.ts";
import type {
  CreateTicketSessionOptions,
  TicketSession,
  TicketSessionFactory,
} from "./sessions.ts";
import { isRunnableStatus } from "./status.ts";
import {
  readTicketStatus,
  type Ticket,
  type TicketInventory,
} from "./tickets.ts";

/** The skill command each ticket is implemented through. */
export const IMPLEMENT_SKILL_NAME = "skill:implement";

/** The explicit prompt command used to invoke the implement skill. */
export const IMPLEMENT_PROMPT_COMMAND = `/${IMPLEMENT_SKILL_NAME}`;

/** A ticket the run implemented, with the status it persisted. */
export interface RanTicket {
  readonly ticket: Ticket;
  readonly status: string;
}

/** A ticket the run skipped, with the status that made it non-runnable. */
export interface SkippedTicket {
  readonly ticket: Ticket;
  readonly status: string;
}

/** Why a run stopped before every runnable ticket was processed. */
export type RunStop =
  | {
      readonly kind: "gate-rejected";
      readonly ticket: Ticket;
      readonly status: Exclude<GateStatus, "COMPLETE">;
      readonly reason: string;
    }
  | {
      readonly kind: "gate-malformed";
      readonly ticket: Ticket;
      readonly reason: string;
      readonly text: string | undefined;
    }
  | { readonly kind: "status-unchanged"; readonly ticket: Ticket; readonly status: string }
  | {
      readonly kind: "turn-limit";
      readonly ticket: Ticket;
      readonly turns: number;
      readonly maxTurns: number;
    }
  | {
      readonly kind: "session-error";
      readonly ticket: Ticket;
      readonly phase: "create" | "implementation" | "completion-gate";
      readonly message: string;
    };

/** The final result of one `/ticket-runner start` invocation. */
export type RunOutcome =
  | { readonly kind: "nothing-to-run" }
  | {
      readonly kind: "finished";
      readonly ran: readonly RanTicket[];
      readonly skipped: readonly SkippedTicket[];
      readonly remainingRunnable: number;
    }
  | {
      readonly kind: "stopped";
      readonly ran: readonly RanTicket[];
      readonly skipped: readonly SkippedTicket[];
      readonly stop: RunStop;
      readonly remainingRunnable: number;
    };

/** Progress reported after a ticket passes the gate and persists a new status. */
export interface TicketProgress {
  readonly ticket: Ticket;
  /** The status newly persisted in the ticket file. */
  readonly status: string;
  /** The next runnable ticket in numeric order, if one remains. */
  readonly next: Ticket | undefined;
  /** Tickets still in a runnable status across the whole folder. */
  readonly remainingRunnable: number;
}

/** Options for running every runnable ticket in a folder. */
export interface RunTicketsOptions {
  /** Main project working directory, shared with every child. */
  readonly cwd: string;
  /** Pi agent directory, source of global resources. */
  readonly agentDir: string;
  /** This extension's entry path, filtered out of child resource loading. */
  readonly extensionPath: string;
  /** Main session's model, inherited by every child. */
  readonly model?: CreateTicketSessionOptions["model"] | undefined;
  /** Main session's thinking level, inherited by every child. */
  readonly thinkingLevel?: CreateTicketSessionOptions["thinkingLevel"] | undefined;
  readonly inventory: TicketInventory;
  readonly config: TicketRunnerConfig;
  readonly createSession: TicketSessionFactory;
  readonly getCommands: () => readonly SlashCommandInfo[];
  /** Re-read a ticket status from disk. Defaults to reading the ticket file. */
  readonly readStatus?: ((ticket: Ticket) => string) | undefined;
  /** Repository's completed status value, named in the gate prompt. */
  readonly completedStatus?: string | undefined;
  /** Called after each ticket persists a non-runnable status. */
  readonly onProgress?: ((progress: TicketProgress) => void) | undefined;
  /** In-memory state observable by `/ticket-runner status`. */
  readonly state?: TicketRunState | undefined;
}

/** True when the implement skill is invokable as `/skill:implement`. */
export function hasImplementSkill(commands: readonly SlashCommandInfo[]): boolean {
  return commands.some(
    (command) => command.name === IMPLEMENT_SKILL_NAME && command.source === "skill",
  );
}

/**
 * Run every runnable ticket in numeric order, one fresh persistent child
 * session at a time.
 *
 * Ticket statuses are re-read from disk before every ticket and after every
 * gate. The next ticket starts only after the gate answered `COMPLETE` and the
 * previous ticket's persisted status left the runnable set. Any gate failure,
 * unchanged status, turn-limit breach, or child-session error stops the run.
 */
export async function runTickets(options: RunTicketsOptions): Promise<RunOutcome> {
  const readStatus = options.readStatus ?? readTicketStatus;
  const runnableStatuses = options.config.runnableStatuses;
  const ran: RanTicket[] = [];
  const skipped: SkippedTicket[] = [];

  let statuses = readAllStatuses(options.inventory, readStatus);
  const initialRunnable = countRunnable(statuses, runnableStatuses);
  if (initialRunnable === 0) return { kind: "nothing-to-run" };

  if (!hasImplementSkill(options.getCommands())) {
    throw new TicketRunnerError(
      "Cannot start: the implement skill is not discoverable as /skill:implement. " +
        "Install the Matt Pocock skills (including to-tickets and implement), run " +
        "setup-matt-pocock-skills, and reload Pi before starting a ticket run.",
    );
  }

  options.state?.begin(options.inventory.folderLabel, options.inventory.tickets.length, initialRunnable);

  try {
    for (const ticket of options.inventory.tickets) {
      // Statuses are read from disk before every ticket, never from run state.
      statuses = readAllStatuses(options.inventory, readStatus);
      const status = statuses.get(ticket) ?? "";
      if (!isRunnableStatus(status, runnableStatuses)) {
        skipped.push({ ticket, status });
        continue;
      }

      const remainingRunnable = countRunnable(statuses, runnableStatuses);
      options.state?.setPosition(ticket, remainingRunnable);

      let session: TicketSession;
      try {
        session = await options.createSession({
          cwd: options.cwd,
          agentDir: options.agentDir,
          extensionPath: options.extensionPath,
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
        });
      } catch (error) {
        return stopped(
          options,
          readStatus,
          ran,
          skipped,
          {
            kind: "session-error",
            ticket,
            phase: "create",
            message: errorMessage(error),
          },
        );
      }

      options.state?.setSessionFile(session.sessionFile);

      let attempt: TicketAttempt;
      try {
        attempt = await runTicketAttempt(session, ticket, options, readStatus);
      } finally {
        // The subscription is removed inside the attempt; dispose never deletes
        // the persisted session file.
        session.dispose();
      }

      if (attempt.kind === "stop") {
        return stopped(options, readStatus, ran, skipped, attempt.stop);
      }

      ran.push({ ticket, status: attempt.status });
      statuses = readAllStatuses(options.inventory, readStatus);
      const next = firstRunnable(options.inventory.tickets, statuses, runnableStatuses);
      const remaining = countRunnable(statuses, runnableStatuses);
      options.state?.setPosition(next, remaining);
      options.onProgress?.({
        ticket,
        status: attempt.status,
        next,
        remainingRunnable: remaining,
      });
    }

    statuses = readAllStatuses(options.inventory, readStatus);
    return {
      kind: "finished",
      ran,
      skipped,
      remainingRunnable: countRunnable(statuses, runnableStatuses),
    };
  } finally {
    options.state?.end();
  }
}

interface TicketAttemptSuccess {
  readonly kind: "success";
  readonly status: string;
}

interface TicketAttemptStop {
  readonly kind: "stop";
  readonly stop: RunStop;
}

type TicketAttempt = TicketAttemptSuccess | TicketAttemptStop;

/**
 * Run one ticket's implementation prompt, completion gate, and persisted-status
 * verification. The subscription exists only for this attempt and is removed
 * before the caller disposes the session.
 */
async function runTicketAttempt(
  session: TicketSession,
  ticket: Ticket,
  options: RunTicketsOptions,
  readStatus: (ticket: Ticket) => string,
): Promise<TicketAttempt> {
  const maxTurns = options.config.maxTurnsPerTicket;
  let phase: "implementation" | "completion-gate" = "implementation";
  let turns = 0;
  let turnLimitReached = false;
  let abortPromise: Promise<void> | undefined;

  const unsubscribe = session.subscribe((event) => {
    if (phase !== "implementation" || event.type !== "turn_end") return;
    if (turnLimitReached) return;

    turns += 1;
    if (turns >= maxTurns) {
      turnLimitReached = true;
      abortPromise = session.abort().catch(() => {});
    }
  });

  const turnLimitStop = (): TicketAttemptStop => ({
    kind: "stop",
    stop: { kind: "turn-limit", ticket, turns, maxTurns },
  });

  try {
    try {
      await session.prompt(`${IMPLEMENT_PROMPT_COMMAND} ${ticket.reference}`);
    } catch (error) {
      if (turnLimitReached) {
        await abortPromise;
        return turnLimitStop();
      }
      return sessionError(ticket, "implementation", error);
    }

    if (turnLimitReached) {
      await abortPromise;
      return turnLimitStop();
    }

    phase = "completion-gate";
    try {
      await session.prompt(
        buildCompletionGatePrompt(
          ticket.reference,
          options.config.runnableStatuses,
          options.completedStatus ?? COMPLETED_STATUS,
        ),
      );
    } catch (error) {
      return sessionError(ticket, "completion-gate", error);
    }

    const gate = parseGateResult(session.getLastAssistantText());
    if (gate.kind === "malformed") {
      return {
        kind: "stop",
        stop: { kind: "gate-malformed", ticket, reason: gate.reason, text: gate.text },
      };
    }
    if (gate.kind !== "complete") {
      return {
        kind: "stop",
        stop: { kind: "gate-rejected", ticket, status: gate.status, reason: gate.reason },
      };
    }

    const status = readStatus(ticket);
    if (isRunnableStatus(status, options.config.runnableStatuses)) {
      return { kind: "stop", stop: { kind: "status-unchanged", ticket, status } };
    }

    return { kind: "success", status };
  } finally {
    unsubscribe();
  }
}

function sessionError(
  ticket: Ticket,
  phase: "implementation" | "completion-gate",
  error: unknown,
): TicketAttemptStop {
  return {
    kind: "stop",
    stop: { kind: "session-error", ticket, phase, message: errorMessage(error) },
  };
}

function stopped(
  options: RunTicketsOptions,
  readStatus: (ticket: Ticket) => string,
  ran: readonly RanTicket[],
  skipped: readonly SkippedTicket[],
  stop: RunStop,
): RunOutcome {
  const statuses = readAllStatuses(options.inventory, readStatus);
  return {
    kind: "stopped",
    ran,
    skipped,
    stop,
    remainingRunnable: countRunnable(statuses, options.config.runnableStatuses),
  };
}

function readAllStatuses(
  inventory: TicketInventory,
  readStatus: (ticket: Ticket) => string,
): Map<Ticket, string> {
  const statuses = new Map<Ticket, string>();
  for (const ticket of inventory.tickets) statuses.set(ticket, readStatus(ticket));
  return statuses;
}

function countRunnable(
  statuses: ReadonlyMap<Ticket, string>,
  runnableStatuses: readonly string[],
): number {
  let count = 0;
  for (const status of statuses.values()) {
    if (isRunnableStatus(status, runnableStatuses)) count += 1;
  }
  return count;
}

function firstRunnable(
  tickets: readonly Ticket[],
  statuses: ReadonlyMap<Ticket, string>,
  runnableStatuses: readonly string[],
): Ticket | undefined {
  return tickets.find((ticket) =>
    isRunnableStatus(statuses.get(ticket) ?? "", runnableStatuses),
  );
}
