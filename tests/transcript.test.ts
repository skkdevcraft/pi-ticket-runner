import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { buildCompletionGatePrompt } from "../src/gate.ts";
import {
  TRUNCATION_FOOTER,
  compactUserPrompt,
  projectTranscript,
  renderTranscript,
  type TranscriptLine,
  type TranscriptRenderOptions,
} from "../src/transcript.ts";

const REFERENCE = ".scratch/pi-ticket-runner/issues/11-expanded-live-transcript.md";

function messageEntry(message: unknown, id = "entry"): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2025-01-01T00:00:00.000Z",
    message,
  } as unknown as SessionEntry;
}

function userMessage(content: string): SessionEntry {
  return messageEntry({ role: "user", content, timestamp: 0 });
}

function assistantMessage(content: unknown[], overrides: Record<string, unknown> = {}): SessionEntry {
  return messageEntry({
    role: "assistant",
    content,
    api: "test",
    provider: "test",
    model: "gpt-5",
    usage: {},
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  });
}

function toolResult(
  toolCallId: string,
  toolName: string,
  text: string,
  options: { isError?: boolean; details?: unknown } = {},
): SessionEntry {
  return messageEntry({
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: options.isError ?? false,
    timestamp: 0,
    ...(options.details === undefined ? {} : { details: options.details }),
  });
}

function skillUserMessage(name: string, reference: string): string {
  return `<skill name="${name}" location="/skills/${name}/SKILL.md">
References are relative to /skills/${name}.

Expanded skill body that must never reach the frame.
</skill>

${reference}`;
}

/** Render without Markdown or diff styling so assertions see plain text. */
function plainOptions(overrides: Partial<TranscriptRenderOptions> = {}): TranscriptRenderOptions {
  return {
    width: 100,
    maxLines: 1_000,
    maxBytes: 131_072,
    ...overrides,
  };
}

function text(lines: readonly TranscriptLine[]): string[] {
  return lines.map((line) => line.text);
}

describe("compactUserPrompt", () => {
  it("compacts the expanded implement skill invocation into one line", () => {
    assert.equal(
      compactUserPrompt(skillUserMessage("implement", REFERENCE)),
      `Skill: implement · ${REFERENCE}`,
    );
  });

  it("compacts the completion-gate prompt into one line", () => {
    assert.equal(
      compactUserPrompt(buildCompletionGatePrompt(REFERENCE, ["ready-for-agent"])),
      `Gate: verify completion · ${REFERENCE}`,
    );
  });

  it("collapses any other user turn to a single trimmed line", () => {
    assert.equal(compactUserPrompt("  first\n\nsecond   line  "), "first second line");
  });
});

describe("projectTranscript", () => {
  it("projects a skill invocation as a compact user turn and drops the skill body", () => {
    const entries = projectTranscript([
      userMessage(skillUserMessage("implement", REFERENCE)),
    ]);

    assert.deepEqual(entries, [
      { kind: "user", text: `Skill: implement · ${REFERENCE}` },
    ]);
  });

  it("projects the gate prompt as a compact user turn", () => {
    const entries = projectTranscript([
      userMessage(buildCompletionGatePrompt(REFERENCE, ["ready-for-agent"])),
    ]);

    assert.deepEqual(entries, [
      { kind: "user", text: `Gate: verify completion · ${REFERENCE}` },
    ]);
  });

  it("projects assistant text and excludes thinking blocks", () => {
    const entries = projectTranscript([
      assistantMessage([
        { type: "thinking", thinking: "secret reasoning" },
        { type: "text", text: "Writing the repository layer." },
      ]),
    ]);

    assert.deepEqual(entries, [
      { kind: "assistant", text: "Writing the repository layer." },
    ]);
    assert.doesNotMatch(JSON.stringify(entries), /secret reasoning/);
  });

  it("projects tool calls with results, matching results by call id", () => {
    const entries = projectTranscript([
      assistantMessage([
        { type: "text", text: "Reading the file." },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/repository.ts" } },
      ]),
      toolResult("call-1", "read", "export const repository = {};\n"),
    ]);

    assert.deepEqual(entries, [
      { kind: "assistant", text: "Reading the file." },
      {
        kind: "tool",
        callId: "call-1",
        name: "read",
        summary: "src/repository.ts",
        result: "export const repository = {};\n",
        isError: false,
        finished: true,
      },
    ]);
  });

  it("keeps edit diffs from tool-result details", () => {
    const entries = projectTranscript([
      assistantMessage([
        { type: "toolCall", id: "call-2", name: "edit", arguments: { path: "src/a.ts" } },
      ]),
      toolResult("call-2", "edit", "Successfully replaced 1 block(s) in src/a.ts.", {
        details: { diff: "+1 const a = 1;\n-1 const a = 0;" },
      }),
    ]);

    assert.equal(entries[0]?.kind, "tool");
    if (entries[0]?.kind !== "tool") return;
    assert.equal(entries[0].diff, "+1 const a = 1;\n-1 const a = 0;");
    assert.equal(entries[0].finished, true);
  });

  it("keeps write content from the tool-call arguments", () => {
    const entries = projectTranscript([
      assistantMessage([
        {
          type: "toolCall",
          id: "call-3",
          name: "write",
          arguments: { path: "src/new.ts", content: "line one\nline two" },
        },
      ]),
      toolResult("call-3", "write", "Successfully wrote to src/new.ts"),
    ]);

    assert.equal(entries[0]?.kind, "tool");
    if (entries[0]?.kind !== "tool") return;
    assert.equal(entries[0].content, "line one\nline two");
    assert.equal(entries[0].summary, "src/new.ts");
  });

  it("marks failed tool results and keeps their error text", () => {
    const entries = projectTranscript([
      assistantMessage([
        { type: "toolCall", id: "call-4", name: "bash", arguments: { command: "npm test" } },
      ]),
      toolResult("call-4", "bash", "1 test failed", { isError: true }),
    ]);

    assert.equal(entries[0]?.kind, "tool");
    if (entries[0]?.kind !== "tool") return;
    assert.equal(entries[0].isError, true);
    assert.equal(entries[0].result, "1 test failed");
  });

  it("projects an assistant error message as an error entry", () => {
    const entries = projectTranscript([
      assistantMessage([], { errorMessage: "Provider unavailable", stopReason: "error" }),
    ]);

    assert.deepEqual(entries, [{ kind: "error", text: "Provider unavailable" }]);
  });

  it("excludes the system prompt and non-message entries", () => {
    const entries = projectTranscript([
      messageEntry({ role: "system", content: "You are a helpful agent.", timestamp: 0 }, "system"),
      {
        type: "custom",
        id: "custom",
        parentId: null,
        timestamp: "2025-01-01T00:00:00.000Z",
        customType: "ticket-runner-frame",
        data: {},
      },
      {
        type: "model_change",
        id: "model",
        parentId: null,
        timestamp: "2025-01-01T00:00:00.000Z",
        provider: "test",
        modelId: "gpt-5",
      },
    ]);

    assert.deepEqual(entries, []);
  });

  it("keeps an unmatched tool result visible", () => {
    const entries = projectTranscript([toolResult("orphan", "bash", "orphaned output")]);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "tool");
    if (entries[0]?.kind !== "tool") return;
    assert.equal(entries[0].result, "orphaned output");
    assert.equal(entries[0].finished, true);
  });
});

describe("renderTranscript", () => {
  it("reports an empty child session", () => {
    assert.deepEqual(text(renderTranscript([], plainOptions())), [
      "Transcript not yet available.",
    ]);
  });

  it("renders compact turns, assistant Markdown, and full tool results", () => {
    const lines = renderTranscript(
      [
        { kind: "user", text: `Skill: implement · ${REFERENCE}` },
        { kind: "assistant", text: "Writing the repository layer." },
        {
          kind: "tool",
          callId: "call-1",
          name: "read",
          summary: "src/repository.ts",
          result: "export const repository = {};",
          isError: false,
          finished: true,
        },
      ],
      plainOptions({
        renderMarkdown: (markdown) => [`md:${markdown}`],
      }),
    );

    assert.deepEqual(text(lines), [
      `Skill: implement · ${REFERENCE}`,
      "md:Writing the repository layer.",
      "Tool: read src/repository.ts — success",
      "export const repository = {};",
    ]);
  });

  it("renders edit results as diffs and write results as their full content", () => {
    const lines = renderTranscript(
      [
        {
          kind: "tool",
          callId: "call-1",
          name: "edit",
          summary: "src/a.ts",
          result: "Successfully replaced 1 block(s) in src/a.ts.",
          diff: "+1 const a = 1;\n-1 const a = 0;",
          isError: false,
          finished: true,
        },
        {
          kind: "tool",
          callId: "call-2",
          name: "write",
          summary: "src/new.ts",
          result: "Successfully wrote to src/new.ts",
          content: "line one\nline two",
          isError: false,
          finished: true,
        },
      ],
      plainOptions({
        renderDiff: (diff) => diff.split("\n").map((line) => `diff:${line}`),
      }),
    );

    assert.deepEqual(text(lines), [
      "Tool: edit src/a.ts — success",
      "diff:+1 const a = 1;",
      "diff:-1 const a = 0;",
      "Tool: write src/new.ts — success",
      "line one",
      "line two",
    ]);
    assert.doesNotMatch(text(lines).join("\n"), /Successfully/);
  });

  it("uses the error tone for failed tool rows and their output", () => {
    const lines = renderTranscript(
      [
        {
          kind: "tool",
          callId: "call-1",
          name: "bash",
          summary: "npm test",
          result: "1 test failed",
          isError: true,
          finished: true,
        },
        { kind: "error", text: "Provider unavailable" },
      ],
      plainOptions(),
    );

    assert.deepEqual(text(lines), [
      "Tool: bash npm test — failed",
      "1 test failed",
      "Error: Provider unavailable",
    ]);
    assert.equal(lines[0]?.tone, "error");
    assert.equal(lines[1]?.tone, "error");
    assert.equal(lines[2]?.tone, "error");
  });

  it("shows a failed write's error instead of its content", () => {
    const lines = renderTranscript(
      [
        {
          kind: "tool",
          callId: "call-1",
          name: "write",
          summary: "src/locked.ts",
          content: "should not render",
          result: "EACCES: permission denied",
          isError: true,
          finished: true,
        },
      ],
      plainOptions(),
    );

    assert.deepEqual(text(lines), [
      "Tool: write src/locked.ts — failed",
      "EACCES: permission denied",
    ]);
    assert.doesNotMatch(text(lines).join("\n"), /should not render/);
  });

  it("shows an unfinished tool call without a status suffix", () => {
    const lines = renderTranscript(
      [
        {
          kind: "tool",
          callId: "call-1",
          name: "write",
          summary: "src/new.ts",
          content: "line one",
          isError: false,
          finished: false,
        },
      ],
      plainOptions(),
    );

    assert.equal(lines[0]?.text, "Tool: write src/new.ts");
  });

  it("caps the transcript by line count and appends the truncation footer", () => {
    const lines = renderTranscript(
      [
        { kind: "assistant", text: "one\ntwo\nthree" },
        { kind: "assistant", text: "four" },
      ],
      plainOptions({ maxLines: 2 }),
    );

    assert.deepEqual(text(lines), ["one", "two", TRUNCATION_FOOTER]);
  });

  it("caps the transcript by byte count and appends the truncation footer", () => {
    const lines = renderTranscript(
      [{ kind: "assistant", text: "12345\n67890\nabcde" }],
      plainOptions({ maxBytes: 10 }),
    );

    assert.deepEqual(text(lines), ["12345", TRUNCATION_FOOTER]);
  });

  it("prefers whichever cap is reached first", () => {
    const lines = renderTranscript(
      [{ kind: "assistant", text: "12345\n67890\nabcde" }],
      plainOptions({ maxBytes: 10, maxLines: 2 }),
    );

    assert.deepEqual(text(lines), ["12345", TRUNCATION_FOOTER]);
  });

  it("does not append the footer when the transcript fits both caps", () => {
    const lines = renderTranscript(
      [{ kind: "assistant", text: "one\ntwo" }],
      plainOptions({ maxLines: 2, maxBytes: 100 }),
    );

    assert.deepEqual(text(lines), ["one", "two"]);
  });
});
