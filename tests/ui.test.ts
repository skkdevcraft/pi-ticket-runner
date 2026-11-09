import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ActiveRun } from "../src/run-state.ts";
import type { RunOutcome, TicketProgress } from "../src/runner.ts";
import type { Ticket, TicketInventory } from "../src/tickets.ts";
import {
  renderActiveRun,
  renderRunOutcome,
  renderTicketList,
  renderTicketProgress,
} from "../src/ui.ts";

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

describe("renderTicketProgress", () => {
  it("reports the persisted status, next ticket, and remaining count", () => {
    const progress: TicketProgress = {
      ticket: ticket("03", "repository-layer", "resolved", "Repository Layer"),
      status: "resolved",
      next: ticket("05", "documentation", "ready-for-agent", "Documentation"),
      remainingRunnable: 1,
    };

    assert.deepEqual(lines(renderTicketProgress(progress)), [
      "✅ 03 Repository Layer — status now `resolved`.",
      "Next: 05 Documentation (1 ticket left).",
    ]);
  });

  it("reports when no runnable ticket remains", () => {
    const progress: TicketProgress = {
      ticket: ticket("05", "documentation", "resolved", "Documentation"),
      status: "resolved",
      next: undefined,
      remainingRunnable: 0,
    };

    assert.deepEqual(lines(renderTicketProgress(progress)), [
      "✅ 05 Documentation — status now `resolved`.",
      "Next: none (0 tickets left).",
    ]);
  });
});

describe("renderActiveRun", () => {
  it("shows the folder, current ticket, remaining count, and session file", () => {
    const run: ActiveRun = {
      folderLabel: ".scratch/auth/issues",
      totalTickets: 5,
      currentTicket: ticket("03", "repository-layer", "ready-for-agent", "Repository Layer"),
      remainingRunnable: 2,
      sessionFile: "/sessions/03.jsonl",
    };

    assert.deepEqual(lines(renderActiveRun(run)), [
      "🎫 Ticket runner active",
      "",
      "Folder: .scratch/auth/issues",
      "Position: 03 Repository Layer",
      "Executable remaining: 2 of 5",
      "Session: /sessions/03.jsonl",
    ]);
  });

  it("renders a run that has not started its first ticket yet", () => {
    const run: ActiveRun = {
      folderLabel: "issues",
      totalTickets: 2,
      currentTicket: undefined,
      remainingRunnable: 2,
      sessionFile: undefined,
    };

    const output = renderActiveRun(run);
    assert.match(output, /Position: \(starting\)/);
    assert.match(output, /Session: \(not saved\)/);
  });
});

describe("renderRunOutcome", () => {
  const runnable = ["ready-for-agent"];

  it("reports nothing to run with the folder and runnable status", () => {
    const output = renderRunOutcome(
      { kind: "nothing-to-run" },
      ".scratch/auth/issues",
      runnable,
    );

    assert.equal(
      output,
      "✅ Nothing to run — no ticket in .scratch/auth/issues is ready-for-agent.",
    );
  });

  it("summarises ran tickets and names every skip reason", () => {
    const outcome: RunOutcome = {
      kind: "finished",
      ran: [
        {
          ticket: ticket("03", "repository-layer", "ready-for-agent", "Repository Layer"),
          status: "resolved",
        },
        {
          ticket: ticket("05", "documentation", "ready-for-agent", "Documentation"),
          status: "resolved",
        },
      ],
      skipped: [
        {
          ticket: ticket("04", "integration-tests", "ready-for-human", "Integration Tests"),
          status: "ready-for-human",
        },
        { ticket: ticket("06", "wontfix", "wontfix", "Wontfix"), status: "wontfix" },
      ],
      remainingRunnable: 0,
    };

    assert.deepEqual(lines(renderRunOutcome(outcome, ".scratch/auth/issues", runnable)), [
      "✅ Run finished · 0 tickets ready-for-agent.",
      "Ran: 03 Repository Layer, 05 Documentation.",
      "Skipped: 04 Integration Tests (ready-for-human), 06 Wontfix (wontfix).",
    ]);
  });

  it("reports an empty skip list explicitly", () => {
    const outcome: RunOutcome = {
      kind: "finished",
      ran: [{ ticket: ticket("01", "one", "ready-for-agent", "One"), status: "resolved" }],
      skipped: [],
      remainingRunnable: 0,
    };

    const output = renderRunOutcome(outcome, "issues", runnable);
    assert.match(output, /Skipped: none\./);
  });

  it("reports a gate rejection, its reason, remaining count, and summary", () => {
    const outcome: RunOutcome = {
      kind: "stopped",
      ran: [],
      skipped: [
        {
          ticket: ticket("01", "one", "resolved", "One"),
          status: "resolved",
        },
      ],
      stop: {
        kind: "gate-rejected",
        ticket: ticket("03", "repository-layer", "ready-for-agent", "Repository Layer"),
        status: "INCOMPLETE",
        reason: "integration tests are failing",
      },
      remainingRunnable: 2,
    };

    const output = renderRunOutcome(outcome, ".scratch/auth/issues", runnable);

    assert.match(output, /^⏹ 03 Repository Layer is incomplete\./);
    assert.match(output, /Reason: integration tests are failing/);
    assert.match(output, /Execution stopped · 2 tickets left\./);
    assert.match(output, /Ran: none\./);
    assert.match(output, /Skipped: 01 One \(resolved\)\./);
  });

  it("reports a malformed gate answer and the raw final message", () => {
    const outcome: RunOutcome = {
      kind: "stopped",
      ran: [],
      skipped: [],
      stop: {
        kind: "gate-malformed",
        ticket: ticket("03", "repository-layer", "ready-for-agent", "Repository Layer"),
        reason: "The gate returned no STATUS: line.",
        text: "I finished everything.",
      },
      remainingRunnable: 1,
    };

    const output = renderRunOutcome(outcome, ".scratch/auth/issues", runnable);

    assert.match(output, /unusable answer for 03 Repository Layer/);
    assert.match(output, /no STATUS: line/);
    assert.match(output, /I finished everything\./);
    assert.match(output, /Execution stopped · 1 ticket left\./);
  });

  it("reports COMPLETE without a persisted status change", () => {
    const outcome: RunOutcome = {
      kind: "stopped",
      ran: [],
      skipped: [],
      stop: {
        kind: "status-unchanged",
        ticket: ticket("03", "repository-layer", "ready-for-agent", "Repository Layer"),
        status: "ready-for-agent",
      },
      remainingRunnable: 1,
    };

    const output = renderRunOutcome(outcome, ".scratch/auth/issues", runnable);

    assert.match(
      output,
      /^⏹ Ticket 03-repository-layer reported COMPLETE,\nbut its ticket file is still ready-for-agent\./,
    );
    assert.match(output, /Execution stopped · 1 ticket left\./);
  });

  it("reports a turn-limit stop", () => {
    const outcome: RunOutcome = {
      kind: "stopped",
      ran: [],
      skipped: [],
      stop: {
        kind: "turn-limit",
        ticket: ticket("03", "repository-layer", "ready-for-agent", "Repository Layer"),
        turns: 50,
        maxTurns: 50,
      },
      remainingRunnable: 2,
    };

    const output = renderRunOutcome(outcome, ".scratch/auth/issues", runnable);

    assert.match(output, /^⏹ 03 Repository Layer hit the 50-turn limit after 50 turns\./);
    assert.match(output, /Execution stopped · 2 tickets left\./);
  });

  it("reports a child-session error with its phase and message", () => {
    const outcome: RunOutcome = {
      kind: "stopped",
      ran: [],
      skipped: [],
      stop: {
        kind: "session-error",
        ticket: ticket("03", "repository-layer", "ready-for-agent", "Repository Layer"),
        phase: "completion-gate",
        message: "gate crashed",
      },
      remainingRunnable: 1,
    };

    const output = renderRunOutcome(outcome, ".scratch/auth/issues", runnable);

    assert.match(output, /child session error during the completion gate\./);
    assert.match(output, /gate crashed/);
    assert.match(output, /Execution stopped · 1 ticket left\./);
  });

  it("reports a branch or HEAD change before the next ticket", () => {
    const expected = { root: "/project", branch: "main", head: "aaaaaaaa1111" };
    const outcome: RunOutcome = {
      kind: "stopped",
      ran: [],
      skipped: [],
      stop: {
        kind: "git-changed",
        ticket: ticket("03", "repository-layer", "ready-for-agent", "Repository Layer"),
        expected,
        actual: { root: "/project", branch: "feature", head: "bbbbbbbb2222" },
      },
      remainingRunnable: 2,
    };

    const output = renderRunOutcome(outcome, ".scratch/auth/issues", runnable);

    assert.match(output, /^⏹ Repository branch or HEAD changed before 03 Repository Layer\./);
    assert.match(output, /Expected main at aaaaaaaa, found feature at bbbbbbbb\./);
    assert.match(output, /Execution stopped · 2 tickets left\./);
  });

  it("reports an unreadable git state before a ticket", () => {
    const outcome: RunOutcome = {
      kind: "stopped",
      ran: [],
      skipped: [],
      stop: {
        kind: "git-check-error",
        ticket: ticket("03", "repository-layer", "ready-for-agent", "Repository Layer"),
        message: "git is unavailable",
      },
      remainingRunnable: 1,
    };

    const output = renderRunOutcome(outcome, ".scratch/auth/issues", runnable);

    assert.match(output, /^⏹ Cannot verify the repository branch and HEAD before 03 Repository Layer\./);
    assert.match(output, /git is unavailable/);
    assert.match(output, /Execution stopped · 1 ticket left\./);
  });
});
