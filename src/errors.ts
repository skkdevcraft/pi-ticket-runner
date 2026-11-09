/**
 * An expected, user-facing failure. Commands report these messages verbatim and
 * never continue past them.
 */
export class TicketRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketRunnerError";
  }
}

/** Extract a printable message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Test a Node.js system error for a specific `code`, such as `ENOENT`. */
export function hasErrorCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { code?: unknown }).code === code;
}
