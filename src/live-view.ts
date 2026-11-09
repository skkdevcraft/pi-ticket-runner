import type { SessionFrameChild, SessionFrameStatus } from "./session-frame.ts";
import type { ChildEvent } from "./sessions.ts";
import type { Ticket } from "./tickets.ts";
import { renderFooterStatus, type FooterStatus } from "./ui.ts";

/** Where footer updates are delivered. */
export interface RunFooterSink {
  setStatus(text: string | undefined): void;
}

/** The runner phase a child event arrived in. */
export type LiveObserverPhase = "implementation" | "completion-gate";

/**
 * The runner's live-view port.
 *
 * The sequential loop reports lifecycle milestones and forwards every child
 * event; the footer and the session frames decide what to paint. Keeping this a
 * port lets the loop be tested without a terminal.
 */
export interface RunObserver {
  ticketStarted(ticket: Ticket, remainingRunnable: number): void;
  /** A child session now exists; create its one frame. */
  frameStarted?(ticket: Ticket, child: SessionFrameChild): void;
  childEvent(event: ChildEvent, phase: LiveObserverPhase): void;
  gateStarted(ticket: Ticket): void;
  /** The active child is leaving every exit path with this frame status. */
  frameSettled?(status: SessionFrameStatus): void;
  betweenTickets(next: Ticket | undefined, remainingRunnable: number): void;
}

/** Options for {@link RunFooterView}. */
export interface RunFooterViewOptions {
  readonly sink: RunFooterSink;
}

/**
 * The footer is the only run-level progress surface.
 *
 * Child progress lives in inline session frames; the footer only names the
 * active or next ticket, the remaining runnable count, and the terminal
 * outcome. It clears on teardown while the frames stay in the transcript.
 */
export class RunFooterView implements RunObserver {
  private readonly sink: RunFooterSink;

  private ticket: Ticket | undefined;
  private next: Ticket | undefined;
  private remaining = 0;

  /** Torn down for good: shutdown or reload. */
  private disposed = false;

  constructor(options: RunFooterViewOptions) {
    this.sink = options.sink;
  }

  ticketStarted(ticket: Ticket, remainingRunnable: number): void {
    if (this.disposed) return;
    this.ticket = ticket;
    this.next = undefined;
    this.remaining = remainingRunnable;
    this.renderRunning();
  }

  childEvent(_event: ChildEvent, _phase: LiveObserverPhase): void {}

  gateStarted(ticket: Ticket): void {
    if (this.disposed) return;
    this.ticket = ticket;
    this.next = undefined;
    this.renderRunning();
  }

  betweenTickets(next: Ticket | undefined, remainingRunnable: number): void {
    if (this.disposed) return;
    this.ticket = undefined;
    this.next = next;
    this.remaining = remainingRunnable;
    this.renderRunning();
  }

  finish(remainingRunnable: number): void {
    this.end("done", remainingRunnable);
  }

  stop(remainingRunnable = this.remaining): void {
    this.end("stopped", remainingRunnable);
  }

  /** Clear the footer for an extension shutdown or reload. */
  clear(): void {
    this.disposed = true;
    this.sink.setStatus(undefined);
  }

  private end(outcome: "done" | "stopped", remainingRunnable: number): void {
    if (this.disposed) return;
    this.remaining = remainingRunnable;
    this.sink.setStatus(
      renderFooterStatus({
        outcome,
        remainingRunnable,
        ticket: undefined,
        next: undefined,
      }),
    );
  }

  private renderRunning(): void {
    this.sink.setStatus(
      renderFooterStatus({
        outcome: "running",
        remainingRunnable: this.remaining,
        ticket: this.ticket,
        next: this.next,
      } satisfies FooterStatus),
    );
  }
}
