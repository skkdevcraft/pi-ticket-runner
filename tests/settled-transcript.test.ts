import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { describe, it } from "node:test";

import type { CustomEntry, Theme } from "@earendil-works/pi-coding-agent";

import {
  FRAME_ENTRY_TYPE,
  SessionFrameComponent,
  type SessionFrameSummary,
} from "../src/session-frame.ts";
import { SessionFrameController, SessionFrameRegistry } from "../src/session-frames.ts";
import {
  openSessionTranscript,
  type SessionTranscriptLoader,
} from "../src/session-transcript.ts";
import { renderTranscript, type TranscriptEntry } from "../src/transcript.ts";
import type { Ticket } from "../src/tickets.ts";
import {
  createTempTree,
  makeUnreadable,
  permissionsAreEnforced,
  type TempTree,
} from "./helpers.ts";

const identityTheme = {
  fg: (_colour: string, text: string) => text,
} as unknown as Theme;

function ticket(id = "12", title = "Settled transcript"): Ticket {
  return {
    id,
    number: Number.parseInt(id, 10),
    slug: "settled-transcript",
    filename: `${id}-settled-transcript.md`,
    path: `/project/issues/${id}-settled-transcript.md`,
    reference: `issues/${id}-settled-transcript.md`,
    status: "ready-for-agent",
    title,
  };
}

function summary(overrides: Partial<SessionFrameSummary> = {}): SessionFrameSummary {
  return {
    frameId: "frame-1",
    ticketId: "12",
    ticketTitle: "Settled transcript",
    childSessionFile: "/sessions/child.jsonl",
    model: "gpt-5",
    status: "done",
    turns: 3,
    tools: 2,
    errors: 0,
    startedAt: "2025-01-01T00:00:00.000Z",
    endedAt: "2025-01-01T00:00:12.000Z",
    ...overrides,
  };
}

function frameEntry(id: string, data: SessionFrameSummary | unknown): CustomEntry {
  return {
    type: "custom",
    customType: FRAME_ENTRY_TYPE,
    id,
    parentId: null,
    timestamp: "2025-01-01T00:00:00.000Z",
    data,
  };
}

interface SessionMessage {
  readonly role: string;
  readonly content: unknown;
  readonly [key: string]: unknown;
}

function messageEntry(id: string, parentId: string | null, message: SessionMessage): unknown {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2025-01-01T00:00:01.000Z",
    message,
  };
}

/** Write a real Pi session file, so loading goes through the public SDK reader. */
function writeSessionFile(
  tree: TempTree,
  relativePath: string,
  entries: readonly unknown[],
): string {
  const header = {
    type: "session",
    version: 3,
    id: "fixture-session",
    timestamp: "2025-01-01T00:00:00.000Z",
    cwd: "/project",
  };
  const lines = [header, ...entries].map((entry) => JSON.stringify(entry));
  return tree.write(relativePath, `${lines.join("\n")}\n`);
}

function fixtureTranscript(): { file: string; tree: TempTree } {
  const tree = createTempTree();
  const user = messageEntry("entry-1", null, {
    role: "user",
    content: "Skill: implement · issues/12-settled-transcript.md",
  });
  const assistant = messageEntry("entry-2", "entry-1", {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hidden reasoning" },
      { type: "text", text: "Loaded from the child session file." },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } },
    ],
    api: "test",
    provider: "test",
    model: "gpt-5",
    usage: {},
    stopReason: "stop",
  });
  const result = messageEntry("entry-3", "entry-2", {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "export const a = 1;\n" }],
    isError: false,
  });

  return {
    tree,
    file: writeSessionFile(tree, "sessions/child.jsonl", [user, assistant, result]),
  };
}

function renderedText(component: unknown, width = 120): string[] {
  assert.ok(component instanceof SessionFrameComponent);
  return component.render(width);
}

function loadedTranscriptLoader(
  entries: readonly TranscriptEntry[],
): { loader: SessionTranscriptLoader; calls: Array<string | undefined> } {
  const calls: Array<string | undefined> = [];
  return {
    calls,
    loader: (sessionFile) => {
      calls.push(sessionFile);
      return { kind: "loaded", entries };
    },
  };
}

describe("openSessionTranscript", () => {
  it("loads and projects a fixture child session file through the public reader", () => {
    const { file } = fixtureTranscript();
    const result = openSessionTranscript(file);

    assert.equal(result.kind, "loaded");
    if (result.kind !== "loaded") return;
    assert.deepEqual(result.entries, [
      { kind: "user", text: "Skill: implement · issues/12-settled-transcript.md" },
      { kind: "assistant", text: "Loaded from the child session file." },
      {
        kind: "tool",
        callId: "call-1",
        name: "read",
        summary: "src/a.ts",
        result: "export const a = 1;\n",
        isError: false,
        finished: true,
      },
    ]);
    assert.doesNotMatch(JSON.stringify(result), /hidden reasoning/);
  });

  it("reports a missing session file instead of throwing", () => {
    const tree = createTempTree();
    const result = openSessionTranscript(tree.path("sessions/missing.jsonl"));

    assert.equal(result.kind, "unavailable");
    if (result.kind !== "unavailable") return;
    assert.match(result.reason, /not found/i);
  });

  it("reports a session file that was never recorded", () => {
    const result = openSessionTranscript(undefined);

    assert.equal(result.kind, "unavailable");
    if (result.kind !== "unavailable") return;
    assert.match(result.reason, /not recorded/i);
  });

  it("reports an unreadable session file instead of throwing", { skip: !permissionsAreEnforced() }, () => {
    const { file } = fixtureTranscript();
    makeUnreadable(file);
    try {
      const result = openSessionTranscript(file);
      assert.equal(result.kind, "unavailable");
      if (result.kind !== "unavailable") return;
      assert.match(result.reason, /permission|denied|EACCES/i);
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it("reports a session file that is not a valid Pi session instead of throwing", () => {
    const tree = createTempTree();
    const file = tree.write("sessions/broken.jsonl", "not a session\n");
    const result = openSessionTranscript(file);

    assert.equal(result.kind, "unavailable");
    if (result.kind !== "unavailable") return;
    assert.match(result.reason, /not a valid .* session/i);
  });

  it("loads an empty session as an empty projection", () => {
    const tree = createTempTree();
    const file = writeSessionFile(tree, "sessions/empty.jsonl", []);
    const result = openSessionTranscript(file);

    assert.equal(result.kind, "loaded");
    if (result.kind !== "loaded") return;
    assert.deepEqual(result.entries, []);
    assert.deepEqual(
      renderTranscript(result.entries, { width: 80, maxLines: 100, maxBytes: 10_000 }),
      [{ text: "Transcript not yet available.", tone: "dim" }],
    );
  });
});

describe("settled frame transcripts", () => {
  it("renders summary data without reading a collapsed frame's transcript", () => {
    const { loader, calls } = loadedTranscriptLoader([{ kind: "assistant", text: "secret body" }]);
    const registry = new SessionFrameRegistry({ now: () => 20_000, openTranscript: loader });
    const entry = frameEntry("entry-2", summary());
    registry.rememberEntries([entry]);

    const lines = renderedText(registry.renderEntry(entry, false, identityTheme));

    assert.equal(calls.length, 0);
    assert.match(lines[1] ?? "", /12 Settled transcript · Done/);
    assert.doesNotMatch(lines.join("\n"), /secret body/);
  });

  it("loads a fixture transcript on expand and caches it until collapse", () => {
    const { file } = fixtureTranscript();
    const registry = new SessionFrameRegistry({
      now: () => 20_000,
      openTranscript: (sessionFile) => openSessionTranscript(sessionFile),
    });
    const entry = frameEntry("entry-2", summary({ childSessionFile: file }));
    registry.rememberEntries([entry]);

    const expanded = registry.renderEntry(entry, true, identityTheme);
    const first = renderedText(expanded).join("\n");
    assert.match(first, /Loaded from the child session file\./);
    assert.match(first, /export const a = 1;/);

    // Repeated renders of an expanded settled frame reuse the cache rather than
    // reopening the child session file.
    const cachedComponent = registry.renderEntry(entry, true, identityTheme);
    assert.match(renderedText(cachedComponent).join("\n"), /Loaded from the child session file\./);

    registry.renderEntry(entry, false, identityTheme);
    const reloaded = renderedText(registry.renderEntry(entry, true, identityTheme)).join("\n");
    assert.match(reloaded, /Loaded from the child session file\./);
  });

  it("reloads after collapse instead of keeping the expanded cache", () => {
    const { loader, calls } = loadedTranscriptLoader([{ kind: "assistant", text: "first load" }]);
    const registry = new SessionFrameRegistry({ openTranscript: loader });
    const entry = frameEntry("entry-2", summary());
    registry.rememberEntries([entry]);

    assert.match(renderedText(registry.renderEntry(entry, true, identityTheme)).join("\n"), /first load/);
    assert.equal(calls.length, 1);

    registry.renderEntry(entry, false, identityTheme);
    assert.match(renderedText(registry.renderEntry(entry, true, identityTheme)).join("\n"), /first load/);
    assert.equal(calls.length, 2);
  });

  it("drops the cache when the run tears down", () => {
    const { loader, calls } = loadedTranscriptLoader([{ kind: "assistant", text: "body" }]);
    const registry = new SessionFrameRegistry({ openTranscript: loader });
    const controller = new SessionFrameController({
      registry,
      append: () => "entry-2",
    });
    const entry = frameEntry("entry-2", summary());
    registry.rememberEntries([entry]);

    registry.renderEntry(entry, true, identityTheme);
    assert.equal(calls.length, 1);

    controller.teardown();
    registry.renderEntry(entry, true, identityTheme);
    assert.equal(calls.length, 2);
  });

  it("drops the cache on shutdown", () => {
    const { loader, calls } = loadedTranscriptLoader([{ kind: "assistant", text: "body" }]);
    const registry = new SessionFrameRegistry({ openTranscript: loader });
    const controller = new SessionFrameController({
      registry,
      append: () => "entry-2",
    });
    const entry = frameEntry("entry-2", summary());
    registry.rememberEntries([entry]);

    registry.renderEntry(entry, true, identityTheme);
    assert.equal(calls.length, 1);

    controller.shutdown();
    registry.renderEntry(entry, true, identityTheme);
    assert.equal(calls.length, 2);
  });

  it("renders a clear unavailable message when the child session file is missing", () => {
    const tree = createTempTree();
    const registry = new SessionFrameRegistry();
    const entry = frameEntry(
      "entry-2",
      summary({ childSessionFile: tree.path("sessions/missing.jsonl") }),
    );
    registry.rememberEntries([entry]);

    const lines = renderedText(registry.renderEntry(entry, true, identityTheme)).join("\n");
    assert.match(lines, /Transcript unavailable · .*not found/i);
  });

  it("renders the empty-session message for a header-only child session", () => {
    const tree = createTempTree();
    const file = writeSessionFile(tree, "sessions/empty.jsonl", []);
    const registry = new SessionFrameRegistry();
    const entry = frameEntry("entry-2", summary({ childSessionFile: file }));
    registry.rememberEntries([entry]);

    const lines = renderedText(registry.renderEntry(entry, true, identityTheme)).join("\n");
    assert.match(lines, /Transcript not yet available\./);
  });

  it("keeps transcript content out of the persisted summary", () => {
    const transcript: TranscriptEntry[] = [
      { kind: "assistant", text: "never persist this transcript body" },
    ];
    const appended: SessionFrameSummary[] = [];
    const controller = new SessionFrameController({
      registry: new SessionFrameRegistry(),
      append: (value) => {
        appended.push(value);
        return `entry-${appended.length}`;
      },
    });

    controller.start(ticket(), {
      sessionFile: "/sessions/child.jsonl",
      model: "gpt-5",
      transcript: () => transcript,
    });
    controller.settle("done");

    assert.equal(appended.length, 2);
    assert.doesNotMatch(JSON.stringify(appended), /never persist this transcript body/);
  });
});
