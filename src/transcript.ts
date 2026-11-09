import { parseSkillBlock, type SessionEntry } from "@earendil-works/pi-coding-agent";

/** Appended when the expanded transcript reaches either display cap. */
export const TRUNCATION_FOOTER =
  "… truncated · open the child session in /resume for the full transcript";

/** Shown while the child session has produced no displayable messages yet. */
export const EMPTY_TRANSCRIPT_TEXT = "Transcript not yet available.";

/** Shown when a settled frame cannot read its child session file. */
export const UNAVAILABLE_TRANSCRIPT_TEXT = "Transcript unavailable";

/** One compact user turn: the skill invocation or the completion gate. */
export interface TranscriptUserEntry {
  readonly kind: "user";
  readonly text: string;
}

/** One assistant text block. Thinking blocks never reach this projection. */
export interface TranscriptAssistantEntry {
  readonly kind: "assistant";
  readonly text: string;
}

/** One tool call, with its result once the child session recorded it. */
export interface TranscriptToolEntry {
  readonly kind: "tool";
  readonly callId: string;
  readonly name: string;
  /** Compact one-line argument summary, normally the file path or command. */
  readonly summary: string;
  /** Full textual result, when the tool returned one. */
  readonly result?: string;
  /** Display diff from an edit result. */
  readonly diff?: string;
  /** Full file body from a write call. */
  readonly content?: string;
  readonly isError: boolean;
  readonly finished: boolean;
}

/** An assistant message that reports a session-level error. */
export interface TranscriptErrorEntry {
  readonly kind: "error";
  readonly text: string;
}

/** A settled frame whose persisted child session could not be opened. */
export interface TranscriptUnavailableEntry {
  readonly kind: "unavailable";
  readonly reason: string;
}

/**
 * A read-only projection of one child message.
 *
 * This is deliberately not Pi's raw session entry: frames never need tool
 * payloads, images, signatures, usage, or thinking text.
 */
export type TranscriptEntry =
  | TranscriptUserEntry
  | TranscriptAssistantEntry
  | TranscriptToolEntry
  | TranscriptErrorEntry
  | TranscriptUnavailableEntry;

/** How one projected entry is painted. */
export type TranscriptTone = "dim" | "error";

/** One rendered transcript line with an optional colour role. */
export interface TranscriptLine {
  readonly text: string;
  readonly tone?: TranscriptTone;
}

/** Renderers for the two rich content kinds. Plain text is the default. */
export interface TranscriptRenderOptions {
  /** Available content width in terminal columns. */
  readonly width: number;
  readonly maxLines: number;
  readonly maxBytes: number;
  readonly renderMarkdown?: ((text: string, width: number) => readonly string[]) | undefined;
  readonly renderDiff?: ((diff: string) => readonly string[]) | undefined;
}

/**
 * Project the child session entries into the small, display-only transcript a
 * frame renders.
 *
 * The expanded `implement` skill body becomes a compact `Skill:` turn, the
 * completion gate becomes a compact `Gate:` turn, thinking blocks are dropped,
 * and non-message entries are ignored. Tool results are attached to their call
 * by id so a call and its result render as one row plus its output.
 */
export function projectTranscript(entries: readonly SessionEntry[]): TranscriptEntry[] {
  const transcript: TranscriptEntry[] = [];
  const toolsByCallId = new Map<string, TranscriptToolEntry>();

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (!isRecord(entry.message)) continue;
    const message: Record<string, unknown> = entry.message;

    switch (message.role) {
      case "user": {
        const text = compactUserPrompt(textFromContent(message.content));
        if (text.length > 0) transcript.push({ kind: "user", text });
        break;
      }
      case "assistant": {
        const content = Array.isArray(message.content) ? message.content : [];

        const text = textFromContent(content);
        if (text.length > 0) transcript.push({ kind: "assistant", text });

        for (const block of content) {
          if (!isRecord(block) || block.type !== "toolCall") continue;

          const callId = typeof block.id === "string" ? block.id : "";
          const name = typeof block.name === "string" ? block.name : "tool";
          const args = isRecord(block.arguments) ? block.arguments : {};
          const tool: TranscriptToolEntry = {
            kind: "tool",
            callId,
            name,
            summary: compactToolArgs(name, args),
            isError: false,
            finished: false,
            ...(name === "write" && typeof args.content === "string"
              ? { content: args.content }
              : {}),
          };
          transcript.push(tool);
          if (callId.length > 0) toolsByCallId.set(callId, tool);
        }

        if (typeof message.errorMessage === "string" && message.errorMessage.length > 0) {
          transcript.push({ kind: "error", text: message.errorMessage });
        }
        break;
      }
      case "toolResult": {
        const callId = typeof message.toolCallId === "string" ? message.toolCallId : "";
        const name = typeof message.toolName === "string" ? message.toolName : "tool";
        const result = textFromContent(message.content);
        const isError = message.isError === true;
        const diff = diffFromDetails(message.details);
        const existing = callId.length > 0 ? toolsByCallId.get(callId) : undefined;

        if (existing === undefined) {
          transcript.push({
            kind: "tool",
            callId,
            name,
            summary: "",
            isError,
            finished: true,
            ...(result.length > 0 ? { result } : {}),
            ...(diff === undefined ? {} : { diff }),
          });
          break;
        }

        // Replace the call entry in place so call and result stay one row.
        const finished: TranscriptToolEntry = {
          ...existing,
          isError,
          finished: true,
          ...(result.length > 0 ? { result } : {}),
          ...(diff === undefined ? {} : { diff }),
        };
        const index = transcript.indexOf(existing);
        if (index === -1) transcript.push(finished);
        else transcript[index] = finished;
        toolsByCallId.set(callId, finished);
        break;
      }
      default:
        // The system prompt and any non-conversation role never render.
        break;
    }
  }

  return transcript;
}

/**
 * Turn a user turn into one compact line.
 *
 * Pi expands `/skill:implement …` into a skill block plus the ticket reference,
 * and the completion gate is a long fixed prompt. Both become a single label;
 * every other user turn collapses to its first line.
 */
export function compactUserPrompt(text: string): string {
  const skill = parseSkillBlock(text);
  if (skill !== null) {
    const args = compactLine(skill.userMessage ?? "");
    return args.length > 0 ? `Skill: ${skill.name} · ${args}` : `Skill: ${skill.name}`;
  }

  const gate = /^Review your implementation of (.+?)\.\s*$/m.exec(text);
  if (gate !== null && text.includes("Determine whether the ticket is fully implemented")) {
    return `Gate: verify completion · ${gate[1] ?? ""}`.trim();
  }

  return compactLine(text);
}

/**
 * Render the projected transcript as bounded display lines.
 *
 * Markdown and diffs are injected so the frame component can supply Pi's
 * native renderers while tests stay plain and deterministic.
 */
export function renderTranscript(
  entries: readonly TranscriptEntry[],
  options: TranscriptRenderOptions,
): TranscriptLine[] {
  const rendered = entries.flatMap((entry) => renderEntry(entry, options));
  if (rendered.length === 0) {
    return [{ text: EMPTY_TRANSCRIPT_TEXT, tone: "dim" }];
  }

  const kept: TranscriptLine[] = [];
  let bytes = 0;

  for (const line of rendered) {
    const lineBytes = Buffer.byteLength(line.text, "utf8");
    const withSeparator = bytes + (kept.length === 0 ? 0 : 1) + lineBytes;
    if (kept.length >= options.maxLines || withSeparator > options.maxBytes) {
      return [...kept, { text: TRUNCATION_FOOTER, tone: "dim" }];
    }
    kept.push(line);
    bytes = withSeparator;
  }

  return kept;
}

function renderEntry(entry: TranscriptEntry, options: TranscriptRenderOptions): TranscriptLine[] {
  switch (entry.kind) {
    case "user":
      return [{ text: entry.text }];
    case "assistant":
      return (options.renderMarkdown ?? splitLines)(entry.text, options.width).map((text) => ({
        text,
      }));
    case "error":
      return [{ text: `Error: ${entry.text}`, tone: "error" }];
    case "unavailable":
      return [{ text: `${UNAVAILABLE_TRANSCRIPT_TEXT} · ${entry.reason}`, tone: "error" }];
    case "tool":
      return renderTool(entry, options);
  }
}

function renderTool(entry: TranscriptToolEntry, options: TranscriptRenderOptions): TranscriptLine[] {
  const summary = entry.summary.length > 0 ? ` ${entry.summary}` : "";
  const status = entry.finished ? (entry.isError ? " — failed" : " — success") : "";
  const lines: TranscriptLine[] = [
    {
      text: `Tool: ${entry.name}${summary}${status}`,
      ...(entry.isError ? { tone: "error" as const } : {}),
    },
  ];

  if (entry.isError && entry.result !== undefined) {
    for (const line of splitLines(entry.result)) {
      lines.push({ text: line, tone: "error" });
    }
    return lines;
  }

  if (entry.diff !== undefined) {
    for (const line of (options.renderDiff ?? splitLines)(entry.diff)) {
      lines.push({ text: line });
    }
    return lines;
  }

  if (entry.content !== undefined) {
    for (const line of splitLines(entry.content)) lines.push({ text: line });
    return lines;
  }

  if (entry.result !== undefined) {
    for (const line of splitLines(entry.result)) {
      lines.push(entry.isError ? { text: line, tone: "error" } : { text: line });
    }
  }

  return lines;
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.replace(/\t/g, "   "));
}

function compactLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function compactToolArgs(name: string, args: Record<string, unknown>): string {
  if (name === "bash" && typeof args.command === "string") return compactLine(args.command);
  if (typeof args.pattern === "string") {
    return typeof args.path === "string" ? `${args.pattern} ${args.path}` : args.pattern;
  }
  if (typeof args.path === "string" && args.path.length > 0) return args.path;

  try {
    return compactLine(JSON.stringify(args));
  } catch {
    return "";
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text") continue;
    if (typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n\n");
}

function diffFromDetails(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;
  const diff = details.diff;
  return typeof diff === "string" && diff.length > 0 ? diff : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
