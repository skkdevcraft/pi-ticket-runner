import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createHerdrActivity,
  type HerdrActivityOptions,
  type HerdrActivitySnapshot,
} from "../src/herdr-activity.ts";

const SESSION_PATH = "/sessions/root.jsonl";
const SESSION_ID = "root-session";

const baseEnv: NodeJS.ProcessEnv = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "pane-1",
  HERDR_BIN_PATH: "/opt/herdr/bin/herdr",
};

interface RequestRecorder {
  readonly calls: string[][];
  readonly run: (args: readonly string[]) => Promise<void>;
}

function createRecorder(): RequestRecorder {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      calls.push([...args]);
    },
  };
}

function createActivity(
  env: NodeJS.ProcessEnv,
  run: RequestRecorder["run"],
  session: HerdrActivityOptions["session"] = { path: SESSION_PATH, id: SESSION_ID },
) {
  return createHerdrActivity({ session, env, run });
}

function snapshot(
  overrides: Partial<HerdrActivitySnapshot> = {},
): HerdrActivitySnapshot {
  return {
    ticket: { id: "03", title: "Repository layer" },
    remainingRunnable: 2,
    phase: "implementing",
    ...overrides,
  };
}

function seqOf(call: readonly string[]): number {
  const index = call.indexOf("--seq");
  assert.notEqual(index, -1, `missing --seq in ${call.join(" ")}`);
  const value = Number(call[index + 1]);
  assert.ok(Number.isInteger(value), `non-integer --seq in ${call.join(" ")}`);
  return value;
}

function expectStateCall(
  call: readonly string[],
  options: {
    state: string;
    session?: readonly string[] | undefined;
  },
): void {
  assert.deepEqual(call.slice(0, 9), [
    "pane",
    "report-agent",
    "pane-1",
    "--source",
    "ticket-runner",
    "--agent",
    "pi",
    "--state",
    options.state,
  ]);
  assert.equal(call[9], "--seq");
  assert.ok(Number.isInteger(Number(call[10])), `non-integer --seq in ${call.join(" ")}`);
  const tail = call.slice(11);
  if (options.session === undefined) {
    assert.deepEqual(tail, []);
  } else {
    assert.deepEqual(tail, [...options.session]);
  }
}

function expectMetadataCall(
  call: readonly string[],
  options: { readonly cleared: boolean },
): void {
  assert.deepEqual(call.slice(0, 8), [
    "pane",
    "report-metadata",
    "pane-1",
    "--source",
    "ticket-runner",
    "--agent",
    "pi",
    "--seq",
  ]);
  assert.ok(Number.isInteger(Number(call[8])), `non-integer --seq in ${call.join(" ")}`);

  if (options.cleared) {
    assert.deepEqual(call.slice(9), [
      "--clear-title",
      "--clear-state-labels",
      "--clear-token",
      "ticket",
      "--clear-token",
      "remaining",
      "--clear-token",
      "phase",
    ]);
  }
}

describe("createHerdrActivity enablement", () => {
  const unavailable: Array<[string, NodeJS.ProcessEnv]> = [
    ["HERDR_ENV missing", { ...baseEnv, HERDR_ENV: undefined }],
    ["HERDR_ENV not 1", { ...baseEnv, HERDR_ENV: "0" }],
    ["HERDR_PANE_ID missing", { ...baseEnv, HERDR_PANE_ID: undefined }],
    ["HERDR_PANE_ID empty", { ...baseEnv, HERDR_PANE_ID: "" }],
    ["HERDR_BIN_PATH missing", { ...baseEnv, HERDR_BIN_PATH: undefined }],
    ["HERDR_BIN_PATH empty", { ...baseEnv, HERDR_BIN_PATH: "" }],
  ];

  for (const [label, env] of unavailable) {
    it(`spawns nothing when ${label}`, () => {
      const recorder = createRecorder();
      const activity = createActivity(env, recorder.run);

      activity.update(snapshot());
      activity.idle();

      assert.deepEqual(recorder.calls, []);
    });
  }
});

describe("createHerdrActivity reporting", () => {
  it("reports working, then metadata with the ticket identity", () => {
    const recorder = createRecorder();
    const activity = createActivity(baseEnv, recorder.run);

    activity.update(snapshot());

    assert.equal(recorder.calls.length, 2);
    const [state, metadata] = recorder.calls;
    assert.ok(state);
    assert.ok(metadata);

    expectStateCall(state, {
      state: "working",
      session: ["--agent-session-path", SESSION_PATH],
    });
    expectMetadataCall(metadata, { cleared: false });
    assert.equal(metadata[9], "--title");
    assert.equal(metadata[10], "03 Repository layer");
    assert.deepEqual(metadata.slice(11), [
      "--state-label",
      "working=implementing 03",
      "--token",
      "ticket=03",
      "--token",
      "remaining=2",
      "--token",
      "phase=implementing",
    ]);
  });

  it("refreshes metadata only on later updates", () => {
    const recorder = createRecorder();
    const activity = createActivity(baseEnv, recorder.run);

    activity.update(snapshot());
    activity.update(snapshot({ remainingRunnable: 1, phase: "verifying" }));

    assert.equal(recorder.calls.length, 3);
    assert.equal(recorder.calls.filter((call) => call[1] === "report-agent").length, 1);

    const metadata = recorder.calls[2];
    assert.ok(metadata);
    expectMetadataCall(metadata, { cleared: false });
    assert.equal(metadata[10], "03 Repository layer");
    assert.deepEqual(metadata.slice(11), [
      "--state-label",
      "working=verifying 03",
      "--token",
      "ticket=03",
      "--token",
      "remaining=1",
      "--token",
      "phase=verifying",
    ]);
  });

  it("reports idle and clears metadata, then ignores later updates", () => {
    const recorder = createRecorder();
    const activity = createActivity(baseEnv, recorder.run);
    activity.update(snapshot());

    activity.idle();

    assert.equal(recorder.calls.length, 4);
    const state = recorder.calls[2];
    const metadata = recorder.calls[3];
    assert.ok(state);
    assert.ok(metadata);
    expectStateCall(state, {
      state: "idle",
      session: ["--agent-session-path", SESSION_PATH],
    });
    expectMetadataCall(metadata, { cleared: true });

    activity.update(snapshot());
    activity.idle();

    assert.equal(recorder.calls.length, 4);
  });

  it("spawns nothing for an idle before any update", () => {
    const recorder = createRecorder();
    const activity = createActivity(baseEnv, recorder.run);

    activity.idle();
    activity.update(snapshot());

    assert.deepEqual(recorder.calls, []);
  });

  it("increases seq across every state and metadata request", () => {
    const recorder = createRecorder();
    const activity = createActivity(baseEnv, recorder.run);

    activity.update(snapshot());
    activity.update(snapshot({ phase: "verifying" }));
    activity.idle();

    const sequences = recorder.calls.map(seqOf);
    assert.equal(sequences.length, recorder.calls.length);
    for (let index = 1; index < sequences.length; index += 1) {
      assert.ok(
        (sequences[index] ?? 0) > (sequences[index - 1] ?? 0),
        `seq not increasing at ${index}: ${sequences.join(", ")}`,
      );
    }
  });

  it("prefers the session path, falls back to the session id, and allows neither", () => {
    const withPath = createRecorder();
    createActivity(baseEnv, withPath.run, { path: SESSION_PATH, id: SESSION_ID })
      .update(snapshot());
    const pathState = withPath.calls[0];
    assert.ok(pathState);
    assert.deepEqual(pathState.slice(-2), ["--agent-session-path", SESSION_PATH]);

    const withId = createRecorder();
    createActivity(baseEnv, withId.run, { id: SESSION_ID }).update(snapshot());
    const idState = withId.calls[0];
    assert.ok(idState);
    assert.deepEqual(idState.slice(-2), ["--agent-session-id", SESSION_ID]);

    const withoutSession = createRecorder();
    createActivity(baseEnv, withoutSession.run, {}).update(snapshot());
    const bareState = withoutSession.calls[0];
    assert.ok(bareState);
    assert.equal(bareState.at(-2), "--seq");
  });

  it("swallows a rejecting or synchronously throwing command", async () => {
    const rejections: string[] = [];
    const activity = createActivity(baseEnv, async (args) => {
      rejections.push(args[1] ?? "");
      throw new Error("herdr is gone");
    });
    assert.doesNotThrow(() => activity.update(snapshot()));
    assert.doesNotThrow(() => activity.idle());
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(rejections, ["report-agent", "report-metadata", "report-agent", "report-metadata"]);

    const throwing = createActivity(baseEnv, () => {
      throw new Error("cannot spawn");
    });
    assert.doesNotThrow(() => throwing.update(snapshot()));
    assert.doesNotThrow(() => throwing.idle());
  });
});
