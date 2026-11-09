import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Ticket, TicketInventory } from "../src/tickets.ts";
import type { StartOutcome } from "../src/runner.ts";
import { renderStartOutcome, renderTicketList } from "../src/ui.ts";

const RUNNABLE = ["ready-for-agent"];

function ticket(id: string, slug: string, status: string, title: string): Ticket {
  return {
    id,
    number: Number.parseInt(id, 10),
    slug,
    filename: `${id}-${slug}.md`,
    path: `/project/issues/${id}-${slug}.md`,
    reference: `issues/${id}-${slug}.md`,
    status,
    title,
  };
}

function inventory(tickets: readonly Ticket[]): TicketInventory {
  return {
    folderLabel: ".scratch/auth/issues",
    folderPath: "/project/.scratch/auth/issues",
    tickets,
  };
}

function lines(output: string): string[] {
  return output.split("\n");
}

function rowStartingWith(output: string, name: string): string {
  const row = lines(output).find((line) => line.startsWith(name));
  assert.ok(row, `expected a row starting with ${name}`);
  return row;
}

describe("renderTicketList", () => {
  it("renders the header, rows, executable count, and next ticket", () => {
    const output = renderTicketList(
      inventory([
        ticket("01", "database-schema", "resolved", "Database Schema"),
        ticket("02", "api-endpoints", "resolved", "API Endpoints"),
        ticket("03", "repository-layer", "ready-for-agent", "Repository Layer"),
        ticket("04", "integration-tests", "ready-for-human", "Integration Tests"),
      ]),
      RUNNABLE,
    );

    assert.deepEqual(lines(output), [
      "🎫 Tickets: .scratch/auth/issues",
      "",
      "01-database-schema      resolved           skip",
      "02-api-endpoints        resolved           skip",
      "03-repository-layer     ready-for-agent    NEXT ▶",
      "04-integration-tests    ready-for-human    skip",
      "",
      "Executable: 1 of 4",
      "Next: 03 Repository Layer",
    ]);
  });

  it("lists tickets in the supplied numeric order", () => {
    const output = renderTicketList(
      inventory([
        ticket("02", "second", "ready-for-agent", "Second"),
        ticket("01", "first", "ready-for-agent", "First"),
        ticket("10", "tenth", "ready-for-agent", "Tenth"),
      ]),
      RUNNABLE,
    );

    const names = lines(output)
      .filter((line) => /^\d+-/.test(line))
      .map((line) => line.split(/\s+/)[0]);
    assert.deepEqual(names, ["02-second", "01-first", "10-tenth"]);
  });

  it("marks the first runnable ticket as NEXT and later runnable tickets as run", () => {
    const output = renderTicketList(
      inventory([
        ticket("01", "done", "resolved", "Done"),
        ticket("02", "first-runnable", "ready-for-agent", "First Runnable"),
        ticket("03", "second-runnable", "ready-for-agent", "Second Runnable"),
      ]),
      RUNNABLE,
    );

    assert.match(rowStartingWith(output, "01-done"), /skip$/);
    assert.match(rowStartingWith(output, "02-first-runnable"), /NEXT ▶$/);
    assert.match(rowStartingWith(output, "03-second-runnable"), /run$/);
    assert.equal(output.match(/NEXT ▶/g)?.length, 1);
  });

  it("reports nothing to run when no ticket is runnable", () => {
    const output = renderTicketList(
      inventory([
        ticket("01", "database-schema", "resolved", "Database Schema"),
        ticket("02", "api-endpoints", "resolved", "API Endpoints"),
        ticket("03", "repository-layer", "resolved", "Repository Layer"),
      ]),
      RUNNABLE,
    );

    assert.deepEqual(lines(output).slice(-3), [
      "",
      "Executable: 0 of 3",
      "Nothing to run.",
    ]);
    assert.doesNotMatch(output, /NEXT ▶/);
    assert.doesNotMatch(output, /^Next:/m);
  });

  it("treats unknown statuses as skipped rather than errors", () => {
    const output = renderTicketList(
      inventory([ticket("01", "mystery", "something-else", "Mystery")]),
      RUNNABLE,
    );

    assert.match(rowStartingWith(output, "01-mystery"), /something-else\s+skip$/);
    assert.match(output, /Nothing to run\.$/);
  });

  it("honours configured runnable statuses", () => {
    const output = renderTicketList(
      inventory([ticket("01", "queued", "queued", "Queued")]),
      ["queued"],
    );

    assert.match(output, /NEXT ▶$/m);
    assert.match(output, /Executable: 1 of 1/);
  });
});


describe("renderStartOutcome", () => {
  const runnable = ["ready-for-agent"];

  it("reports nothing to run with the folder and runnable status", () => {
    const output = renderStartOutcome(
      { kind: "nothing-to-run" },
      ".scratch/auth/issues",
      runnable,
    );

    assert.equal(
      output,
      "✅ Nothing to run — no ticket in .scratch/auth/issues is ready-for-agent.",
    );
  });

  it("reports the status a successful ticket persisted", () => {
    const output = renderStartOutcome(
      {
        kind: "success",
        ticket: ticket("03", "repository-layer", "ready-for-agent", "Repository Layer"),
        status: "resolved",
      },
      ".scratch/auth/issues",
      runnable,
    );

    assert.equal(output, "✅ 03 Repository Layer — status now `resolved`.");
  });

  it("reports a gate rejection with its reason", () => {
    const outcome: StartOutcome = {
      kind: "gate-rejected",
      ticket: ticket("03", "repository-layer", "ready-for-agent", "Repository Layer"),
      status: "INCOMPLETE",
      reason: "integration tests are failing",
    };

    const output = renderStartOutcome(outcome, ".scratch/auth/issues", runnable);

    assert.match(output, /^⏹ 03 Repository Layer is incomplete\./);
    assert.match(output, /Reason: integration tests are failing/);
    assert.match(output, /Execution stopped\./);
  });

  it("reports a malformed gate answer and the raw final message", () => {
    const outcome: StartOutcome = {
      kind: "gate-malformed",
      ticket: ticket("03", "repository-layer", "ready-for-agent", "Repository Layer"),
      reason: "The gate returned no STATUS: line.",
      text: "I finished everything.",
    };

    const output = renderStartOutcome(outcome, ".scratch/auth/issues", runnable);

    assert.match(output, /unusable answer for 03 Repository Layer/);
    assert.match(output, /no STATUS: line/);
    assert.match(output, /I finished everything\./);
    assert.match(output, /Execution stopped\./);
  });

  it("reports COMPLETE without a persisted status change", () => {
    const outcome: StartOutcome = {
      kind: "status-unchanged",
      ticket: ticket("03", "repository-layer", "ready-for-agent", "Repository Layer"),
      status: "ready-for-agent",
    };

    const output = renderStartOutcome(outcome, ".scratch/auth/issues", runnable);

    assert.equal(
      output,
      [
        "⏹ Ticket 03-repository-layer reported COMPLETE,",
        "but its ticket file is still ready-for-agent.",
        "",
        "Execution stopped.",
      ].join("\n"),
    );
  });
});
