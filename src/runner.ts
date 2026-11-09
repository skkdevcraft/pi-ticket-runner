import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import type { TicketRunnerConfig } from "./config.ts";
import { TicketRunnerError } from "./errors.ts";
import {
  buildCompletionGatePrompt,
  COMPLETED_STATUS,
  parseGateResult,
  type GateStatus,
} from "./gate.ts";
import type {
  CreateTicketSessionOptions,
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

/** The result of trying to start the first runnable ticket. */
export type StartOutcome =
  | { readonly kind: "nothing-to-run" }
  | { readonly kind: "success"; readonly ticket: Ticket; readonly status: string }
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
  | {
      readonly kind: "status-unchanged";
      readonly ticket: Ticket;
      readonly status: string;
    };

/** Options for starting one ticket through the completion gate. */
export interface StartTicketOptions {
  /** Main project working directory, shared with the child. */
  readonly cwd: string;
  /** Pi agent directory, source of global resources. */
  readonly agentDir: string;
  /** This extension's entry path, filtered out of child resource loading. */
  readonly extensionPath: string;
  /** Main session's model, inherited by the child. */
  readonly model?: CreateTicketSessionOptions["model"] | undefined;
  /** Main session's thinking level, inherited by the child. */
  readonly thinkingLevel?: CreateTicketSessionOptions["thinkingLevel"] | undefined;
  readonly inventory: TicketInventory;
  readonly config: TicketRunnerConfig;
  readonly createSession: TicketSessionFactory;
  readonly getCommands: () => readonly SlashCommandInfo[];
  /** Re-read the ticket status from disk. Defaults to reading the ticket file. */
  readonly readStatus?: ((ticket: Ticket) => string) | undefined;
  /** Repository's completed status value, named in the gate prompt. */
  readonly completedStatus?: string | undefined;
}

/** True when the implement skill is invokable as `/skill:implement`. */
export function hasImplementSkill(commands: readonly SlashCommandInfo[]): boolean {
  return commands.some(
    (command) => command.name === IMPLEMENT_SKILL_NAME && command.source === "skill",
  );
}

/** The first ticket, in numeric order, whose status is currently runnable. */
export function selectFirstRunnableTicket(
  inventory: TicketInventory,
  runnableStatuses: readonly string[],
): Ticket | undefined {
  return inventory.tickets.find((ticket) => isRunnableStatus(ticket.status, runnableStatuses));
}

/**
 * Run the first runnable ticket through `/skill:implement` and one completion
 * gate, then verify the child actually persisted a non-runnable status.
 *
 * The runner selects automatically, never writes a ticket status, and disposes
 * the child on every path without deleting its persisted session history.
 */
export async function startFirstRunnableTicket(
  options: StartTicketOptions,
): Promise<StartOutcome> {
  const ticket = selectFirstRunnableTicket(options.inventory, options.config.runnableStatuses);
  if (!ticket) return { kind: "nothing-to-run" };

  if (!hasImplementSkill(options.getCommands())) {
    throw new TicketRunnerError(
      "Cannot start: the implement skill is not discoverable as /skill:implement. " +
        "Install the Matt Pocock skills (including to-tickets and implement), run " +
        "setup-matt-pocock-skills, and reload Pi before starting a ticket run.",
    );
  }

  const session = await options.createSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    extensionPath: options.extensionPath,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
  });

  try {
    await session.prompt(`${IMPLEMENT_PROMPT_COMMAND} ${ticket.reference}`);

    await session.prompt(
      buildCompletionGatePrompt(
        ticket.reference,
        options.config.runnableStatuses,
        options.completedStatus ?? COMPLETED_STATUS,
      ),
    );

    const gate = parseGateResult(session.getLastAssistantText());
    if (gate.kind === "malformed") {
      return {
        kind: "gate-malformed",
        ticket,
        reason: gate.reason,
        text: gate.text,
      };
    }
    if (gate.kind !== "complete") {
      return {
        kind: "gate-rejected",
        ticket,
        status: gate.status,
        reason: gate.reason,
      };
    }

    const status = (options.readStatus ?? readTicketStatus)(ticket);
    if (isRunnableStatus(status, options.config.runnableStatuses)) {
      return { kind: "status-unchanged", ticket, status };
    }

    return { kind: "success", ticket, status };
  } finally {
    session.dispose();
  }
}
