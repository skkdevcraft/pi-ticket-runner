import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  Extension,
  LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";

import { filterTicketRunnerExtension } from "../src/sessions.ts";

function extension(path: string, commands: readonly string[] = []): Extension {
  return {
    path,
    resolvedPath: path,
    sourceInfo: { path, source: "local", scope: "project", origin: "top-level" },
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(commands.map((name) => [name, {}])),
    flags: new Map(),
    shortcuts: new Map(),
  } as unknown as Extension;
}

function result(extensions: readonly Extension[]): LoadExtensionsResult {
  return {
    extensions: [...extensions],
    errors: [{ path: "broken.ts", error: "boom" }],
    warnings: [{ path: "warn.ts", warning: "careful" }],
    runtime: {} as LoadExtensionsResult["runtime"],
  };
}

describe("filterTicketRunnerExtension", () => {
  it("removes this extension by path and preserves every other extension", () => {
    const base = result([
      extension("/repo/pi-ticket-runner/index.ts"),
      extension("/repo/other-extension.ts"),
    ]);

    const filtered = filterTicketRunnerExtension(base, "/repo/pi-ticket-runner/index.ts");

    assert.deepEqual(
      filtered.extensions.map((item) => item.path),
      ["/repo/other-extension.ts"],
    );
    assert.deepEqual(filtered.errors, base.errors);
    assert.deepEqual(filtered.warnings, base.warnings);
    assert.equal(filtered.runtime, base.runtime);
  });

  it("recognizes this extension when its loaded path differs but it owns the command", () => {
    const base = result([
      extension("/repo/pi-ticket-runner/index.ts", ["ticket-runner"]),
      extension("/repo/other-extension.ts", ["other"]),
    ]);

    const filtered = filterTicketRunnerExtension(base, "/different/install/index.ts");

    assert.deepEqual(
      filtered.extensions.map((item) => item.path),
      ["/repo/other-extension.ts"],
    );
  });
});
