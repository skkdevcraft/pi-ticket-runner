import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TicketLiveView,
  type LiveViewSink,
} from "../src/live-view.ts";
import type { Ticket } from "../src/tickets.ts";
import { settled, textDelta, toolEnd, toolStart, turnEnd } from "./helpers.ts";

const HINT = "  (/ticket-runner stop to interrupt)";

function ticket(id: string, slug: string, title: string): Ticket {
  return {
    id,
    number: Number.parseInt(id, 10),
    slug,
    filename: `${id}-${slug}.md`,
    path: `/project/issues/${id}-${slug}.md`,
    reference: `issues/${id}-${slug}.md`,
    status: "ready-for-agent",
    title,
  };
}

interface Collector {
  readonly sink: LiveViewSink;
  readonly widgets: Array<readonly string[] | undefined>;
  readonly statuses: Array<string | undefined>;
  lastWidget(): readonly string[] | undefined;
  lastStatus(): string | undefined;
}

function collector(): Collector {
  const widgets: Array<readonly string[] | undefined> = [];
  const statuses: Array<string | undefined> = [];
  return {
    sink: {
      setWidget(lines) {
        widgets.push(lines);
      },
      setStatus(text) {
        statuses.push(text);
      },
    },
    widgets,
    statuses,
    lastWidget() {
      return widgets[widgets.length - 1];
    },
    lastStatus() {
      return statuses[statuses.length - 1];
    },
  };
}

interface FakeClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
  advance(ms: number): void;
  pending(): number;
}

function fakeClock(): FakeClock {
  let current = 0;
  const timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];

  return {
    now: () => current,
    schedule(callback, delayMs) {
      const timer = { at: current + delayMs, callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    advance(ms) {
      current += ms;
      for (;;) {
        const index = timers.findIndex((timer) => !timer.cancelled && timer.at <= current);
        if (index === -1) return;
        const [timer] = timers.splice(index, 1);
        timer?.callback();
      }
    },
    pending() {
      return timers.filter((timer) => !timer.cancelled).length;
    },
  };
}

function liveView(
  collectorValue: Collector,
  overrides: { intervalMs?: number; width?: number } = {},
): { view: TicketLiveView; clock: FakeClock } {
  const clock = fakeClock();
  const view = new TicketLiveView({
    sink: collectorValue.sink,
    intervalMs: overrides.intervalMs ?? 150,
    width: () => overrides.width ?? 80,
    now: () => clock.now(),
    schedule: (callback, delayMs) => clock.schedule(callback, delayMs),
  });
  return { view, clock };
}

describe("TicketLiveView", () => {
  it("renders a ticket header, the stop hint, and a remaining-ticket footer", () => {
    const sink = collector();
    const { view } = liveView(sink);

    view.ticketStarted(ticket("03", "repository-layer", "Repository Layer"), 2);

    assert.deepEqual(sink.lastWidget(), [
      "▶ 03 Repository Layer",
      HINT,
    ]);
    assert.equal(sink.lastStatus(), "🎫 2 left · 03-repository-layer");
  });

  it("renders up to three recent assistant text lines and truncates them to the width", () => {
    const sink = collector();
    const { view, clock } = liveView(sink, { width: 28 });

    view.ticketStarted(ticket("01", "first", "First"), 1);
    view.childEvent(
      textDelta(
        "one line that is quite long indeed\n" +
          "second line\n" +
          "third line\n" +
          "fourth line\n",
      ),
      "implementation",
    );
    clock.advance(150);

    const widget = sink.lastWidget();
    assert.ok(widget);
    assert.deepEqual(widget, [
      "▶ 01 First",
      "  second line",
      "  third line",
      "  fourth line",
      HINT,
    ]);
    for (const line of widget.slice(0, -1)) {
      assert.ok(line.length <= 28, `line is wider than the terminal: ${line}`);
    }

    view.childEvent(textDelta("never shown because it is longer than the width"), "implementation");
    clock.advance(150);
    const truncated = sink.lastWidget();
    assert.ok(truncated);
    assert.match(truncated.at(-2) ?? "", /…$/);
    assert.ok((truncated.at(-2) ?? "").length <= 28);
  });

  it("renders at most six lines with a ticket, three text lines, a tool, and the hint", () => {
    const sink = collector();
    const { view, clock } = liveView(sink);

    view.ticketStarted(ticket("03", "repository-layer", "Repository Layer"), 2);
    view.childEvent(textDelta("alpha\nbeta\ngamma\ndelta\n"), "implementation");
    view.childEvent(toolStart("edit"), "implementation");
    clock.advance(150);

    const widget = sink.lastWidget();
    assert.ok(widget);
    assert.equal(widget.length, 6);
    assert.deepEqual(widget, [
      "▶ 03 Repository Layer",
      "  beta",
      "  gamma",
      "  delta",
      "  Tool: edit — running",
      HINT,
    ]);
  });

  it("tracks the current tool as running, success, or error", () => {
    const sink = collector();
    const { view, clock } = liveView(sink);

    view.ticketStarted(ticket("01", "first", "First"), 1);
    view.childEvent(toolStart("edit"), "implementation");
    clock.advance(150);
    assert.match(sink.lastWidget()?.at(-2) ?? "", /Tool: edit — running/);

    view.childEvent(toolEnd("edit", false), "implementation");
    clock.advance(150);
    assert.match(sink.lastWidget()?.at(-2) ?? "", /Tool: edit — success/);

    view.childEvent(toolEnd("bash", true), "implementation");
    clock.advance(150);
    assert.match(sink.lastWidget()?.at(-2) ?? "", /Tool: bash — error/);
  });

  it("labels the completion-gate phase and streams the gate output", () => {
    const sink = collector();
    const { view, clock } = liveView(sink);

    view.ticketStarted(ticket("03", "repository-layer", "Repository Layer"), 2);
    view.childEvent(textDelta("implementation detail"), "implementation");
    clock.advance(150);
    assert.match(sink.lastWidget()?.[0] ?? "", /▶ 03 Repository Layer/);

    view.gateStarted(ticket("03", "repository-layer", "Repository Layer"));
    clock.advance(150);
    assert.deepEqual(sink.lastWidget(), ["🔎 03 verifying completion", HINT]);
    assert.equal(sink.lastStatus(), "🎫 2 left · 03-repository-layer");

    view.childEvent(textDelta("checking tests\nrunning typecheck"), "completion-gate");
    clock.advance(150);
    assert.deepEqual(sink.lastWidget(), [
      "🔎 03 verifying completion",
      "  checking tests",
      "  running typecheck",
      HINT,
    ]);
  });

  it("renders the next ticket between runs instead of clearing the widget", () => {
    const sink = collector();
    const { view, clock } = liveView(sink);

    view.ticketStarted(ticket("03", "repository-layer", "Repository Layer"), 2);
    view.betweenTickets(ticket("04", "integration-tests", "Integration Tests"), 1);
    clock.advance(150);

    assert.deepEqual(sink.lastWidget(), ["⏳ next: 04-integration-tests", HINT]);
    assert.equal(sink.lastStatus(), "🎫 1 left · 04-integration-tests");
    assert.notEqual(sink.lastWidget(), undefined);
  });

  it("throttles renders to the configured interval and coalesces deltas", () => {
    const sink = collector();
    const { view, clock } = liveView(sink, { intervalMs: 150 });

    view.ticketStarted(ticket("01", "first", "First"), 1);
    const afterStart = sink.widgets.length;

    view.childEvent(textDelta("a"), "implementation");
    view.childEvent(textDelta("b"), "implementation");
    view.childEvent(textDelta("c"), "implementation");
    assert.equal(sink.widgets.length, afterStart, "renders must be throttled");

    clock.advance(149);
    assert.equal(sink.widgets.length, afterStart);

    clock.advance(1);
    assert.equal(sink.widgets.length, afterStart + 1);
    assert.deepEqual(sink.lastWidget(), ["▶ 01 First", "  abc", HINT]);
  });

  it("retains only a bounded rolling text buffer", () => {
    const sink = collector();
    const { view, clock } = liveView(sink, { width: 200 });

    view.ticketStarted(ticket("01", "first", "First"), 1);
    view.childEvent(textDelta(`OLDEST-LINE\n${"x".repeat(3000)}`), "implementation");
    clock.advance(150);

    const rendered = (sink.lastWidget() ?? []).join("\n");
    assert.doesNotMatch(rendered, /OLDEST-LINE/);
    assert.ok(rendered.length < 500, "the full transcript must never be retained or rendered");
  });

  it("reports finished and stopped runs in the footer and clears the widget", () => {
    const finished = collector();
    const first = liveView(finished);
    first.view.ticketStarted(ticket("01", "first", "First"), 1);
    first.view.finish(0);
    assert.equal(finished.lastWidget(), undefined);
    assert.equal(finished.lastStatus(), "🎫 done · 0 left");

    const stopped = collector();
    const second = liveView(stopped);
    second.view.ticketStarted(ticket("03", "repository-layer", "Repository Layer"), 2);
    second.view.stop(2);
    assert.equal(stopped.lastWidget(), undefined);
    assert.equal(stopped.lastStatus(), "🎫 stopped · 2 left");
  });

  it("clears the widget and footer on teardown and suppresses later updates", () => {
    const sink = collector();
    const { view, clock } = liveView(sink);

    view.ticketStarted(ticket("01", "first", "First"), 1);
    view.childEvent(textDelta("pending"), "implementation");
    view.clear();

    assert.equal(sink.lastWidget(), undefined);
    assert.equal(sink.lastStatus(), undefined);

    const calls = sink.widgets.length;
    clock.advance(150);
    view.finish(0);
    view.stop(1);
    view.ticketStarted(ticket("02", "second", "Second"), 1);
    assert.equal(sink.widgets.length, calls, "a torn-down view must not render again");
    assert.equal(sink.lastWidget(), undefined);
    assert.equal(sink.lastStatus(), undefined);
  });

  it("clears the footer on teardown after a finished run", () => {
    const sink = collector();
    const { view } = liveView(sink);

    view.ticketStarted(ticket("01", "first", "First"), 1);
    view.finish(0);
    assert.equal(sink.lastStatus(), "🎫 done · 0 left");

    view.clear();
    assert.equal(sink.lastWidget(), undefined);
    assert.equal(sink.lastStatus(), undefined);
  });

  it("accepts turn_end and settled events without adding text", () => {
    const sink = collector();
    const { view, clock } = liveView(sink);

    view.ticketStarted(ticket("01", "first", "First"), 1);
    const before = sink.widgets.length;
    view.childEvent(turnEnd(), "implementation");
    view.childEvent(settled(), "implementation");
    clock.advance(150);

    assert.deepEqual(sink.lastWidget(), ["▶ 01 First", HINT]);
    assert.equal(sink.widgets.length, before);
  });
});
