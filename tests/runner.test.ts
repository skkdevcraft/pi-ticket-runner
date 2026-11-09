import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { TicketRunnerError } from "../src/errors.ts";
import {
  hasImplementSkill,
  selectFirstRunnableTicket,
  startFirstRunnableTicket,
  type StartTicketOptions,
} from "../src/runner.ts";
import type {
  ChildEvent,
  CreateTicketSessionOptions,
  TicketSession,
} from "../src/sessions.ts";
import { loadTicketInventory, type Ticket, type TicketInventory } from "../src/tickets.ts";
import { createTempTree, ticketMarkdown } from "./helpers.ts";

function ticket(id: string, status: string, title = `Ticket ${id}`): Ticket {
  const slug = `ticket-${id}`;
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

function inventory(...tickets: Ticket[]): TicketInventory {
  return {
    folderLabel: "issues",
    folderPath: "/project/issues",
    tickets,
  };
}

function skillCommand(overrides: Partial<SlashCommandInfo> = {}): SlashCommandInfo {
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
    ...overrides,
  };
}

interface FakeSessionOptions {
  readonly responses?: ReadonlyArray<string | Error>;
  readonly implementation?: Promise<void>;
}

interface FakeSession extends TicketSession {
  readonly prompts: string[];
  readonly sessionOptions: CreateTicketSessionOptions[];
  disposed: number;
  aborted: number;
  subscribed: number;
  unsubscribed: number;
  lastText: string | undefined;
}

function fakeSessionFactory(options: FakeSessionOptions = {}): {
  readonly sessions: FakeSession[];
  readonly create: (sessionOptions: CreateTicketSessionOptions) => Promise<TicketSession>;
} {
  const sessions: FakeSession[] = [];

  return {
    sessions,
    async create(sessionOptions) {
      const session: FakeSession = {
        prompts: [],
        sessionOptions: [sessionOptions],
        disposed: 0,
        aborted: 0,
        subscribed: 0,
        unsubscribed: 0,
        lastText: undefined,
        async prompt(text: string) {
          session.prompts.push(text);
          if (session.prompts.length === 1 && options.implementation) {
            await options.implementation;
          }
          const response = options.responses?.[session.prompts.length - 1];
          if (response instanceof Error) throw response;
          session.lastText = response ?? session.lastText;
        },
        async abort() {
          session.aborted += 1;
        },
        subscribe(_listener: (event: ChildEvent) => void) {
          session.subscribed += 1;
          return () => {
            session.unsubscribed += 1;
          };
        },
        getLastAssistantText() {
          return session.lastText;
        },
        dispose() {
          session.disposed += 1;
        },
      };
      sessions.push(session);
      return session;
    },
  };
}

function options(
  overrides: Partial<StartTicketOptions> & Pick<StartTicketOptions, "inventory">,
): StartTicketOptions {
  return {
    cwd: "/project",
    agentDir: "/agent",
    extensionPath: "/repo/index.ts",
    model: { provider: "test", id: "model" } as StartTicketOptions["model"],
    thinkingLevel: "high",
    config: { ...DEFAULT_CONFIG, runnableStatuses: ["ready-for-agent"] },
    createSession: fakeSessionFactory().create,
    getCommands: () => [skillCommand()],
    readStatus: () => "resolved",
    ...overrides,
  };
}

describe("hasImplementSkill", () => {
  it("requires both the skill command name and a skill source", () => {
    assert.equal(hasImplementSkill([skillCommand()]), true);
    assert.equal(hasImplementSkill([skillCommand({ name: "implement" })]), false);
    assert.equal(hasImplementSkill([skillCommand({ source: "extension" })]), false);
    assert.equal(hasImplementSkill([]), false);
  });
});

describe("selectFirstRunnableTicket", () => {
  it("selects the first runnable ticket in numeric order", () => {
    const selected = selectFirstRunnableTicket(
      inventory(
        ticket("01", "resolved"),
        ticket("02", "ready-for-agent"),
        ticket("03", "ready-for-agent"),
      ),
      ["ready-for-agent"],
    );

    assert.equal(selected?.id, "02");
  });

  it("returns undefined when nothing is runnable", () => {
    assert.equal(
      selectFirstRunnableTicket(inventory(ticket("01", "resolved")), ["ready-for-agent"]),
      undefined,
    );
  });
});

describe("startFirstRunnableTicket", () => {
  it("reports nothing to run without checking the skill or creating a session", async () => {
    const fake = fakeSessionFactory();
    let checkedCommands = false;

    const outcome = await startFirstRunnableTicket(
      options({
        inventory: inventory(ticket("01", "resolved"), ticket("02", "ready-for-human")),
        createSession: fake.create,
        getCommands: () => {
          checkedCommands = true;
          return [];
        },
      }),
    );

    assert.deepEqual(outcome, { kind: "nothing-to-run" });
    assert.equal(checkedCommands, false);
    assert.equal(fake.sessions.length, 0);
  });

  it("stops with a descriptive error when skill:implement is missing", async () => {
    const fake = fakeSessionFactory();

    await assert.rejects(
      startFirstRunnableTicket(
        options({
          inventory: inventory(ticket("01", "ready-for-agent")),
          createSession: fake.create,
          getCommands: () => [],
        }),
      ),
      (error: unknown) =>
        error instanceof TicketRunnerError && /skill:implement/.test(error.message),
    );

    assert.equal(fake.sessions.length, 0);
  });

  it("runs the first runnable ticket through implementation and one gate prompt", async () => {
    const fake = fakeSessionFactory({
      responses: ["implemented", "STATUS: COMPLETE\nREASON: all checks pass"],
    });

    const outcome = await startFirstRunnableTicket(
      options({
        inventory: inventory(
          ticket("01", "resolved"),
          ticket("02", "ready-for-agent", "Second"),
          ticket("03", "ready-for-agent", "Third"),
        ),
        createSession: fake.create,
      }),
    );

    const session = fake.sessions[0];
    assert.ok(session);
    assert.deepEqual(outcome, {
      kind: "success",
      ticket: ticket("02", "ready-for-agent", "Second"),
      status: "resolved",
    });
    assert.equal(session.prompts.length, 2);
    assert.equal(session.prompts[0], "/skill:implement issues/02-ticket-02.md");
    assert.match(session.prompts[1] ?? "", /Review your implementation of issues\/02-ticket-02\.md/);
    assert.match(session.prompts[1] ?? "", /any of: ready-for-agent\./);
    assert.match(session.prompts[1] ?? "", /completed value is `resolved`/);
    assert.equal(session.disposed, 1);
    assert.equal(session.aborted, 0);
    assert.deepEqual(session.sessionOptions, [
      {
        cwd: "/project",
        agentDir: "/agent",
        extensionPath: "/repo/index.ts",
        model: { provider: "test", id: "model" },
        thinkingLevel: "high",
      },
    ]);
  });

  it("waits for the implementation prompt to settle before sending the gate", async () => {
    let release!: () => void;
    const implementation = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeSessionFactory({
      implementation,
      responses: ["implemented", "STATUS: COMPLETE"],
    });

    const run = startFirstRunnableTicket(
      options({
        inventory: inventory(ticket("01", "ready-for-agent")),
        createSession: fake.create,
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(fake.sessions[0]?.prompts.length, 1);

    release();
    await run;

    assert.equal(fake.sessions[0]?.prompts.length, 2);
  });

  it("stops when the gate reports INCOMPLETE", async () => {
    const fake = fakeSessionFactory({
      responses: ["implemented", "STATUS: INCOMPLETE\nREASON: integration tests fail"],
    });
    let statusReads = 0;

    const outcome = await startFirstRunnableTicket(
      options({
        inventory: inventory(ticket("01", "ready-for-agent")),
        createSession: fake.create,
        readStatus: () => {
          statusReads += 1;
          return "ready-for-agent";
        },
      }),
    );

    assert.deepEqual(outcome, {
      kind: "gate-rejected",
      ticket: ticket("01", "ready-for-agent"),
      status: "INCOMPLETE",
      reason: "integration tests fail",
    });
    assert.equal(statusReads, 0);
    assert.equal(fake.sessions[0]?.disposed, 1);
  });

  it("stops when the gate reports BLOCKED", async () => {
    const fake = fakeSessionFactory({
      responses: ["implemented", "STATUS: BLOCKED\nREASON: needs credentials"],
    });

    const outcome = await startFirstRunnableTicket(
      options({
        inventory: inventory(ticket("01", "ready-for-agent")),
        createSession: fake.create,
      }),
    );

    assert.equal(outcome.kind, "gate-rejected");
    assert.equal(outcome.kind === "gate-rejected" ? outcome.status : undefined, "BLOCKED");
  });

  it("stops on a missing, unknown, or contradictory gate answer", async () => {
    for (const answer of ["No status.", "STATUS: DONE", "STATUS: COMPLETE\nSTATUS: BLOCKED"]) {
      const fake = fakeSessionFactory({ responses: ["implemented", answer] });

      const outcome = await startFirstRunnableTicket(
        options({
          inventory: inventory(ticket("01", "ready-for-agent")),
          createSession: fake.create,
        }),
      );

      assert.equal(outcome.kind, "gate-malformed", answer);
      assert.equal(outcome.kind === "gate-malformed" ? outcome.text : undefined, answer);
      assert.equal(fake.sessions[0]?.disposed, 1);
    }
  });

  it("stops when COMPLETE is reported but the ticket is still runnable", async () => {
    const fake = fakeSessionFactory({ responses: ["implemented", "STATUS: COMPLETE"] });
    let statusReads = 0;

    const outcome = await startFirstRunnableTicket(
      options({
        inventory: inventory(ticket("03", "ready-for-agent")),
        createSession: fake.create,
        readStatus: () => {
          statusReads += 1;
          return "ready-for-agent";
        },
      }),
    );

    assert.deepEqual(outcome, {
      kind: "status-unchanged",
      ticket: ticket("03", "ready-for-agent"),
      status: "ready-for-agent",
    });
    assert.equal(statusReads, 1);
    assert.equal(fake.sessions[0]?.disposed, 1);
  });

  it("never writes a status itself when COMPLETE leaves the ticket runnable", async () => {
    const tree = createTempTree();
    const before = ticketMarkdown({ status: "Status: ready-for-agent" });
    tree.write("issues/03-ticket-03.md", before);
    const loaded = loadTicketInventory({ cwd: tree.root, folder: "issues" });
    const fake = fakeSessionFactory({ responses: ["implemented", "STATUS: COMPLETE"] });

    const outcome = await startFirstRunnableTicket(
      options({
        cwd: tree.root,
        inventory: loaded,
        createSession: fake.create,
        readStatus: undefined,
      }),
    );

    assert.equal(outcome.kind, "status-unchanged");
    assert.equal(readFileSync(tree.path("issues/03-ticket-03.md"), "utf8"), before);
  });

  it("accepts a COMPLETE answer when the persisted status leaves the runnable set", async () => {
    const fake = fakeSessionFactory({ responses: ["implemented", "STATUS: COMPLETE"] });

    const outcome = await startFirstRunnableTicket(
      options({
        inventory: inventory(ticket("01", "ready-for-agent")),
        createSession: fake.create,
        config: { ...DEFAULT_CONFIG, runnableStatuses: ["ready-for-agent", "queued"] },
        readStatus: () => "needs-info",
      }),
    );

    assert.equal(outcome.kind, "success");
    assert.equal(outcome.kind === "success" ? outcome.status : undefined, "needs-info");
  });

  it("disposes the child when an implementation prompt throws", async () => {
    const fake = fakeSessionFactory({ responses: [new Error("child crashed")] });

    await assert.rejects(
      startFirstRunnableTicket(
        options({
          inventory: inventory(ticket("01", "ready-for-agent")),
          createSession: fake.create,
        }),
      ),
      /child crashed/,
    );

    const session = fake.sessions[0];
    assert.ok(session);
    assert.equal(session.prompts.length, 1);
    assert.equal(session.disposed, 1);
  });

  it("disposes the child when the gate prompt throws", async () => {
    const fake = fakeSessionFactory({
      responses: ["implemented", new Error("gate crashed")],
    });

    await assert.rejects(
      startFirstRunnableTicket(
        options({
          inventory: inventory(ticket("01", "ready-for-agent")),
          createSession: fake.create,
        }),
      ),
      /gate crashed/,
    );

    assert.equal(fake.sessions[0]?.disposed, 1);
  });
});
