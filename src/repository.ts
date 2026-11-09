import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { errorMessage, hasErrorCode, TicketRunnerError } from "./errors.ts";

/** Repository-relative location of the execution lock. */
export const LOCK_RELATIVE_PATH = join(".pi", "ticket-runner.lock");

/** Recovery instruction reported for every stale lock. */
export const LOCK_REMOVAL_COMMAND = "rm .pi/ticket-runner.lock";

/** The coordination record stored in the execution lock. */
export interface ExecutionLockRecord {
  readonly pid: number;
  readonly cwd: string;
  readonly startedAt: string;
  readonly ticketFolder: string;
}

/** A held repository execution lock. */
export interface ExecutionLock {
  readonly path: string;
  readonly record: ExecutionLockRecord;
  /** Remove the lock. Safe to call more than once. */
  release(): void;
}

/** Options for {@link acquireExecutionLock}. */
export interface AcquireExecutionLockOptions {
  /** Project working directory; the lock lives under its `.pi/` directory. */
  readonly cwd: string;
  /** Ticket folder label as supplied by the user. */
  readonly ticketFolder: string;
  /** Age after which an unreadable-PID lock is described as past the stale threshold. */
  readonly staleLockHours: number;
  /** Clock seam for tests. */
  readonly now?: (() => Date) | undefined;
  /** Process-liveness seam for tests. */
  readonly isProcessAlive?: ((pid: number) => boolean) | undefined;
}

/**
 * Acquire the repository execution lock with an exclusive create.
 *
 * A pre-existing lock is never replaced: a live PID refuses the run and names
 * the PID, while a dead or unreadable PID is reported as stale with the exact
 * removal instruction. Stale lock files are left on disk deliberately so the
 * user decides when to remove them.
 */
export function acquireExecutionLock(options: AcquireExecutionLockOptions): ExecutionLock {
  const cwd = resolve(options.cwd);
  const lockPath = join(cwd, LOCK_RELATIVE_PATH);
  const record: ExecutionLockRecord = {
    pid: process.pid,
    cwd,
    startedAt: (options.now?.() ?? new Date()).toISOString(),
    ticketFolder: options.ticketFolder,
  };
  const serialized = `${JSON.stringify(record)}\n`;

  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch (error) {
    throw new TicketRunnerError(
      `Cannot create the repository lock directory ${dirname(lockPath)}: ${errorMessage(error)}`,
    );
  }

  try {
    writeFileSync(lockPath, serialized, { flag: "wx" });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw new TicketRunnerError(`Cannot create repository lock ${lockPath}: ${errorMessage(error)}`);
    }
    refuseExistingLock(
      lockPath,
      options.staleLockHours,
      options.isProcessAlive ?? isProcessAlive,
      options.now ?? (() => new Date()),
    );
  }

  let released = false;
  return {
    path: lockPath,
    record,
    release() {
      if (released) return;
      released = true;

      // Only remove a lock that still contains exactly the record this run
      // wrote. A lock replaced by another process is not ours to delete.
      try {
        if (readFileSync(lockPath, "utf8") !== serialized) return;
        unlinkSync(lockPath);
      } catch {
        // ENOENT means it is already released; any other failure leaves the
        // stale lock for the user rather than masking the run's outcome.
      }
    },
  };
}

function refuseExistingLock(
  lockPath: string,
  staleLockHours: number,
  isAlive: (pid: number) => boolean,
  now: () => Date,
): never {
  const existing = readExistingLock(lockPath);
  const age = lockAgeHours(lockPath, now);

  if (existing) {
    if (isAlive(existing.pid)) {
      throw new TicketRunnerError(
        `Repository lock is held by live PID ${existing.pid} at ${lockPath}. ` +
          "A ticket run is already active in this repository; stop it before starting another run.",
      );
    }

    throw new TicketRunnerError(
      `Repository lock is stale at ${lockPath}: PID ${existing.pid} is no longer running.` +
        ageSuffix(age, staleLockHours) +
        ` It was not removed automatically. Remove it before starting: ${LOCK_REMOVAL_COMMAND}`,
    );
  }

  throw new TicketRunnerError(
    `Repository lock is stale at ${lockPath}: it has an unreadable PID.` +
      ageSuffix(age, staleLockHours) +
      ` It was not removed automatically. Remove it before starting: ${LOCK_REMOVAL_COMMAND}`,
  );
}

function readExistingLock(lockPath: string): { readonly pid: number } | undefined {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const pid = parsed.pid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
    return { pid };
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM");
  }
}

function lockAgeHours(lockPath: string, now: () => Date): number | undefined {
  try {
    const age = (now().getTime() - statSync(lockPath).mtimeMs) / 3_600_000;
    return Math.max(0, age);
  } catch {
    return undefined;
  }
}

function ageSuffix(ageHours: number | undefined, staleLockHours: number): string {
  if (ageHours === undefined) return "";
  const hours = ageHours.toFixed(1);
  return ageHours >= staleLockHours
    ? ` The lock file is ${hours}h old, past the ${staleLockHours}h stale threshold.`
    : ` The lock file is ${hours}h old.`;
}

/** The branch and HEAD a run was preflighted against. */
export interface GitState {
  /** Absolute repository root. */
  readonly root: string;
  readonly branch: string;
  readonly head: string;
}

/** One working-tree change reported by Git. */
export interface WorkingTreeChange {
  /** Two-character porcelain status, for example `M `, `??`, or `R `. */
  readonly status: string;
  /** Repository-relative path after the change. */
  readonly path: string;
  /** Repository-relative source path for a rename or copy. */
  readonly previousPath: string | undefined;
}

/** What moved since preflight, or why the current state could not be read. */
export interface GitStateChange {
  readonly expected: GitState;
  readonly actual: GitState | undefined;
  readonly error: string | undefined;
}

/**
 * The preflight result a run holds for its whole lifetime.
 *
 * It represents exclusive access to the repository plus the branch and HEAD the
 * run started from. Releasing it removes the execution lock.
 */
export interface RepositoryGuard {
  /** The branch and HEAD the next ticket is checked against. */
  readonly git: GitState;
  /** Undefined when branch and HEAD still match the recorded state. */
  checkUnchanged(): GitStateChange | undefined;
  /**
   * Accept commits made by this run's child on the same branch.
   *
   * The implement skill commits every ticket to the current branch, so a
   * completed ticket legitimately advances HEAD. Accepting that advance keeps
   * the next check focused on work the runner did not make. A branch change or
   * an unreadable state is still reported as a change.
   */
  acceptHead(): GitStateChange | undefined;
  release(): void;
}

/** Options for opening a {@link RepositoryGuard}. */
export interface OpenRepositoryGuardOptions {
  /** Project working directory. */
  readonly cwd: string;
  /** Ticket folder label as supplied by the user. */
  readonly ticketFolder: string;
  /** Absolute path of the ticket folder; changes inside it are always allowed. */
  readonly ticketFolderPath: string;
  /** Suppress only the unrelated-changes refusal. */
  readonly allowDirty: boolean;
  readonly staleLockHours: number;
  /** Clock seam for lock tests. */
  readonly now?: (() => Date) | undefined;
  /** Process-liveness seam for lock tests. */
  readonly isProcessAlive?: ((pid: number) => boolean) | undefined;
}

/** Factory seam used by the runner and its tests. */
export type RepositoryGuardFactory = (options: OpenRepositoryGuardOptions) => RepositoryGuard;

/**
 * Acquire the repository lock and run preflight checks.
 *
 * The lock is taken first and released if any check refuses the run, so a
 * failed start never leaks the lock. Preflight verifies that the working
 * directory is a Git repository, records branch and HEAD, and refuses changes
 * outside the supplied ticket folder unless `allowDirty` is set. The runner's
 * own lock file is ignored by the dirty check.
 */
export function openRepositoryGuard(options: OpenRepositoryGuardOptions): RepositoryGuard {
  const lock = acquireExecutionLock({
    cwd: options.cwd,
    ticketFolder: options.ticketFolder,
    staleLockHours: options.staleLockHours,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.isProcessAlive === undefined ? {} : { isProcessAlive: options.isProcessAlive }),
  });

  try {
    const git = readGitState(options.cwd);
    if (!options.allowDirty) {
      refuseUnrelatedChanges(options, git, lock.path);
    }

    let baseline = git;
    const compare = (): GitStateChange | undefined => {
      try {
        const actual = readGitState(options.cwd);
        if (actual.branch === baseline.branch && actual.head === baseline.head) return undefined;
        return { expected: baseline, actual, error: undefined };
      } catch (error) {
        return { expected: baseline, actual: undefined, error: errorMessage(error) };
      }
    };

    return {
      get git() {
        return baseline;
      },
      checkUnchanged: compare,
      acceptHead() {
        const change = compare();
        if (change === undefined) return undefined;
        if (change.error !== undefined || change.actual === undefined) return change;
        if (change.actual.branch !== baseline.branch) return change;
        baseline = change.actual;
        return undefined;
      },
      release() {
        lock.release();
      },
    };
  } catch (error) {
    lock.release();
    throw error;
  }
}

/** Read the repository root, current branch, and HEAD. */
export function readGitState(cwd: string): GitState {
  let root: string;
  try {
    root = gitOutput(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new TicketRunnerError(`Working directory is not a Git repository: ${cwd}`);
  }

  if (root.length === 0) {
    throw new TicketRunnerError(`Working directory is not a Git repository: ${cwd}`);
  }

  try {
    const branch = gitOutput(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    const head = gitOutput(cwd, ["rev-parse", "HEAD"]).trim();
    return { root: resolve(root), branch, head };
  } catch (error) {
    throw new TicketRunnerError(
      `Cannot read the current branch and HEAD in ${cwd}: ${gitFailure(error)}`,
    );
  }
}

/**
 * List every modified, staged, and untracked path in a repository.
 *
 * Renames and copies include their source path so the working-tree policy can
 * detect a change that touches files both inside and outside the ticket folder.
 */
export function readWorkingTreeChanges(repositoryRoot: string): WorkingTreeChange[] {
  let output: string;
  try {
    output = gitOutput(repositoryRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
  } catch (error) {
    throw new TicketRunnerError(
      `Cannot read the working tree in ${repositoryRoot}: ${gitFailure(error)}`,
    );
  }

  const tokens = output.split("\0");
  if (tokens[tokens.length - 1] === "") tokens.pop();

  const changes: WorkingTreeChange[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index] ?? "";
    if (entry.length < 3) continue;

    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    const renamed = status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C";
    if (renamed) {
      const previousPath = tokens[index + 1];
      index += 1;
      changes.push({ status, path, previousPath });
      continue;
    }

    changes.push({ status, path, previousPath: undefined });
  }
  return changes;
}

function refuseUnrelatedChanges(
  options: OpenRepositoryGuardOptions,
  git: GitState,
  lockPath: string,
): void {
  const ticketFolderPath = canonicalPath(options.ticketFolderPath);
  const ignoredLockPath = canonicalPath(lockPath);

  const outside = readWorkingTreeChanges(git.root).filter((change) => {
    const paths = [change.path];
    if (change.previousPath !== undefined) paths.push(change.previousPath);

    return paths.some((path) => {
      const absolute = canonicalPath(resolve(git.root, path));
      if (absolute === ignoredLockPath) return false;
      return !isInside(ticketFolderPath, absolute);
    });
  });

  if (outside.length === 0) return;

  const lines = outside.map(formatChange);
  throw new TicketRunnerError(
    `Refusing to start: the working tree has changes outside the ticket folder ` +
      `${options.ticketFolder}:\n${lines.join("\n")}\n` +
      "Commit, stash, or discard them first, or pass --allow-dirty to start anyway.",
  );
}

function formatChange(change: WorkingTreeChange): string {
  const status = change.status.trim() || "?";
  const previous = change.previousPath === undefined ? "" : ` (from ${change.previousPath})`;
  return `  ${status} ${change.path}${previous}`;
}

function isInside(folder: string, path: string): boolean {
  const relativePath = relative(folder, path);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function gitOutput(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitFailure(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim().length > 0) return stderr.trim();
    if (Buffer.isBuffer(stderr) && stderr.length > 0) return stderr.toString("utf8").trim();
  }
  return errorMessage(error);
}
