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
    assert.equal(config.liveFrameUpdateIntervalMs, 150);
    assert.equal(config.expandedTranscriptMaxLines, 1000);
    assert.equal(config.expandedTranscriptMaxBytes, 131072);
    assert.equal(config.staleLockHours, 12);
  });

  it("lets project values override global values per key", () => {
    const tree = createTempTree();
    tree.write(
      "agent/ticket-runner.json",
      JSON.stringify({
        maxTurnsPerTicket: 7,
        staleLockHours: 3,
        liveFrameUpdateIntervalMs: 200,
        expandedTranscriptMaxLines: 500,
        expandedTranscriptMaxBytes: 65536,
      }),
    );
    tree.write(
      "project/.pi/ticket-runner.json",
      JSON.stringify({
        maxTurnsPerTicket: 9,
        runnableStatuses: ["queued"],
        liveFrameUpdateIntervalMs: 300,
      }),
    );

    const { config } = loadConfig({ cwd: tree.path("project"), agentDir: tree.path("agent") });

    assert.equal(config.maxTurnsPerTicket, 9);
    assert.equal(config.staleLockHours, 3);
    assert.equal(config.liveFrameUpdateIntervalMs, 300);
    assert.equal(config.expandedTranscriptMaxLines, 500);
    assert.equal(config.expandedTranscriptMaxBytes, 65536);
    assert.deepEqual(config.runnableStatuses, ["queued"]);
  });

  it("accepts the deprecated widget interval alias without warning", () => {
    const tree = createTempTree();
    tree.write("agent/ticket-runner.json", JSON.stringify({ liveWidgetUpdateIntervalMs: 250 }));

    const { config, warnings } = loadConfig({
      cwd: tree.path("project"),
      agentDir: tree.path("agent"),
    });

    assert.equal(config.liveFrameUpdateIntervalMs, 250);
    assert.deepEqual(warnings, []);
  });

  it("prefers the frame interval key over the alias in the same file", () => {
    const tree = createTempTree();
    tree.write(
      "project/.pi/ticket-runner.json",
      JSON.stringify({ liveWidgetUpdateIntervalMs: 250, liveFrameUpdateIntervalMs: 300 }),
    );

    const { config } = loadConfig({ cwd: tree.path("project"), agentDir: tree.path("agent") });

    assert.equal(config.liveFrameUpdateIntervalMs, 300);
  });

  it("prefers the frame interval key wherever it appears over an alias", () => {
    const globalFrame = createTempTree();
    globalFrame.write("agent/ticket-runner.json", JSON.stringify({ liveFrameUpdateIntervalMs: 200 }));
    globalFrame.write(
      "project/.pi/ticket-runner.json",
      JSON.stringify({ liveWidgetUpdateIntervalMs: 300 }),
    );

    const fromGlobal = loadConfig({
      cwd: globalFrame.path("project"),
      agentDir: globalFrame.path("agent"),
    });
    assert.equal(fromGlobal.config.liveFrameUpdateIntervalMs, 200);

    const projectFrame = createTempTree();
    projectFrame.write(
      "agent/ticket-runner.json",
      JSON.stringify({ liveWidgetUpdateIntervalMs: 200 }),
    );
    projectFrame.write(
      "project/.pi/ticket-runner.json",
      JSON.stringify({ liveFrameUpdateIntervalMs: 300 }),
    );

    const fromProject = loadConfig({
      cwd: projectFrame.path("project"),
      agentDir: projectFrame.path("agent"),
    });
    assert.equal(fromProject.config.liveFrameUpdateIntervalMs, 300);
  });

  it("lets a project alias override a global alias", () => {
    const tree = createTempTree();
    tree.write("agent/ticket-runner.json", JSON.stringify({ liveWidgetUpdateIntervalMs: 200 }));
    tree.write(
      "project/.pi/ticket-runner.json",
      JSON.stringify({ liveWidgetUpdateIntervalMs: 300 }),
    );

    const { config } = loadConfig({ cwd: tree.path("project"), agentDir: tree.path("agent") });

    assert.equal(config.liveFrameUpdateIntervalMs, 300);
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
      { liveFrameUpdateIntervalMs: -1 },
      { liveFrameUpdateIntervalMs: 12.5 },
      { liveWidgetUpdateIntervalMs: -1 },
      { liveWidgetUpdateIntervalMs: 12.5 },
      { expandedTranscriptMaxLines: 0 },
      { expandedTranscriptMaxLines: -5 },
      { expandedTranscriptMaxLines: 1.5 },
      { expandedTranscriptMaxLines: "1000" },
      { expandedTranscriptMaxBytes: 0 },
      { expandedTranscriptMaxBytes: -5 },
      { expandedTranscriptMaxBytes: 1.5 },
      { expandedTranscriptMaxBytes: "131072" },
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
          const key = Object.keys(invalid)[0] ?? "";
          assert.ok(
            error.message.includes(`"${key}"`),
            `error should name the invalid key: ${error.message}`,
          );
          return true;
        },
        JSON.stringify(invalid),
      );
    }
  });

  it("rejects an invalid alias even when the frame key is present", () => {
    const tree = createTempTree();
    tree.write(
      "project/.pi/ticket-runner.json",
      JSON.stringify({ liveFrameUpdateIntervalMs: 200, liveWidgetUpdateIntervalMs: -1 }),
    );

    assert.throws(
      () => loadConfig({ cwd: tree.path("project"), agentDir: tree.path("agent") }),
      (error: unknown) =>
        error instanceof TicketRunnerError &&
        /"liveWidgetUpdateIntervalMs" must be/.test(error.message) &&
        /ticket-runner\.json/.test(error.message),
    );
  });
});
