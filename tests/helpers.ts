import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { RepaintClock } from "../src/live-view.ts";
import type { ChildEvent } from "../src/sessions.ts";

/** A throwaway directory tree for filesystem tests. */
export interface TempTree {
  readonly root: string;
  /** Write a file, creating parent directories. Returns its absolute path. */
  write(relativePath: string, content: string): string;
  /** Create a directory, including parents. Returns its absolute path. */
  mkdir(relativePath: string): string;
  /** Resolve a path inside the tree. */
  path(relativePath: string): string;
}

export function createTempTree(): TempTree {
  const root = mkdtempSync(join(tmpdir(), "pi-ticket-runner-"));
  return {
    root,
    write(relativePath, content) {
      const fullPath = join(root, relativePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, "utf8");
      return fullPath;
    },
    mkdir(relativePath) {
      const fullPath = join(root, relativePath);
      mkdirSync(fullPath, { recursive: true });
      return fullPath;
    },
    path(relativePath) {
      return join(root, relativePath);
    },
  };
}

/** Run a Git command in a directory and return its stdout. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Initialise a Git repository with a deterministic local identity. */
export function initGitRepo(root: string, branch = "main"): void {
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", `refs/heads/${branch}`);
  git(root, "config", "user.email", "ticket-runner@example.com");
  git(root, "config", "user.name", "Ticket Runner Tests");
}

/** Stage and commit everything in a repository. */
export function commitAll(root: string, message = "initial"): void {
  git(root, "add", "-A");
  git(root, "commit", "-qm", message);
}

/** Mark a path unreadable for the current process. */
export function makeUnreadable(path: string): void {
  chmodSync(path, 0o000);
}

/** True when permission bits are enforced (false when running as root). */
export function permissionsAreEnforced(): boolean {
  return typeof process.getuid === "function" && process.getuid() !== 0;
}

/** A minimal ticket file with a status line and an optional heading. */
export function ticketMarkdown(options: {
  status?: string;
  title?: string;
  body?: string;
} = {}): string {
  const title = options.title ?? "# 01: Example ticket";
  const status = options.status ?? "Status: ready-for-agent";
  return [title, "", status, "", options.body ?? "Do the thing.", ""].join("\n");
}

/** A manual clock with controllable scheduled callbacks. */
export interface FakeClock {
  /** The clock seam handed to a throttled repainter. */
  readonly clock: RepaintClock;
  now(): number;
  /** Move time forward, running due callbacks in order. */
  advance(ms: number): void;
  /** Number of callbacks still scheduled. */
  readonly pending: number;
}

export function createFakeClock(start = 0): FakeClock {
  let current = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();

  const clock: RepaintClock = {
    now: () => current,
    schedule(callback, delayMs) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: current + Math.max(0, delayMs), callback });
      return () => {
        timers.delete(id);
      };
    },
  };

  return {
    clock,
    now: () => current,
    advance(ms) {
      const target = current + ms;
      for (;;) {
        let dueId: number | undefined;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < dueAt) {
            dueId = id;
            dueAt = timer.at;
          }
        }
        if (dueId === undefined) break;
        const timer = timers.get(dueId);
        timers.delete(dueId);
        if (timer === undefined) continue;
        current = timer.at;
        timer.callback();
      }
      current = target;
    },
    get pending() {
      return timers.size;
    },
  };
}

/** A streamed assistant text delta, as the child session emits it. */
export function textDelta(delta: string): ChildEvent {
  return {
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
  } as unknown as ChildEvent;
}

/** A tool starting, as the child session emits it. */
export function toolStart(name: string): ChildEvent {
  return {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: name,
    args: {},
  } as unknown as ChildEvent;
}

/** A tool finishing, as the child session emits it. */
export function toolEnd(name: string, isError = false): ChildEvent {
  return {
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: name,
    result: {},
    isError,
  } as unknown as ChildEvent;
}

/** One completed child turn. */
export function turnEnd(): ChildEvent {
  return {
    type: "turn_end",
    message: { role: "assistant", content: [] },
    toolResults: [],
  } as unknown as ChildEvent;
}

/** A settled child run. */
export function settled(): ChildEvent {
  return { type: "agent_settled", aborted: false };
}
