import { randomUUID } from "node:crypto";

import type { CustomEntry, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import { DEFAULT_CONFIG } from "./config.ts";
import { ThrottledRepaint, type RepaintClock } from "./live-view.ts";
import type { ChildEvent } from "./sessions.ts";
import {
  FRAME_ENTRY_TYPE,
  SessionFrameComponent,
  isTerminalFrameStatus,
  readSessionFrameSummary,
  summaryToFrameView,
  type SessionFrameChild,
  type SessionFrameStatus,
  type SessionFrameSummary,
  type SessionFrameView,
} from "./session-frame.ts";
import type { Ticket } from "./tickets.ts";

/** Append one durable summary and return the persisted entry id, when known. */
export type AppendSessionFrameEntry = (
  summary: SessionFrameSummary,
) => string | undefined;

/** Options for {@link SessionFrameController}. */
export interface SessionFrameControllerOptions {
  readonly registry: SessionFrameRegistry;
  readonly append: AppendSessionFrameEntry;
  readonly now?: (() => number) | undefined;
  /** Repaint the surface that displays live frames. No-op when omitted. */
  readonly repaint?: (() => void) | undefined;
  /** Minimum interval between live repaints, from `liveFrameUpdateIntervalMs`. */
  readonly liveFrameUpdateIntervalMs?: number | undefined;
  /** Timer seam for throttled repaints; tests supply a fake clock. */
  readonly clock?: RepaintClock | undefined;
}

/** Options for {@link SessionFrameRegistry}. */
export interface SessionFrameRegistryOptions {
  readonly now?: (() => number) | undefined;
}

/**
 * The in-memory half of one live frame.
 *
 * It owns only counters and identity. Child transcript content is never copied
 * here; the frame's expanded transcript is loaded separately.
 */
export class LiveSessionFrame {
  readonly frameId: string;
  private readonly ticket: Ticket;
  private readonly child: SessionFrameChild;
  private readonly startedAt: number;

  private status: SessionFrameStatus = "running";
  private turns = 0;
  private tools = 0;
  private errors = 0;
  private endedAt: number | undefined;
  private settled = false;

  constructor(ticket: Ticket, child: SessionFrameChild, startedAt: number) {
    this.frameId = randomUUID();
    this.ticket = ticket;
    this.child = child;
    this.startedAt = startedAt;
  }

  get isSettled(): boolean {
    return this.settled;
  }

  childEvent(event: ChildEvent): void {
    if (this.settled) return;

    switch (event.type) {
      case "turn_end":
        this.turns += 1;
        break;
      case "tool_execution_start":
        this.tools += 1;
        break;
      case "tool_execution_end":
        if (event.isError) this.errors += 1;
        break;
      case "message_update":
      case "agent_settled":
        break;
    }
  }

  gateStarted(): void {
    if (!this.settled) this.status = "verifying";
  }

  settle(status: SessionFrameStatus, now: number): void {
    if (this.settled) return;
    this.status = status;
    this.endedAt = now;
    this.settled = true;
  }

  summary(): SessionFrameSummary {
    return {
      frameId: this.frameId,
      ticketId: this.ticket.id,
      ticketTitle: this.ticket.title,
      childSessionFile: this.child.sessionFile,
      model: this.child.model,
      status: this.status,
      turns: this.turns,
      tools: this.tools,
      errors: this.errors,
      startedAt: new Date(this.startedAt).toISOString(),
      ...(this.endedAt === undefined ? {} : { endedAt: new Date(this.endedAt).toISOString() }),
    };
  }

  view(expanded: boolean, now: number): SessionFrameView {
    return {
      frameId: this.frameId,
      ticketId: this.ticket.id,
      ticketTitle: this.ticket.title,
      status: this.status,
      turns: this.turns,
      tools: this.tools,
      errors: this.errors,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      model: this.child.model,
      childSessionFile: this.child.sessionFile,
      expanded,
      now,
    };
  }
}

/**
 * Which frame summary entry may render.
 *
 * While a live frame exists its creation entry paints the live view and the
 * settlement entry stays hidden. After a reload no live frame exists, so the
 * latest persisted summary for each frame id paints the settled frame and every
 * superseded summary renders nothing.
 */
export class SessionFrameRegistry {
  private readonly live = new Map<string, LiveSessionFrame>();
  private readonly latestEntry = new Map<string, string>();
  private readonly now: () => number;

  constructor(options: SessionFrameRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Rebuild latest-entry knowledge from the entries of the current session. */
  rememberEntries(entries: readonly SessionEntry[]): void {
    this.latestEntry.clear();
    for (const entry of entries) {
      const summary = frameEntrySummary(entry);
      if (summary !== undefined) this.latestEntry.set(summary.frameId, entry.id);
    }
  }

  rememberLatestEntry(frameId: string, entryId: string): void {
    this.latestEntry.set(frameId, entryId);
  }

  registerLive(frame: LiveSessionFrame): void {
    this.live.set(frame.frameId, frame);
  }

  liveFrame(frameId: string): LiveSessionFrame | undefined {
    return this.live.get(frameId);
  }

  /** Drop every live view, for example on shutdown or reload. */
  clearLive(): void {
    this.live.clear();
  }

  /** Render one persisted summary entry, or hide it as superseded. */
  renderEntry(entry: CustomEntry, expanded: boolean, theme: Theme): Component | undefined {
    const summary = readSessionFrameSummary(entry.data);
    if (summary === undefined) return undefined;

    const live = this.live.get(summary.frameId);
    if (live !== undefined) {
      // The creation entry paints the live model; the settlement entry must not
      // paint a second copy of the same frame.
      if (isTerminalFrameStatus(summary.status)) return undefined;
      // Pi caches this component; the view source keeps the counters and
      // elapsed time live across renders driven by a footer repaint.
      return new SessionFrameComponent(() => live.view(expanded, this.now()), theme);
    }

    const latest = this.latestEntry.get(summary.frameId);
    if (latest !== undefined) {
      if (latest !== entry.id) return undefined;
      return new SessionFrameComponent(
        summaryToFrameView(stoppedAfterReload(summary), expanded, this.now()),
        theme,
      );
    }

    // No scan has run yet. A terminal summary is the settled frame; a creation
    // summary only exists while its live model is available.
    if (!isTerminalFrameStatus(summary.status)) return undefined;
    return new SessionFrameComponent(
      summaryToFrameView(summary, expanded, this.now()),
      theme,
    );
  }
}

/**
 * Owns the frame lifecycle for one ticket run.
 *
 * Creation and settlement are the only times a summary entry is appended. The
 * live model handles all intermediate updates without adding session entries.
 */
export class SessionFrameController {
  private readonly registry: SessionFrameRegistry;
  private readonly append: AppendSessionFrameEntry;
  private readonly now: () => number;
  private readonly repaint: (() => void) | undefined;
  private readonly repaintIntervalMs: number;
  private readonly clock: RepaintClock | undefined;
  private active: LiveSessionFrame | undefined;
  private repainter: ThrottledRepaint | undefined;

  constructor(options: SessionFrameControllerOptions) {
    this.registry = options.registry;
    this.append = options.append;
    this.now = options.now ?? (() => Date.now());
    this.repaint = options.repaint;
    this.repaintIntervalMs =
      options.liveFrameUpdateIntervalMs ?? DEFAULT_CONFIG.liveFrameUpdateIntervalMs;
    this.clock = options.clock;
  }

  /** Create the one frame for a child session that now exists. */
  start(ticket: Ticket, child: SessionFrameChild): void {
    if (this.active !== undefined) this.settle("stopped");

    const frame = new LiveSessionFrame(ticket, child, this.now());
    this.active = frame;
    this.registry.registerLive(frame);
    this.persist(frame);

    this.repainter = this.createRepainter();
    this.repainter?.request();
  }

  /** Feed one child event into the active frame's live counters. */
  childEvent(event: ChildEvent): void {
    if (this.active === undefined) return;
    this.active.childEvent(event);
    this.repainter?.request();
  }

  /** Move the active frame to the completion-gate phase without creating another. */
  gateStarted(): void {
    if (this.active === undefined) return;
    this.active.gateStarted();
    this.repainter?.request();
  }

  /** Settle the active frame exactly once and persist its final summary. */
  settle(status: SessionFrameStatus): void {
    const frame = this.active;
    if (frame === undefined) return;

    this.active = undefined;
    const repainter = this.repainter;
    this.repainter = undefined;

    if (!frame.isSettled) {
      frame.settle(status, this.now());
      this.persist(frame);
    }

    // Paint the terminal status once, then make the frame static. Settlement is
    // not throttled: it is the last paint this frame will ever ask for.
    repainter?.settle();
  }

  /**
   * Settle a still-active frame before teardown, then drop live views.
   *
   * This ordering is what keeps a reload from finding an active frame that
   * still reports `running`.
   */
  shutdown(): void {
    this.settle("stopped");
    this.registry.clearLive();
  }

  private persist(frame: LiveSessionFrame): void {
    const entryId = this.append(frame.summary());
    if (entryId !== undefined) {
      this.registry.rememberLatestEntry(frame.frameId, entryId);
    }
  }

  private createRepainter(): ThrottledRepaint | undefined {
    const repaint = this.repaint;
    if (repaint === undefined) return undefined;
    return new ThrottledRepaint({
      intervalMs: this.repaintIntervalMs,
      paint: repaint,
      ...(this.clock === undefined ? {} : { clock: this.clock }),
    });
  }
}

/** Find the newest persisted summary entry for a frame. */
export function findFrameEntryId(
  entries: readonly SessionEntry[],
  frameId: string,
): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const summary = frameEntrySummary(entry);
    if (summary?.frameId === frameId) return entry.id;
  }
  return undefined;
}

function frameEntrySummary(entry: SessionEntry): SessionFrameSummary | undefined {
  if (entry.type !== "custom" || entry.customType !== FRAME_ENTRY_TYPE) return undefined;
  return readSessionFrameSummary(entry.data);
}

function stoppedAfterReload(summary: SessionFrameSummary): SessionFrameSummary {
  if (isTerminalFrameStatus(summary.status)) return summary;

  // A crash can leave a non-terminal summary behind. A reload must never show
  // that frame as still running.
  return { ...summary, status: "stopped" };
}
