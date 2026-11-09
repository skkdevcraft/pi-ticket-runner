import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "./config.ts";
import { errorMessage, TicketRunnerError } from "./errors.ts";
import { loadTicketInventory } from "./tickets.ts";
import { renderTicketList } from "./ui.ts";

export const COMMAND_NAME = "ticket-runner";

const SUBCOMMANDS = ["list", "start", "status", "stop"] as const;

export type Subcommand = (typeof SUBCOMMANDS)[number];

const USAGE = `Usage: /${COMMAND_NAME} <${SUBCOMMANDS.join("|")}> [ticket-folder]`;

/** A parsed `/ticket-runner` invocation. */
export interface ParsedCommand {
  readonly subcommand: Subcommand;
  /** Ticket folder as supplied by the user; empty for `status` and `stop`. */
  readonly folder: string;
  readonly allowDirty: boolean;
}

/** Options for {@link registerTicketRunnerCommand}. */
export interface RegisterCommandOptions {
  /** Pi agent directory, source of the global configuration file. */
  readonly agentDir: string;
}

/**
 * Parse `/ticket-runner` arguments. Throws a descriptive
 * {@link TicketRunnerError} for anything the command cannot act on.
 */
export function parseCommandArgs(args: string): ParsedCommand {
  const tokens = splitCommandTokens(args.trim());
  const [subcommand, ...rest] = tokens;

  if (!subcommand) throw new TicketRunnerError(USAGE);
  if (!isSubcommand(subcommand)) {
    throw new TicketRunnerError(
      `Unknown subcommand "${subcommand}". ${USAGE}`,
    );
  }

  if (subcommand === "status" || subcommand === "stop") {
    if (rest.length > 0) throw new TicketRunnerError(`Usage: /${COMMAND_NAME} ${subcommand}`);
    return { subcommand, folder: "", allowDirty: false };
  }

  let allowDirty = false;
  const folderParts: string[] = [];
  for (const token of rest) {
    if (token === "--allow-dirty" && subcommand === "start") {
      allowDirty = true;
      continue;
    }
    if (token.startsWith("--")) throw new TicketRunnerError(`Unknown option "${token}".`);
    folderParts.push(token);
  }

  const folder = folderParts.join(" ").trim();
  if (folder.length === 0) {
    throw new TicketRunnerError(`Usage: /${COMMAND_NAME} ${subcommand} <ticket-folder>`);
  }

  return { subcommand, folder, allowDirty };
}

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

/** Split arguments on whitespace, honouring single and double quotes. */
function splitCommandTokens(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  for (const character of text) {
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (quote) throw new TicketRunnerError("Unterminated quote in arguments.");
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/** Register `/ticket-runner` with Pi. */
export function registerTicketRunnerCommand(
  pi: ExtensionAPI,
  options: RegisterCommandOptions,
): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "List and run local Markdown tickets, one fresh session per ticket",
    handler: async (args, ctx) => {
      await runCommand(pi, options, args, ctx);
    },
  });
}

async function runCommand(
  pi: ExtensionAPI,
  options: RegisterCommandOptions,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const command = parseCommandArgs(args);
    switch (command.subcommand) {
      case "list":
        runList(pi, options, ctx, command.folder);
        return;
      case "start":
      case "status":
      case "stop":
        ctx.ui.notify(
          `/${COMMAND_NAME} ${command.subcommand} is not implemented yet.`,
          "warning",
        );
        return;
    }
  } catch (error) {
    const message = error instanceof TicketRunnerError
      ? error.message
      : `Ticket runner failed: ${errorMessage(error)}`;
    ctx.ui.notify(message, "error");
  }
}

function runList(
  pi: ExtensionAPI,
  options: RegisterCommandOptions,
  ctx: ExtensionCommandContext,
  folder: string,
): void {
  const { config, warnings } = loadConfig({ cwd: ctx.cwd, agentDir: options.agentDir });
  for (const warning of warnings) ctx.ui.notify(warning, "warning");

  const inventory = loadTicketInventory({ cwd: ctx.cwd, folder });
  const content = renderTicketList(inventory, config.runnableStatuses);

  pi.sendMessage(
    { customType: COMMAND_NAME, content, display: true },
    { triggerTurn: false },
  );
}
