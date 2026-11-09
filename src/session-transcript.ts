import { existsSync, statSync } from "node:fs";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { errorMessage } from "./errors.ts";
import { projectTranscript, type TranscriptEntry } from "./transcript.ts";

/** Loading a settled frame's child transcript can succeed or degrade visibly. */
export type SessionTranscript =
  | { readonly kind: "loaded"; readonly entries: readonly TranscriptEntry[] }
  | { readonly kind: "unavailable"; readonly reason: string };

/** Seam for opening a persisted child session file, injectable in tests. */
export type SessionTranscriptLoader = (sessionFile: string | undefined) => SessionTranscript;

/**
 * Open a persisted child session and project its display transcript.
 *
 * This is the only place a settled frame reads the child session file. It uses
 * Pi's public session-opening API and never throws: a missing, unreadable, or
 * malformed file becomes a visible unavailable entry instead.
 */
export function openSessionTranscript(sessionFile: string | undefined): SessionTranscript {
  if (sessionFile === undefined) {
    return unavailable("session file not recorded");
  }

  try {
    if (!existsSync(sessionFile)) return unavailable("session file not found");

    // Pi initializes an empty file with a header when opened. A zero-byte file
    // is already an empty session, so report that without touching it.
    if (statSync(sessionFile).size === 0) {
      return { kind: "loaded", entries: [] };
    }

    const manager = SessionManager.open(sessionFile);
    return { kind: "loaded", entries: projectTranscript(manager.getBranch()) };
  } catch (error) {
    return unavailable(errorMessage(error));
  }
}

function unavailable(reason: string): SessionTranscript {
  return { kind: "unavailable", reason: compact(reason) || "session file could not be read" };
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
