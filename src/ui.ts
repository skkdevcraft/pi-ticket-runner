import type { ActiveRun } from "./run-state.ts";
import type { RanTicket, RunOutcome, RunStop, SkippedTicket, TicketProgress } from "./runner.ts";
import { isRunnableStatus } from "./status.ts";
import type { Ticket, TicketInventory } from "./tickets.ts";

/** The line advertising the only supported interruption command. */
export const STOP_HINT = "  (/ticket-runner stop to interrupt)";

/** Which part of a ticket the live widget is currently showing. */
export type LivePhase = "running" | "gate" | "next";

/** The current or most recent tool call shown in the live widget. */
export interface ToolActivity {
  readonly name: string;
  readonly status: "running" | "success" | "error";
}

/** Everything the live widget needs to render one frame. */
export interface WidgetView {
  readonly phase: LivePhase;
  readonly ticket: Ticket | undefined;
  readonly next: Ticket | undefined;
  /** Recent assistant text lines, oldest first. At most the last three render. */
  readonly textLines: readonly string[];
  readonly tool: ToolActivity | undefined;
}

/** Whether the footer describes a live, finished, or stopped run. */
export type FooterOutcome = "running" | "done" | "stopped";

/** Everything the footer needs to render one frame. */
export interface FooterStatus {
  readonly outcome: FooterOutcome;
  readonly remainingRunnable: number;
  readonly ticket: Ticket | undefined;
  readonly next: Ticket | undefined;
}

/**
 * Render the bounded live-session widget.
 *
 * The result is never more than six lines: one header, up to three recent
 * assistant text lines, one current-or-most-recent tool line, and the stop
 * hint. Between tickets the header becomes the next ticket so a long run never
 * looks dead.
 */
export function renderTicketWidget(view: WidgetView, width: number): string[] {
  if (view.phase === "next") {
    const next = view.next === undefined ? "none" : `${view.next.id}-${view.next.slug}`;
    return [truncateLine(`⏳ next: ${next}`, width), STOP_HINT];
  }

  const ticket = view.ticket;
  if (ticket === undefined) return [];

  const header = view.phase === "gate"
    ? `🔎 ${ticket.id} verifying completion`
    : `▶ ${ticket.id} ${ticket.title}`;

  const lines = [truncateLine(header, width)];
  for (const textLine of view.textLines.slice(-3)) {
    lines.push(truncateLine(`  ${textLine}`, width));
  }
  if (view.tool !== undefined) {
    lines.push(truncateLine(`  Tool: ${view.tool.name} — ${view.tool.status}`, width));
  }
  lines.push(STOP_HINT);
  return lines.slice(0, 6);
}

/** Render the footer progress label for the current run state. */
export function renderFooterStatus(status: FooterStatus): string {
  switch (status.outcome) {
    case "done":
      return `🎫 done · ${status.remainingRunnable} left`;
    case "stopped":
      return `🎫 stopped · ${status.remainingRunnable} left`;
    case "running": {
      const ticket = status.ticket ?? status.next;
      const label = ticket === undefined ? "starting" : `${ticket.id}-${ticket.slug}`;
      return `🎫 ${status.remainingRunnable} left · ${label}`;
    }
  }
}

function truncateLine(line: string, width: number): string {
  if (width <= 0 || line.length <= width) return line;
  if (width === 1) return "…";
  return `${line.slice(0, width - 1)}…`;
}

/**
 * Render the `/ticket-runner list` output.
 *
 * Read-only and side-effect free: it takes an already-loaded inventory and
 * produces the text that the command displays.
 *
 *     🎫 Tickets: .scratch/auth/issues
 *
 *     01-database-schema      resolved           skip
 *     02-api-endpoints        resolved           skip
 *     03-repository-layer     ready-for-agent    NEXT ▶
 *     04-integration-tests    ready-for-human    skip
 *
 *     Executable: 1 of 4
 *     Next: 03 Repository Layer
 */
export function renderTicketList(
  inventory: TicketInventory,
  runnableStatuses: readonly string[],
): string {
  const rows = inventory.tickets.map((ticket) => ({
    ticket,
    name: ticket.filename.replace(/\.md$/, ""),
    runnable: isRunnableStatus(ticket.status, runnableStatuses),
  }));
  const runnable = rows.filter((row) => row.runnable);

  const nameWidth = columnWidth(rows.map((row) => row.name.length));
  const statusWidth = columnWidth(rows.map((row) => row.ticket.status.length));

  const lines = [`🎫 Tickets: ${inventory.folderLabel}`, ""];
  for (const row of rows) {
    const marker = row.runnable ? (row === runnable[0] ? "NEXT ▶" : "run") : "skip";
    lines.push(
      `${row.name.padEnd(nameWidth)}${row.ticket.status.padEnd(statusWidth)}${marker}`,
    );
  }

  lines.push("");
  lines.push(`Executable: ${runnable.length} of ${rows.length}`);

  const next = runnable[0];
  lines.push(next ? `Next: ${next.ticket.id} ${next.ticket.title}` : "Nothing to run.");

  return lines.join("\n");
}

function columnWidth(lengths: readonly number[]): number {
  return Math.max(0, ...lengths) + 4;
}

/** Render the progress message injected after a ticket passes the gate. */
export function renderTicketProgress(progress: TicketProgress): string {
  const ticket = progress.ticket;
  const next = progress.next
    ? `Next: ${progress.next.id} ${progress.next.title} (${countLabel(progress.remainingRunnable)} left).`
    : `Next: none (${countLabel(progress.remainingRunnable)} left).`;

  return [
    `✅ ${ticket.id} ${ticket.title} — status now \`${progress.status}\`.`,
    next,
  ].join("\n");
}

/** Render the active-run state shown by `/ticket-runner status`. */
export function renderActiveRun(run: ActiveRun): string {
  const position = run.currentTicket
    ? `${run.currentTicket.id} ${run.currentTicket.title}`
    : "(starting)";

  return [
    "🎫 Ticket runner active",
    "",
    `Folder: ${run.folderLabel}`,
    `Position: ${position}`,
    `Executable remaining: ${run.remainingRunnable} of ${run.totalTickets}`,
    `Session: ${run.sessionFile ?? "(not saved)"}`,
  ].join("\n");
}

/** Render the final result of `/ticket-runner start` for the main transcript. */
export function renderRunOutcome(
  outcome: RunOutcome,
  folder: string,
  runnableStatuses: readonly string[],
): string {
  switch (outcome.kind) {
    case "nothing-to-run":
      return `✅ Nothing to run — no ticket in ${folder} is ${runnableStatuses.join(", ")}.`;
    case "finished":
      return [
        `✅ Run finished · ${countLabel(outcome.remainingRunnable)} ${statusList(runnableStatuses)}.`,
        ...renderSummary(outcome.ran, outcome.skipped),
      ].join("\n");
    case "stopped":
      return [
        renderStop(outcome.stop, outcome.remainingRunnable),
        "",
        ...renderSummary(outcome.ran, outcome.skipped),
      ].join("\n");
  }
}

function renderStop(stop: RunStop, remainingRunnable: number): string {
  const stopped = `Execution stopped · ${countLabel(remainingRunnable)} left.`;

  switch (stop.kind) {
    case "gate-rejected":
      return [
        `⏹ ${stop.ticket.id} ${stop.ticket.title} is ${stop.status.toLowerCase()}.`,
        `Reason: ${stop.reason || "no reason given."}`,
        stopped,
      ].join("\n");
    case "gate-malformed":
      return [
        `⏹ The completion gate returned an unusable answer for ${stop.ticket.id} ${stop.ticket.title}.`,
        stop.reason,
        "",
        "Final message:",
        stop.text ?? "(empty)",
        "",
        stopped,
      ].join("\n");
    case "status-unchanged":
      return [
        `⏹ Ticket ${stop.ticket.id}-${stop.ticket.slug} reported COMPLETE,`,
        `but its ticket file is still ${stop.status}.`,
        "",
        stopped,
      ].join("\n");
    case "turn-limit":
      return [
        `⏹ ${stop.ticket.id} ${stop.ticket.title} hit the ${stop.maxTurns}-turn limit after ${stop.turns} turns.`,
        stopped,
      ].join("\n");
    case "session-error":
      return [
        `⏹ ${stop.ticket.id} ${stop.ticket.title} — child session error during ${phaseLabel(stop.phase)}.`,
        stop.message,
        stopped,
      ].join("\n");
    case "git-changed": {
      const actual = stop.actual
        ? `${stop.actual.branch} at ${shortHead(stop.actual.head)}`
        : "an unreadable Git state";
      return [
        `⏹ Repository branch or HEAD changed before ${stop.ticket.id} ${stop.ticket.title}.`,
        `Expected ${stop.expected.branch} at ${shortHead(stop.expected.head)}, found ${actual}.`,
        "The runner never switches branches, stashes, or discards work.",
        stopped,
      ].join("\n");
    }
    case "git-check-error":
      return [
        `⏹ Cannot verify the repository branch and HEAD before ${stop.ticket.id} ${stop.ticket.title}.`,
        stop.message,
        stopped,
      ].join("\n");
    case "interrupted":
      return [
        `⏹ Execution interrupted at ${stop.ticket.id} ${stop.ticket.title} · ${countLabel(remainingRunnable)} left.`,
        "Remaining tickets not started.",
      ].join("\n");
  }
}

function shortHead(head: string): string {
  return head.length > 8 ? head.slice(0, 8) : head || "unknown";
}

function phaseLabel(phase: "create" | "implementation" | "completion-gate"): string {
  switch (phase) {
    case "create":
      return "session creation";
    case "implementation":
      return "implementation";
    case "completion-gate":
      return "the completion gate";
  }
}

function renderSummary(
  ran: readonly RanTicket[],
  skipped: readonly SkippedTicket[],
): string[] {
  return [
    ran.length > 0
      ? `Ran: ${ran.map((entry) => `${entry.ticket.id} ${entry.ticket.title}`).join(", ")}.`
      : "Ran: none.",
    skipped.length > 0
      ? `Skipped: ${skipped
          .map((entry) => `${entry.ticket.id} ${entry.ticket.title} (${entry.status})`)
          .join(", ")}.`
      : "Skipped: none.",
  ];
}

function countLabel(count: number): string {
  return `${count} ${count === 1 ? "ticket" : "tickets"}`;
}

function statusList(runnableStatuses: readonly string[]): string {
  return runnableStatuses.length === 1
    ? runnableStatuses[0] ?? "runnable"
    : runnableStatuses.join(", ");
}
