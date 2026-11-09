import type { Ticket } from "./tickets.ts";

/** The in-memory state of a run that is currently executing tickets. */
export interface ActiveRun {
  /** Ticket folder label exactly as supplied by the user. */
  readonly folderLabel: string;
  /** Number of tickets in the folder at the time the run started. */
  readonly totalTickets: number;
  /** The ticket the runner is working on, or the next one between tickets. */
  readonly currentTicket: Ticket | undefined;
  /** Tickets still in a runnable status, including the current one while it runs. */
  readonly remainingRunnable: number;
  /** File backing the current child session, when the session is persistent. */
  readonly sessionFile: string | undefined;
}

/**
 * Process-local run state used by `/ticket-runner status`.
 *
 * This is deliberately not persisted: ticket files remain the only durable
 * source of truth. It only lets a status request observe the run that is
 * currently in flight in this process.
 */
export class TicketRunState {
  private activeRun: ActiveRun | undefined;
  private lastUsedFolder: string | undefined;

  get active(): ActiveRun | undefined {
    return this.activeRun;
  }

  /** The most recently supplied ticket folder, used by status when idle. */
  get lastFolder(): string | undefined {
    return this.lastUsedFolder;
  }

  rememberFolder(folder: string): void {
    this.lastUsedFolder = folder;
  }

  begin(folderLabel: string, totalTickets: number, remainingRunnable: number): void {
    this.lastUsedFolder = folderLabel;
    this.activeRun = {
      folderLabel,
      totalTickets,
      currentTicket: undefined,
      remainingRunnable,
      sessionFile: undefined,
    };
  }

  setPosition(currentTicket: Ticket | undefined, remainingRunnable: number): void {
    if (!this.activeRun) return;
    this.activeRun = {
      ...this.activeRun,
      currentTicket,
      remainingRunnable,
      sessionFile: undefined,
    };
  }

  setSessionFile(sessionFile: string | undefined): void {
    if (!this.activeRun) return;
    this.activeRun = { ...this.activeRun, sessionFile };
  }

  end(): void {
    this.activeRun = undefined;
  }
}
