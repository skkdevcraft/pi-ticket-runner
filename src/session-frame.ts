import { basename } from "node:path";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

/** Session entry type used to persist one frame summary per child session. */
export const FRAME_ENTRY_TYPE = "ticket-runner-frame";

/** The status a session frame can paint. */
export type SessionFrameStatus = "running" | "verifying" | "done" | "stopped" | "failed";

/** Statuses after which a frame never updates again. */
export const TERMINAL_FRAME_STATUSES: readonly SessionFrameStatus[] = [
  "done",
  "stopped",
  "failed",
];

export function isTerminalFrameStatus(status: SessionFrameStatus): boolean {
  return TERMINAL_FRAME_STATUSES.includes(status);
}

/**
 * The small, durable summary persisted for a frame.
 *
 * It deliberately contains counters and identity only. Transcript content stays
 * in the child session file and never enters this entry.
 */
export interface SessionFrameSummary {
  readonly frameId: string;
  readonly ticketId: string;
  readonly ticketTitle: string;
  readonly childSessionFile: string | undefined;
  readonly model: string | undefined;
  readonly status: SessionFrameStatus;
  readonly turns: number;
  readonly tools: number;
  readonly errors: number;
  readonly startedAt: string;
  readonly endedAt?: string;
}

/** Child-session facts a frame records when it is created. */
export interface SessionFrameChild {
  readonly sessionFile: string | undefined;
  readonly model: string | undefined;
}

/** Everything the pure frame renderer needs. */
export interface SessionFrameView {
  readonly frameId: string;
  readonly ticketId: string;
  readonly ticketTitle: string;
  readonly status: SessionFrameStatus;
  readonly turns: number;
  readonly tools: number;
  readonly errors: number;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  /** Epoch milliseconds, or undefined while the frame is live. */
  readonly endedAt: number | undefined;
  readonly model: string | undefined;
  readonly childSessionFile: string | undefined;
  readonly expanded: boolean;
  /** Epoch milliseconds used for the live elapsed time. */
  readonly now: number;
}

/** A colour role inside one rendered frame line. */
export type SessionFrameTone = "border" | "status" | "dim";

/** One coloured span of a frame line. */
export interface SessionFrameSegment {
  readonly text: string;
  readonly tone?: SessionFrameTone;
}

/** One rendered frame line, made of plain-text segments with colour roles. */
export type SessionFrameLine = readonly SessionFrameSegment[];

/**
 * Render one session frame from a view model.
 *
 * This is a pure function: the same view and width always produce the same
 * segments. The border always occupies the full supplied width, and every
 * content line is truncated to the space between the borders.
 */
export function renderSessionFrame(view: SessionFrameView, width: number): SessionFrameLine[] {
  const outerWidth = Math.floor(width);
  if (!Number.isFinite(outerWidth) || outerWidth < 4) return [];

  const innerWidth = outerWidth - 4;
  const horizontal = "─".repeat(outerWidth - 2);

  return [
    [{ text: `┌${horizontal}┐`, tone: "border" }],
    contentLine(headerSegments(view), innerWidth),
    contentLine([{ text: "  " }, ...metaSegments(view)], innerWidth),
    [{ text: `└${horizontal}┘`, tone: "border" }],
  ];
}

/** Flatten a rendered frame line to its unstyled text. */
export function sessionFrameLineText(line: SessionFrameLine): string {
  return line.map((segment) => segment.text).join("");
}

/** Join a rendered frame as unstyled text, useful for assertions and logging. */
export function sessionFrameText(lines: readonly SessionFrameLine[]): string[] {
  return lines.map(sessionFrameLineText);
}

/** Apply the Pi theme to one rendered frame line. */
export function paintSessionFrameLine(
  line: SessionFrameLine,
  status: SessionFrameStatus,
  theme: Theme,
): string {
  return line
    .map((segment) => {
      switch (segment.tone) {
        case "border":
          return theme.fg("borderMuted", segment.text);
        case "status":
          return theme.fg(statusColour(status), segment.text);
        case "dim":
          return theme.fg("dim", segment.text);
        default:
          return segment.text;
      }
    })
    .join("");
}

/** A Pi component that renders one session frame. */
export class SessionFrameComponent implements Component {
  private readonly view: SessionFrameView;
  private readonly theme: Theme;

  constructor(view: SessionFrameView, theme: Theme) {
    this.view = view;
    this.theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return renderSessionFrame(this.view, width).map((line) =>
      paintSessionFrameLine(line, this.view.status, this.theme),
    );
  }
}

/** Display label for a frame status. */
export function sessionFrameStatusWord(status: SessionFrameStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/**
 * Short session id shown in an expanded frame's meta line.
 *
 * Pi names session files `<timestamp>_<session-id>.jsonl`; the short form is the
 * first six alphanumerics of that id.
 */
export function shortSessionId(childSessionFile: string | undefined): string | undefined {
  if (childSessionFile === undefined) return undefined;

  const stem = basename(childSessionFile).replace(/\.jsonl$/i, "");
  const separator = stem.lastIndexOf("_");
  const id = (separator === -1 ? stem : stem.slice(separator + 1)).replace(/[^A-Za-z0-9]/g, "");
  return id.length === 0 ? undefined : id.slice(0, 6);
}

/** Convert a persisted summary back into a render view. */
export function summaryToFrameView(
  summary: SessionFrameSummary,
  expanded: boolean,
  now: number,
): SessionFrameView {
  const startedAt = Date.parse(summary.startedAt);
  const endedAt = summary.endedAt === undefined ? undefined : Date.parse(summary.endedAt);

  return {
    frameId: summary.frameId,
    ticketId: summary.ticketId,
    ticketTitle: summary.ticketTitle,
    status: summary.status,
    turns: summary.turns,
    tools: summary.tools,
    errors: summary.errors,
    startedAt: Number.isFinite(startedAt) ? startedAt : now,
    endedAt: endedAt !== undefined && Number.isFinite(endedAt) ? endedAt : undefined,
    model: summary.model,
    childSessionFile: summary.childSessionFile,
    expanded,
    now,
  };
}

/**
 * Validate persisted frame data before rendering it.
 *
 * Session entries are user-editable files, so a malformed summary must render
 * nothing rather than crash the transcript.
 */
export function readSessionFrameSummary(value: unknown): SessionFrameSummary | undefined {
  if (!isRecord(value)) return undefined;

  const frameId = value.frameId;
  const ticketId = value.ticketId;
  const ticketTitle = value.ticketTitle;
  const status = value.status;
  const startedAt = value.startedAt;

  if (!isNonEmptyString(frameId)) return undefined;
  if (!isNonEmptyString(ticketId)) return undefined;
  if (typeof ticketTitle !== "string") return undefined;
  if (!isFrameStatus(status)) return undefined;
  if (!isNonEmptyString(startedAt)) return undefined;
  if (!isCount(value.turns) || !isCount(value.tools) || !isCount(value.errors)) return undefined;

  const childSessionFile = value.childSessionFile;
  if (childSessionFile !== undefined && typeof childSessionFile !== "string") return undefined;

  const model = value.model;
  if (model !== undefined && typeof model !== "string") return undefined;

  const endedAt = value.endedAt;
  if (endedAt !== undefined && !isNonEmptyString(endedAt)) return undefined;

  return {
    frameId,
    ticketId,
    ticketTitle,
    childSessionFile,
    model,
    status,
    turns: value.turns,
    tools: value.tools,
    errors: value.errors,
    startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
  };
}

function headerSegments(view: SessionFrameView): SessionFrameSegment[] {
  const glyph = view.expanded ? "▾" : "▸";
  return [
    { text: `${glyph} ` },
    { text: "●", tone: "status" },
    {
      text: ` ${view.ticketId} ${view.ticketTitle} · ${sessionFrameStatusWord(view.status)}`,
    },
  ];
}

function metaSegments(view: SessionFrameView): SessionFrameSegment[] {
  const elapsed = formatElapsed(view.startedAt, view.endedAt ?? view.now);
  const parts = [
    `${view.turns} turns`,
    `${view.tools} tools`,
    `${view.errors} errors`,
    elapsed,
    view.model ?? "unknown",
    "(ctrl+o)",
  ];

  // Only one command is advertised, and only while the child can still be
  // interrupted.
  if (view.status === "running" || view.status === "verifying") {
    parts.push("/ticket-runner stop");
  }

  let text = parts.join(" • ");
  if (view.expanded) {
    const shortId = shortSessionId(view.childSessionFile);
    if (shortId !== undefined) text = `Session ${shortId} · ${text}`;
  }

  return [{ text, tone: "dim" }];
}

function contentLine(content: readonly SessionFrameSegment[], innerWidth: number): SessionFrameLine {
  const visible = truncateSegments(content, innerWidth);
  const padding = " ".repeat(Math.max(0, innerWidth - segmentLength(visible)));
  return [
    { text: "│ ", tone: "border" },
    ...visible,
    { text: padding },
    { text: " │", tone: "border" },
  ];
}

function truncateSegments(
  segments: readonly SessionFrameSegment[],
  maxWidth: number,
): readonly SessionFrameSegment[] {
  if (maxWidth <= 0) return [];
  if (segmentLength(segments) <= maxWidth) return segments;

  const limit = maxWidth - 1;
  const truncated: SessionFrameSegment[] = [];
  let remaining = limit;

  for (const segment of segments) {
    if (remaining <= 0) break;
    const text = segment.text.slice(0, remaining);
    if (text.length > 0) {
      truncated.push(segment.tone === undefined ? { text } : { text, tone: segment.tone });
      remaining -= text.length;
    }
  }

  truncated.push({ text: "…" });
  return truncated;
}

function segmentLength(segments: readonly SessionFrameSegment[]): number {
  let length = 0;
  for (const segment of segments) length += segment.text.length;
  return length;
}

function formatElapsed(startedAt: number, endedAt: number): string {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function statusColour(status: SessionFrameStatus): "warning" | "success" | "error" {
  switch (status) {
    case "done":
      return "success";
    case "failed":
      return "error";
    case "running":
    case "verifying":
    case "stopped":
      return "warning";
  }
}

function isFrameStatus(value: unknown): value is SessionFrameStatus {
  return (
    value === "running" ||
    value === "verifying" ||
    value === "done" ||
    value === "stopped" ||
    value === "failed"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
