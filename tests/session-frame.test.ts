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
import type { Ticket } from "../src/tickets.ts";
import { settled, textDelta, toolEnd, toolStart, turnEnd } from "./helpers.ts";

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
});
