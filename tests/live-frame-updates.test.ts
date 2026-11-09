import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CustomEntry, Theme } from "@earendil-works/pi-coding-agent";

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
