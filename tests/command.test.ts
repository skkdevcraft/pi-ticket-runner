import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";

import { parseCommandArgs, registerTicketRunnerCommand } from "../src/command.ts";
import { TicketRunnerError } from "../src/errors.ts";
import type {
  ChildEvent,
  CreateTicketSessionOptions,
  TicketSession,
} from "../src/sessions.ts";
import { createTempTree, ticketMarkdown, type TempTree } from "./helpers.ts";

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

interface FakePiOptions {
  readonly commands?: readonly SlashCommandInfo[];
  readonly createSession?: (options: CreateTicketSessionOptions) => Promise<TicketSession>;
  readonly extensionPath?: string;
}

function skillCommand(): SlashCommandInfo {
  return {
    name: "skill:implement",
    description: "Implement a ticket",
    source: "skill",
    sourceInfo: {
      path: "/agent/skills/implement/SKILL.md",
      source: "local",
      scope: "user",
      origin: "top-level",
    },
  };
}

function createFakePi(agentDir: string, options: FakePiOptions = {}): FakePi {
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
    getCommands: () => [...(options.commands ?? [skillCommand()])],
  } as unknown as ExtensionAPI;

  const notifications: Array<{ message: string; level: string }> = [];

  registerTicketRunnerCommand(pi, {
    agentDir,
    extensionPath: options.extensionPath ?? "/repo/index.ts",
    ...(options.createSession ? { createSession: options.createSession } : {}),
  });

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

interface FakeSession extends TicketSession {
  readonly prompts: string[];
  readonly sessionOptions: CreateTicketSessionOptions[];
  disposed: number;
  lastText: string | undefined;
}

function fakeSession(
  responses: ReadonlyArray<string | Error>,
  onPrompt?: (prompt: string, index: number) => void,
): {
  readonly created: FakeSession[];
  readonly create: (options: CreateTicketSessionOptions) => Promise<TicketSession>;
} {
  const created: FakeSession[] = [];
  return {
    created,
    async create(sessionOptions) {
      const session: FakeSession = {
        sessionFile: `/sessions/${created.length + 1}.jsonl`,
        prompts: [],
        sessionOptions: [sessionOptions],
        disposed: 0,
        async prompt(text: string) {
          const index = session.prompts.length;
          session.prompts.push(text);
          onPrompt?.(text, index);
          const response = responses[index];
          if (response instanceof Error) throw response;
          session.lastText = response ?? session.lastText;
        },
        async abort() {},
        subscribe(_listener: (event: ChildEvent) => void) {
          return () => {};
        },
        getLastAssistantText() {
          return session.lastText;
        },
        dispose() {
          session.disposed += 1;
        },
        lastText: undefined,
      };
      created.push(session);
      return session;
    },
  };
}

function resolveTicket(tree: TempTree, filename: string): void {
  tree.write(`issues/${filename}`, ticketMarkdown({ status: "Status: resolved" }));
}

describe("/ticket-runner start", () => {
  it("reports nothing to run without creating a session", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown({ status: "Status: resolved" }));
    tree.write("issues/02-second.md", ticketMarkdown({ status: "Status: ready-for-human" }));
    const fake = fakeSession(["unused"]);
    const pi = createFakePi(tree.path("agent"), { createSession: fake.create });

    await pi.run("start issues", tree.root);

    assert.equal(fake.created.length, 0);
    assert.equal(pi.sent.length, 1);
    assert.match(
      pi.sent[0]?.message.content as string,
      /✅ Nothing to run — no ticket in issues is ready-for-agent\./,
    );
  });

  it("stops before creating a session when skill:implement is missing", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown());
    const fake = fakeSession(["unused"]);
    const pi = createFakePi(tree.path("agent"), {
      commands: [],
      createSession: fake.create,
    });

    await pi.run("start issues", tree.root);

    assert.equal(fake.created.length, 0);
    assert.equal(pi.sent.length, 0);
    assert.equal(pi.notifications[0]?.level, "error");
    assert.match(pi.notifications[0]?.message ?? "", /skill:implement/);
  });

  it("runs the first runnable ticket and reports the persisted status", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown({ title: "# 01: First", status: "Status: resolved" }));
    tree.write("issues/02-second.md", ticketMarkdown({ title: "# 02: Second" }));
    const fake = fakeSession(
      ["implemented", "STATUS: COMPLETE\nREASON: all checks pass"],
      (prompt, index) => {
        if (index === 1) resolveTicket(tree, "02-second.md");
      },
    );
    const pi = createFakePi(tree.path("agent"), { createSession: fake.create });

    await pi.run("start issues", tree.root);

    assert.equal(fake.created.length, 1);
    assert.deepEqual(fake.created[0]?.prompts.slice(0, 1), [
      "/skill:implement issues/02-second.md",
    ]);
    assert.match(fake.created[0]?.prompts[1] ?? "", /Review your implementation/);
    assert.equal(fake.created[0]?.disposed, 1);
    assert.equal(pi.notifications.length, 0);
    assert.equal(pi.sent.length, 2);
    assert.equal(pi.sent[0]?.message.customType, "ticket-runner");
    assert.equal(pi.sent[0]?.message.display, true);
    assert.deepEqual(pi.sent[0]?.options, { triggerTurn: false });
    assert.equal(
      pi.sent[0]?.message.content,
      "✅ 02 Second — status now `resolved`.\nNext: none (0 tickets left).",
    );
    const summary = pi.sent[1]?.message.content as string;
    assert.match(summary, /✅ Run finished · 0 tickets ready-for-agent\./);
    assert.match(summary, /Ran: 02 Second\./);
    assert.match(summary, /Skipped: 01 First \(resolved\)\./);
  });

  it("runs every runnable ticket in numeric order, skipping the rest", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown({ title: "# 01: First", status: "Status: resolved" }));
    tree.write("issues/02-second.md", ticketMarkdown({ title: "# 02: Second", status: "Status: resolved" }));
    tree.write("issues/03-third.md", ticketMarkdown({ title: "# 03: Third" }));
    tree.write("issues/04-fourth.md", ticketMarkdown({ title: "# 04: Fourth", status: "Status: ready-for-human" }));
    tree.write("issues/05-fifth.md", ticketMarkdown({ title: "# 05: Fifth" }));
    const resolvedBySession = ["03-third.md", "05-fifth.md"];
    const fake = fakeSession(
      ["implemented", "STATUS: COMPLETE\nREASON: all checks pass"],
      (prompt, index) => {
        if (index !== 1) return;
        const sessionIndex = fake.created.findIndex(
          (session) => session.prompts[1] === prompt,
        );
        const filename = resolvedBySession[sessionIndex];
        assert.ok(filename);
        resolveTicket(tree, filename);
      },
    );
    const pi = createFakePi(tree.path("agent"), { createSession: fake.create });

    await pi.run("start issues", tree.root);

    assert.equal(fake.created.length, 2);
    assert.deepEqual(
      fake.created.map((session) => session.prompts[0]),
      ["/skill:implement issues/03-third.md", "/skill:implement issues/05-fifth.md"],
    );
    assert.equal(pi.sent.length, 3);
    assert.equal(
      pi.sent[0]?.message.content,
      "✅ 03 Third — status now `resolved`.\nNext: 05 Fifth (1 ticket left).",
    );
    const summary = pi.sent[2]?.message.content as string;
    assert.match(summary, /Ran: 03 Third, 05 Fifth\./);
    assert.match(
      summary,
      /Skipped: 01 First \(resolved\), 02 Second \(resolved\), 04 Fourth \(ready-for-human\)\./,
    );
  });

  it("validates ticket files before creating a session", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", "# 01: One\n\nNo status.\n");
    const fake = fakeSession(["unused"]);
    const pi = createFakePi(tree.path("agent"), { createSession: fake.create });

    await pi.run("start issues", tree.root);

    assert.equal(fake.created.length, 0);
    assert.equal(pi.sent.length, 0);
    assert.equal(pi.notifications[0]?.level, "error");
    assert.match(pi.notifications[0]?.message ?? "", /01-first\.md has no Status: line/);
  });

  it("stops when the gate reports INCOMPLETE", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown());
    const fake = fakeSession([
      "implemented",
      "STATUS: INCOMPLETE\nREASON: tests fail",
    ]);
    const pi = createFakePi(tree.path("agent"), { createSession: fake.create });

    await pi.run("start issues", tree.root);

    assert.equal(fake.created[0]?.disposed, 1);
    assert.match(pi.sent[0]?.message.content as string, /is incomplete/);
    assert.match(pi.sent[0]?.message.content as string, /tests fail/);
  });
});

describe("/ticket-runner status", () => {
  it("reports no active run before any folder was used", async () => {
    const tree = createTempTree();
    const fake = createFakePi(tree.path("agent"));

    await fake.run("status", tree.root);

    assert.equal(fake.sent.length, 1);
    assert.equal(fake.sent[0]?.message.content, "No run active.");
    assert.deepEqual(fake.sent[0]?.options, { triggerTurn: false });
  });

  it("re-reads the last-used folder and reports no active run", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown({ title: "# 01: First" }));
    tree.write("issues/02-second.md", ticketMarkdown({ title: "# 02: Second", status: "Status: resolved" }));
    const fake = createFakePi(tree.path("agent"));

    await fake.run("list issues", tree.root);
    await fake.run("status", tree.root);

    assert.equal(fake.sent.length, 2);
    const content = fake.sent[1]?.message.content as string;
    assert.match(content, /🎫 Tickets: issues/);
    assert.match(content, /01-first\s+ready-for-agent\s+NEXT ▶/);
    assert.match(content, /No run active\.$/);
  });

  it("shows the active run's folder, current ticket, remaining count, and session", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown({ title: "# 01: First" }));
    let pi: FakePi;
    const observed: string[] = [];
    const fake = fakeSession(
      ["implemented", "STATUS: COMPLETE\nREASON: all checks pass"],
      async (prompt, index) => {
        if (index === 0) {
          await pi.run("status", tree.root);
          observed.push(pi.sent[pi.sent.length - 1]?.message.content as string);
          return;
        }
        resolveTicket(tree, "01-first.md");
      },
    );
    pi = createFakePi(tree.path("agent"), { createSession: fake.create });

    await pi.run("start issues", tree.root);

    assert.equal(observed.length, 1);
    assert.deepEqual((observed[0] ?? "").split("\n"), [
      "🎫 Ticket runner active",
      "",
      "Folder: issues",
      "Position: 01 First",
      "Executable remaining: 1 of 1",
      "Session: /sessions/1.jsonl",
    ]);

    await pi.run("status", tree.root);
    const after = pi.sent[pi.sent.length - 1]?.message.content as string;
    assert.match(after, /No run active\.$/);
    assert.match(after, /01-first\s+resolved\s+skip/);
  });

  it("never creates a session or modifies ticket files", async () => {
    const tree = createTempTree();
    const path = tree.write("issues/01-first.md", ticketMarkdown({ title: "# 01: First" }));
    const before = readFileSync(path, "utf8");
    const fake = createFakePi(tree.path("agent"));

    await fake.run("list issues", tree.root);
    await fake.run("status", tree.root);

    assert.equal(readFileSync(path, "utf8"), before);
  });
});

describe("/ticket-runner other subcommands", () => {
  it("reports stop as not implemented yet", async () => {
    const tree = createTempTree();
    const fake = createFakePi(tree.path("agent"));

    await fake.run("stop", tree.root);

    assert.equal(fake.sent.length, 0);
    assert.equal(fake.notifications.length, 1);
    assert.equal(fake.notifications[0]?.level, "warning");
    assert.match(fake.notifications[0]?.message ?? "", /not implemented yet/);
  });

  it("reports invalid invocations as errors", async () => {
    const tree = createTempTree();
    const fake = createFakePi(tree.path("agent"));

    await fake.run("bogus", tree.root);

    assert.equal(fake.notifications[0]?.level, "error");
    assert.match(fake.notifications[0]?.message ?? "", /Unknown subcommand "bogus"/);
  });
});
