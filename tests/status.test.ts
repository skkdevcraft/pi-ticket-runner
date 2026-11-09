import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TicketRunnerError } from "../src/errors.ts";
import { isRunnableStatus, parseTicketStatus } from "../src/status.ts";

describe("parseTicketStatus", () => {
  it("reads a plain Status: line", () => {
    assert.equal(parseTicketStatus("Status: ready-for-agent\n"), "ready-for-agent");
  });

  it("reads a bolded **Status:** line", () => {
    assert.equal(parseTicketStatus("**Status:** ready-for-agent\n"), "ready-for-agent");
  });

  it("trims whitespace and lowercases the value", () => {
    assert.equal(parseTicketStatus("Status:   Ready-For-Agent   \n"), "ready-for-agent");
    assert.equal(parseTicketStatus("**Status:**\tRESOLVED\n"), "resolved");
  });

  it("finds the status line among other content", () => {
    const content = ["# 01: One", "", "Some prose about Status: values.", "", "**Status:** resolved", ""]
      .join("\n");
    assert.equal(parseTicketStatus(content), "resolved");
  });

  it("rejects a ticket with no status line", () => {
    assert.throws(
      () => parseTicketStatus("# 01: One\n\nBody.\n", "01-one.md"),
      (error: unknown) =>
        error instanceof TicketRunnerError &&
        error.message === "Ticket 01-one.md has no Status: line.",
    );
  });

  it("rejects a ticket with duplicate status lines", () => {
    assert.throws(
      () => parseTicketStatus("Status: resolved\nStatus: ready-for-agent\n", "01-one.md"),
      (error: unknown) =>
        error instanceof TicketRunnerError &&
        error.message === "Ticket 01-one.md has more than one Status: line.",
    );
  });

  it("rejects a mixed plain and bolded duplicate", () => {
    assert.throws(
      () => parseTicketStatus("Status: resolved\n**Status:** resolved\n"),
      (error: unknown) =>
        error instanceof TicketRunnerError && /more than one Status: line/.test(error.message),
    );
  });

  it("rejects an empty status value", () => {
    assert.throws(
      () => parseTicketStatus("Status:\n"),
      (error: unknown) =>
        error instanceof TicketRunnerError && /empty Status: value/.test(error.message),
    );
    assert.throws(
      () => parseTicketStatus("**Status:**    \n"),
      (error: unknown) =>
        error instanceof TicketRunnerError && /empty Status: value/.test(error.message),
    );
  });

  it("does not treat prose containing the word status as a status line", () => {
    assert.throws(
      () => parseTicketStatus("The Status: is unknown\n"),
      (error: unknown) => error instanceof TicketRunnerError && /no Status: line/.test(error.message),
    );
  });
});

describe("isRunnableStatus", () => {
  const runnableStatuses = ["ready-for-agent"];

  it("marks a configured runnable status executable", () => {
    assert.equal(isRunnableStatus("ready-for-agent", runnableStatuses), true);
  });

  it("marks every other status as skipped", () => {
    for (const status of ["resolved", "ready-for-human", "needs-triage", "wontfix", "unknown"]) {
      assert.equal(isRunnableStatus(status, runnableStatuses), false, status);
    }
  });

  it("uses an overridden runnable list", () => {
    assert.equal(isRunnableStatus("queued", ["queued", "ready-for-agent"]), true);
    assert.equal(isRunnableStatus("ready-for-agent", ["queued"]), false);
  });
});
