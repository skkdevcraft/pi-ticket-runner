import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
