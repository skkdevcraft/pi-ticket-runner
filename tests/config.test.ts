import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";
import { TicketRunnerError } from "../src/errors.ts";
import { createTempTree } from "./helpers.ts";

describe("loadConfig", () => {
  it("uses defaults when neither file exists", () => {
    const tree = createTempTree();
    const { config, warnings } = loadConfig({
      cwd: tree.path("project"),
      agentDir: tree.path("agent"),
    });

    assert.deepEqual(config, DEFAULT_CONFIG);
    assert.deepEqual(warnings, []);
  });

  it("loads values from the global file", () => {
    const tree = createTempTree();
    tree.write("agent/ticket-runner.json", JSON.stringify({ maxTurnsPerTicket: 7 }));

    const { config } = loadConfig({ cwd: tree.path("project"), agentDir: tree.path("agent") });

    assert.equal(config.maxTurnsPerTicket, 7);
    assert.deepEqual(config.runnableStatuses, ["ready-for-agent"]);
    assert.equal(config.liveWidgetUpdateIntervalMs, 150);
    assert.equal(config.staleLockHours, 12);
  });

  it("lets project values override global values per key", () => {
    const tree = createTempTree();
    tree.write(
      "agent/ticket-runner.json",
      JSON.stringify({ maxTurnsPerTicket: 7, staleLockHours: 3, liveWidgetUpdateIntervalMs: 200 }),
    );
    tree.write(
      "project/.pi/ticket-runner.json",
      JSON.stringify({ maxTurnsPerTicket: 9, runnableStatuses: ["queued"] }),
    );

    const { config } = loadConfig({ cwd: tree.path("project"), agentDir: tree.path("agent") });

    assert.equal(config.maxTurnsPerTicket, 9);
    assert.equal(config.staleLockHours, 3);
    assert.equal(config.liveWidgetUpdateIntervalMs, 200);
    assert.deepEqual(config.runnableStatuses, ["queued"]);
  });

  it("normalizes runnable statuses", () => {
    const tree = createTempTree();
    tree.write(
      "project/.pi/ticket-runner.json",
      JSON.stringify({ runnableStatuses: ["  Ready-For-Agent ", "QUEUED"] }),
    );

    const { config } = loadConfig({ cwd: tree.path("project"), agentDir: tree.path("agent") });

    assert.deepEqual(config.runnableStatuses, ["ready-for-agent", "queued"]);
  });

  it("replaces rather than merges runnable statuses", () => {
    const tree = createTempTree();
    tree.write("agent/ticket-runner.json", JSON.stringify({ runnableStatuses: ["ready-for-agent"] }));
    tree.write("project/.pi/ticket-runner.json", JSON.stringify({ runnableStatuses: ["queued"] }));

    const { config } = loadConfig({ cwd: tree.path("project"), agentDir: tree.path("agent") });

    assert.deepEqual(config.runnableStatuses, ["queued"]);
  });

  it("warns about unknown keys without failing", () => {
    const tree = createTempTree();
    tree.write("project/.pi/ticket-runner.json", JSON.stringify({ maxTurnsPerTicket: 4, colour: "blue" }));

    const { config, warnings } = loadConfig({
      cwd: tree.path("project"),
      agentDir: tree.path("agent"),
    });

    assert.equal(config.maxTurnsPerTicket, 4);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /Unknown configuration key "colour"/);
    assert.match(warnings[0] ?? "", /ticket-runner\.json/);
  });

  it("rejects invalid JSON", () => {
    const tree = createTempTree();
    tree.write("project/.pi/ticket-runner.json", "{ not json");

    assert.throws(
      () => loadConfig({ cwd: tree.path("project"), agentDir: tree.path("agent") }),
      (error: unknown) =>
        error instanceof TicketRunnerError && /Invalid JSON in configuration file/.test(error.message),
    );
  });

  it("rejects a non-object configuration file", () => {
    const tree = createTempTree();
    tree.write("project/.pi/ticket-runner.json", "[]");

    assert.throws(
      () => loadConfig({ cwd: tree.path("project"), agentDir: tree.path("agent") }),
      (error: unknown) =>
        error instanceof TicketRunnerError && /expected a JSON object/.test(error.message),
    );
  });

  it("rejects invalid values with a descriptive error", () => {
    const invalidConfigurations: Array<Record<string, unknown>> = [
      { runnableStatuses: "ready-for-agent" },
      { runnableStatuses: [42] },
      { runnableStatuses: ["  "] },
      { maxTurnsPerTicket: 0 },
      { maxTurnsPerTicket: 2.5 },
      { maxTurnsPerTicket: "50" },
      { liveWidgetUpdateIntervalMs: -1 },
      { liveWidgetUpdateIntervalMs: 12.5 },
      { staleLockHours: 0 },
      { staleLockHours: "12" },
    ];

    for (const invalid of invalidConfigurations) {
      const tree = createTempTree();
      tree.write("project/.pi/ticket-runner.json", JSON.stringify(invalid));

      assert.throws(
        () => loadConfig({ cwd: tree.path("project"), agentDir: tree.path("agent") }),
        (error: unknown) => {
          if (!(error instanceof TicketRunnerError)) return false;
          assert.match(error.message, /Invalid configuration in .*ticket-runner\.json:/);
          assert.match(error.message, /"runnableStatuses"|"maxTurnsPerTicket"|"liveWidgetUpdateIntervalMs"|"staleLockHours"/);
          return true;
        },
        JSON.stringify(invalid),
      );
    }
  });
});
