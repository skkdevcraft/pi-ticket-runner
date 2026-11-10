import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ContextUsage, CustomEntry, Theme } from "@earendil-works/pi-coding-agent";

import { RunFooterView, ThrottledRepaint, type RunFooterSink } from "../src/live-view.ts";
import {
  FRAME_ENTRY_TYPE,
  SessionFrameComponent,
  type SessionFrameSummary,
} from "../src/session-frame.ts";
import { SessionFrameController, SessionFrameRegistry } from "../src/session-frames.ts";
import type { Ticket } from "../src/tickets.ts";
import {
  createFakeClock,
  messageEnd,
  settled,
  textDelta,
  toolEnd,
  toolStart,
  turnEnd,
  type FakeClock,
} from "./helpers.ts";

const SESSION_FILE = "/sessions/2025-01-01T00-00-00_0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl";

const identityTheme = {
  fg: (_colour: string, text: string) => text,
} as unknown as Theme;

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

function frameEntry(id: string, data: SessionFrameSummary): CustomEntry {
  return {
    type: "custom",
    customType: FRAME_ENTRY_TYPE,
    id,
    parentId: null,
    timestamp: "2025-01-01T00:00:00.000Z",
    data,
  };
}

function liveLines(
  registry: SessionFrameRegistry,
  summary: SessionFrameSummary,
  id = "entry-1",
): string[] {
  const component = registry.renderEntry(frameEntry(id, summary), false, identityTheme);
  assert.ok(component instanceof SessionFrameComponent, "the live frame must render");
  return component.render(160);
}

interface Fixture {
  readonly clock: FakeClock;
  readonly registry: SessionFrameRegistry;
  readonly controller: SessionFrameController;
  readonly appended: SessionFrameSummary[];
  readonly paints: () => number;
}

function fixture(intervalMs = 150, start = 1_000): Fixture {
  const clock = createFakeClock(start);
  const registry = new SessionFrameRegistry({ now: clock.now });
  const appended: SessionFrameSummary[] = [];
  let paintCount = 0;

  const controller = new SessionFrameController({
    registry,
    now: clock.now,
    liveFrameUpdateIntervalMs: intervalMs,
    clock: clock.clock,
    repaint: () => {
      paintCount += 1;
    },
    append: (summary) => {
      appended.push(summary);
      return `entry-${appended.length}`;
    },
  });

  return { clock, registry, controller, appended, paints: () => paintCount };
}

describe("ThrottledRepaint", () => {
  it("paints the first change immediately and coalesces changes inside the interval", () => {
    const clock = createFakeClock(0);
    let paints = 0;
    const repaint = new ThrottledRepaint({
      intervalMs: 150,
      clock: clock.clock,
      paint: () => {
        paints += 1;
      },
    });

    repaint.request();
    assert.equal(paints, 1);

    repaint.request();
    repaint.request();
    repaint.request();
    assert.equal(paints, 1);
    assert.equal(clock.pending, 1);

    clock.advance(149);
    assert.equal(paints, 1);
    clock.advance(1);
    assert.equal(paints, 2);
    assert.equal(clock.pending, 0);
  });

  it("paints every change when the interval is zero", () => {
    const clock = createFakeClock(0);
    let paints = 0;
    const repaint = new ThrottledRepaint({
      intervalMs: 0,
      clock: clock.clock,
      paint: () => {
        paints += 1;
      },
    });

    repaint.request();
    repaint.request();
    clock.advance(0);

    assert.equal(paints, 2);
    assert.equal(clock.pending, 0);
  });

  it("paints once on settlement and then ignores requests", () => {
    const clock = createFakeClock(0);
    let paints = 0;
    const repaint = new ThrottledRepaint({
      intervalMs: 150,
      clock: clock.clock,
      paint: () => {
        paints += 1;
      },
    });

    repaint.request();
    repaint.request();
    repaint.settle();
    assert.equal(paints, 2);
    assert.equal(clock.pending, 0);

    repaint.request();
    clock.advance(1_000);
    assert.equal(paints, 2);
  });
});

describe("RunFooterView repaint", () => {
  function collector(): { sink: RunFooterSink; statuses: Array<string | undefined> } {
    const statuses: Array<string | undefined> = [];
    return {
      sink: {
        setStatus(text) {
          statuses.push(text);
        },
      },
      statuses,
    };
  }

  it("re-emits the current status so Pi re-renders the transcript", () => {
    const sink = collector();
    const footer = new RunFooterView({ sink: sink.sink });

    footer.ticketStarted(ticket("03", "Repository Layer"), 2);
    footer.repaint();

    assert.deepEqual(sink.statuses, [
      "🎫 2 left · 03-repository-layer",
      "🎫 2 left · 03-repository-layer",
    ]);
  });

  it("does not repaint after teardown", () => {
    const sink = collector();
    const footer = new RunFooterView({ sink: sink.sink });

    footer.ticketStarted(ticket("03", "Repository Layer"), 2);
    footer.clear();
    footer.repaint();

    assert.deepEqual(sink.statuses, ["🎫 2 left · 03-repository-layer", undefined]);
  });
});

describe("live frame updates", () => {
  it("paints counters during the throttled window and keeps them in the same frame", () => {
    const { clock, registry, controller, appended, paints } = fixture();

    controller.start(ticket(), { sessionFile: SESSION_FILE, model: "gpt-5" });
    assert.equal(paints(), 1);

    clock.advance(10);
    controller.childEvent(textDelta("Writing the repository layer…"));
    controller.childEvent(toolStart("edit"));
    controller.childEvent(toolEnd("edit"));
    controller.childEvent(turnEnd());
    assert.equal(paints(), 1, "updates inside the interval are coalesced");

    clock.advance(140);
    assert.equal(paints(), 2);

    const creation = appended[0];
    assert.ok(creation);
    assert.equal(appended.length, 1, "no entry is appended per update");
    const rendered = liveLines(registry, creation).join("\n");
    assert.match(rendered, /03 Repository Layer · Running/);
    assert.match(rendered, /1 turns/);
    assert.match(rendered, /1 tools/);
    assert.match(rendered, /0 errors/);
  });

  it("counts tool errors and not successful tool endings", () => {
    const { clock, registry, controller, appended, paints } = fixture();

    controller.start(ticket(), { sessionFile: SESSION_FILE, model: "gpt-5" });
    clock.advance(150);
    controller.childEvent(toolStart("edit"));
    controller.childEvent(toolEnd("edit", true));
    clock.advance(150);
    assert.equal(paints(), 3);

    const creation = appended[0];
    assert.ok(creation);
    const rendered = liveLines(registry, creation).join("\n");
    assert.match(rendered, /1 tools/);
    assert.match(rendered, /1 errors/);

    clock.advance(150);
    controller.childEvent(toolStart("edit"));
    controller.childEvent(toolEnd("edit"));
    clock.advance(150);

    const afterSuccess = liveLines(registry, appended[0] ?? creation).join("\n");
    assert.match(afterSuccess, /2 tools/);
    assert.match(afterSuccess, /1 errors/);
  });

  it("moves the painted status of the same frame to verifying without a new frame", () => {
    const { clock, registry, controller, appended, paints } = fixture();

    controller.start(ticket(), { sessionFile: SESSION_FILE, model: "gpt-5" });
    clock.advance(10);
    controller.gateStarted();
    clock.advance(140);

    assert.equal(paints(), 2);
    assert.equal(appended.length, 1);
    const creation = appended[0];
    assert.ok(creation);
    const rendered = liveLines(registry, creation).join("\n");
    assert.match(rendered, /03 Repository Layer · Verifying/);
    assert.doesNotMatch(rendered, /· Running/);
  });

  it("paints one final settled frame and then ignores every later update", () => {
    const { clock, registry, controller, appended, paints } = fixture();

    controller.start(ticket(), { sessionFile: SESSION_FILE, model: "gpt-5" });
    clock.advance(10);
    controller.childEvent(turnEnd());
    controller.settle("done");
    const paintsAtSettle = paints();
    assert.equal(paintsAtSettle, 2, "settlement paints immediately, without waiting for the interval");

    controller.childEvent(turnEnd());
    controller.childEvent(toolStart("edit"));
    controller.childEvent(settled());
    clock.advance(10_000);

    assert.equal(paints(), paintsAtSettle, "a settled frame never repaints again");
    assert.equal(clock.pending, 0);
    assert.equal(appended.length, 2);
    assert.equal(appended[1]?.status, "done");
    assert.equal(appended[1]?.turns, 1);

    const creation = appended[0];
    assert.ok(creation);
    const rendered = liveLines(registry, creation).join("\n");
    assert.match(rendered, /· Done/);
  });

  it("reads the live view model on every render of the cached component", () => {
    const { clock, registry, controller, appended } = fixture();

    controller.start(ticket(), { sessionFile: SESSION_FILE, model: "gpt-5" });
    const creation = appended[0];
    assert.ok(creation);
    const component = registry.renderEntry(
      frameEntry("entry-1", creation),
      false,
      identityTheme,
    );
    assert.ok(component instanceof SessionFrameComponent);

    assert.match(component.render(160).join("\n"), /0 turns/);

    clock.advance(10);
    controller.childEvent(turnEnd());
    clock.advance(140);

    assert.match(component.render(160).join("\n"), /1 turns/);
  });

  it("updates the collapsed meta while the frame is expanded", () => {
    const { clock, registry, controller, appended } = fixture();

    controller.start(ticket(), { sessionFile: SESSION_FILE, model: "gpt-5" });
    clock.advance(500);
    controller.childEvent(toolStart("edit"));
    controller.childEvent(toolEnd("edit", true));
    controller.childEvent(turnEnd());
    clock.advance(150);

    const creation = appended[0];
    assert.ok(creation);
    const component = registry.renderEntry(frameEntry("entry-1", creation), true, identityTheme);
    assert.ok(component instanceof SessionFrameComponent);
    const rendered = component.render(160).join("\n");

    assert.match(rendered, /▾ ● 03 Repository Layer · Running/);
    assert.match(rendered, /Session 0190a1 · 1 turns • 1 tools • 1 errors • 0s/);
  });

  it("paints elapsed time from the injected clock", () => {
    const { clock, registry, controller, appended } = fixture(0, 0);

    controller.start(ticket(), { sessionFile: SESSION_FILE, model: "gpt-5" });
    clock.advance(65_000);
    controller.childEvent(textDelta("still working"));
    assert.equal(clock.now(), 65_000);

    const creation = appended[0];
    assert.ok(creation);
    const rendered = liveLines(registry, creation).join("\n");
    assert.match(rendered, /1m 05s/);
  });
});

describe("live frame context usage", () => {
  interface ContextFixture {
    readonly clock: FakeClock;
    readonly registry: SessionFrameRegistry;
    readonly controller: SessionFrameController;
    readonly appended: SessionFrameSummary[];
    readonly usage: { value: ContextUsage | undefined; fails: boolean };
    readonly reads: () => number;
    readonly child: () => {
      sessionFile: string;
      model: string;
      contextUsage: () => ContextUsage | undefined;
    };
  }

  function contextFixture(initial?: ContextUsage): ContextFixture {
    const clock = createFakeClock(1_000);
    const registry = new SessionFrameRegistry({ now: clock.now });
    const appended: SessionFrameSummary[] = [];
    const usage: { value: ContextUsage | undefined; fails: boolean } = {
      value: initial ?? { tokens: 84_200, contextWindow: 200_000, percent: 42.1 },
      fails: false,
    };
    let reads = 0;

    const controller = new SessionFrameController({
      registry,
      now: clock.now,
      clock: clock.clock,
      append: (summary) => {
        appended.push(summary);
        return `entry-${appended.length}`;
      },
    });

    return {
      clock,
      registry,
      controller,
      appended,
      usage,
      reads: () => reads,
      child: () => ({
        sessionFile: SESSION_FILE,
        model: "gpt-5",
        contextUsage: () => {
          reads += 1;
          if (usage.fails) throw new Error("context usage unavailable");
          return usage.value;
        },
      }),
    };
  }

  function meta(fixture: ContextFixture): string {
    const creation = fixture.appended[0];
    assert.ok(creation);
    return liveLines(fixture.registry, creation)[2] ?? "";
  }

  it("samples context usage when the frame is created and paints it immediately", () => {
    const fixture = contextFixture();

    fixture.controller.start(ticket(), fixture.child());

    assert.equal(fixture.reads(), 1);
    assert.match(meta(fixture), /0 errors • 42\.1%\/200k • 0s/);
  });

  it("refreshes only at assistant-message end, tool end, gate start, and settlement", () => {
    const fixture = contextFixture();
    fixture.controller.start(ticket(), fixture.child());

    const creation = fixture.appended[0];
    assert.ok(creation);
    const component = fixture.registry.renderEntry(
      frameEntry("entry-1", creation),
      false,
      identityTheme,
    );
    assert.ok(component instanceof SessionFrameComponent);
    component.render(160);
    component.render(160);
    fixture.controller.childEvent(textDelta("streaming"));
    fixture.controller.childEvent(messageEnd({ role: "user", content: "prompt" }));
    assert.equal(fixture.reads(), 1, "streaming and user messages never resample");

    fixture.clock.advance(200);
    fixture.usage.value = { tokens: 100_000, contextWindow: 200_000, percent: 50 };
    fixture.controller.childEvent(messageEnd({ role: "assistant", content: [] }));
    assert.equal(fixture.reads(), 2);
    assert.match(meta(fixture), /50\.0%\/200k/);

    fixture.clock.advance(200);
    fixture.usage.value = { tokens: 140_000, contextWindow: 200_000, percent: 70 };
    fixture.controller.childEvent(toolStart("edit"));
    assert.equal(fixture.reads(), 2, "a tool starting is not a boundary");
    fixture.controller.childEvent(toolEnd("edit"));
    assert.equal(fixture.reads(), 3);
    assert.match(meta(fixture), /70\.0%\/200k/);

    fixture.clock.advance(200);
    fixture.usage.value = { tokens: 90_000, contextWindow: 200_000, percent: 45 };
    fixture.controller.gateStarted();
    assert.equal(fixture.reads(), 4);
    assert.match(meta(fixture), /45\.0%\/200k/);

    fixture.controller.settle("done");
    assert.equal(fixture.reads(), 5);
  });

  it("keeps the line's shape with ?/window when the count becomes unknown", () => {
    const fixture = contextFixture();
    fixture.controller.start(ticket(), fixture.child());
    assert.match(meta(fixture), /42\.1%\/200k/);

    fixture.clock.advance(200);
    fixture.usage.value = { tokens: null, contextWindow: 200_000, percent: null };
    fixture.controller.childEvent(messageEnd({ role: "assistant", content: [] }));

    assert.match(meta(fixture), /0 errors • \?\/200k • 0s/);
  });

  it("keeps the last known value when a read fails, without counting an error", () => {
    const fixture = contextFixture();
    fixture.controller.start(ticket(), fixture.child());

    fixture.usage.fails = true;
    fixture.controller.childEvent(toolStart("edit"));
    fixture.controller.childEvent(toolEnd("edit"));
    fixture.controller.gateStarted();

    assert.match(meta(fixture), /0 errors • 42\.1%\/200k/);
    fixture.controller.settle("failed");
    assert.equal(fixture.appended.at(-1)?.errors, 0);
    assert.deepEqual(fixture.appended.at(-1)?.contextUsage, {
      percent: 42.1,
      contextWindow: 200_000,
    });
  });

  it("omits the segment and persists nothing when the model has no context window", () => {
    const fixture = contextFixture({ tokens: 0, contextWindow: 0, percent: 0 });
    fixture.controller.start(ticket(), fixture.child());
    fixture.controller.settle("done");

    assert.match(meta(fixture), /0 errors • 0s/);
    assert.doesNotMatch(meta(fixture), /%/);
    assert.equal(fixture.appended[0]?.contextUsage, undefined);
    assert.equal(fixture.appended[1]?.contextUsage, undefined);
  });

  it("persists the settled snapshot and renders it after reload", () => {
    const fixture = contextFixture();
    fixture.controller.start(ticket(), fixture.child());

    fixture.clock.advance(200);
    fixture.usage.value = { tokens: 164_000, contextWindow: 200_000, percent: 82 };
    fixture.controller.childEvent(messageEnd({ role: "assistant", content: [] }));
    fixture.controller.settle("done");

    const settlement = fixture.appended[1];
    assert.ok(settlement);
    assert.deepEqual(settlement.contextUsage, { percent: 82, contextWindow: 200_000 });
    assert.doesNotMatch(JSON.stringify(settlement), /tokens/);

    fixture.registry.clearLive();
    const component = fixture.registry.renderEntry(
      frameEntry("entry-2", settlement),
      false,
      identityTheme,
    );
    assert.ok(component instanceof SessionFrameComponent);
    assert.match(component.render(160)[2] ?? "", /0 errors • 82\.0%\/200k/);
  });
});
