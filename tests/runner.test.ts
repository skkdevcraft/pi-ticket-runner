import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { TicketRunnerError } from "../src/errors.ts";
import { TicketRunState } from "../src/run-state.ts";
import {
  hasImplementSkill,
  runTickets,
  type RanTicket,
  type RunStop,
  type RunTicketsOptions,
  type TicketProgress,
} from "../src/runner.ts";
import type {
  ChildEvent,
  CreateTicketSessionOptions,
  TicketSession,
} from "../src/sessions.ts";
import type { Ticket, TicketInventory } from "../src/tickets.ts";

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

interface PromptContext {
  readonly prompt: string;
  readonly promptIndex: number;
  readonly sessionIndex: number;
  readonly session: FakeSession;
}

interface FakeSessionOptions {
  readonly responses?: readonly (string | Error)[];
  readonly onPrompt?: (context: PromptContext) => void | Promise<void>;
}

interface FakeSession extends TicketSession {
  readonly prompts: string[];
  readonly sessionOptions: CreateTicketSessionOptions[];
  disposed: number;
  aborted: number;
  subscribed: number;
  unsubscribed: number;
  lastText: string | undefined;
  emit(event: ChildEvent): void;
}

const COMPLETE = "STATUS: COMPLETE\nREASON: all checks pass";

function fakeSessionFactory(options: FakeSessionOptions = {}): {
  readonly sessions: FakeSession[];
  readonly create: (sessionOptions: CreateTicketSessionOptions) => Promise<TicketSession>;
} {
  const sessions: FakeSession[] = [];

  return {
    sessions,
    async create(sessionOptions) {
      const sessionIndex = sessions.length;
      const listeners = new Set<(event: ChildEvent) => void>();
      const session: FakeSession = {
        sessionFile: `/sessions/${sessionIndex + 1}.jsonl`,
        prompts: [],
        sessionOptions: [sessionOptions],
        disposed: 0,
        aborted: 0,
        subscribed: 0,
        unsubscribed: 0,
        lastText: undefined,
        emit(event) {
          for (const listener of listeners) listener(event);
        },
        async prompt(text: string) {
          const promptIndex = session.prompts.length;
          session.prompts.push(text);
          await options.onPrompt?.({ prompt: text, promptIndex, sessionIndex, session });
          const response = options.responses?.[promptIndex];
          if (response instanceof Error) throw response;
          session.lastText = response ?? session.lastText;
        },
        async abort() {
          session.aborted += 1;
        },
        subscribe(listener: (event: ChildEvent) => void) {
          session.subscribed += 1;
          listeners.add(listener);
          return () => {
            session.unsubscribed += 1;
            listeners.delete(listener);
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
  overrides: Partial<RunTicketsOptions> & Pick<RunTicketsOptions, "inventory">,
): RunTicketsOptions {
  return {
    cwd: "/project",
    agentDir: "/agent",
    extensionPath: "/repo/index.ts",
    model: { provider: "test", id: "model" } as RunTicketsOptions["model"],
    thinkingLevel: "high",
    config: { ...DEFAULT_CONFIG, runnableStatuses: ["ready-for-agent"] },
    createSession: fakeSessionFactory().create,
    getCommands: () => [skillCommand()],
    readStatus: (value) => value.status,
    ...overrides,
  };
}

function statusReader(statuses: ReadonlyMap<string, string>): (value: Ticket) => string {
  return (value) => statuses.get(value.filename) ?? value.status;
}

function ranIds(ran: readonly RanTicket[]): string[] {
  return ran.map((entry) => entry.ticket.id);
}

function stopKind(stop: RunStop): RunStop["kind"] {
  return stop.kind;
}

describe("hasImplementSkill", () => {
  it("requires both the skill command name and a skill source", () => {
    assert.equal(hasImplementSkill([skillCommand()]), true);
    assert.equal(hasImplementSkill([skillCommand({ name: "implement" })]), false);
    assert.equal(hasImplementSkill([skillCommand({ source: "extension" })]), false);
    assert.equal(hasImplementSkill([]), false);
  });
});

describe("runTickets: sequential execution", () => {
  it("runs runnable tickets in numeric order and skips every non-runnable ticket", async () => {
    const statuses = new Map([
      ["01-ticket-01.md", "resolved"],
      ["02-ticket-02.md", "ready-for-agent"],
      ["03-ticket-03.md", "ready-for-human"],
      ["04-ticket-04.md", "ready-for-agent"],
      ["05-ticket-05.md", "resolved"],
    ]);
    const implemented: string[] = ["02-ticket-02.md", "04-ticket-04.md"];
    const progress: TicketProgress[] = [];
    const fake = fakeSessionFactory({
      responses: ["implemented", COMPLETE],
      onPrompt: ({ promptIndex, sessionIndex }) => {
        if (promptIndex === 1) {
          const filename = implemented[sessionIndex];
          assert.ok(filename);
          statuses.set(filename, "resolved");
        }
      },
    });

    const outcome = await runTickets(
      options({
        inventory: inventory(
          ticket("01", "resolved", "First"),
          ticket("02", "ready-for-agent", "Second"),
          ticket("03", "ready-for-human", "Third"),
          ticket("04", "ready-for-agent", "Fourth"),
          ticket("05", "resolved", "Fifth"),
        ),
        createSession: fake.create,
        readStatus: statusReader(statuses),
        onProgress: (update) => progress.push(update),
      }),
    );

    assert.equal(outcome.kind, "finished");
    assert.deepEqual(outcome.kind === "finished" ? ranIds(outcome.ran) : [], ["02", "04"]);
    assert.deepEqual(
      outcome.kind === "finished" ? outcome.skipped.map((entry) => entry.ticket.id) : [],
      ["01", "03", "05"],
    );
    assert.deepEqual(
      outcome.kind === "finished" ? outcome.skipped.map((entry) => entry.status) : [],
      ["resolved", "ready-for-human", "resolved"],
    );
    assert.equal(outcome.kind === "finished" ? outcome.remainingRunnable : -1, 0);

    assert.equal(fake.sessions.length, 2);
    assert.deepEqual(fake.sessions[0]?.prompts[0], "/skill:implement issues/02-ticket-02.md");
    assert.deepEqual(fake.sessions[1]?.prompts[0], "/skill:implement issues/04-ticket-04.md");
    for (const session of fake.sessions) {
      assert.equal(session.prompts.length, 2);
      assert.match(session.prompts[1] ?? "", /Review your implementation/);
      assert.equal(session.disposed, 1);
      assert.equal(session.subscribed, 1);
      assert.equal(session.unsubscribed, 1);
    }

    assert.deepEqual(
      progress.map((update) => [update.ticket.id, update.status, update.next?.id, update.remainingRunnable]),
      [
        ["02", "resolved", "04", 1],
        ["04", "resolved", undefined, 0],
      ],
    );
  });

  it("creates a fresh session for every ticket with no inherited conversation", async () => {
    const statuses = new Map([
      ["01-ticket-01.md", "ready-for-agent"],
      ["02-ticket-02.md", "ready-for-agent"],
    ]);
    let processed = 0;
    const fake = fakeSessionFactory({
      responses: ["implemented", COMPLETE],
      onPrompt: ({ promptIndex }) => {
        if (promptIndex !== 1) return;
        processed += 1;
        statuses.set(processed === 1 ? "01-ticket-01.md" : "02-ticket-02.md", "resolved");
      },
    });

    await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent"), ticket("02", "ready-for-agent")),
        createSession: fake.create,
        readStatus: statusReader(statuses),
      }),
    );

    assert.equal(fake.sessions.length, 2);
    assert.notEqual(fake.sessions[0], fake.sessions[1]);
    assert.equal(fake.sessions[0]?.prompts.length, 2);
    assert.equal(fake.sessions[1]?.prompts.length, 2);
    assert.deepEqual(fake.sessions[0]?.sessionOptions, fake.sessions[1]?.sessionOptions);
    assert.deepEqual(fake.sessions[0]?.sessionOptions[0], {
      cwd: "/project",
      agentDir: "/agent",
      extensionPath: "/repo/index.ts",
      model: { provider: "test", id: "model" },
      thinkingLevel: "high",
    });
  });

  it("starts the next ticket only after the previous gate and persisted status pass", async () => {
    const statuses = new Map([
      ["01-ticket-01.md", "ready-for-agent"],
      ["02-ticket-02.md", "ready-for-agent"],
    ]);
    const sessionStarts: number[] = [];
    const fake = fakeSessionFactory({
      responses: ["implemented", COMPLETE],
      onPrompt: ({ promptIndex, sessionIndex }) => {
        if (promptIndex !== 1) return;
        if (sessionIndex === 0) {
          sessionStarts.push(statuses.get("02-ticket-02.md") === "ready-for-agent" ? 1 : 0);
          statuses.set("01-ticket-01.md", "resolved");
        } else {
          statuses.set("02-ticket-02.md", "resolved");
        }
      },
    });

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent"), ticket("02", "ready-for-agent")),
        createSession: fake.create,
        readStatus: statusReader(statuses),
      }),
    );

    assert.equal(outcome.kind, "finished");
    assert.deepEqual(sessionStarts, [1]);
    assert.equal(fake.sessions.length, 2);
  });

  it("re-reads statuses before each ticket instead of trusting the inventory", async () => {
    const statuses = new Map([
      ["01-ticket-01.md", "ready-for-agent"],
      ["02-ticket-02.md", "ready-for-agent"],
    ]);
    const fake = fakeSessionFactory({
      responses: ["implemented", COMPLETE],
      onPrompt: ({ promptIndex }) => {
        if (promptIndex === 1) {
          statuses.set("01-ticket-01.md", "resolved");
          // Simulate a ticket becoming non-runnable outside the runner.
          statuses.set("02-ticket-02.md", "ready-for-human");
        }
      },
    });

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent"), ticket("02", "ready-for-agent")),
        createSession: fake.create,
        readStatus: statusReader(statuses),
      }),
    );

    assert.equal(fake.sessions.length, 1);
    assert.equal(outcome.kind, "finished");
    assert.deepEqual(outcome.kind === "finished" ? ranIds(outcome.ran) : [], ["01"]);
    assert.deepEqual(
      outcome.kind === "finished"
        ? outcome.skipped.map((entry) => [entry.ticket.id, entry.status])
        : [],
      [["02", "ready-for-human"]],
    );
  });

  it("reports nothing to run without checking the skill or creating a session", async () => {
    const fake = fakeSessionFactory();
    let checkedCommands = false;

    const outcome = await runTickets(
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
      runTickets(
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

  it("tracks the active ticket and session for status reporting", async () => {
    const statuses = new Map([["01-ticket-01.md", "ready-for-agent"]]);
    const state = new TicketRunState();
    const observations: Array<{ current: string | undefined; session: string | undefined }> = [];
    const fake = fakeSessionFactory({
      responses: ["implemented", COMPLETE],
      onPrompt: ({ promptIndex, session }) => {
        observations.push({
          current: state.active?.currentTicket?.id,
          session: state.active?.sessionFile,
        });
        if (promptIndex === 1) {
          assert.equal(session.sessionFile, "/sessions/1.jsonl");
          statuses.set("01-ticket-01.md", "resolved");
        }
      },
    });

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent")),
        createSession: fake.create,
        readStatus: statusReader(statuses),
        state,
      }),
    );

    assert.equal(outcome.kind, "finished");
    assert.deepEqual(observations[0], { current: "01", session: "/sessions/1.jsonl" });
    assert.equal(state.active, undefined);
    assert.equal(state.lastFolder, "issues");
  });
});

describe("runTickets: stop conditions", () => {
  it("stops when the gate reports INCOMPLETE", async () => {
    const fake = fakeSessionFactory({
      responses: ["implemented", "STATUS: INCOMPLETE\nREASON: integration tests fail"],
    });

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent"), ticket("02", "ready-for-agent")),
        createSession: fake.create,
        readStatus: (value) => value.status,
      }),
    );

    assert.equal(outcome.kind, "stopped");
    if (outcome.kind !== "stopped") return;
    assert.equal(stopKind(outcome.stop), "gate-rejected");
    assert.deepEqual(outcome.stop.kind === "gate-rejected" ? outcome.stop.reason : "", "integration tests fail");
    assert.equal(outcome.remainingRunnable, 2);
    assert.equal(fake.sessions.length, 1);
    assert.equal(fake.sessions[0]?.disposed, 1);
    assert.equal(fake.sessions[0]?.unsubscribed, 1);
    assert.equal(outcome.ran.length, 0);
  });

  it("stops when the gate reports BLOCKED", async () => {
    const fake = fakeSessionFactory({
      responses: ["implemented", "STATUS: BLOCKED\nREASON: needs credentials"],
    });

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent")),
        createSession: fake.create,
      }),
    );

    assert.equal(outcome.kind, "stopped");
    assert.equal(outcome.kind === "stopped" ? outcome.stop.kind : undefined, "gate-rejected");
    assert.equal(
      outcome.kind === "stopped" && outcome.stop.kind === "gate-rejected"
        ? outcome.stop.status
        : undefined,
      "BLOCKED",
    );
  });

  it("stops on a missing, unknown, or contradictory gate answer", async () => {
    for (const answer of ["No status.", "STATUS: DONE", "STATUS: COMPLETE\nSTATUS: BLOCKED"]) {
      const fake = fakeSessionFactory({ responses: ["implemented", answer] });

      const outcome = await runTickets(
        options({
          inventory: inventory(ticket("01", "ready-for-agent")),
          createSession: fake.create,
        }),
      );

      assert.equal(outcome.kind, "stopped", answer);
      assert.equal(outcome.kind === "stopped" ? outcome.stop.kind : undefined, "gate-malformed");
      assert.equal(
        outcome.kind === "stopped" && outcome.stop.kind === "gate-malformed"
          ? outcome.stop.text
          : undefined,
        answer,
      );
      assert.equal(fake.sessions[0]?.disposed, 1);
    }
  });

  it("stops when COMPLETE leaves the ticket runnable", async () => {
    const fake = fakeSessionFactory({ responses: ["implemented", "STATUS: COMPLETE"] });

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent"), ticket("02", "ready-for-agent")),
        createSession: fake.create,
        readStatus: () => "ready-for-agent",
      }),
    );

    assert.equal(outcome.kind, "stopped");
    assert.equal(outcome.kind === "stopped" ? outcome.stop.kind : undefined, "status-unchanged");
    assert.equal(fake.sessions.length, 1);
    assert.equal(outcome.kind === "stopped" ? outcome.remainingRunnable : -1, 2);
  });

  it("accepts COMPLETE when the persisted status leaves the runnable set", async () => {
    const statuses = new Map([["01-ticket-01.md", "ready-for-agent"]]);
    const fake = fakeSessionFactory({
      responses: ["implemented", "STATUS: COMPLETE"],
      onPrompt: ({ promptIndex }) => {
        if (promptIndex === 1) statuses.set("01-ticket-01.md", "needs-info");
      },
    });

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent")),
        createSession: fake.create,
        config: { ...DEFAULT_CONFIG, runnableStatuses: ["ready-for-agent", "queued"] },
        readStatus: statusReader(statuses),
      }),
    );

    assert.equal(outcome.kind, "finished");
    assert.equal(
      outcome.kind === "finished" ? outcome.ran[0]?.status : undefined,
      "needs-info",
    );
  });

  it("stops when the implementation prompt throws", async () => {
    const fake = fakeSessionFactory({ responses: [new Error("child crashed")] });

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent"), ticket("02", "ready-for-agent")),
        createSession: fake.create,
        readStatus: (value) => value.status,
      }),
    );

    assert.equal(outcome.kind, "stopped");
    assert.equal(outcome.kind === "stopped" ? outcome.stop.kind : undefined, "session-error");
    assert.equal(
      outcome.kind === "stopped" && outcome.stop.kind === "session-error"
        ? outcome.stop.phase
        : undefined,
      "implementation",
    );
    assert.equal(
      outcome.kind === "stopped" && outcome.stop.kind === "session-error"
        ? outcome.stop.message
        : undefined,
      "child crashed",
    );
    assert.equal(fake.sessions.length, 1);
    assert.equal(fake.sessions[0]?.prompts.length, 1);
    assert.equal(fake.sessions[0]?.disposed, 1);
  });

  it("stops when the gate prompt throws", async () => {
    const fake = fakeSessionFactory({
      responses: ["implemented", new Error("gate crashed")],
    });

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent")),
        createSession: fake.create,
        readStatus: (value) => value.status,
      }),
    );

    assert.equal(outcome.kind, "stopped");
    assert.equal(
      outcome.kind === "stopped" && outcome.stop.kind === "session-error"
        ? outcome.stop.phase
        : undefined,
      "completion-gate",
    );
    assert.equal(fake.sessions[0]?.disposed, 1);
  });

  it("stops when the child session cannot be created", async () => {
    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent")),
        createSession: async () => {
          throw new Error("no session");
        },
      }),
    );

    assert.equal(outcome.kind, "stopped");
    assert.equal(
      outcome.kind === "stopped" && outcome.stop.kind === "session-error"
        ? outcome.stop.phase
        : undefined,
      "create",
    );
    assert.equal(outcome.kind === "stopped" ? outcome.remainingRunnable : -1, 1);
  });
});

describe("runTickets: turn limit", () => {
  function turnEnd(): ChildEvent {
    return { type: "turn_end" } as unknown as ChildEvent;
  }

  it("aborts the child, skips the gate, and stops at the turn limit", async () => {
    const fake = fakeSessionFactory({
      responses: ["implemented", COMPLETE],
      onPrompt: ({ promptIndex, session }) => {
        if (promptIndex !== 0) return;
        for (let turn = 0; turn < 3; turn += 1) session.emit(turnEnd());
      },
    });

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent"), ticket("02", "ready-for-agent")),
        createSession: fake.create,
        readStatus: (value) => value.status,
        config: { ...DEFAULT_CONFIG, maxTurnsPerTicket: 3 },
      }),
    );

    assert.equal(outcome.kind, "stopped");
    assert.equal(outcome.kind === "stopped" ? outcome.stop.kind : undefined, "turn-limit");
    assert.deepEqual(
      outcome.kind === "stopped" && outcome.stop.kind === "turn-limit"
        ? [outcome.stop.turns, outcome.stop.maxTurns]
        : [],
      [3, 3],
    );
    assert.equal(fake.sessions.length, 1);
    assert.equal(fake.sessions[0]?.aborted, 1);
    assert.equal(fake.sessions[0]?.prompts.length, 1, "the gate must not be sent");
    assert.equal(fake.sessions[0]?.disposed, 1);
  });

  it("does not count completion-gate turns against the limit", async () => {
    const statuses = new Map([["01-ticket-01.md", "ready-for-agent"]]);
    const fake = fakeSessionFactory({
      responses: ["implemented", COMPLETE],
      onPrompt: ({ promptIndex, session }) => {
        if (promptIndex === 0) {
          session.emit(turnEnd());
          return;
        }
        for (let turn = 0; turn < 5; turn += 1) session.emit(turnEnd());
        statuses.set("01-ticket-01.md", "resolved");
      },
    });

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent")),
        createSession: fake.create,
        readStatus: statusReader(statuses),
        config: { ...DEFAULT_CONFIG, maxTurnsPerTicket: 2 },
      }),
    );

    assert.equal(outcome.kind, "finished");
    assert.equal(fake.sessions[0]?.aborted, 0);
    assert.equal(fake.sessions[0]?.prompts.length, 2);
  });
});
