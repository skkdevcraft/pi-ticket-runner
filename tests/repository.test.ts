import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { TicketRunnerError } from "../src/errors.ts";
import {
  acquireExecutionLock,
  LOCK_REMOVAL_COMMAND,
  openRepositoryGuard,
  readGitState,
  readWorkingTreeChanges,
  type OpenRepositoryGuardOptions,
} from "../src/repository.ts";
import { commitAll, createTempTree, git, initGitRepo, ticketMarkdown } from "./helpers.ts";

function guardOptions(
  tree: ReturnType<typeof createTempTree>,
  overrides: Partial<OpenRepositoryGuardOptions> = {},
): OpenRepositoryGuardOptions {
  return {
    cwd: tree.root,
    ticketFolder: "issues",
    ticketFolderPath: tree.path("issues"),
    allowDirty: false,
    staleLockHours: 12,
    ...overrides,
  };
}

function lockPath(tree: ReturnType<typeof createTempTree>): string {
  return tree.path(".pi/ticket-runner.lock");
}

function repoTree(): ReturnType<typeof createTempTree> {
  const tree = createTempTree();
  tree.write("issues/01-first.md", ticketMarkdown());
  tree.write("src/app.ts", "initial\n");
  initGitRepo(tree.root);
  commitAll(tree.root);
  return tree;
}

describe("execution lock", () => {
  it("is created exclusively with the PID, working directory, start time, and ticket folder", () => {
    const tree = createTempTree();

    const lock = acquireExecutionLock({
      cwd: tree.root,
      ticketFolder: ".scratch/auth/issues",
      staleLockHours: 12,
    });

    assert.equal(lock.path, lockPath(tree));
    const record = JSON.parse(readFileSync(lock.path, "utf8")) as {
      pid: number;
      cwd: string;
      startedAt: string;
      ticketFolder: string;
    };
    assert.equal(record.pid, process.pid);
    assert.equal(record.cwd, resolve(tree.root));
    assert.equal(record.ticketFolder, ".scratch/auth/issues");
    assert.match(record.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    lock.release();
    assert.equal(existsSync(lockPath(tree)), false);
    lock.release();
  });

  it("refuses a lock held by a live PID and names it", () => {
    const tree = createTempTree();
    tree.write(
      ".pi/ticket-runner.lock",
      JSON.stringify({
        pid: process.pid,
        cwd: tree.root,
        startedAt: new Date().toISOString(),
        ticketFolder: "issues",
      }),
    );

    assert.throws(
      () => acquireExecutionLock({ cwd: tree.root, ticketFolder: "issues", staleLockHours: 12 }),
      (error: unknown) =>
        error instanceof TicketRunnerError &&
        /live PID/.test(error.message) &&
        error.message.includes(String(process.pid)),
    );
    assert.equal(existsSync(lockPath(tree)), true);
  });

  it("refuses a second acquisition while this process holds the lock", () => {
    const tree = createTempTree();
    const lock = acquireExecutionLock({
      cwd: tree.root,
      ticketFolder: "issues",
      staleLockHours: 12,
    });

    assert.throws(
      () => acquireExecutionLock({ cwd: tree.root, ticketFolder: "issues", staleLockHours: 12 }),
      /live PID/,
    );

    lock.release();
  });

  it("reports a dead-PID lock as stale with the removal instruction and never deletes it", () => {
    const tree = createTempTree();
    const content = JSON.stringify({
      pid: 987654,
      cwd: tree.root,
      startedAt: new Date().toISOString(),
      ticketFolder: "issues",
    });
    tree.write(".pi/ticket-runner.lock", content);

    assert.throws(
      () =>
        acquireExecutionLock({
          cwd: tree.root,
          ticketFolder: "issues",
          staleLockHours: 12,
          isProcessAlive: () => false,
        }),
      (error: unknown) =>
        error instanceof TicketRunnerError &&
        /stale/.test(error.message) &&
        error.message.includes(LOCK_REMOVAL_COMMAND),
    );

    assert.equal(readFileSync(lockPath(tree), "utf8"), content);
  });

  it("reports an unreadable lock as stale with the removal instruction and never deletes it", () => {
    const tree = createTempTree();
    tree.write(".pi/ticket-runner.lock", "not a lock record");

    assert.throws(
      () => acquireExecutionLock({ cwd: tree.root, ticketFolder: "issues", staleLockHours: 12 }),
      (error: unknown) =>
        error instanceof TicketRunnerError &&
        /stale/.test(error.message) &&
        /unreadable PID/.test(error.message) &&
        error.message.includes(LOCK_REMOVAL_COMMAND),
    );

    assert.equal(readFileSync(lockPath(tree), "utf8"), "not a lock record");
  });
});

describe("git state", () => {
  it("records the repository root, current branch, and HEAD", () => {
    const tree = repoTree();

    const state = readGitState(tree.root);

    assert.equal(state.root, resolve(tree.root));
    assert.equal(state.branch, "main");
    assert.match(state.head, /^[0-9a-f]{40}$/);
  });

  it("rejects a directory that is not a Git repository", () => {
    const tree = createTempTree();

    assert.throws(
      () => readGitState(tree.root),
      (error: unknown) =>
        error instanceof TicketRunnerError && /not a Git repository/.test(error.message),
    );
  });

  it("lists modified, untracked, and renamed paths", () => {
    const tree = repoTree();
    tree.write("src/app.ts", "changed\n");
    tree.write("notes.txt", "new\n");
    git(tree.root, "mv", "src/app.ts", "src/renamed.ts");

    const changes = readWorkingTreeChanges(tree.root);

    assert.deepEqual(
      changes.map((change) => [change.status.trim(), change.path, change.previousPath]),
      [
        ["RM", "src/renamed.ts", "src/app.ts"],
        ["??", "notes.txt", undefined],
      ],
    );
  });
});

describe("repository preflight", () => {
  it("acquires the lock, records git state, and releases cleanly", () => {
    const tree = repoTree();

    const guard = openRepositoryGuard(guardOptions(tree));

    assert.equal(guard.git.branch, "main");
    assert.match(guard.git.head, /^[0-9a-f]{40}$/);
    assert.equal(existsSync(lockPath(tree)), true);
    assert.equal(guard.checkUnchanged(), undefined);

    guard.release();
    assert.equal(existsSync(lockPath(tree)), false);
  });

  it("ignores its own lock file when checking for a dirty working tree", () => {
    const tree = repoTree();

    const guard = openRepositoryGuard(guardOptions(tree));

    guard.release();
  });

  it("refuses changes outside the ticket folder and names every offending path", () => {
    const tree = repoTree();
    tree.write("src/app.ts", "changed\n");
    tree.write("notes.txt", "new\n");

    assert.throws(
      () => openRepositoryGuard(guardOptions(tree)),
      (error: unknown) =>
        error instanceof TicketRunnerError &&
        /outside the ticket folder/.test(error.message) &&
        error.message.includes("src/app.ts") &&
        error.message.includes("notes.txt"),
    );
    assert.equal(existsSync(lockPath(tree)), false);
  });

  it("allows changes inside the ticket folder", () => {
    const tree = repoTree();
    tree.write("issues/01-first.md", ticketMarkdown({ body: "changed in the ticket folder" }));
    tree.write("issues/02-new.md", ticketMarkdown());

    const guard = openRepositoryGuard(guardOptions(tree));

    guard.release();
  });

  it("allows unrelated changes only with --allow-dirty", () => {
    const tree = repoTree();
    tree.write("src/app.ts", "changed\n");

    assert.throws(() => openRepositoryGuard(guardOptions(tree)), /src\/app\.ts/);

    const guard = openRepositoryGuard(guardOptions(tree, { allowDirty: true }));

    guard.release();
  });

  it("still requires a Git repository when --allow-dirty is set", () => {
    const tree = createTempTree();
    tree.write("issues/01-first.md", ticketMarkdown());

    assert.throws(
      () => openRepositoryGuard(guardOptions(tree, { allowDirty: true })),
      (error: unknown) =>
        error instanceof TicketRunnerError && /not a Git repository/.test(error.message),
    );
    assert.equal(existsSync(lockPath(tree)), false);
  });

  it("detects a branch change since preflight", () => {
    const tree = repoTree();
    const guard = openRepositoryGuard(guardOptions(tree));

    git(tree.root, "switch", "-q", "-c", "other");
    const change = guard.checkUnchanged();

    assert.ok(change);
    assert.equal(change.expected.branch, "main");
    assert.equal(change.actual?.branch, "other");
    assert.equal(change.error, undefined);

    guard.release();
  });

  it("detects a HEAD change since preflight", () => {
    const tree = repoTree();
    const guard = openRepositoryGuard(guardOptions(tree));

    tree.write("src/next.ts", "next\n");
    git(tree.root, "add", "src/next.ts");
    git(tree.root, "commit", "-qm", "next");
    const change = guard.checkUnchanged();

    assert.ok(change);
    assert.equal(change.actual?.branch, "main");
    assert.notEqual(change.actual?.head, guard.git.head);

    guard.release();
  });

  it("accepts the child's commit on the same branch as the new baseline", () => {
    const tree = repoTree();
    const guard = openRepositoryGuard(guardOptions(tree));
    const initialHead = guard.git.head;

    tree.write("src/next.ts", "next\n");
    git(tree.root, "add", "src/next.ts");
    git(tree.root, "commit", "-qm", "next");

    assert.ok(guard.checkUnchanged());
    assert.equal(guard.acceptHead(), undefined);
    assert.notEqual(guard.git.head, initialHead);
    assert.equal(guard.checkUnchanged(), undefined);

    guard.release();
  });

  it("does not accept a branch switch as a child commit", () => {
    const tree = repoTree();
    const guard = openRepositoryGuard(guardOptions(tree));

    git(tree.root, "switch", "-q", "-c", "other");
    const change = guard.acceptHead();

    assert.ok(change);
    assert.equal(change.expected.branch, "main");
    assert.equal(change.actual?.branch, "other");
    assert.equal(guard.git.branch, "main");

    guard.release();
  });
});
