import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "./config.ts";
import { errorMessage, TicketRunnerError } from "./errors.ts";
import type { RepositoryGuard, RepositoryGuardFactory } from "./repository.ts";
import { TicketRunState } from "./run-state.ts";
import { RunCancellation, runTickets } from "./runner.ts";
import { createTicketSession, type TicketSessionFactory } from "./sessions.ts";
import { loadTicketInventory } from "./tickets.ts";
import {
  renderActiveRun,
  renderRunOutcome,
  renderTicketList,
  renderTicketProgress,
} from "./ui.ts";

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
  /** This extension's entry path, filtered out of child resource loading. */
  readonly extensionPath?: string;
  /** Session factory, injectable so command behaviour can be tested without an LLM. */
  readonly createSession?: TicketSessionFactory;
  /** In-memory run state, injectable so status behaviour can be tested. */
  readonly state?: TicketRunState;
  /** Repository guard factory, injectable so start can be tested without Git. */
  readonly openGuard?: RepositoryGuardFactory;
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

/** Hooks shared between the command handler and an in-flight run. */
interface RunHooks {
  onGuardChange(guard: RepositoryGuard | undefined): void;
  getCancellation(): RunCancellation | undefined;
  setCancellation(cancellation: RunCancellation | undefined): void;
}

/** Register `/ticket-runner` with Pi. */
export function registerTicketRunnerCommand(
  pi: ExtensionAPI,
  options: RegisterCommandOptions,
): void {
  const state = options.state ?? new TicketRunState();
  let activeGuard: RepositoryGuard | undefined;
  let activeCancellation: RunCancellation | undefined;

  // Quitting or reloading Pi must abort the child and must never leave a
  // repository locked. The run's own cleanup releases the lock again
  // (idempotently) once the abort settles.
  pi.on("session_shutdown", () => {
    activeGuard?.release();
    activeGuard = undefined;
    void activeCancellation?.cancel();
    activeCancellation = undefined;
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "List and run local Markdown tickets, one fresh session per ticket",
    handler: async (args, ctx) => {
      await runCommand(pi, options, state, args, ctx, {
        onGuardChange: (guard) => {
          activeGuard = guard;
        },
        getCancellation: () => activeCancellation,
        setCancellation: (cancellation) => {
          activeCancellation = cancellation;
        },
      });
    },
  });
}

async function runCommand(
  pi: ExtensionAPI,
  options: RegisterCommandOptions,
  state: TicketRunState,
  args: string,
  ctx: ExtensionCommandContext,
  hooks: RunHooks,
): Promise<void> {
  try {
    const command = parseCommandArgs(args);
    switch (command.subcommand) {
      case "list":
        runList(pi, options, state, ctx, command.folder);
        return;
      case "start":
        await runStart(pi, options, state, ctx, command.folder, command.allowDirty, hooks);
        return;
      case "status":
        runStatus(pi, options, state, ctx);
        return;
      case "stop":
        await runStop(hooks, ctx);
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
  state: TicketRunState,
  ctx: ExtensionCommandContext,
  folder: string,
): void {
  const { config, warnings } = loadConfig({ cwd: ctx.cwd, agentDir: options.agentDir });
  for (const warning of warnings) ctx.ui.notify(warning, "warning");

  const inventory = loadTicketInventory({ cwd: ctx.cwd, folder });
  state.rememberFolder(folder);
  const content = renderTicketList(inventory, config.runnableStatuses);

  pi.sendMessage(
    { customType: COMMAND_NAME, content, display: true },
    { triggerTurn: false },
  );
}

async function runStart(
  pi: ExtensionAPI,
  options: RegisterCommandOptions,
  state: TicketRunState,
  ctx: ExtensionCommandContext,
  folder: string,
  allowDirty: boolean,
  hooks: RunHooks,
): Promise<void> {
  const { config, warnings } = loadConfig({ cwd: ctx.cwd, agentDir: options.agentDir });
  for (const warning of warnings) ctx.ui.notify(warning, "warning");

  const inventory = loadTicketInventory({ cwd: ctx.cwd, folder });
  state.rememberFolder(folder);

  const cancellation = new RunCancellation();
  hooks.setCancellation(cancellation);

  try {
    const outcome = await runTickets({
      cwd: ctx.cwd,
      agentDir: options.agentDir,
      extensionPath: options.extensionPath ?? DEFAULT_EXTENSION_PATH,
      inventory,
      config,
      createSession: options.createSession ?? createTicketSession,
      getCommands: () => pi.getCommands(),
      state,
      allowDirty,
      cancellation,
      onGuardChange: hooks.onGuardChange,
      ...(options.openGuard === undefined ? {} : { openGuard: options.openGuard }),
      onProgress: (progress) => {
        pi.sendMessage(
          {
            customType: COMMAND_NAME,
            content: renderTicketProgress(progress),
            display: true,
          },
          { triggerTurn: false },
        );
      },
      ...(ctx.model === undefined ? {} : { model: ctx.model }),
      ...(ctx.thinkingLevel === undefined ? {} : { thinkingLevel: ctx.thinkingLevel }),
    });

    pi.sendMessage(
      {
        customType: COMMAND_NAME,
        content: renderRunOutcome(outcome, inventory.folderLabel, config.runnableStatuses),
        display: true,
      },
      { triggerTurn: false },
    );
  } finally {
    // Every run exit path, including interruption and failure, clears the live
    // widget and footer. `state.end()` inside the runner unblocks main input.
    ctx.ui.setWidget(COMMAND_NAME, undefined);
    ctx.ui.setStatus(COMMAND_NAME, undefined);
    if (hooks.getCancellation() === cancellation) hooks.setCancellation(undefined);
  }
}

/**
 * Stop the active run. Cancellation aborts the active child and awaits the
 * abort; the sequential loop then unsubscribes, disposes, releases the lock,
 * and reports the interruption through its normal `start` outcome.
 */
async function runStop(hooks: RunHooks, ctx: ExtensionCommandContext): Promise<void> {
  const cancellation = hooks.getCancellation();
  if (cancellation === undefined) {
    ctx.ui.notify("No ticket run is active.", "warning");
    return;
  }
  await cancellation.cancel();
}

function runStatus(
  pi: ExtensionAPI,
  options: RegisterCommandOptions,
  state: TicketRunState,
  ctx: ExtensionCommandContext,
): void {
  const active = state.active;
  if (active) {
    pi.sendMessage(
      { customType: COMMAND_NAME, content: renderActiveRun(active), display: true },
      { triggerTurn: false },
    );
    return;
  }

  const folder = state.lastFolder;
  if (folder === undefined) {
    pi.sendMessage(
      { customType: COMMAND_NAME, content: "No run active.", display: true },
      { triggerTurn: false },
    );
    return;
  }

  const { config, warnings } = loadConfig({ cwd: ctx.cwd, agentDir: options.agentDir });
  for (const warning of warnings) ctx.ui.notify(warning, "warning");

  const inventory = loadTicketInventory({ cwd: ctx.cwd, folder });
  const content = `${renderTicketList(inventory, config.runnableStatuses)}\n\nNo run active.`;
  pi.sendMessage(
    { customType: COMMAND_NAME, content, display: true },
    { triggerTurn: false },
  );
}

const DEFAULT_EXTENSION_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));
