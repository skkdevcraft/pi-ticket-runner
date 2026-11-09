import { TicketRunnerError } from "./errors.ts";

/**
 * A ticket's status line, in either supported form:
 *
 *     Status: ready-for-agent
 *     **Status:** ready-for-agent
 *
 * Anchored at the start of a line so prose that mentions the word does not count.
 */
const STATUS_LINE_PATTERN = /^\s*(?:\*\*Status:\*\*|Status:)\s*(.*?)\s*$/i;

/**
 * Read the ticket file's single status line.
 *
 * The value is trimmed and lowercased so comparisons do not depend on
 * formatting. A missing, duplicated, or empty status is a malformed ticket: the
 * extension must never guess a status, so every one of those cases throws.
 */
export function parseTicketStatus(content: string, source = "ticket"): string {
  const values: string[] = [];

  for (const line of content.split(/\r?\n/)) {
    const match = STATUS_LINE_PATTERN.exec(line);
    if (match) values.push(match[1] ?? "");
  }

  if (values.length === 0) {
    throw new TicketRunnerError(`Ticket ${source} has no Status: line.`);
  }
  if (values.length > 1) {
    throw new TicketRunnerError(`Ticket ${source} has more than one Status: line.`);
  }

  const status = (values[0] ?? "").trim().toLowerCase();
  if (status.length === 0) {
    throw new TicketRunnerError(`Ticket ${source} has an empty Status: value.`);
  }
  return status;
}

/**
 * The extension understands exactly two classes: runnable now, or not.
 * There is no completion vocabulary and no "unknown status" error.
 */
export function isRunnableStatus(status: string, runnableStatuses: readonly string[]): boolean {
  return runnableStatuses.includes(status);
}
