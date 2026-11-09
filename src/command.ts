import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";

import { loadConfig } from "./config.ts";
import { errorMessage, TicketRunnerError } from "./errors.ts";
import { RunFooterView, type RunObserver } from "./live-view.ts";
import type { RepositoryGuard, RepositoryGuardFactory } from "./repository.ts";
import { TicketRunState } from "./run-state.ts";
import { RunCancellation, runTickets, type RunOutcome } from "./runner.ts";
import {
  FRAME_ENTRY_TYPE,
  type SessionFrameSummary,
} from "./session-frame.ts";
import {
  findFrameEntryId,
  SessionFrameController,
  SessionFrameRegistry,
} from "./session-frames.ts";
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
  setFooter(footer: RunFooterView | undefined): void;
  setFrames(frames: SessionFrameController | undefined): void;
}

/** Register `/ticket-runner` with Pi. */
export function registerTicketRunnerCommand(
  pi: ExtensionAPI,
  options: RegisterCommandOptions,
): void {
  const state = options.state ?? new TicketRunState();
  const frameRegistry = new SessionFrameRegistry();
  let activeGuard: RepositoryGuard | undefined;
  let activeCancellation: RunCancellation | undefined;
  let activeFooter: RunFooterView | undefined;
  let activeFrames: SessionFrameController | undefined;

  // Reloading or resuming a session rebuilds which summary entry is current for
  // every frame, so superseded summaries render nothing.
  pi.on("session_start", (_event, ctx) => {
    frameRegistry.rememberEntries(ctx.sessionManager.getEntries());
  });

  // Frames are durable TUI-only entries. Their renderer consults the live model
  // while a child is active and the latest persisted summary after a reload.
  pi.registerEntryRenderer<SessionFrameSummary>(
    FRAME_ENTRY_TYPE,
    (entry, { expanded }, theme) => frameRegistry.renderEntry(entry, expanded, theme),
  );

  // Quitting or reloading Pi must settle the active frame, abort the child,
  // clear the footer, and never leave a repository locked. The run's own
  // cleanup releases the lock again (idempotently) once the abort settles.
  pi.on("session_shutdown", () => {
    activeFrames?.shutdown();
    activeGuard?.release();
    activeGuard = undefined;
    void activeCancellation?.cancel();
    activeCancellation = undefined;
    activeFooter?.clear();
  });

  // The main session is otherwise idle while a child runs, so another agent
  // could edit the same tree and race the child. Ordinary prompts are blocked;
  // extension commands never reach this handler, and runner-injected messages
  // arrive with source "extension" and pass through.
  pi.on("input", (event: InputEvent, ctx: ExtensionContext): InputEventResult => {
    if (event.source === "extension") return { action: "continue" };

    const active = state.active;
    if (active === undefined) return { action: "continue" };

    const ticket = active.currentTicket;
    const label = ticket === undefined ? "starting" : `${ticket.id} ${ticket.title}`;
    ctx.ui.notify(
      `A ticket run is active (${label}).\n` +
        `Run /${COMMAND_NAME} stop before prompting the main session.`,
      "warning",
    );
    return { action: "handled" };
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "List and run local Markdown tickets, one fresh session per ticket",
    handler: async (args, ctx) => {
      await runCommand(
        pi,
        options,
        state,
        args,
        ctx,
        {
          onGuardChange: (guard) => {
            activeGuard = guard;
          },
          getCancellation: () => activeCancellation,
          setCancellation: (cancellation) => {
            activeCancellation = cancellation;
          },
          setFooter: (footer) => {
            activeFooter = footer;
          },
          setFrames: (frames) => {
            activeFrames = frames;
          },
        },
        frameRegistry,
      );
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
  frameRegistry: SessionFrameRegistry,
): Promise<void> {
  try {
    const command = parseCommandArgs(args);
    switch (command.subcommand) {
      case "list":
        runList(pi, options, state, ctx, command.folder);
        return;
      case "start":
        await runStart(
          pi,
          options,
          state,
          ctx,
          command.folder,
          command.allowDirty,
          hooks,
          frameRegistry,
        );
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
  frameRegistry: SessionFrameRegistry,
): Promise<void> {
  const { config, warnings } = loadConfig({ cwd: ctx.cwd, agentDir: options.agentDir });
  for (const warning of warnings) ctx.ui.notify(warning, "warning");

  const inventory = loadTicketInventory({ cwd: ctx.cwd, folder });
  state.rememberFolder(folder);

  // The footer is the only run-level progress surface. There is deliberately
  // no editor widget.
  const footer = new RunFooterView({
    sink: {
      setStatus: (text) => {
        ctx.ui.setStatus(COMMAND_NAME, text);
      },
    },
  });
  hooks.setFooter(footer);

  const frames = new SessionFrameController({
    registry: frameRegistry,
    liveFrameUpdateIntervalMs: config.liveFrameUpdateIntervalMs,
    expandedTranscriptMaxLines: config.expandedTranscriptMaxLines,
    expandedTranscriptMaxBytes: config.expandedTranscriptMaxBytes,
    // Custom entries have no public update-in-place API. Re-publishing the
    // unchanged footer status requests a TUI render, and the frame renderer
    // reads the live view model on every render.
    repaint: () => footer.repaint(),
    append: (summary) => {
      pi.appendEntry(FRAME_ENTRY_TYPE, summary);
      return findFrameEntryId(ctx.sessionManager.getEntries(), summary.frameId);
    },
  });
  hooks.setFrames(frames);

  const observer: RunObserver = {
    ticketStarted: (ticket, remainingRunnable) => {
      footer.ticketStarted(ticket, remainingRunnable);
    },
    frameStarted: (ticket, child) => {
      frames.start(ticket, child);
    },
    childEvent: (event) => {
      frames.childEvent(event);
    },
    gateStarted: (ticket) => {
      footer.gateStarted(ticket);
      frames.gateStarted();
    },
    frameSettled: (status) => {
      frames.settle(status);
    },
    betweenTickets: (next, remainingRunnable) => {
      footer.betweenTickets(next, remainingRunnable);
    },
  };

  const cancellation = new RunCancellation();
  hooks.setCancellation(cancellation);

  let outcome: RunOutcome | undefined;
  try {
    outcome = await runTickets({
      cwd: ctx.cwd,
      agentDir: options.agentDir,
      extensionPath: options.extensionPath ?? DEFAULT_EXTENSION_PATH,
      inventory,
      config,
      createSession: options.createSession ?? createTicketSession,
      getCommands: () => pi.getCommands(),
      state,
      observer,
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

    // The footer keeps a terminal summary until the next run or teardown;
    // session frames stay in the transcript either way.
    if (outcome.kind === "stopped") footer.stop(outcome.remainingRunnable);
    else if (outcome.kind === "finished") footer.finish(outcome.remainingRunnable);
    else footer.clear();

    pi.sendMessage(
      {
        customType: COMMAND_NAME,
        content: renderRunOutcome(outcome, inventory.folderLabel, config.runnableStatuses),
        display: true,
      },
      { triggerTurn: false },
    );
  } finally {
    // A thrown failure still leaves a stopped frame and footer. A shutdown
    // clear wins because both views ignore later updates once torn down.
    if (outcome === undefined) {
      frames.settle("stopped");
      footer.stop();
    }
    if (hooks.getCancellation() === cancellation) hooks.setCancellation(undefined);
    hooks.setFrames(undefined);
    hooks.setFooter(undefined);
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
