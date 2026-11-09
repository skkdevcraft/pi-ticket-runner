import type { ChildEvent } from "./sessions.ts";
import type { Ticket } from "./tickets.ts";
import {
  renderFooterStatus,
  renderTicketWidget,
  type FooterStatus,
  type LivePhase,
  type ToolActivity,
  type WidgetView,
} from "./ui.ts";

/**
 * The longest assistant text retained in the parent process.
 *
 * The child session owns the full transcript; the parent keeps only enough
 * recent text to fill the widget, so a long ticket can never grow the parent's
 * memory or render cost without bound.
 */
export const MAX_TEXT_BUFFER_CHARS = 2_000;

/** The most assistant text lines the widget renders. */
export const MAX_WIDGET_TEXT_LINES = 3;

/** Fallback terminal width when stdout does not report one. */
const DEFAULT_TERMINAL_WIDTH = 80;

/** Where live-view frames are delivered. */
export interface LiveViewSink {
  setWidget(lines: readonly string[] | undefined): void;
  setStatus(text: string | undefined): void;
}

/** The runner phase a child event arrived in. */
export type LiveObserverPhase = "implementation" | "completion-gate";

/**
 * The runner's live-view port.
 *
 * The sequential loop reports lifecycle milestones and forwards every child
 * event; a live view decides what to render. Keeping this a port lets the loop
 * be tested without a terminal.
 */
export interface RunObserver {
  ticketStarted(ticket: Ticket, remainingRunnable: number): void;
  childEvent(event: ChildEvent, phase: LiveObserverPhase): void;
  gateStarted(ticket: Ticket): void;
  betweenTickets(next: Ticket | undefined, remainingRunnable: number): void;
}

/** Schedule a delayed callback, returning a cancel function. */
export type LiveViewSchedule = (callback: () => void, delayMs: number) => () => void;

/** Options for {@link TicketLiveView}. */
export interface TicketLiveViewOptions {
  readonly sink: LiveViewSink;
  /** Minimum interval between widget renders. */
  readonly intervalMs: number;
  /** Terminal width used to truncate rendered lines. */
  readonly width?: (() => number) | undefined;
  readonly now?: (() => number) | undefined;
  readonly schedule?: LiveViewSchedule | undefined;
}

/**
 * Bounded, throttled live view of the active child session.
 *
 * It keeps a rolling text buffer, the latest tool activity, and the current
 * phase. Every frame, including lifecycle changes, is throttled to
 * {@link TicketLiveViewOptions.intervalMs}; terminal frames clear the widget
 * immediately so a finished or stopped run never waits on the throttle.
 */
export class TicketLiveView implements RunObserver {
  private readonly sink: LiveViewSink;
  private readonly intervalMs: number;
  private readonly width: () => number;
  private readonly now: () => number;
  private readonly schedule: LiveViewSchedule;

  private phase: LivePhase = "running";
  private ticket: Ticket | undefined;
  private next: Ticket | undefined;
  private remaining = 0;
  private textBuffer = "";
  private tool: ToolActivity | undefined;

  private lastRenderAt = Number.NEGATIVE_INFINITY;
  private cancelScheduled: (() => void) | undefined;
  /** No more child-driven renders; the final footer may still be shown. */
  private ended = false;
  /** Torn down for good: shutdown or reload. */
  private disposed = false;

  constructor(options: TicketLiveViewOptions) {
    this.sink = options.sink;
    this.intervalMs = Math.max(0, options.intervalMs);
    this.width = options.width ?? defaultWidth;
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? defaultSchedule;
  }

  ticketStarted(ticket: Ticket, remainingRunnable: number): void {
    if (this.disposed) return;
    this.ended = false;
    this.phase = "running";
    this.ticket = ticket;
    this.next = undefined;
    this.remaining = remainingRunnable;
    this.textBuffer = "";
    this.tool = undefined;
    this.requestRender();
  }

  childEvent(event: ChildEvent, _phase: LiveObserverPhase): void {
    if (this.inactive()) return;

    switch (event.type) {
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          this.appendText(event.assistantMessageEvent.delta);
          this.requestRender();
        }
        break;
      case "tool_execution_start":
        this.tool = { name: event.toolName, status: "running" };
        this.requestRender();
        break;
      case "tool_execution_end":
        this.tool = { name: event.toolName, status: event.isError ? "error" : "success" };
        this.requestRender();
        break;
      case "agent_settled":
      case "turn_end":
        break;
    }
  }

  gateStarted(ticket: Ticket): void {
    if (this.inactive()) return;
    this.phase = "gate";
    this.ticket = ticket;
    this.next = undefined;
    this.textBuffer = "";
    this.tool = undefined;
    this.requestRender();
  }

  betweenTickets(next: Ticket | undefined, remainingRunnable: number): void {
    if (this.inactive()) return;
    this.phase = "next";
    this.ticket = undefined;
    this.next = next;
    this.remaining = remainingRunnable;
    this.textBuffer = "";
    this.tool = undefined;
    this.requestRender();
  }

  finish(remainingRunnable: number): void {
    this.end("done", remainingRunnable);
  }

  stop(remainingRunnable = this.remaining): void {
    this.end("stopped", remainingRunnable);
  }

  /** Clear everything for an extension shutdown or reload. */
  clear(): void {
    this.ended = true;
    this.disposed = true;
    this.cancelPending();
    this.sink.setWidget(undefined);
    this.sink.setStatus(undefined);
  }

  private end(outcome: "done" | "stopped", remainingRunnable: number): void {
    if (this.disposed) return;
    this.ended = true;
    this.remaining = remainingRunnable;
    this.cancelPending();
    this.sink.setWidget(undefined);
    this.sink.setStatus(
      renderFooterStatus({
        outcome,
        remainingRunnable,
        ticket: undefined,
        next: undefined,
      }),
    );
  }

  private inactive(): boolean {
    return this.ended || this.disposed;
  }

  private appendText(delta: string): void {
    this.textBuffer += delta;
    if (this.textBuffer.length <= MAX_TEXT_BUFFER_CHARS) return;

    const excess = this.textBuffer.length - MAX_TEXT_BUFFER_CHARS;
    const nextLine = this.textBuffer.indexOf("\n", excess);
    this.textBuffer = nextLine === -1
      ? this.textBuffer.slice(excess)
      : this.textBuffer.slice(nextLine + 1);
  }

  private recentTextLines(): string[] {
    return this.textBuffer
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .slice(-MAX_WIDGET_TEXT_LINES);
  }

  private view(): WidgetView {
    return {
      phase: this.phase,
      ticket: this.ticket,
      next: this.next,
      textLines: this.recentTextLines(),
      tool: this.tool,
    };
  }

  private footer(): FooterStatus {
    return {
      outcome: "running",
      remainingRunnable: this.remaining,
      ticket: this.ticket,
      next: this.next,
    };
  }

  private requestRender(): void {
    if (this.inactive()) return;

    const elapsed = this.now() - this.lastRenderAt;
    if (elapsed >= this.intervalMs) {
      this.renderNow();
      return;
    }
    if (this.cancelScheduled !== undefined) return;

    this.cancelScheduled = this.schedule(() => {
      this.cancelScheduled = undefined;
      this.render();
    }, this.intervalMs - elapsed);
  }

  private renderNow(): void {
    this.cancelPending();
    this.render();
  }

  private render(): void {
    if (this.inactive()) return;

    this.lastRenderAt = this.now();
    this.sink.setWidget(renderTicketWidget(this.view(), this.terminalWidth()));
    this.sink.setStatus(renderFooterStatus(this.footer()));
  }

  private cancelPending(): void {
    this.cancelScheduled?.();
    this.cancelScheduled = undefined;
  }

  private terminalWidth(): number {
    return Math.max(1, Math.floor(this.width()));
  }
}

function defaultWidth(): number {
  const columns = process.stdout.columns;
  return typeof columns === "number" && columns > 0 ? columns : DEFAULT_TERMINAL_WIDTH;
}

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => {
    clearTimeout(handle);
  };
}
