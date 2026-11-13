import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type {
  ContextUsage,
  CustomEntry,
  EntryRenderer,
  ExtensionAPI,
  ExtensionCommandContext,
  SlashCommandInfo,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import { parseCommandArgs, registerTicketRunnerCommand } from "../src/command.ts";
import { TicketRunnerError } from "../src/errors.ts";
import { FRAME_ENTRY_TYPE, type SessionFrameSummary } from "../src/session-frame.ts";
import type {
  OpenRepositoryGuardOptions,
  RepositoryGuard,
  RepositoryGuardFactory,
} from "../src/repository.ts";
import type {
  ChildEvent,
  CreateTicketSessionOptions,
  TicketSession,
} from "../src/sessions.ts";
import {
  createTempTree,
  textDelta,
  ticketMarkdown,
  toolStart,
  toolEnd,
  turnEnd,
  waitFor,
  type TempTree,
} from "./helpers.ts";

interface SentMessage {
  readonly message: Record<string, unknown>;
  readonly options: unknown;
}

interface UiCall {
  readonly method: "setStatus";
  readonly key: string;
  readonly value: unknown;
}

interface FakePi {
  readonly sent: SentMessage[];
  readonly notifications: Array<{ message: string; level: string }>;
  readonly uiCalls: UiCall[];
  readonly registered: { readonly name?: string; readonly description?: string | undefined };
  readonly entries: CustomEntry[];
  run(args: string, cwd: string): Promise<void>;
  /** Invoke the handler only, leaving a `start` run detached and in flight. */
  runCommand(args: string, cwd: string): Promise<void>;
  /** Await every detached `start` run started so far. */
  settle(): Promise<void>;
  input(text: string, source?: "interactive" | "rpc" | "extension"): Promise<unknown>;
  shutdown(): void;
  startSession(cwd?: string): Promise<void>;
  renderEntry(entry: CustomEntry, expanded?: boolean): Component | undefined;
}

interface FakePiOptions {
  readonly commands?: readonly SlashCommandInfo[];
  readonly createSession?: (options: CreateTicketSessionOptions) => Promise<TicketSession>;
  readonly extensionPath?: string;
  readonly openGuard?: RepositoryGuardFactory;
  readonly initialEntries?: readonly CustomEntry[];
}

function fakeRepositoryGuard(): RepositoryGuard {
  return {
    git: { root: "/repo", branch: "main", head: "abc123" },
    checkUnchanged: () => undefined,
    acceptHead: () => undefined,
    release: () => {},
  };
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

const identityTheme = {
  fg: (_colour: string, text: string) => text,
} as unknown as Theme;

function customEntry(id: string, customType: string, data: unknown): CustomEntry {
  return {
    type: "custom",
    customType,
    id,
    parentId: null,
    timestamp: "2025-01-01T00:00:00.000Z",
    data,
  };
}

function createFakePi(agentDir: string, options: FakePiOptions = {}): FakePi {
  const sent: SentMessage[] = [];
  const registered: { name?: string; description?: string | undefined } = {};
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const shutdownHandlers: Array<() => void> = [];
  const sessionStartHandlers: Array<
    (event: unknown, ctx: ExtensionCommandContext) => unknown
  > = [];
  const inputHandlers: Array<
    (event: { type: "input"; text: string; source: string }, ctx: ExtensionCommandContext) => unknown
  > = [];

  const notifications: Array<{ message: string; level: string }> = [];
  const uiCalls: UiCall[] = [];
  const entries: CustomEntry[] = [...(options.initialEntries ?? [])];
  const detachedRuns: Promise<void>[] = [];
  const entryRenderers = new Map<string, EntryRenderer>();
  let entryCounter = options.initialEntries?.length ?? 0;

  const createContext = (cwd: string): ExtensionCommandContext => ({
    cwd,
    model: { provider: "test", id: "gpt-5" },
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      setStatus: (key: string, value: unknown) => {
        uiCalls.push({ method: "setStatus", key, value });
      },
    },
    sessionManager: {
      getEntries: () => [...entries],
    },
  }) as unknown as ExtensionCommandContext;

  const pi = {
    registerCommand: (name: string, options: { description?: string; handler: typeof handler }) => {
      registered.name = name;
      registered.description = options.description;
      handler = options.handler;
    },
    registerEntryRenderer: (customType: string, renderer: EntryRenderer) => {
      entryRenderers.set(customType, renderer);
    },
    appendEntry: (customType: string, data?: unknown) => {
      entryCounter += 1;
      entries.push(customEntry(`entry-${entryCounter}`, customType, data));
    },
    sendMessage: (message: Record<string, unknown>, options: unknown) => {
      sent.push({ message, options });
    },
    getCommands: () => [...(options.commands ?? [skillCommand()])],
    on: (event: string, listener: (...args: never[]) => void) => {
      if (event === "session_shutdown") shutdownHandlers.push(listener as () => void);
      if (event === "session_start") {
        sessionStartHandlers.push(
          listener as (event: unknown, ctx: ExtensionCommandContext) => unknown,
        );
      }
      if (event === "input") {
        inputHandlers.push(
          listener as (event: { type: "input"; text: string; source: string }, ctx: ExtensionCommandContext) => unknown,
        );
      }
      return () => {};
    },
  } as unknown as ExtensionAPI;

  registerTicketRunnerCommand(pi, {
    agentDir,
    extensionPath: options.extensionPath ?? "/repo/index.ts",
    ...(options.createSession ? { createSession: options.createSession } : {}),
    openGuard: options.openGuard ?? fakeRepositoryGuard,
    observeRun: (run) => {
      detachedRuns.push(run);
    },
  });

  const runCommand = async (args: string, cwd: string): Promise<void> => {
    assert.ok(handler, "command handler was not registered");
    await handler(args, createContext(cwd));
  };
  const settle = async (): Promise<void> => {
    await Promise.all(detachedRuns);
  };

  return {
    sent,
    notifications,
    uiCalls,
    registered,
    entries,
    shutdown() {
      for (const listener of shutdownHandlers) listener();
    },
    async startSession(cwd = "/project") {
      const ctx = createContext(cwd);
      for (const listener of sessionStartHandlers) await listener({ type: "session_start" }, ctx);
    },
    async input(text, source = "interactive") {
      const ctx = createContext("/project");
      let result: unknown;
      for (const listener of inputHandlers) {
        result = (await listener({ type: "input", text, source }, ctx)) ?? result;
      }
      return result;
    },
    runCommand,
    settle,
    async run(args, cwd) {
      // Capture the runs this invocation starts, then wait for them so
      // assertions can observe the run's terminal effects. The handler itself
      // still returns before the run settles, as it does in Pi.
      const before = detachedRuns.length;
      await runCommand(args, cwd);
      await Promise.all(detachedRuns.slice(before));
    },
    renderEntry(entry, expanded = false) {
      const renderer = entryRenderers.get(entry.customType);
      if (!renderer) return undefined;
      return renderer(entry, { expanded } as never, identityTheme);
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
  aborted: number;
  unsubscribed: number;
  lastText: string | undefined;
  contextUsage: ContextUsage | undefined;
  emit(event: ChildEvent): void;
}

function fakeSession(
  responses: ReadonlyArray<string | Error>,
  onPrompt?: (prompt: string, index: number, session: FakeSession) => void | Promise<void>,
): {
  readonly created: FakeSession[];
  readonly create: (options: CreateTicketSessionOptions) => Promise<TicketSession>;
} {
  const created: FakeSession[] = [];
  return {
    created,
    async create(sessionOptions) {
      const listeners = new Set<(event: ChildEvent) => void>();
      const session: FakeSession = {
        sessionFile: `/sessions/${created.length + 1}.jsonl`,
        prompts: [],
        sessionOptions: [sessionOptions],
        disposed: 0,
        aborted: 0,
        unsubscribed: 0,
        async prompt(text: string) {
          const index = session.prompts.length;
          session.prompts.push(text);
          await onPrompt?.(text, index, session);
          const response = responses[index];
          if (response instanceof Error) throw response;
          session.lastText = response ?? session.lastText;
        },
        async abort() {
          session.aborted += 1;
        },
        subscribe(listener: (event: ChildEvent) => void) {
          listeners.add(listener);
          return () => {
            session.unsubscribed += 1;
            listeners.delete(listener);
          };
        },
        emit(event: ChildEvent) {
          for (const listener of listeners) listener(event);
        },
        getLastAssistantText() {
          return session.lastText;
        },
        getTranscript() {
          return [];
        },
        getContextUsage() {
          return session.contextUsage;
        },
        dispose() {
          session.disposed += 1;
        },
        lastText: undefined,
        contextUsage: undefined,
      };
      created.push(session);
      return session;
    },
  };
}

function resolveTicket(tree: TempTree, filename: string): void {
  tree.write(`issues/${filename}`, ticketMarkdown({ status: "Status: resolved" }));
}

function frameSummaries(pi: FakePi): SessionFrameSummary[] {
  return pi.entries
    .filter((entry) => entry.customType === FRAME_ENTRY_TYPE)
    .map((entry) => entry.data as SessionFrameSummary);
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
    assert.equal(pi.entries.length, 0);
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
    assert.equal(pi.entries.length, 0);
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
    assert.equal(pi.entries.length, 0);
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

  it("passes the folder and --allow-dirty policy to preflight", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown());
    const fake = fakeSession(
      ["implemented", "STATUS: COMPLETE\nREASON: all checks pass"],
      (_prompt, index) => {
        if (index === 1) resolveTicket(tree, "01-first.md");
      },
    );
    const observed: OpenRepositoryGuardOptions[] = [];
    const pi = createFakePi(tree.path("agent"), {
      createSession: fake.create,
      openGuard: (guardOptions) => {
        observed.push(guardOptions);
        return fakeRepositoryGuard();
      },
    });

    await pi.run("start issues --allow-dirty", tree.root);

    assert.deepEqual(observed, [
      {
        cwd: tree.root,
        ticketFolder: "issues",
        ticketFolderPath: tree.path("issues"),
        allowDirty: true,
        staleLockHours: 12,
      },
    ]);
  });

  it("reports a preflight refusal without creating a session", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown());
    const fake = fakeSession(["unused"]);
    const pi = createFakePi(tree.path("agent"), {
      createSession: fake.create,
      openGuard: () => {
        throw new TicketRunnerError("Refusing to start: src/app.ts is dirty");
      },
    });

    await pi.run("start issues", tree.root);

    assert.equal(fake.created.length, 0);
    assert.equal(pi.entries.length, 0);
    assert.equal(pi.sent.length, 0);
    assert.equal(pi.notifications[0]?.level, "error");
    assert.match(pi.notifications[0]?.message ?? "", /src\/app\.ts is dirty/);
  });

  it("releases the repository lock on extension shutdown", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown());
    let releases = 0;
    let releasesDuringPrompt = 0;
    let pi: FakePi;
    const guard: RepositoryGuard = {
      git: { root: tree.root, branch: "main", head: "abc123" },
      checkUnchanged: () => undefined,
      acceptHead: () => undefined,
      release: () => {
        releases += 1;
      },
    };
    const fake = fakeSession(
      ["implemented", "STATUS: COMPLETE\nREASON: all checks pass"],
      (_prompt, index) => {
        if (index === 0) {
          pi.shutdown();
          releasesDuringPrompt = releases;
          return;
        }
        resolveTicket(tree, "01-first.md");
      },
    );
    pi = createFakePi(tree.path("agent"), {
      createSession: fake.create,
      openGuard: () => guard,
    });

    await pi.run("start issues", tree.root);

    assert.equal(releasesDuringPrompt, 1);
    assert.ok(releases >= 1);
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

describe("/ticket-runner stop", () => {
  it("stops the active run, aborts the child, releases the lock, and reports the interruption", async () => {
    const tree = createTempTree();
    const first = tree.write(
      "issues/01-first.md",
      ticketMarkdown({ title: "# 01: First" }),
    );
    tree.write("issues/02-second.md", ticketMarkdown({ title: "# 02: Second" }));
    let pi: FakePi;
    let releases = 0;
    const fake = fakeSession(
      ["implemented", "STATUS: COMPLETE\nREASON: all checks pass"],
      async (_prompt, index) => {
        if (index === 0) await pi.run("stop", tree.root);
      },
    );
    pi = createFakePi(tree.path("agent"), {
      createSession: fake.create,
      openGuard: () => ({
        git: { root: tree.root, branch: "main", head: "abc123" },
        checkUnchanged: () => undefined,
        acceptHead: () => undefined,
        release: () => {
          releases += 1;
        },
      }),
    });

    await pi.run("start issues", tree.root);

    assert.equal(fake.created.length, 1);
    assert.equal(fake.created[0]?.prompts.length, 1, "the gate must not be sent");
    assert.equal(fake.created[0]?.aborted, 1);
    assert.equal(fake.created[0]?.disposed, 1);
    assert.equal(fake.created[0]?.unsubscribed, 1);
    assert.equal(releases, 1);
    assert.equal(readFileSync(first, "utf8"), ticketMarkdown({ title: "# 01: First" }));
    const statuses = pi.uiCalls.map((call) => call.value);
    assert.ok(statuses.includes("🎫 2 left · 01-first"));
    assert.equal(statuses.at(-1), "🎫 stopped · 2 left");
    assert.ok(
      pi.entries.every((entry) => entry.customType === FRAME_ENTRY_TYPE),
      "the editor widget must not be installed",
    );
    const frames = frameSummaries(pi);
    assert.equal(frames.length, 2);
    assert.equal(frames[0]?.status, "running");
    assert.equal(frames[1]?.status, "stopped");

    const content = pi.sent[pi.sent.length - 1]?.message.content as string;
    assert.match(content, /^⏹ Execution interrupted at 01 First · 2 tickets left\./);
    assert.match(content, /Remaining tickets not started\./);
    assert.match(content, /Ran: none\./);
    assert.doesNotMatch(content, /Ran: 01 First/);
  });

  it("reports that no run is active when idle", async () => {
    const tree = createTempTree();
    const fake = createFakePi(tree.path("agent"));

    await fake.run("stop", tree.root);

    assert.equal(fake.sent.length, 0);
    assert.equal(fake.notifications.length, 1);
    assert.equal(fake.notifications[0]?.level, "warning");
    assert.match(fake.notifications[0]?.message ?? "", /No ticket run is active/);
  });

  it("leaves the interrupted ticket runnable for the next start", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown({ title: "# 01: First" }));
    let stopping: FakePi;
    const firstRun = fakeSession(
      ["implemented", "STATUS: COMPLETE\nREASON: all checks pass"],
      async (_prompt, index) => {
        if (index === 0) await stopping.run("stop", tree.root);
      },
    );
    stopping = createFakePi(tree.path("agent"), { createSession: firstRun.create });

    await stopping.run("start issues", tree.root);
    assert.match(
      stopping.sent[stopping.sent.length - 1]?.message.content as string,
      /Execution interrupted at 01 First/,
    );

    const secondRun = fakeSession(
      ["implemented", "STATUS: COMPLETE\nREASON: all checks pass"],
      (_prompt, index) => {
        if (index === 1) resolveTicket(tree, "01-first.md");
      },
    );
    const restarted = createFakePi(tree.path("agent"), { createSession: secondRun.create });

    await restarted.run("start issues", tree.root);

    assert.equal(secondRun.created.length, 1);
    assert.equal(secondRun.created[0]?.prompts[0], "/skill:implement issues/01-first.md");
    const summary = restarted.sent[restarted.sent.length - 1]?.message.content as string;
    assert.match(summary, /✅ Run finished/);
    assert.match(summary, /Ran: 01 First\./);
  });
});

describe("/ticket-runner start responsiveness", () => {
  it("returns before the run settles so a following stop is processed", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown({ title: "# 01: First" }));
    let releasePrompt: (() => void) | undefined;
    const fake = fakeSession(["unused"], async (_prompt, index) => {
      if (index !== 0) return;
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
    });
    const pi = createFakePi(tree.path("agent"), { createSession: fake.create });

    // Pi's input loop awaits the command handler before reading the next line.
    // The handler must return while the child is still running.
    await pi.runCommand("start issues", tree.root);
    await waitFor(() => fake.created[0]?.prompts.length === 1, "the child prompt to start");
    assert.equal(pi.sent.length, 0, "the run is still in flight after the handler returned");

    // This is the command Pi only dispatches once the start handler settles.
    await pi.run("stop", tree.root);
    assert.equal(fake.created[0]?.aborted, 1, "stop must abort the live child");
    assert.ok(releasePrompt, "the child prompt is still pending");
    releasePrompt();

    await pi.settle();

    assert.equal(fake.created[0]?.disposed, 1);
    const content = pi.sent[pi.sent.length - 1]?.message.content as string;
    assert.match(content, /^⏹ Execution interrupted at 01 First/);
  });

  it("refuses a second start while a run is active", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown({ title: "# 01: First" }));
    let releasePrompt: (() => void) | undefined;
    const fake = fakeSession(["unused"], async (_prompt, index) => {
      if (index !== 0) return;
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
    });
    const pi = createFakePi(tree.path("agent"), { createSession: fake.create });

    await pi.runCommand("start issues", tree.root);
    await waitFor(() => fake.created[0]?.prompts.length === 1, "the first child prompt");

    await pi.run("start issues", tree.root);

    assert.equal(fake.created.length, 1, "a second session must not be created");
    const warning = pi.notifications.at(-1);
    assert.equal(warning?.level, "warning");
    assert.match(warning?.message ?? "", /A ticket run is already active/);
    assert.match(warning?.message ?? "", /\/ticket-runner stop/);

    await pi.run("stop", tree.root);
    releasePrompt?.();
    await pi.settle();
  });
});

describe("main-session input while a run is active", () => {
  it("blocks ordinary prompts but passes runner-injected messages through", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown({ title: "# 01: First" }));
    let pi: FakePi;
    const results: unknown[] = [];
    const fake = fakeSession(
      ["implemented", "STATUS: COMPLETE\nREASON: all checks pass"],
      async (_prompt, index) => {
        if (index !== 0) {
          resolveTicket(tree, "01-first.md");
          return;
        }
        results.push(await pi.input("please edit something"));
        results.push(await pi.input("runner-injected", "extension"));
      },
    );
    pi = createFakePi(tree.path("agent"), { createSession: fake.create });

    await pi.run("start issues", tree.root);

    assert.deepEqual(results, [{ action: "handled" }, { action: "continue" }]);
    const warning = pi.notifications.find((entry) => entry.level === "warning");
    assert.ok(warning);
    assert.match(warning.message, /A ticket run is active \(01 First\)\./);
    assert.match(
      warning.message,
      /Run \/ticket-runner stop before prompting the main session\./,
    );

    assert.deepEqual(await pi.input("the run is over now"), { action: "continue" });
  });
});

describe("session frames and footer", () => {
  it("appends one creation and one settlement summary per child session", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown({ title: "# 01: First" }));
    tree.write("issues/02-second.md", ticketMarkdown({ title: "# 02: Second" }));
    const files = ["01-first.md", "02-second.md"];
    let pi: FakePi;
    const fake = fakeSession(
      [
        "implemented",
        "STATUS: COMPLETE\nREASON: all checks pass",
        "implemented",
        "STATUS: COMPLETE\nREASON: all checks pass",
      ],
      (prompt, index, session) => {
        if (index === 0) {
          session.emit(textDelta("Writing src/repository.ts…"));
          session.emit(toolStart("edit"));
          session.emit(turnEnd());
          return;
        }
        session.emit(textDelta("STATUS: COMPLETE\nREASON: all checks pass"));
        const filename = files[fake.created.indexOf(session)];
        assert.ok(filename);
        resolveTicket(tree, filename);
      },
    );
    pi = createFakePi(tree.path("agent"), { createSession: fake.create });

    await pi.run("start issues", tree.root);

    const frames = frameSummaries(pi);
    assert.equal(frames.length, 4);
    assert.deepEqual(
      frames.map((frame) => [frame.ticketId, frame.status]),
      [
        ["01", "running"],
        ["01", "done"],
        ["02", "running"],
        ["02", "done"],
      ],
    );
    for (const frame of frames) {
      assert.equal(frame.childSessionFile !== undefined, true);
      assert.equal(frame.model !== undefined, true);
      assert.equal(frame.ticketTitle.length > 0, true);
      assert.equal("text" in frame, false);
      assert.equal("transcript" in frame, false);
    }
    assert.equal(frames[1]?.turns, 1);
    assert.equal(frames[1]?.tools, 1);
    assert.equal(frames[1]?.errors, 0);

    const statuses = pi.uiCalls.map((call) => call.value);
    assert.ok(statuses.includes("🎫 2 left · 01-first"));
    assert.ok(statuses.includes("🎫 1 left · 02-second"));
    assert.equal(statuses.at(-1), "🎫 done · 0 left");
    assert.ok(pi.uiCalls.every((call) => call.method === "setStatus"));
  });

  it("repaints live frames through the footer status without new session entries", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown({ title: "# 01: First" }));
    tree.write(".pi/ticket-runner.json", JSON.stringify({ liveFrameUpdateIntervalMs: 0 }));
    const fake = fakeSession(
      ["implemented", "STATUS: COMPLETE\nREASON: all checks pass"],
      (prompt, index, session) => {
        if (index === 0) {
          session.emit(textDelta("writing code"));
          session.emit(toolStart("edit"));
          session.emit(turnEnd());
          return;
        }
        resolveTicket(tree, "01-first.md");
      },
    );
    const pi = createFakePi(tree.path("agent"), { createSession: fake.create });

    await pi.run("start issues", tree.root);

    const renderedStatuses = pi.uiCalls
      .filter((call) => call.method === "setStatus")
      .map((call) => call.value);
    assert.ok(
      renderedStatuses.filter((value) => value === "🎫 1 left · 01-first").length > 1,
      "live child events must repaint the frame through the footer status",
    );
    assert.deepEqual(
      frameSummaries(pi).map((frame) => frame.status),
      ["running", "done"],
      "live repaints never append a session entry",
    );
  });

  it("renders the live creation entry, then the settlement entry after a reload", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown({ title: "# 01: First" }));
    const fake = fakeSession(
      ["implemented", "STATUS: COMPLETE\nREASON: all checks pass"],
      (_prompt, index) => {
        if (index === 1) resolveTicket(tree, "01-first.md");
      },
    );
    const pi = createFakePi(tree.path("agent"), { createSession: fake.create });

    await pi.run("start issues", tree.root);

    const [creation, settlement] = pi.entries;
    assert.ok(creation);
    assert.ok(settlement);
    assert.ok(pi.renderEntry(creation));
    assert.equal(pi.renderEntry(settlement), undefined);

    const reloaded = createFakePi(tree.path("agent"), {
      initialEntries: [...pi.entries],
    });
    await reloaded.startSession(tree.root);

    assert.equal(reloaded.renderEntry(creation), undefined);
    const rendered = reloaded.renderEntry(settlement);
    assert.ok(rendered);
    const lines = rendered.render(120);
    assert.ok(lines.some((line) => /01 First · Done/.test(line)));
  });

  it("persists context usage in the settlement summary and renders it after reload", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown({ title: "# 01: First" }));
    const usage: ContextUsage = { tokens: 84_200, contextWindow: 200_000, percent: 42.1 };
    const fake = fakeSession(
      ["implemented", "STATUS: COMPLETE\nREASON: all checks pass"],
      (_prompt, index, session) => {
        if (index !== 0) {
          resolveTicket(tree, "01-first.md");
          return;
        }
        session.contextUsage = usage;
        session.emit(toolStart("edit"));
        session.emit(toolEnd("edit"));
        session.emit(turnEnd());
      },
    );
    const pi = createFakePi(tree.path("agent"), { createSession: fake.create });

    await pi.run("start issues", tree.root);

    const frames = frameSummaries(pi);
    assert.equal(frames[0]?.contextUsage, undefined, "live samples are not persisted");
    assert.deepEqual(frames[1]?.contextUsage, { percent: 42.1, contextWindow: 200_000 });
    assert.doesNotMatch(JSON.stringify(frames), /tokens/);

    const [creation, settlement] = pi.entries;
    assert.ok(creation);
    assert.ok(settlement);
    const reloaded = createFakePi(tree.path("agent"), {
      initialEntries: [...pi.entries],
    });
    await reloaded.startSession(tree.root);

    assert.equal(reloaded.renderEntry(creation), undefined);
    const rendered = reloaded.renderEntry(settlement);
    assert.ok(rendered);
    const meta = rendered.render(160).find((line) => line.includes("errors"));
    assert.match(meta ?? "", /0 errors • 42\.1%\/200k/);
  });

  it("settles the active frame as stopped before shutdown and clears the footer", async () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown({ title: "# 01: First" }));
    let pi: FakePi;
    let callsAtShutdown: UiCall[] = [];
    let entriesAtShutdown: CustomEntry[] = [];
    const fake = fakeSession(
      ["implemented", "STATUS: COMPLETE\nREASON: all checks pass"],
      (_prompt, index) => {
        if (index !== 0) {
          resolveTicket(tree, "01-first.md");
          return;
        }
        pi.shutdown();
        callsAtShutdown = [...pi.uiCalls];
        entriesAtShutdown = [...pi.entries];
      },
    );
    pi = createFakePi(tree.path("agent"), { createSession: fake.create });

    await pi.run("start issues", tree.root);

    assert.deepEqual(callsAtShutdown.slice(-1), [
      { method: "setStatus", key: "ticket-runner", value: undefined },
    ]);
    const framesAtShutdown = entriesAtShutdown
      .filter((entry) => entry.customType === FRAME_ENTRY_TYPE)
      .map((entry) => entry.data as SessionFrameSummary);
    assert.deepEqual(
      framesAtShutdown.map((frame) => frame.status),
      ["running", "stopped"],
    );
    assert.equal(pi.uiCalls.at(-1)?.value, undefined);
  });

  it("creates no frame when nothing runs or a preflight refusal stops the run", async () => {
    const emptyTree = createTempTree();
    emptyTree.write("issues/01-first.md", ticketMarkdown({ status: "Status: resolved" }));
    const empty = createFakePi(emptyTree.path("agent"));
    await empty.run("start issues", emptyTree.root);
    assert.equal(empty.entries.length, 0);

    const dirtyTree = createTempTree();
    dirtyTree.write("issues/01-first.md", ticketMarkdown());
    const refused = createFakePi(dirtyTree.path("agent"), {
      openGuard: () => {
        throw new TicketRunnerError("Refusing to start: src/app.ts is dirty");
      },
    });
    await refused.run("start issues", dirtyTree.root);
    assert.equal(refused.entries.length, 0);
  });
});

describe("/ticket-runner other subcommands", () => {
  it("reports invalid invocations as errors", async () => {
    const tree = createTempTree();
    const fake = createFakePi(tree.path("agent"));

    await fake.run("bogus", tree.root);

    assert.equal(fake.notifications[0]?.level, "error");
    assert.match(fake.notifications[0]?.message ?? "", /Unknown subcommand "bogus"/);
  });
});
