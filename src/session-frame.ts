import { basename } from "node:path";

import { renderDiff, type ContextUsage, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";

import { DEFAULT_CONFIG } from "./config.ts";
import {
  renderTranscript,
  type TranscriptEntry,
  type TranscriptLine,
} from "./transcript.ts";

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
 * One frame's context usage, limited to what the collapsed summary shows.
 *
 * Token counts are deliberately absent: the meta line never displays them.
 */
export interface SessionFrameContextUsage {
  /** Percentage of the window, or null while the count is unknown. */
  readonly percent: number | null;
  readonly contextWindow: number;
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
  /** Absent when the child's model reports no context window. */
  readonly contextUsage?: SessionFrameContextUsage | undefined;
}

/** Child-session facts a frame records when it is created. */
export interface SessionFrameChild {
  readonly sessionFile: string | undefined;
  readonly model: string | undefined;
  /**
   * Read the child's current display transcript.
   *
   * Called only while the frame is expanded, so a collapsed frame never walks
   * the child session entries.
   */
  readonly transcript?: (() => readonly TranscriptEntry[]) | undefined;
  /**
   * Read the child's current context usage.
   *
   * Sampled at boundaries only, never on every live repaint.
   */
  readonly contextUsage?: (() => ContextUsage | undefined) | undefined;
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
  /** Projected child transcript. Empty while the frame is collapsed. */
  readonly transcript: readonly TranscriptEntry[];
  readonly expandedTranscriptMaxLines: number;
  readonly expandedTranscriptMaxBytes: number;
  /** Absent when the child's model reports no context window. */
  readonly contextUsage: SessionFrameContextUsage | undefined;
  /** Epoch milliseconds used for the live elapsed time. */
  readonly now: number;
}

/** A colour role inside one rendered frame line. */
export type SessionFrameTone = "border" | "status" | "dim" | "warning" | "error";

/** One coloured span of a frame line. */
export interface SessionFrameSegment {
  readonly text: string;
  readonly tone?: SessionFrameTone;
}

/** One rendered frame line, made of plain-text segments with colour roles. */
export type SessionFrameLine = readonly SessionFrameSegment[];

/**
 * Render one frame's transcript rows for the expanded body.
 *
 * Limits are the configured caps; the returned rows are in display order.
 */
export type SessionFrameTranscriptRenderer = (
  entries: readonly TranscriptEntry[],
  width: number,
  limits: { readonly maxLines: number; readonly maxBytes: number },
) => readonly TranscriptLine[];

const defaultTranscriptRenderer: SessionFrameTranscriptRenderer = (entries, width, limits) =>
  renderTranscript(entries, {
    width,
    maxLines: limits.maxLines,
    maxBytes: limits.maxBytes,
  });

/**
 * Render one session frame from a view model.
 *
 * This is a pure function: the same view and width always produce the same
 * segments. The border always occupies the full supplied width, and every
 * content line is truncated to the space between the borders. An expanded
 * frame inserts a separating rule and the projected transcript before the
 * bottom border.
 */
export function renderSessionFrame(
  view: SessionFrameView,
  width: number,
  transcriptRenderer: SessionFrameTranscriptRenderer = defaultTranscriptRenderer,
): SessionFrameLine[] {
  const outerWidth = Math.floor(width);
  if (!Number.isFinite(outerWidth) || outerWidth < 4) return [];

  const innerWidth = outerWidth - 4;
  const horizontal = "─".repeat(outerWidth - 2);

  const lines: SessionFrameLine[] = [
    [{ text: `┌${horizontal}┐`, tone: "border" }],
    contentLine(headerSegments(view), innerWidth),
    contentLine([{ text: "  " }, ...metaSegments(view)], innerWidth),
  ];

  if (view.expanded) {
    lines.push([{ text: `├${horizontal}┤`, tone: "border" }]);
    const transcript = transcriptRenderer(view.transcript, innerWidth, {
      maxLines: view.expandedTranscriptMaxLines,
      maxBytes: view.expandedTranscriptMaxBytes,
    });
    for (const line of transcript) lines.push(transcriptLine(line, innerWidth));
  }

  lines.push([{ text: `└${horizontal}┘`, tone: "border" }]);
  return lines;
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
        case "warning":
          return theme.fg("warning", segment.text);
        case "error":
          return theme.fg("error", segment.text);
        default:
          return segment.text;
      }
    })
    .join("");
}

/** A view snapshot, or a source that supplies the current live view. */
export type SessionFrameViewSource = SessionFrameView | (() => SessionFrameView);

/** Options for a frame component's rich renderers. */
export interface SessionFrameComponentOptions {
  readonly renderMarkdown?: ((text: string, width: number) => readonly string[]) | undefined;
  readonly renderDiff?: ((diff: string) => readonly string[]) | undefined;
}

/**
 * A Pi component that renders one session frame.
 *
 * Pi caches custom entry components, so a live frame passes a view *source*
 * rather than a snapshot. Every render reads the current counters, status, and
 * transcript; a repaint of the TUI is enough to show them. Static frames pass a
 * plain view.
 */
export class SessionFrameComponent implements Component {
  private readonly source: SessionFrameViewSource;
  private readonly theme: Theme;
  private readonly renderMarkdown: (text: string, width: number) => readonly string[];
  private readonly renderDiff: (diff: string) => readonly string[];

  constructor(
    view: SessionFrameViewSource,
    theme: Theme,
    options: SessionFrameComponentOptions = {},
  ) {
    this.source = view;
    this.theme = theme;
    this.renderMarkdown =
      options.renderMarkdown ??
      ((text, width) => new Markdown(text, 0, 0, markdownTheme(theme)).render(width));
    this.renderDiff = options.renderDiff ?? ((diff) => renderDiff(diff).split("\n"));
  }

  invalidate(): void {}

  render(width: number): string[] {
    const view = typeof this.source === "function" ? this.source() : this.source;
    const lines = renderSessionFrame(view, width, (entries, innerWidth, limits) =>
      renderTranscript(entries, {
        width: innerWidth,
        maxLines: limits.maxLines,
        maxBytes: limits.maxBytes,
        renderMarkdown: this.renderMarkdown,
        renderDiff: this.renderDiff,
      }),
    );
    return lines.map((line) => paintSessionFrameLine(line, view.status, this.theme));
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
  limits: { readonly maxLines?: number | undefined; readonly maxBytes?: number | undefined } = {},
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
    transcript: [],
    expandedTranscriptMaxLines: limits.maxLines ?? DEFAULT_CONFIG.expandedTranscriptMaxLines,
    expandedTranscriptMaxBytes: limits.maxBytes ?? DEFAULT_CONFIG.expandedTranscriptMaxBytes,
    contextUsage: summary.contextUsage,
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

  // A malformed context usage is dropped on its own; the rest of the summary
  // still renders, so one bad value can never hide a frame.
  const contextUsage = readContextUsage(value.contextUsage);

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
    ...(contextUsage === undefined ? {} : { contextUsage }),
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
  const segments: SessionFrameSegment[] = [
    { text: `${view.turns} turns • ${view.tools} tools • ${view.errors} errors`, tone: "dim" },
  ];

  const usage = contextUsageSegment(view.contextUsage);
  if (usage !== undefined) segments.push({ text: " • ", tone: "dim" }, usage);

  segments.push({
    text: ` • ${elapsed} • ${view.model ?? "unknown"} • (ctrl+o)`,
    tone: "dim",
  });

  // Only one command is advertised, and only while the child can still be
  // interrupted.
  if (view.status === "running" || view.status === "verifying") {
    segments.push({ text: " • /ticket-runner stop", tone: "dim" });
  }

  if (view.expanded) {
    const shortId = shortSessionId(view.childSessionFile);
    if (shortId !== undefined) segments.unshift({ text: `Session ${shortId} · `, tone: "dim" });
  }

  return segments;
}

/** Render the context-usage segment, or nothing when there is no window. */
function contextUsageSegment(
  usage: SessionFrameContextUsage | undefined,
): SessionFrameSegment | undefined {
  if (usage === undefined) return undefined;

  const window = formatTokenCount(usage.contextWindow);
  const text = usage.percent === null ? `?/${window}` : `${usage.percent.toFixed(1)}%/${window}`;

  if (usage.percent !== null && usage.percent > 90) return { text, tone: "error" };
  if (usage.percent !== null && usage.percent > 70) return { text, tone: "warning" };
  return { text, tone: "dim" };
}

/** Abbreviate a token count like Pi's footer (`200k`, `1M`). */
function formatTokenCount(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${trimTrailingZero((count / 1_000).toFixed(1))}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${trimTrailingZero((count / 1_000_000).toFixed(1))}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

/** Drop Pi's cosmetic `.0` so a round window reads `1M`, not `1.0M`. */
function trimTrailingZero(text: string): string {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/**
 * Validate a persisted context usage as a unit.
 *
 * Absent and malformed values are both undefined; the caller keeps the rest of
 * the summary either way.
 */
function readContextUsage(value: unknown): SessionFrameContextUsage | undefined {
  if (!isRecord(value)) return undefined;

  const contextWindow = value.contextWindow;
  if (
    typeof contextWindow !== "number" ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return undefined;
  }

  const percent = value.percent;
  if (percent !== null && (typeof percent !== "number" || !Number.isFinite(percent))) {
    return undefined;
  }

  return { percent, contextWindow };
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

function transcriptLine(line: TranscriptLine, innerWidth: number): SessionFrameLine {
  const text = truncateToWidth(line.text, innerWidth, "…", true);
  return [
    { text: "│ ", tone: "border" },
    line.tone === undefined ? { text } : { text, tone: line.tone },
    { text: " │", tone: "border" },
  ];
}

/** Build the Markdown theme from a Pi theme so injected themes stay testable. */
function markdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: (text) => theme.fg("mdHeading", theme.bold(text)),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    underline: (text) => theme.underline(text),
    strikethrough: (text) => theme.strikethrough(text),
  };
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
