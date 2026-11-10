import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CustomEntry, Theme } from "@earendil-works/pi-coding-agent";

import {
  FRAME_ENTRY_TYPE,
  SessionFrameComponent,
  paintSessionFrameLine,
  readSessionFrameSummary,
  renderSessionFrame,
  sessionFrameText,
  shortSessionId,
  summaryToFrameView,
  type SessionFrameStatus,
  type SessionFrameSummary,
  type SessionFrameView,
} from "../src/session-frame.ts";
import {
  SessionFrameController,
  SessionFrameRegistry,
} from "../src/session-frames.ts";
import type { TranscriptEntry } from "../src/transcript.ts";
import type { Ticket } from "../src/tickets.ts";
import { settled, textDelta, thinkingDelta, messageEnd, toolEnd, toolStart, turnEnd } from "./helpers.ts";

const SESSION_FILE = "/sessions/2025-01-01T00-00-00_0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl";
const SHORT_ID = "0190a1";

function ticket(id = "03", title = "Repository Layer"): Ticket {
  return {
    id,
    number: Number.parseInt(id, 10),
    slug: "repository-layer",
    filename: `${id}-repository-layer.md`,
    path: `/project/issues/${id}-repository-layer.md`,
    reference: `issues/${id}-repository-layer.md`,
    status: "ready-for-agent",
    title,
  };
}

function view(overrides: Partial<SessionFrameView> = {}): SessionFrameView {
  return {
    frameId: "frame-1",
    ticketId: "03",
    ticketTitle: "Repository Layer",
    status: "running",
    turns: 3,
    tools: 2,
    errors: 0,
    startedAt: 0,
    endedAt: undefined,
    model: "gpt-5",
    childSessionFile: SESSION_FILE,
    expanded: false,
    transcript: [],
    expandedTranscriptMaxLines: 1_000,
    expandedTranscriptMaxBytes: 131_072,
    contextUsage: undefined,
    now: 12_000,
    ...overrides,
  };
}

function summary(overrides: Partial<SessionFrameSummary> = {}): SessionFrameSummary {
  return {
    frameId: "frame-1",
    ticketId: "03",
    ticketTitle: "Repository Layer",
    childSessionFile: SESSION_FILE,
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

function runningSummary(overrides: Partial<SessionFrameSummary> = {}): SessionFrameSummary {
  const { endedAt: _endedAt, ...base } = summary(overrides);
  return base;
}

interface FakeTheme {
  readonly theme: Theme;
  readonly calls: Array<{ colour: string; text: string }>;
}

function fakeTheme(): FakeTheme {
  const calls: Array<{ colour: string; text: string }> = [];
  const theme = {
    fg(colour: string, text: string) {
      calls.push({ colour, text });
      return `[${colour}]${text}[/]`;
    },
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  } as unknown as Theme;
  return { theme, calls };
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

function renderedLines(component: unknown, width = 120): string[] {
  assert.ok(component instanceof SessionFrameComponent);
  return component.render(width);
}

/** Strip the fake theme's `[colour]...[ /]` markers from a painted line. */
function unstyled(painted: string): string {
  return painted.replace(/\[[^\]]*\]/g, "");
}

describe("renderSessionFrame", () => {
  it("draws a full-width border and a collapsed header and meta line", () => {
    const lines = sessionFrameText(renderSessionFrame(view(), 120));

    assert.equal(lines.length, 4);
    for (const line of lines) assert.equal(line.length, 120);
    assert.match(lines[0] ?? "", /^┌─+┐$/);
    assert.match(lines[3] ?? "", /^└─+┘$/);
    assert.match(lines[1] ?? "", /│ ▸ ● 03 Repository Layer · Running/);
  });

  it("shows turns, tools, errors, elapsed time, model, and both hints while running", () => {
    const meta = sessionFrameText(renderSessionFrame(view(), 160))[2] ?? "";

    assert.match(meta, /3 turns/);
    assert.match(meta, /2 tools/);
    assert.match(meta, /0 errors/);
    assert.match(meta, /12s/);
    assert.match(meta, /gpt-5/);
    assert.match(meta, /\(ctrl\+o\)/);
    assert.match(meta, /\/ticket-runner stop/);
    assert.doesNotMatch(meta, /to interrupt/);
  });

  it("omits the stop command once the frame settles", () => {
    const doneLines = sessionFrameText(renderSessionFrame(view({ status: "done" }), 160));
    assert.doesNotMatch(doneLines[2] ?? "", /\/ticket-runner stop/);
    assert.match(doneLines[1] ?? "", /· Done/);
  });

  it("uses the expanded glyph and prepends the short session id", () => {
    const lines = sessionFrameText(renderSessionFrame(view({ expanded: true }), 160));

    assert.match(lines[1] ?? "", /│ ▾ ● 03 Repository Layer · Running/);
    assert.match(lines[2] ?? "", new RegExp(`Session ${SHORT_ID} · 3 turns`));
  });

  it("truncates content and keeps every line within the supplied width", () => {
    const width = 34;
    const lines = sessionFrameText(renderSessionFrame(view(), width));

    assert.equal(lines.length, 4);
    for (const line of lines) assert.equal(line.length, width);
    assert.match(lines[1] ?? "", /…/);
    assert.match(lines[2] ?? "", /…/);
  });

  it("paints the border muted, the status dot by status, and the meta dim", () => {
    const { theme, calls } = fakeTheme();
    const lines = renderSessionFrame(view({ status: "failed" }), 80);
    const painted = lines.map((line) => paintSessionFrameLine(line, "failed", theme));

    assert.match(painted[0] ?? "", /^\[borderMuted\]┌/);
    assert.ok(calls.some((call) => call.colour === "error" && call.text === "●"));
    assert.ok(calls.some((call) => call.colour === "dim" && call.text.includes("3 turns")));
    assert.ok(calls.some((call) => call.colour === "borderMuted" && call.text === " │"));
  });

  it("colours context usage dim below 70%, warning above 70%, and error above 90%", () => {
    const expected: Array<[number | null, string]> = [
      [42.1, "dim"],
      [70, "dim"],
      [70.1, "warning"],
      [90, "warning"],
      [90.1, "error"],
      [null, "dim"],
    ];

    for (const [percent, colour] of expected) {
      const { theme, calls } = fakeTheme();
      const lines = renderSessionFrame(
        view({ contextUsage: { percent, contextWindow: 200_000 } }),
        160,
      );
      lines.forEach((line) => paintSessionFrameLine(line, "running", theme));

      const label = percent === null ? "?" : `${percent}%`;
      assert.ok(
        calls.some((call) => call.colour === colour && call.text.includes("200k")),
        `${label} should paint context usage with ${colour}`,
      );
    }
  });

  it("colours each status dot according to the frame status", () => {
    const expected: Array<[SessionFrameStatus, string]> = [
      ["running", "warning"],
      ["verifying", "warning"],
      ["done", "success"],
      ["stopped", "warning"],
      ["failed", "error"],
    ];

    for (const [status, colour] of expected) {
      const { theme, calls } = fakeTheme();
      const line = renderSessionFrame(view({ status }), 80)[1] ?? [];
      paintSessionFrameLine(line, status, theme);
      assert.ok(
        calls.some((call) => call.colour === colour && call.text === "●"),
        `${status} should use ${colour}`,
      );
    }
  });

  it("renders nothing when the width cannot fit a frame", () => {
    assert.deepEqual(renderSessionFrame(view(), 3), []);
    assert.deepEqual(renderSessionFrame(view(), 0), []);
  });

  it("formats elapsed minutes for longer sessions", () => {
    const meta = sessionFrameText(
      renderSessionFrame(view({ startedAt: 0, now: 125_000 }), 160),
    )[2] ?? "";
    assert.match(meta, /2m 05s/);
  });

  it("adds a separating rule and the transcript rows when expanded", () => {
    const transcript: TranscriptEntry[] = [
      { kind: "user", text: "Skill: implement · issues/03.md" },
      { kind: "assistant", text: "Writing the repository layer." },
    ];
    const lines = sessionFrameText(
      renderSessionFrame(view({ expanded: true, transcript }), 80, (entries) =>
        entries.flatMap((entry) =>
          entry.kind === "assistant"
            ? [{ text: `md:${entry.text}` }]
            : entry.kind === "user"
              ? [{ text: entry.text }]
              : [],
        ),
      ),
    );

    assert.match(lines[3] ?? "", /^├─+┤$/);
    assert.match(lines[4] ?? "", /Skill: implement/);
    assert.match(lines[5] ?? "", /md:Writing the repository layer\./);
    assert.match(lines.at(-1) ?? "", /^└─+┘$/);
    for (const line of lines) assert.equal(line.length, 80);
  });

  it("does not request a transcript while collapsed", () => {
    let calls = 0;
    const lines = renderSessionFrame(view({ expanded: false }), 80, () => {
      calls += 1;
      return [];
    });

    assert.equal(calls, 0);
    assert.equal(lines.length, 4);
  });

  it("renders assistant Markdown and edit diffs inside the expanded border", () => {
    const { theme } = fakeTheme();
    const component = new SessionFrameComponent(
      view({
        expanded: true,
        transcript: [
          { kind: "assistant", text: "# Heading" },
          {
            kind: "tool",
            callId: "call-1",
            name: "edit",
            summary: "src/a.ts",
            diff: "+1 const a = 1;\n-1 const a = 0;",
            isError: false,
            finished: true,
          },
        ],
      }),
      theme,
      { renderDiff: (diff) => diff.split("\n").map((line) => `diff:${line}`) },
    );

    const rendered = component.render(100).join("\n");
    assert.match(rendered, /\[mdHeading\]Heading\[\/\]/);
    assert.match(rendered, /Tool: edit src\/a\.ts — success/);
    assert.match(rendered, /diff:\+1 const a = 1;/);
    assert.match(rendered, /diff:-1 const a = 0;/);
  });

  it("paints transcript error rows in the error colour", () => {
    const { theme, calls } = fakeTheme();
    const lines = renderSessionFrame(
      view({ expanded: true, transcript: [{ kind: "error", text: "boom" }] }),
      80,
      () => [{ text: "Error: boom", tone: "error" }],
    );

    const painted = lines.map((line) => paintSessionFrameLine(line, "failed", theme));
    assert.match(painted.join("\n"), /\[error\]Error: boom\s*\[\/\]/);
    assert.ok(calls.some((call) => call.colour === "error"));
  });
});

describe("context usage in the collapsed summary", () => {
  const usage = { percent: 42.1, contextWindow: 200_000 };

  it("shows the percentage and window between the errors counter and the elapsed time", () => {
    const meta = sessionFrameText(renderSessionFrame(view({ contextUsage: usage }), 160))[2] ?? "";

    assert.match(meta, /0 errors • 42\.1%\/200k • 12s/);
  });

  it("abbreviates the window the way Pi's footer does", () => {
    const abbreviated = (contextWindow: number): string =>
      sessionFrameText(
        renderSessionFrame(view({ contextUsage: { percent: 1, contextWindow } }), 160),
      )[2] ?? "";

    assert.match(abbreviated(200_000), /1\.0%\/200k/);
    assert.match(abbreviated(1_000_000), /1\.0%\/1M/);
    assert.match(abbreviated(999_000), /1\.0%\/999k/);
  });

  it("keeps the line's shape with a question mark when tokens are unknown", () => {
    const meta = sessionFrameText(
      renderSessionFrame(view({ contextUsage: { percent: null, contextWindow: 200_000 } }), 160),
    )[2] ?? "";

    assert.match(meta, /0 errors • \?\/200k • 12s/);
    assert.doesNotMatch(meta, /\?%/);
  });

  it("omits the segment when the child's model has no context window", () => {
    const meta = sessionFrameText(renderSessionFrame(view({ contextUsage: undefined }), 160))[2] ?? "";

    assert.match(meta, /0 errors • 12s/);
    assert.doesNotMatch(meta, /%/);
    assert.doesNotMatch(meta, /\?\//);
  });

  it("keeps context usage when higher-value counters still fit a narrow line", () => {
    const lines = sessionFrameText(renderSessionFrame(view({ contextUsage: usage }), 48));
    const meta = lines[2] ?? "";

    assert.match(meta, /3 turns • 2 tools • 0 errors • 42\.1%\/200k/);
    assert.match(meta, /…/);
    assert.doesNotMatch(meta, /12s/);
    for (const line of lines) assert.equal(line.length, 48);
  });
});

describe("session frame summaries", () => {
  it("keeps only identity, counters, model, status, and timestamps", () => {
    const parsed = readSessionFrameSummary(summary());
    assert.deepEqual(parsed, summary());
    assert.deepEqual(Object.keys(parsed ?? {}).sort(), [
      "childSessionFile",
      "endedAt",
      "errors",
      "frameId",
      "model",
      "startedAt",
      "status",
      "ticketId",
      "ticketTitle",
      "tools",
      "turns",
    ]);
  });

  it("rejects malformed persisted data instead of throwing", () => {
    assert.equal(readSessionFrameSummary(undefined), undefined);
    assert.equal(readSessionFrameSummary({}), undefined);
    assert.equal(readSessionFrameSummary({ ...summary(), status: "running-ish" }), undefined);
    assert.equal(readSessionFrameSummary({ ...summary(), turns: -1 }), undefined);
    assert.equal(readSessionFrameSummary({ ...summary(), frameId: "" }), undefined);
  });

  it("keeps a context usage value through a persisted round trip", () => {
    const contextUsage = { percent: 42.1, contextWindow: 200_000 };

    const parsed = readSessionFrameSummary({ ...summary(), contextUsage });

    assert.deepEqual(parsed?.contextUsage, contextUsage);
    assert.deepEqual(summaryToFrameView(parsed ?? summary(), false, 0).contextUsage, contextUsage);
    assert.deepEqual(Object.keys(parsed ?? {}).sort().includes("contextUsage"), true);
  });

  it("accepts an unknown token count and a window-only value", () => {
    const unknown = readSessionFrameSummary({
      ...summary(),
      contextUsage: { percent: null, contextWindow: 200_000 },
    });
    assert.deepEqual(unknown?.contextUsage, { percent: null, contextWindow: 200_000 });
  });

  it("rejects a malformed context usage without discarding the rest of the summary", () => {
    const malformed: unknown[] = [
      "42.1%/200k",
      { percent: "42.1", contextWindow: 200_000 },
      { percent: 42.1, contextWindow: "200k" },
      { percent: 42.1, contextWindow: 0 },
      { percent: 42.1 },
      { percent: 42.1, contextWindow: Number.NaN },
      { percent: 42.1, contextWindow: -1 },
    ];

    for (const contextUsage of malformed) {
      const parsed = readSessionFrameSummary({ ...summary(), contextUsage });
      assert.notEqual(parsed, undefined, JSON.stringify(contextUsage));
      assert.equal(parsed?.contextUsage, undefined, JSON.stringify(contextUsage));
      assert.equal(parsed?.ticketId, "03", JSON.stringify(contextUsage));
      assert.equal(parsed?.status, "done", JSON.stringify(contextUsage));
    }
  });

  it("converts a summary into a static view", () => {
    const converted = summaryToFrameView(summary(), true, 20_000);

    assert.equal(converted.status, "done");
    assert.equal(converted.expanded, true);
    assert.equal(converted.endedAt, Date.parse("2025-01-01T00:00:12.000Z"));
    assert.equal(converted.now, 20_000);
  });

  it("derives a stable short session id from the session file", () => {
    assert.equal(shortSessionId(SESSION_FILE), SHORT_ID);
    assert.equal(shortSessionId("/sessions/plain-id.jsonl"), "plaini");
    assert.equal(shortSessionId(undefined), undefined);
  });
});

describe("frame visibility", () => {
  const creation = frameEntry("entry-1", runningSummary({ status: "running" }));
  const settlement = frameEntry("entry-2", summary());

  it("hides the creation entry after reload and renders the latest settlement", () => {
    const registry = new SessionFrameRegistry();
    registry.rememberEntries([creation, settlement]);
    const { theme } = fakeTheme();

    assert.equal(registry.renderEntry(creation, false, theme), undefined);
    const lines = renderedLines(registry.renderEntry(settlement, false, theme));
    assert.match(lines[1] ?? "", /· Done/);
  });

  it("renders only the latest terminal summary for a frame id", () => {
    const registry = new SessionFrameRegistry();
    const first = frameEntry("entry-2", summary({ status: "done" }));
    const latest = frameEntry("entry-3", summary({ status: "stopped" }));
    registry.rememberEntries([creation, first, latest]);
    const { theme } = fakeTheme();

    assert.equal(registry.renderEntry(creation, false, theme), undefined);
    assert.equal(registry.renderEntry(first, false, theme), undefined);
    assert.match(renderedLines(registry.renderEntry(latest, false, theme))[1] ?? "", /· Stopped/);
  });

  it("renders a live creation entry from the live model and hides its settlement", () => {
    const registry = new SessionFrameRegistry();
    const appended: Array<{ id: string; summary: SessionFrameSummary }> = [];
    const controller = new SessionFrameController({
      registry,
      now: () => 12_000,
      append: (value) => {
        const id = `entry-${appended.length + 1}`;
        appended.push({ id, summary: value });
        registry.rememberLatestEntry(value.frameId, id);
        return id;
      },
    });

    controller.start(ticket(), { sessionFile: SESSION_FILE, model: "gpt-5" });
    const liveCreation = frameEntry(appended[0]?.id ?? "missing", appended[0]?.summary);
    const liveSettlement = frameEntry(
      "settlement",
      summary({ frameId: appended[0]?.summary.frameId ?? "missing", status: "done" }),
    );

    controller.gateStarted();
    controller.settle("done");
    const settlementEntry = frameEntry(
      appended[1]?.id ?? "missing",
      appended[1]?.summary,
    );

    const { theme } = fakeTheme();
    assert.match(renderedLines(registry.renderEntry(liveCreation, false, theme))[1] ?? "", /· Done/);
    assert.equal(registry.renderEntry(liveSettlement, false, theme), undefined);
    assert.equal(registry.renderEntry(settlementEntry, false, theme), undefined);

    registry.clearLive();
    assert.equal(registry.renderEntry(liveCreation, false, theme), undefined);
    assert.match(
      renderedLines(registry.renderEntry(settlementEntry, false, theme))[1] ?? "",
      /· Done/,
    );
  });

  it("renders a reloaded summary with its recorded context usage", () => {
    const registry = new SessionFrameRegistry();
    const entry = frameEntry(
      "entry-2",
      summary({ contextUsage: { percent: 42.1, contextWindow: 200_000 } }),
    );
    registry.rememberEntries([entry]);
    const { theme } = fakeTheme();

    const meta = unstyled(renderedLines(registry.renderEntry(entry, false, theme))[2] ?? "");
    assert.match(meta, /0 errors • 42\.1%\/200k/);
  });

  it("renders a summary written before context usage existed", () => {
    const registry = new SessionFrameRegistry();
    const entry = frameEntry("entry-2", summary());
    registry.rememberEntries([entry]);
    const { theme } = fakeTheme();

    const meta = unstyled(renderedLines(registry.renderEntry(entry, false, theme))[2] ?? "");
    assert.match(meta, /0 errors • 12s/);
    assert.doesNotMatch(meta, /%/);
  });

  it("never leaves a reloaded non-terminal summary reporting running", () => {
    const registry = new SessionFrameRegistry();
    const orphan = frameEntry("entry-1", runningSummary({ status: "running" }));
    registry.rememberEntries([orphan]);
    const { theme } = fakeTheme();

    assert.match(renderedLines(registry.renderEntry(orphan, false, theme))[1] ?? "", /· Stopped/);
  });
});

describe("SessionFrameController", () => {
  function controllerFixture(now = { value: 0 }) {
    const registry = new SessionFrameRegistry();
    const appended: SessionFrameSummary[] = [];
    const controller = new SessionFrameController({
      registry,
      now: () => now.value,
      append: (value) => {
        appended.push(value);
        return `entry-${appended.length}`;
      },
    });
    return { registry, appended, controller, now };
  }

  it("appends one creation summary and one settlement summary", () => {
    const { appended, controller, now } = controllerFixture();
    now.value = 1_000;

    controller.start(ticket(), { sessionFile: SESSION_FILE, model: "gpt-5" });
    controller.childEvent(turnEnd());
    controller.childEvent(toolStart("edit"));
    controller.childEvent(toolEnd("edit", true));
    now.value = 12_000;
    controller.settle("done");

    assert.equal(appended.length, 2);
    assert.equal(appended[0]?.status, "running");
    assert.equal(appended[0]?.turns, 0);
    assert.equal(appended[1]?.status, "done");
    assert.equal(appended[1]?.turns, 1);
    assert.equal(appended[1]?.tools, 1);
    assert.equal(appended[1]?.errors, 1);
    assert.equal(appended[1]?.childSessionFile, SESSION_FILE);
    assert.equal(appended[1]?.model, "gpt-5");
    assert.ok(appended[1]?.endedAt);
  });

  it("switches the same frame to verifying without adding an entry", () => {
    const { appended, controller, registry } = controllerFixture();

    controller.start(ticket(), { sessionFile: SESSION_FILE, model: "gpt-5" });
    controller.gateStarted();

    assert.equal(appended.length, 1);
    const { theme } = fakeTheme();
    const live = frameEntry("entry-1", appended[0]);
    assert.match(renderedLines(registry.renderEntry(live, false, theme))[1] ?? "", /· Verifying/);
  });

  it("settles at most once and ignores events after settlement", () => {
    const { appended, controller } = controllerFixture();

    controller.start(ticket(), { sessionFile: SESSION_FILE, model: "gpt-5" });
    controller.settle("failed");
    controller.childEvent(turnEnd());
    controller.settle("done");

    assert.equal(appended.length, 2);
    assert.equal(appended[1]?.status, "failed");
    assert.equal(appended[1]?.turns, 0);
  });

  it("settles an active frame as stopped on shutdown and drops the live view", () => {
    const { appended, controller, registry } = controllerFixture();

    controller.start(ticket(), { sessionFile: SESSION_FILE, model: "gpt-5" });
    controller.shutdown();

    assert.equal(appended.at(-1)?.status, "stopped");
    assert.equal(registry.liveFrame(appended[0]?.frameId ?? ""), undefined);
  });

  it("does nothing when settlement happens before any frame exists", () => {
    const { appended, controller } = controllerFixture();

    controller.settle("stopped");
    controller.childEvent(textDelta("ignored"));
    controller.childEvent(settled());

    assert.equal(appended.length, 0);
  });

  it("renders a live expanded transcript and freezes it on settlement", () => {
    const registry = new SessionFrameRegistry();
    const appended: SessionFrameSummary[] = [];
    const transcript: TranscriptEntry[] = [{ kind: "assistant", text: "first" }];
    let reads = 0;
    const controller = new SessionFrameController({
      registry,
      now: () => 1_000,
      append: (value) => {
        appended.push(value);
        return `entry-${appended.length}`;
      },
    });

    controller.start(ticket(), {
      sessionFile: SESSION_FILE,
      model: "gpt-5",
      transcript: () => {
        reads += 1;
        return transcript;
      },
    });

    const { theme } = fakeTheme();
    const entry = frameEntry("entry-1", appended[0]);
    const collapsed = registry.renderEntry(entry, false, theme);
    assert.equal(reads, 0, "a collapsed frame never reads the transcript");
    assert.ok(collapsed instanceof SessionFrameComponent);

    const expanded = registry.renderEntry(entry, true, theme);
    assert.ok(expanded instanceof SessionFrameComponent);
    assert.match(expanded.render(80).join("\n"), /first/);

    transcript.push({ kind: "assistant", text: "second" });
    assert.match(expanded.render(80).join("\n"), /second/, "the live frame re-reads its transcript");

    controller.settle("done");
    transcript.push({ kind: "assistant", text: "after settlement" });
    const settled = registry.renderEntry(entry, true, theme);
    assert.ok(settled instanceof SessionFrameComponent);
    assert.doesNotMatch(settled.render(80).join("\n"), /after settlement/);
  });

  it("streams visible assistant text into an expanded frame before persistence", () => {
    const registry = new SessionFrameRegistry();
    const appended: SessionFrameSummary[] = [];
    let persisted: TranscriptEntry[] = [];
    const controller = new SessionFrameController({
      registry,
      now: () => 1_000,
      append: (value) => {
        appended.push(value);
        return `entry-${appended.length}`;
      },
    });

    controller.start(ticket(), {
      sessionFile: SESSION_FILE,
      model: "gpt-5",
      transcript: () => persisted,
    });

    controller.childEvent(textDelta("Hel"));
    controller.childEvent(thinkingDelta("hidden reasoning"));
    controller.childEvent(textDelta("lo"));

    const { theme } = fakeTheme();
    const expanded = registry.renderEntry(frameEntry("entry-1", appended[0]), true, theme);
    assert.ok(expanded instanceof SessionFrameComponent);
    assert.match(expanded.render(80).join("\n"), /Hello/);
    assert.doesNotMatch(expanded.render(80).join("\n"), /hidden reasoning/);

    persisted = [{ kind: "assistant", text: "Hello" }];
    controller.childEvent(messageEnd());

    const settledText = registry
      .renderEntry(frameEntry("entry-1", appended[0]), true, theme)
      ?.render(80)
      .join("\n");
    assert.equal(settledText?.match(/Hello/g)?.length, 1, "the persisted text replaces the delta");
  });
});
