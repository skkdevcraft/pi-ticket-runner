import { isRunnableStatus } from "./status.ts";
import type { TicketInventory } from "./tickets.ts";

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
