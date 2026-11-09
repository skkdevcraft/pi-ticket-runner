import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildCompletionGatePrompt, parseGateResult } from "../src/gate.ts";

describe("buildCompletionGatePrompt", () => {
  it("names the ticket, the configured runnable statuses, and the completed value", () => {
    const prompt = buildCompletionGatePrompt(
      ".scratch/auth/issues/03-repository-layer.md",
      ["ready-for-agent", "queued"],
      "resolved",
    );

    assert.match(prompt, /\.scratch\/auth\/issues\/03-repository-layer\.md/);
    assert.match(prompt, /any of: ready-for-agent, queued\./);
    assert.match(prompt, /completed value is `resolved`/);
    assert.match(prompt, /STATUS: COMPLETE \| INCOMPLETE \| BLOCKED/);
    assert.match(prompt, /REASON: <brief explanation>/);
  });

  it("uses the repository's completed value", () => {
    const prompt = buildCompletionGatePrompt("issues/01.md", ["ready"], "done");

    assert.match(prompt, /completed value is `done`/);
  });
});

describe("parseGateResult", () => {
  it("reads a complete answer and its reason", () => {
    assert.deepEqual(
      parseGateResult("All checks passed.\n\nSTATUS: COMPLETE\nREASON: tests and typecheck pass"),
      {
        kind: "complete",
        status: "COMPLETE",
        reason: "tests and typecheck pass",
      },
    );
  });

  it("reads each recognized status case-insensitively", () => {
    assert.equal(parseGateResult("STATUS: incomplete").kind, "incomplete");
    assert.equal(parseGateResult("status: blocked").kind, "blocked");
  });

  it("tolerates emphasis and code fences around the status", () => {
    for (const answer of [
      "**STATUS: COMPLETE**",
      "`STATUS: COMPLETE`",
      "```\nSTATUS: COMPLETE\n```",
      "  **`STATUS: COMPLETE`**  ",
      "**STATUS:** COMPLETE",
    ]) {
      assert.equal(parseGateResult(answer).kind, "complete", answer);
    }
  });

  it("takes the last status line when repeated statuses agree", () => {
    assert.equal(
      parseGateResult("STATUS: COMPLETE\nReasoning...\nSTATUS: COMPLETE").kind,
      "complete",
    );
  });

  it("takes the last status line after unrelated text", () => {
    const answer = "I considered the request.\n\nSTATUS: INCOMPLETE\nREASON: tests fail";

    assert.deepEqual(parseGateResult(answer), {
      kind: "incomplete",
      status: "INCOMPLETE",
      reason: "tests fail",
    });
  });

  it("stops on a missing answer", () => {
    for (const answer of [undefined, "", "Everything is done."]) {
      const result = parseGateResult(answer);
      assert.equal(result.kind, "malformed", String(answer));
      assert.match(result.reason, /no STATUS: line/i);
    }
  });

  it("stops on an unrecognized value instead of guessing", () => {
    for (const answer of ["STATUS: DONE", "STATUS: COMPLETE | INCOMPLETE", "STATUS: yes"]) {
      const result = parseGateResult(answer);
      assert.equal(result.kind, "malformed", answer);
      assert.match(result.reason, /unrecognized/i);
    }
  });

  it("stops on contradictory status lines", () => {
    const result = parseGateResult("STATUS: COMPLETE\nSTATUS: INCOMPLETE");

    assert.equal(result.kind, "malformed");
    assert.match(result.reason, /contradictory/i);
  });

  it("tolerates a missing reason", () => {
    assert.deepEqual(parseGateResult("STATUS: BLOCKED"), {
      kind: "blocked",
      status: "BLOCKED",
      reason: "",
    });
  });
});
