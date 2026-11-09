import type { SessionFrameChild, SessionFrameStatus } from "./session-frame.ts";
import type { ChildEvent } from "./sessions.ts";
import type { Ticket } from "./tickets.ts";
import { renderFooterStatus, type FooterStatus } from "./ui.ts";

/** Where footer updates are delivered. */
export interface RunFooterSink {
  setStatus(text: string | undefined): void;
}

/**
 * Timer and clock seam for throttled live repaints.
 *
 * Tests inject a fake clock so throttling and coalescing are deterministic.
 * `schedule` returns a callback that cancels the pending timer.
 */
export interface RepaintClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

/** The process clock and timers used outside tests. */
const systemRepaintClock: RepaintClock = {
  now: () => Date.now(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, Math.max(0, delayMs));
    return () => clearTimeout(timer);
  },
};

/** Options for {@link ThrottledRepaint}. */
export interface ThrottledRepaintOptions {
  /** Minimum milliseconds between paints. Zero paints on every request. */
  readonly intervalMs: number;
  /** Re-render the surface that shows live state. */
  readonly paint: () => void;
  readonly clock?: RepaintClock | undefined;
}

/**
 * Coalesces live repaint requests to at most one paint per interval.
 *
 * The first request paints immediately. Requests that arrive while a paint is
 * pending are folded into that paint, so a burst of child events costs one
 * render. `settle` paints the final state synchronously and then ignores every
 * later request, which is what makes a completed frame static.
 */
export class ThrottledRepaint {
  private readonly intervalMs: number;
  private readonly paint: () => void;
  private readonly clock: RepaintClock;

  private lastPaintedAt: number | undefined;
  private cancelScheduled: (() => void) | undefined;
  private stopped = false;

  constructor(options: ThrottledRepaintOptions) {
    this.intervalMs = options.intervalMs;
    this.paint = options.paint;
    this.clock = options.clock ?? systemRepaintClock;
  }

  /** Ask for a paint, waiting out the rest of the current interval if needed. */
  request(): void {
    if (this.stopped) return;

    const now = this.clock.now();
    const lastPaintedAt = this.lastPaintedAt;
    if (lastPaintedAt === undefined) {
      this.paintNow(now);
      return;
    }

    const waitMs = this.intervalMs - (now - lastPaintedAt);
    if (waitMs <= 0) {
      this.cancel();
      this.paintNow(now);
      return;
    }

    if (this.cancelScheduled !== undefined) return;
    this.cancelScheduled = this.clock.schedule(() => {
      this.cancelScheduled = undefined;
      if (this.stopped) return;
      this.paintNow(this.clock.now());
    }, waitMs);
  }

  /** Paint the final state now, then stop accepting requests. */
  settle(): void {
    if (this.stopped) return;
    this.cancel();
    this.paintNow(this.clock.now());
    this.stop();
  }

  /** Stop accepting requests and drop any pending paint. */
  stop(): void {
    this.stopped = true;
    this.cancel();
  }

  private paintNow(now: number): void {
    this.lastPaintedAt = now;
    this.paint();
  }

  private cancel(): void {
    const cancel = this.cancelScheduled;
    this.cancelScheduled = undefined;
    cancel?.();
  }
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
  private lastStatus: string | undefined;

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
    this.publish(undefined);
  }

  /**
   * Re-emit the current status so Pi re-renders the transcript.
   *
   * Custom entries have no public update-in-place API, so live session frames
   * repaint by asking the footer to publish its unchanged text again. The
   * renderer reads the live view model on each render.
   */
  repaint(): void {
    if (this.disposed) return;
    this.publish(this.lastStatus);
  }

  private end(outcome: "done" | "stopped", remainingRunnable: number): void {
    if (this.disposed) return;
    this.remaining = remainingRunnable;
    this.publish(
      renderFooterStatus({
        outcome,
        remainingRunnable,
        ticket: undefined,
        next: undefined,
      }),
    );
  }

  private renderRunning(): void {
    this.publish(
      renderFooterStatus({
        outcome: "running",
        remainingRunnable: this.remaining,
        ticket: this.ticket,
        next: this.next,
      } satisfies FooterStatus),
    );
  }

  private publish(text: string | undefined): void {
    this.lastStatus = text;
    this.sink.setStatus(text);
  }
}
