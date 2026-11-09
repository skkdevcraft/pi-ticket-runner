import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RunFooterView, type RunFooterSink } from "../src/live-view.ts";
import type { Ticket } from "../src/tickets.ts";
import { settled, textDelta, toolEnd, toolStart, turnEnd } from "./helpers.ts";

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
  readonly sink: RunFooterSink;
  readonly statuses: Array<string | undefined>;
  lastStatus(): string | undefined;
}

function collector(): Collector {
  const statuses: Array<string | undefined> = [];
  return {
    sink: {
      setStatus(text) {
        statuses.push(text);
      },
    },
    statuses,
    lastStatus() {
      return statuses[statuses.length - 1];
    },
  };
}

describe("RunFooterView", () => {
  it("shows the remaining count and the active ticket", () => {
    const sink = collector();
    const footer = new RunFooterView({ sink: sink.sink });

    footer.ticketStarted(ticket("03", "repository-layer", "Repository Layer"), 2);

    assert.equal(sink.lastStatus(), "🎫 2 left · 03-repository-layer");
  });

  it("keeps the active ticket label through the completion gate", () => {
    const sink = collector();
    const footer = new RunFooterView({ sink: sink.sink });

    footer.ticketStarted(ticket("03", "repository-layer", "Repository Layer"), 2);
    footer.gateStarted(ticket("03", "repository-layer", "Repository Layer"));

    assert.equal(sink.lastStatus(), "🎫 2 left · 03-repository-layer");
  });

  it("names the next ticket between tickets", () => {
    const sink = collector();
    const footer = new RunFooterView({ sink: sink.sink });

    footer.ticketStarted(ticket("03", "repository-layer", "Repository Layer"), 2);
    footer.betweenTickets(ticket("04", "integration-tests", "Integration Tests"), 1);

    assert.equal(sink.lastStatus(), "🎫 1 left · 04-integration-tests");
  });

  it("reports finished and stopped runs", () => {
    const finished = collector();
    const first = new RunFooterView({ sink: finished.sink });
    first.ticketStarted(ticket("01", "first", "First"), 1);
    first.finish(0);
    assert.equal(finished.lastStatus(), "🎫 done · 0 left");

    const stopped = collector();
    const second = new RunFooterView({ sink: stopped.sink });
    second.ticketStarted(ticket("03", "repository-layer", "Repository Layer"), 2);
    second.stop(2);
    assert.equal(stopped.lastStatus(), "🎫 stopped · 2 left");
  });

  it("clears on teardown and suppresses later updates", () => {
    const sink = collector();
    const footer = new RunFooterView({ sink: sink.sink });

    footer.ticketStarted(ticket("01", "first", "First"), 1);
    footer.clear();

    assert.equal(sink.lastStatus(), undefined);

    footer.finish(0);
    footer.stop(1);
    footer.ticketStarted(ticket("02", "second", "Second"), 1);
    footer.gateStarted(ticket("02", "second", "Second"));
    footer.betweenTickets(undefined, 0);

    assert.equal(sink.lastStatus(), undefined);
    assert.equal(sink.statuses.at(-1), undefined);
  });

  it("accepts child events without changing the footer", () => {
    const sink = collector();
    const footer = new RunFooterView({ sink: sink.sink });

    footer.ticketStarted(ticket("01", "first", "First"), 1);
    const before = sink.statuses.length;

    footer.childEvent(textDelta("writing"), "implementation");
    footer.childEvent(toolStart("edit"), "implementation");
    footer.childEvent(toolEnd("edit", true), "implementation");
    footer.childEvent(turnEnd(), "implementation");
    footer.childEvent(settled(), "implementation");

    assert.equal(sink.statuses.length, before);
    assert.equal(sink.lastStatus(), "🎫 1 left · 01-first");
  });
});
