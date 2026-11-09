import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { parseCommandArgs, registerTicketRunnerCommand } from "../src/command.ts";
import { TicketRunnerError } from "../src/errors.ts";
import { createTempTree, ticketMarkdown } from "./helpers.ts";

interface SentMessage {
  readonly message: Record<string, unknown>;
  readonly options: unknown;
}

interface FakePi {
  readonly sent: SentMessage[];
  readonly notifications: Array<{ message: string; level: string }>;
  readonly registered: { readonly name?: string; readonly description?: string | undefined };
  run(args: string, cwd: string): Promise<void>;
}

function createFakePi(agentDir: string): FakePi {
  const sent: SentMessage[] = [];
  const registered: { name?: string; description?: string | undefined } = {};
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;

  const pi = {
    registerCommand: (name: string, options: { description?: string; handler: typeof handler }) => {
      registered.name = name;
      registered.description = options.description;
      handler = options.handler;
    },
    sendMessage: (message: Record<string, unknown>, options: unknown) => {
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  const notifications: Array<{ message: string; level: string }> = [];

  registerTicketRunnerCommand(pi, { agentDir });

  return {
    sent,
    notifications,
    registered,
    async run(args, cwd) {
      assert.ok(handler, "command handler was not registered");
      const ctx = {
        cwd,
        ui: {
          notify: (message: string, level: string) => notifications.push({ message, level }),
        },
      } as unknown as ExtensionCommandContext;
      await handler(args, ctx);
    },
  };
}

describe("parseCommandArgs", () => {
  it("parses list and start with a folder", () => {
    assert.deepEqual(parseCommandArgs("list issues"), {
      subcommand: "list",
      folder: "issues",
      allowDirty: false,
    });
    assert.deepEqual(parseCommandArgs("start .scratch/auth/issues"), {
      subcommand: "start",
      folder: ".scratch/auth/issues",
      allowDirty: false,
    });
  });

  it("parses --allow-dirty for start only", () => {
    assert.deepEqual(parseCommandArgs("start issues --allow-dirty"), {
      subcommand: "start",
      folder: "issues",
      allowDirty: true,
    });
    assert.throws(
      () => parseCommandArgs("list issues --allow-dirty"),
      (error: unknown) =>
        error instanceof TicketRunnerError && /Unknown option "--allow-dirty"/.test(error.message),
    );
  });

  it("accepts quoted folder paths", () => {
    assert.equal(parseCommandArgs('list "my tickets"').folder, "my tickets");
    assert.equal(parseCommandArgs("list 'my tickets'").folder, "my tickets");
  });

  it("parses status and stop without a folder", () => {
    assert.equal(parseCommandArgs("status").subcommand, "status");
    assert.equal(parseCommandArgs("stop").subcommand, "stop");
  });

  it("rejects missing, unknown, or incomplete arguments", () => {
    assert.throws(
      () => parseCommandArgs(""),
      (error: unknown) => error instanceof TicketRunnerError && /Usage:/.test(error.message),
    );
    assert.throws(
      () => parseCommandArgs("nope issues"),
      (error: unknown) =>
        error instanceof TicketRunnerError && /Unknown subcommand "nope"/.test(error.message),
    );
    assert.throws(
      () => parseCommandArgs("list"),
      (error: unknown) =>
        error instanceof TicketRunnerError && /list <ticket-folder>/.test(error.message),
    );
    assert.throws(
      () => parseCommandArgs("status extra"),
      (error: unknown) =>
        error instanceof TicketRunnerError && /Usage: \/ticket-runner status/.test(error.message),
    );
    assert.throws(
      () => parseCommandArgs('list "unterminated'),
      (error: unknown) =>
        error instanceof TicketRunnerError && /Unterminated quote/.test(error.message),
    );
  });
});

describe("/ticket-runner list", () => {
  it("registers the ticket-runner command", () => {
    const tree = createTempTree();
    const fake = createFakePi(tree.path("agent"));

    assert.equal(fake.registered.name, "ticket-runner");
    assert.ok(fake.registered.description);
  });

  it("renders the inventory without modifying ticket files", async () => {
    const tree = createTempTree();
    const first = tree.write(
      "issues/01-first.md",
      ticketMarkdown({ title: "# 01: First", status: "Status: resolved" }),
    );
    const second = tree.write(
      "issues/02-second.md",
      ticketMarkdown({ title: "# 02: Second", status: "Status: ready-for-agent" }),
    );
    const fake = createFakePi(tree.path("agent"));

    await fake.run("list issues", tree.root);

    assert.equal(fake.notifications.length, 0);
    assert.equal(fake.sent.length, 1);

    const { message, options } = fake.sent[0] ?? {};
    assert.ok(message);
    assert.equal(message.customType, "ticket-runner");
    assert.equal(message.display, true);
    assert.deepEqual(options, { triggerTurn: false });

    const content = message.content;
    assert.equal(typeof content, "string");
    assert.match(content as string, /🎫 Tickets: issues/);
    assert.match(content as string, /02-second\s+ready-for-agent\s+NEXT ▶/);
    assert.match(content as string, /Executable: 1 of 2/);
    assert.match(content as string, /Next: 02 Second/);

    assert.equal(readFileSync(first, "utf8"), ticketMarkdown({ title: "# 01: First", status: "Status: resolved" }));
    assert.equal(
      readFileSync(second, "utf8"),
      ticketMarkdown({ title: "# 02: Second", status: "Status: ready-for-agent" }),
    );
  });

  it("applies project configuration", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown({ status: "Status: queued" }));
    tree.write(
      ".pi/ticket-runner.json",
      JSON.stringify({ runnableStatuses: ["queued"] }),
    );
    const fake = createFakePi(tree.path("agent"));

    await fake.run("list issues", tree.root);

    const content = fake.sent[0]?.message.content as string;
    assert.match(content, /NEXT ▶/);
    assert.match(content, /Executable: 1 of 1/);
  });

  it("warns about unknown configuration keys", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown());
    tree.write(".pi/ticket-runner.json", JSON.stringify({ colour: "blue" }));
    const fake = createFakePi(tree.path("agent"));

    await fake.run("list issues", tree.root);

    assert.equal(fake.notifications.length, 1);
    assert.equal(fake.notifications[0]?.level, "warning");
    assert.match(fake.notifications[0]?.message ?? "", /Unknown configuration key "colour"/);
    assert.equal(fake.sent.length, 1);
  });

  it("reports malformed tickets without displaying an inventory", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown());
    tree.write("issues/02-broken.md", "# 02: Broken\n\nNo status here.\n");
    const fake = createFakePi(tree.path("agent"));

    await fake.run("list issues", tree.root);

    assert.equal(fake.sent.length, 0);
    assert.equal(fake.notifications.length, 1);
    assert.equal(fake.notifications[0]?.level, "error");
    assert.match(fake.notifications[0]?.message ?? "", /02-broken\.md has no Status: line/);
  });

  it("reports a missing ticket folder", async () => {
    const tree = createTempTree();
    const fake = createFakePi(tree.path("agent"));

    await fake.run("list missing", tree.root);

    assert.equal(fake.sent.length, 0);
    assert.match(fake.notifications[0]?.message ?? "", /Ticket folder not found: missing/);
    assert.equal(fake.notifications[0]?.level, "error");
  });

  it("reports invalid configuration", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown());
    tree.write(".pi/ticket-runner.json", JSON.stringify({ maxTurnsPerTicket: -1 }));
    const fake = createFakePi(tree.path("agent"));

    await fake.run("list issues", tree.root);

    assert.equal(fake.sent.length, 0);
    assert.match(fake.notifications[0]?.message ?? "", /Invalid configuration/);
  });
});

describe("/ticket-runner other subcommands", () => {
  it("reports subcommands that are not implemented yet", async () => {
    const tree = createTempTree();
    const fake = createFakePi(tree.path("agent"));

    await fake.run("start issues", tree.root);
    await fake.run("status", tree.root);
    await fake.run("stop", tree.root);

    assert.equal(fake.sent.length, 0);
    assert.equal(fake.notifications.length, 3);
    for (const notification of fake.notifications) {
      assert.equal(notification.level, "warning");
      assert.match(notification.message, /not implemented yet/);
    }
  });

  it("reports invalid invocations as errors", async () => {
    const tree = createTempTree();
    const fake = createFakePi(tree.path("agent"));

    await fake.run("bogus", tree.root);

    assert.equal(fake.notifications[0]?.level, "error");
    assert.match(fake.notifications[0]?.message ?? "", /Unknown subcommand "bogus"/);
  });
});
