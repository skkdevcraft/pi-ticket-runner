import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { TicketRunnerError } from "../src/errors.ts";
import {
  type GitState,
  type GitStateChange,
  type OpenRepositoryGuardOptions,
  type RepositoryGuard,
} from "../src/repository.ts";
import { TicketRunState } from "../src/run-state.ts";
import type { SessionFrameStatus } from "../src/session-frame.ts";
import {
  hasImplementSkill,
  RunCancellation,
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
import { settled, textDelta, toolEnd, toolStart, turnEnd } from "./helpers.ts";

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
  /** Shared log for asserting cleanup ordering across sessions and the guard. */
  readonly order?: string[];
}

interface FakeSession extends TicketSession {
  readonly prompts: string[];
  readonly sessionOptions: CreateTicketSessionOptions[];
  readonly events: string[];
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
        events: [],
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
          session.events.push("abort");
          options.order?.push("abort");
        },
        subscribe(listener: (event: ChildEvent) => void) {
          session.subscribed += 1;
          listeners.add(listener);
          return () => {
            session.unsubscribed += 1;
            session.events.push("unsubscribe");
            options.order?.push("unsubscribe");
            listeners.delete(listener);
          };
        },
        getLastAssistantText() {
          return session.lastText;
        },
        getTranscript() {
          return [];
        },
        dispose() {
          session.disposed += 1;
          session.events.push("dispose");
          options.order?.push("dispose");
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
    openGuard: () => fakeGuard(),
    ...overrides,
  };
}

interface FakeGuard extends RepositoryGuard {
  released: number;
  checks: number;
  changes: Array<GitStateChange | undefined>;
  accepted: number;
  accepts: Array<GitStateChange | undefined>;
}

const PROJECT_GIT: GitState = { root: "/project", branch: "main", head: "abc123" };

function fakeGuard(changes: Array<GitStateChange | undefined> = []): FakeGuard {
  return {
    git: PROJECT_GIT,
    released: 0,
    checks: 0,
    changes: [...changes],
    accepted: 0,
    accepts: [],
    checkUnchanged() {
      this.checks += 1;
      return this.changes.shift();
    },
    acceptHead() {
      this.accepted += 1;
      return this.accepts.shift();
    },
    release() {
      this.released += 1;
    },
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

  it("forwards subscribable child events and run milestones to the live observer", async () => {
    const statuses = new Map([
      ["01-ticket-01.md", "ready-for-agent"],
      ["02-ticket-02.md", "ready-for-agent"],
    ]);
    const log: string[] = [];
    const observer = {
      ticketStarted(value: Ticket, remainingRunnable: number) {
        log.push(`start:${value.id}:${remainingRunnable}`);
      },
      childEvent(event: ChildEvent, phase: "implementation" | "completion-gate") {
        log.push(`event:${event.type}:${phase}`);
      },
      gateStarted(value: Ticket) {
        log.push(`gate:${value.id}`);
      },
      betweenTickets(next: Ticket | undefined, remainingRunnable: number) {
        log.push(`between:${next?.id ?? "none"}:${remainingRunnable}`);
      },
    };
    const fake = fakeSessionFactory({
      responses: ["implemented", COMPLETE],
      onPrompt: ({ promptIndex, sessionIndex, session }) => {
        if (promptIndex === 0) {
          session.emit(textDelta("writing code"));
          session.emit(toolStart("edit"));
          session.emit(toolEnd("edit"));
          session.emit(turnEnd());
          session.emit(settled());
          return;
        }
        session.emit(textDelta("gate output"));
        statuses.set(
          sessionIndex === 0 ? "01-ticket-01.md" : "02-ticket-02.md",
          "resolved",
        );
      },
    });

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent"), ticket("02", "ready-for-agent")),
        createSession: fake.create,
        readStatus: statusReader(statuses),
        observer,
      }),
    );

    assert.equal(outcome.kind, "finished");
    assert.deepEqual(log.slice(0, 9), [
      "start:01:2",
      "event:message_update:implementation",
      "event:tool_execution_start:implementation",
      "event:tool_execution_end:implementation",
      "event:turn_end:implementation",
      "event:agent_settled:implementation",
      "gate:01",
      "event:message_update:completion-gate",
      "between:02:1",
    ]);
    assert.ok(log.includes("start:02:1"));
    assert.equal(log.at(-1), "between:none:0");
    assert.ok(log.indexOf("gate:01") < log.indexOf("event:message_update:completion-gate"));
    assert.ok(log.indexOf("between:02:1") < log.indexOf("start:02:1"));
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

  it("acquires the repository guard before the first session and releases it after finishing", async () => {
    const statuses = new Map([["01-ticket-01.md", "ready-for-agent"]]);
    const guard = fakeGuard();
    const observed: OpenRepositoryGuardOptions[] = [];
    const fake = fakeSessionFactory({
      responses: ["implemented", COMPLETE],
      onPrompt: ({ promptIndex }) => {
        if (promptIndex === 1) statuses.set("01-ticket-01.md", "resolved");
      },
    });

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent")),
        createSession: fake.create,
        readStatus: statusReader(statuses),
        allowDirty: true,
        openGuard: (guardOptions) => {
          observed.push(guardOptions);
          return guard;
        },
      }),
    );

    assert.equal(outcome.kind, "finished");
    assert.deepEqual(observed, [
      {
        cwd: "/project",
        ticketFolder: "issues",
        ticketFolderPath: "/project/issues",
        allowDirty: true,
        staleLockHours: 12,
      },
    ]);
    assert.equal(fake.sessions.length, 1);
    assert.equal(guard.checks, 1);
    assert.equal(guard.accepted, 1);
    assert.equal(guard.released, 1);
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

  it("does not acquire the lock when nothing is runnable", async () => {
    let opened = 0;

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "resolved")),
        openGuard: () => {
          opened += 1;
          return fakeGuard();
        },
      }),
    );

    assert.deepEqual(outcome, { kind: "nothing-to-run" });
    assert.equal(opened, 0);
  });

  it("releases the lock when an unexpected error escapes the run", async () => {
    const guard = fakeGuard();
    let reads = 0;

    await assert.rejects(
      runTickets(
        options({
          inventory: inventory(ticket("01", "ready-for-agent")),
          readStatus: (value) => {
            reads += 1;
            if (reads > 1) throw new Error("ticket disk disappeared");
            return value.status;
          },
          openGuard: () => guard,
        }),
      ),
      /ticket disk disappeared/,
    );

    assert.equal(guard.released, 1);
  });

  it("refuses the run before any session when preflight throws", async () => {
    const fake = fakeSessionFactory();

    await assert.rejects(
      runTickets(
        options({
          inventory: inventory(ticket("01", "ready-for-agent")),
          createSession: fake.create,
          openGuard: () => {
            throw new TicketRunnerError("Refusing to start: dirty tree");
          },
        }),
      ),
      /dirty tree/,
    );

    assert.equal(fake.sessions.length, 0);
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
    const guard = fakeGuard();
    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent")),
        createSession: async () => {
          throw new Error("no session");
        },
        openGuard: () => guard,
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
    assert.equal(guard.released, 1);
  });

  it("releases the lock when a ticket stops the run", async () => {
    const guard = fakeGuard();
    const fake = fakeSessionFactory({
      responses: ["implemented", "STATUS: BLOCKED\nREASON: needs credentials"],
    });

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent")),
        createSession: fake.create,
        openGuard: () => guard,
      }),
    );

    assert.equal(outcome.kind, "stopped");
    assert.equal(guard.released, 1);
  });

  it("stops before the next session when branch or HEAD changes", async () => {
    const statuses = new Map([
      ["01-ticket-01.md", "ready-for-agent"],
      ["02-ticket-02.md", "ready-for-agent"],
    ]);
    const changed: GitStateChange = {
      expected: PROJECT_GIT,
      actual: { root: "/project", branch: "feature", head: "def456" },
      error: undefined,
    };
    const guard = fakeGuard([undefined, changed]);
    const fake = fakeSessionFactory({
      responses: ["implemented", COMPLETE],
      onPrompt: ({ promptIndex }) => {
        if (promptIndex === 1) statuses.set("01-ticket-01.md", "resolved");
      },
    });

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent"), ticket("02", "ready-for-agent")),
        createSession: fake.create,
        readStatus: statusReader(statuses),
        openGuard: () => guard,
      }),
    );

    assert.equal(outcome.kind, "stopped");
    if (outcome.kind !== "stopped") return;
    assert.equal(outcome.stop.kind, "git-changed");
    assert.equal(outcome.stop.kind === "git-changed" ? outcome.stop.ticket.id : undefined, "02");
    assert.equal(
      outcome.stop.kind === "git-changed" ? outcome.stop.actual?.branch : undefined,
      "feature",
    );
    assert.equal(fake.sessions.length, 1);
    assert.equal(guard.checks, 2);
    assert.equal(guard.released, 1);
    assert.equal(outcome.remainingRunnable, 1);
  });

  it("stops when the child's reported git advance leaves the branch", async () => {
    const statuses = new Map([
      ["01-ticket-01.md", "ready-for-agent"],
      ["02-ticket-02.md", "ready-for-agent"],
    ]);
    const changed: GitStateChange = {
      expected: PROJECT_GIT,
      actual: { root: "/project", branch: "other", head: "def456" },
      error: undefined,
    };
    const guard = fakeGuard();
    guard.accepts.push(changed);
    const fake = fakeSessionFactory({
      responses: ["implemented", COMPLETE],
      onPrompt: ({ promptIndex }) => {
        if (promptIndex === 1) statuses.set("01-ticket-01.md", "resolved");
      },
    });

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent"), ticket("02", "ready-for-agent")),
        createSession: fake.create,
        readStatus: statusReader(statuses),
        openGuard: () => guard,
      }),
    );

    assert.equal(outcome.kind, "stopped");
    assert.equal(outcome.kind === "stopped" ? outcome.stop.kind : undefined, "git-changed");
    assert.equal(
      outcome.kind === "stopped" && outcome.stop.kind === "git-changed"
        ? outcome.stop.ticket.id
        : undefined,
      "01",
    );
    assert.deepEqual(outcome.kind === "stopped" ? ranIds(outcome.ran) : [], ["01"]);
    assert.equal(fake.sessions.length, 1);
    assert.equal(guard.released, 1);
  });

  it("stops before a session when the git state cannot be checked", async () => {
    const guard = fakeGuard([
      { expected: PROJECT_GIT, actual: undefined, error: "git is unavailable" },
    ]);
    const fake = fakeSessionFactory({ responses: ["implemented", COMPLETE] });

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent")),
        createSession: fake.create,
        openGuard: () => guard,
      }),
    );

    assert.equal(outcome.kind, "stopped");
    assert.equal(
      outcome.kind === "stopped" ? outcome.stop.kind : undefined,
      "git-check-error",
    );
    assert.equal(
      outcome.kind === "stopped" && outcome.stop.kind === "git-check-error"
        ? outcome.stop.message
        : undefined,
      "git is unavailable",
    );
    assert.equal(fake.sessions.length, 0);
    assert.equal(guard.released, 1);
  });
});

describe("runTickets: session frame settlement", () => {
  interface FrameRecorder {
    readonly observer: {
      ticketStarted(ticket: Ticket, remainingRunnable: number): void;
      frameStarted(ticket: Ticket, child: { sessionFile: string | undefined; model: string | undefined }): void;
      childEvent(): void;
      gateStarted(ticket: Ticket): void;
      frameSettled(status: SessionFrameStatus): void;
      betweenTickets(next: Ticket | undefined, remainingRunnable: number): void;
    };
    readonly started: Array<{ ticketId: string; sessionFile: string | undefined; model: string | undefined }>;
    readonly settled: SessionFrameStatus[];
    readonly order: string[];
  }

  function frameRecorder(order: string[] = []): FrameRecorder {
    const started: FrameRecorder["started"] = [];
    const settled: SessionFrameStatus[] = [];
    const observer = {
      ticketStarted() {},
      frameStarted(value: Ticket, child: { sessionFile: string | undefined; model: string | undefined }) {
        started.push({ ticketId: value.id, sessionFile: child.sessionFile, model: child.model });
        order.push("frame-start");
      },
      childEvent() {},
      gateStarted() {
        order.push("gate");
      },
      frameSettled(status: SessionFrameStatus) {
        settled.push(status);
        order.push(`settle:${status}`);
      },
      betweenTickets() {},
    };
    return { observer, started, settled, order };
  }

  it("settles done only after a COMPLETE gate and a persisted status change", async () => {
    const order: string[] = [];
    const statuses = new Map([["01-ticket-01.md", "ready-for-agent"]]);
    const fake = fakeSessionFactory({
      responses: ["implemented", COMPLETE],
      order,
      onPrompt: ({ promptIndex }) => {
        if (promptIndex === 1) statuses.set("01-ticket-01.md", "resolved");
      },
    });
    const frames = frameRecorder(order);

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent")),
        createSession: async (sessionOptions) => {
          order.push("create");
          return fake.create(sessionOptions);
        },
        readStatus: statusReader(statuses),
        observer: frames.observer,
      }),
    );

    assert.equal(outcome.kind, "finished");
    assert.deepEqual(frames.started, [
      { ticketId: "01", sessionFile: "/sessions/1.jsonl", model: "model" },
    ]);
    assert.deepEqual(frames.settled, ["done"]);
    assert.deepEqual(order, [
      "create",
      "frame-start",
      "gate",
      "unsubscribe",
      "settle:done",
      "dispose",
    ]);
  });

  it("settles stopped for every deliberate stop", async () => {
    const cases: Array<{
      name: string;
      responses: readonly string[];
      readStatus?: () => string;
      config?: RunTicketsOptions["config"];
      onPrompt?: (context: { promptIndex: number; session: FakeSession }) => void;
    }> = [
      { name: "gate rejection", responses: ["implemented", "STATUS: INCOMPLETE\nREASON: no"] },
      { name: "malformed gate", responses: ["implemented", "no status line"] },
      { name: "unchanged status", responses: ["implemented", COMPLETE] },
      {
        name: "turn limit",
        responses: ["implemented", COMPLETE],
        config: { ...DEFAULT_CONFIG, maxTurnsPerTicket: 1 },
        onPrompt: ({ promptIndex, session }) => {
          if (promptIndex === 0) session.emit(turnEnd());
        },
      },
    ];

    for (const scenario of cases) {
      const fake = fakeSessionFactory({
        responses: scenario.responses,
        ...(scenario.onPrompt ? { onPrompt: scenario.onPrompt } : {}),
      });
      const frames = frameRecorder();

      await runTickets(
        options({
          inventory: inventory(ticket("01", "ready-for-agent")),
          createSession: fake.create,
          readStatus: scenario.readStatus ?? (() => "ready-for-agent"),
          observer: frames.observer,
          ...(scenario.config ? { config: scenario.config } : {}),
        }),
      );

      assert.deepEqual(frames.settled, ["stopped"], scenario.name);
      assert.equal(frames.started.length, 1, scenario.name);
    }
  });

  it("settles stopped when the run is interrupted", async () => {
    const cancellation = new RunCancellation();
    const fake = fakeSessionFactory({
      responses: ["implemented", COMPLETE],
      onPrompt: async ({ promptIndex }) => {
        if (promptIndex === 0) await cancellation.cancel();
      },
    });
    const frames = frameRecorder();

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent")),
        createSession: fake.create,
        readStatus: (value) => value.status,
        cancellation,
        observer: frames.observer,
      }),
    );

    assert.equal(outcome.kind, "stopped");
    assert.deepEqual(frames.settled, ["stopped"]);
  });

  it("settles failed only for a child-session error", async () => {
    for (const [phase, responses] of [
      ["implementation", [new Error("child crashed")]],
      ["completion-gate", ["implemented", new Error("gate crashed")]],
    ] as const) {
      const fake = fakeSessionFactory({ responses });
      const frames = frameRecorder();

      const outcome = await runTickets(
        options({
          inventory: inventory(ticket("01", "ready-for-agent")),
          createSession: fake.create,
          readStatus: (value) => value.status,
          observer: frames.observer,
        }),
      );

      assert.equal(outcome.kind === "stopped" ? outcome.stop.kind : undefined, "session-error");
      assert.deepEqual(frames.settled, ["failed"], phase);
    }
  });

  it("creates no frame for skipped tickets, Git stops, or session-creation failures", async () => {
    const skipped = frameRecorder();
    const nothing = await runTickets(
      options({
        inventory: inventory(ticket("01", "resolved"), ticket("02", "ready-for-human")),
        observer: skipped.observer,
      }),
    );
    assert.equal(nothing.kind, "nothing-to-run");
    assert.deepEqual(skipped.started, []);
    assert.deepEqual(skipped.settled, []);

    const gitStop = frameRecorder();
    await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent")),
        readStatus: (value) => value.status,
        observer: gitStop.observer,
        openGuard: () =>
          fakeGuard([
            {
              expected: PROJECT_GIT,
              actual: { root: "/project", branch: "feature", head: "def456" },
              error: undefined,
            },
          ]),
      }),
    );
    assert.deepEqual(gitStop.started, []);
    assert.deepEqual(gitStop.settled, []);

    const createFailure = frameRecorder();
    await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent")),
        createSession: async () => {
          throw new Error("no session");
        },
        observer: createFailure.observer,
      }),
    );
    assert.deepEqual(createFailure.started, []);
    assert.deepEqual(createFailure.settled, []);
  });

  it("creates a frame only for the runnable ticket when earlier tickets are skipped", async () => {
    const statuses = new Map([["01-ticket-01.md", "resolved"], ["02-ticket-02.md", "ready-for-agent"]]);
    const fake = fakeSessionFactory({
      responses: ["implemented", COMPLETE],
      onPrompt: ({ promptIndex }) => {
        if (promptIndex === 1) statuses.set("02-ticket-02.md", "resolved");
      },
    });
    const frames = frameRecorder();

    await runTickets(
      options({
        inventory: inventory(ticket("01", "resolved"), ticket("02", "ready-for-agent")),
        createSession: fake.create,
        readStatus: statusReader(statuses),
        observer: frames.observer,
      }),
    );

    assert.deepEqual(frames.started.map((frame) => frame.ticketId), ["02"]);
    assert.deepEqual(frames.settled, ["done"]);
  });
});

describe("runTickets: turn limit", () => {
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

describe("runTickets: interruption", () => {
  it("stops before creating a session when cancellation was already requested", async () => {
    const cancellation = new RunCancellation();
    await cancellation.cancel();
    const fake = fakeSessionFactory({ responses: ["implemented", COMPLETE] });
    const guard = fakeGuard();

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent", "First")),
        createSession: fake.create,
        readStatus: (value) => value.status,
        cancellation,
        openGuard: () => guard,
      }),
    );

    assert.equal(outcome.kind, "stopped");
    assert.equal(outcome.kind === "stopped" ? outcome.stop.kind : undefined, "interrupted");
    assert.equal(
      outcome.kind === "stopped" && outcome.stop.kind === "interrupted"
        ? outcome.stop.ticket.id
        : undefined,
      "01",
    );
    assert.equal(outcome.kind === "stopped" ? outcome.remainingRunnable : -1, 1);
    assert.equal(fake.sessions.length, 0);
    assert.equal(guard.released, 1);
  });

  it("cancels during the implementation prompt without sending the gate or advancing", async () => {
    const cancellation = new RunCancellation();
    const statuses = new Map([
      ["01-ticket-01.md", "ready-for-agent"],
      ["02-ticket-02.md", "ready-for-agent"],
    ]);
    const fake = fakeSessionFactory({
      responses: ["implemented", COMPLETE],
      onPrompt: async ({ promptIndex }) => {
        if (promptIndex === 0) await cancellation.cancel();
      },
    });

    const outcome = await runTickets(
      options({
        inventory: inventory(
          ticket("01", "ready-for-agent", "First"),
          ticket("02", "ready-for-agent", "Second"),
        ),
        createSession: fake.create,
        readStatus: statusReader(statuses),
        cancellation,
      }),
    );

    assert.equal(outcome.kind, "stopped");
    assert.equal(outcome.kind === "stopped" ? outcome.stop.kind : undefined, "interrupted");
    assert.equal(
      outcome.kind === "stopped" && outcome.stop.kind === "interrupted"
        ? outcome.stop.ticket.id
        : undefined,
      "01",
    );
    assert.deepEqual(outcome.kind === "stopped" ? ranIds(outcome.ran) : [], []);
    assert.equal(outcome.kind === "stopped" ? outcome.remainingRunnable : -1, 2);

    const session = fake.sessions[0];
    assert.ok(session);
    assert.equal(session.prompts.length, 1, "the completion gate must not be sent");
    assert.equal(session.aborted, 1);
    assert.equal(session.disposed, 1);
    assert.equal(session.unsubscribed, 1);
    assert.equal(session.sessionFile, "/sessions/1.jsonl");
    assert.equal(fake.sessions.length, 1);
  });

  it("clears the active run state so main-session input can resume", async () => {
    const cancellation = new RunCancellation();
    const state = new TicketRunState();
    const fake = fakeSessionFactory({
      responses: ["implemented", COMPLETE],
      onPrompt: async ({ promptIndex }) => {
        if (promptIndex === 0) await cancellation.cancel();
      },
    });

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent", "First")),
        createSession: fake.create,
        readStatus: (value) => value.status,
        cancellation,
        state,
      }),
    );

    assert.equal(outcome.kind, "stopped");
    assert.equal(state.active, undefined);
    assert.equal(state.lastFolder, "issues");
  });

  it("cancels during the completion gate and leaves the ticket runnable", async () => {
    const cancellation = new RunCancellation();
    const statuses = new Map([["01-ticket-01.md", "ready-for-agent"]]);
    const fake = fakeSessionFactory({
      responses: ["implemented", COMPLETE],
      onPrompt: async ({ promptIndex }) => {
        if (promptIndex === 1) await cancellation.cancel();
      },
    });

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent", "First")),
        createSession: fake.create,
        readStatus: statusReader(statuses),
        cancellation,
      }),
    );

    assert.equal(outcome.kind, "stopped");
    assert.equal(outcome.kind === "stopped" ? outcome.stop.kind : undefined, "interrupted");
    assert.deepEqual(outcome.kind === "stopped" ? ranIds(outcome.ran) : [], []);
    assert.equal(outcome.kind === "stopped" ? outcome.remainingRunnable : -1, 1);
    assert.equal(fake.sessions[0]?.prompts.length, 2);
    assert.equal(fake.sessions[0]?.aborted, 1);
    assert.equal(fake.sessions[0]?.disposed, 1);
    assert.equal(statuses.get("01-ticket-01.md"), "ready-for-agent");
  });

  it("cancels between tickets and does not start the next one", async () => {
    const cancellation = new RunCancellation();
    const statuses = new Map([
      ["01-ticket-01.md", "ready-for-agent"],
      ["02-ticket-02.md", "ready-for-agent"],
    ]);
    const fake = fakeSessionFactory({
      responses: ["implemented", COMPLETE],
      onPrompt: ({ promptIndex }) => {
        if (promptIndex === 1) statuses.set("01-ticket-01.md", "resolved");
      },
    });

    const outcome = await runTickets(
      options({
        inventory: inventory(
          ticket("01", "ready-for-agent", "First"),
          ticket("02", "ready-for-agent", "Second"),
        ),
        createSession: fake.create,
        readStatus: statusReader(statuses),
        cancellation,
        onProgress: () => {
          void cancellation.cancel();
        },
      }),
    );

    assert.equal(outcome.kind, "stopped");
    assert.equal(outcome.kind === "stopped" ? outcome.stop.kind : undefined, "interrupted");
    assert.equal(
      outcome.kind === "stopped" && outcome.stop.kind === "interrupted"
        ? outcome.stop.ticket.id
        : undefined,
      "02",
    );
    assert.deepEqual(outcome.kind === "stopped" ? ranIds(outcome.ran) : [], ["01"]);
    assert.equal(outcome.kind === "stopped" ? outcome.remainingRunnable : -1, 1);
    assert.equal(fake.sessions.length, 1);
    assert.equal(statuses.get("02-ticket-02.md"), "ready-for-agent");
  });

  it("stops when cancellation arrives while the child session is being created", async () => {
    const cancellation = new RunCancellation();
    const fake = fakeSessionFactory({ responses: ["implemented", COMPLETE] });

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent", "First")),
        createSession: async (sessionOptions) => {
          const session = await fake.create(sessionOptions);
          await cancellation.cancel();
          return session;
        },
        readStatus: (value) => value.status,
        cancellation,
      }),
    );

    assert.equal(outcome.kind, "stopped");
    assert.equal(outcome.kind === "stopped" ? outcome.stop.kind : undefined, "interrupted");
    assert.equal(
      outcome.kind === "stopped" && outcome.stop.kind === "interrupted"
        ? outcome.stop.ticket.id
        : undefined,
      "01",
    );
    assert.equal(fake.sessions[0]?.prompts.length, 0);
    assert.equal(fake.sessions[0]?.aborted, 1);
    assert.equal(fake.sessions[0]?.disposed, 1);
    assert.equal(fake.sessions[0]?.subscribed, 0);
  });

  it("removes the subscription, waits for the abort, disposes, then releases the lock", async () => {
    const cancellation = new RunCancellation();
    const order: string[] = [];
    const fake = fakeSessionFactory({
      responses: ["implemented", COMPLETE],
      order,
      onPrompt: async ({ promptIndex }) => {
        if (promptIndex === 0) await cancellation.cancel();
      },
    });
    const guard = fakeGuard();
    const release = guard.release.bind(guard);
    guard.release = () => {
      order.push("release");
      release();
    };

    const outcome = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent", "First")),
        createSession: fake.create,
        readStatus: (value) => value.status,
        cancellation,
        openGuard: () => guard,
      }),
    );

    assert.equal(outcome.kind, "stopped");
    assert.deepEqual(order, ["abort", "unsubscribe", "dispose", "release"]);
  });

  it("leaves an interrupted ticket eligible for the next start", async () => {
    const cancellation = new RunCancellation();
    const statuses = new Map([["01-ticket-01.md", "ready-for-agent"]]);
    const first = fakeSessionFactory({
      responses: ["implemented", COMPLETE],
      onPrompt: async ({ promptIndex }) => {
        if (promptIndex === 0) await cancellation.cancel();
      },
    });

    const interrupted = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent", "First")),
        createSession: first.create,
        readStatus: statusReader(statuses),
        cancellation,
      }),
    );

    assert.equal(interrupted.kind, "stopped");
    assert.equal(statuses.get("01-ticket-01.md"), "ready-for-agent");

    const second = fakeSessionFactory({
      responses: ["implemented", COMPLETE],
      onPrompt: ({ promptIndex }) => {
        if (promptIndex === 1) statuses.set("01-ticket-01.md", "resolved");
      },
    });

    const resumed = await runTickets(
      options({
        inventory: inventory(ticket("01", "ready-for-agent", "First")),
        createSession: second.create,
        readStatus: statusReader(statuses),
      }),
    );

    assert.equal(second.sessions.length, 1);
    assert.equal(second.sessions[0]?.prompts[0], "/skill:implement issues/01-ticket-01.md");
    assert.equal(resumed.kind, "finished");
    assert.deepEqual(resumed.kind === "finished" ? ranIds(resumed.ran) : [], ["01"]);
  });
});
