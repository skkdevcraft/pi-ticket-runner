/**
 * The repository's completed status value. The runner never writes it; the
 * completion gate names it so the child can update the ticket file using the
 * project's existing convention.
 */
export const COMPLETED_STATUS = "resolved";

/** Statuses a gate answer may use. Vocabulary outside this set is never success. */
export type GateStatus = "COMPLETE" | "INCOMPLETE" | "BLOCKED";

/** A recognized gate answer. */
export interface CompleteGateDecision {
  readonly kind: "complete";
  readonly status: "COMPLETE";
  readonly reason: string;
}

export interface IncompleteGateDecision {
  readonly kind: "incomplete";
  readonly status: "INCOMPLETE";
  readonly reason: string;
}

export interface BlockedGateDecision {
  readonly kind: "blocked";
  readonly status: "BLOCKED";
  readonly reason: string;
}

export type GateDecision =
  | CompleteGateDecision
  | IncompleteGateDecision
  | BlockedGateDecision;

/** An unusable gate answer. The run always stops on one of these. */
export interface MalformedGateDecision {
  readonly kind: "malformed";
  readonly reason: string;
  /** The final assistant message exactly as read from the child session. */
  readonly text: string | undefined;
}

export type GateResult = GateDecision | MalformedGateDecision;

/** Matches a status line with optional emphasis and code formatting. */
const STATUS_LINE_PATTERN =
  /^\s*(?:[-*+]\s+)?(?:[`~*_]+)?\s*STATUS\s*:\s*(?:[`~*_]+)?\s*(.*?)\s*$/i;

/** Matches a reason line with optional emphasis. */
const REASON_LINE_PATTERN =
  /^\s*(?:[-*+]\s+)?(?:[`~*_]+)?\s*REASON\s*:\s*(?:[`~*_]+)?\s*(.*?)\s*$/i;

const RECOGNIZED_STATUSES: readonly GateStatus[] = ["COMPLETE", "INCOMPLETE", "BLOCKED"];

/**
 * Build the single follow-up prompt that asks the child to assess completion
 * and persist the ticket status.
 */
export function buildCompletionGatePrompt(
  ticketReference: string,
  runnableStatuses: readonly string[],
  completedStatus = COMPLETED_STATUS,
): string {
  return `Review your implementation of ${ticketReference}.

Determine whether the ticket is fully implemented
according to its acceptance criteria.

Confirm that all required verification has passed,
including the tests, typechecking, code review,
and commit steps required by the implement skill.

If the ticket is fully complete:

1. Update the ticket's Status line so it is no longer
   any of: ${runnableStatuses.join(", ")}.
   This repository's completed value is \`${completedStatus}\`.
   Preserve the rest of the ticket file format.
   Do not introduce a new status convention.

2. If the ticket file is tracked by Git, ensure the
   final status update is committed.

Then respond with exactly:

STATUS: COMPLETE | INCOMPLETE | BLOCKED
REASON: <brief explanation>

Use COMPLETE only when the ticket is fully implemented,
required verification has passed, and its persisted
ticket status has been updated successfully.

Use INCOMPLETE if work remains or verification failed.

Use BLOCKED if the ticket cannot be completed without
external intervention.

Do not claim COMPLETE if any required condition is unmet.`;
}

/**
 * Parse the final assistant message of the completion gate.
 *
 * The last `STATUS:` line decides. Emphasis and code fences are formatting,
 * not vocabulary: unknown values, missing answers, and contradictions stop the
 * run rather than being treated as success.
 */
export function parseGateResult(text: string | undefined): GateResult {
  const statuses: string[] = [];
  let reason = "";

  for (const line of (text ?? "").split(/\r?\n/)) {
    const status = STATUS_LINE_PATTERN.exec(line);
    if (status) statuses.push(cleanMarkdown(status[1] ?? ""));

    const reasonMatch = REASON_LINE_PATTERN.exec(line);
    if (reasonMatch) reason = cleanMarkdown(reasonMatch[1] ?? "");
  }

  if (statuses.length === 0) {
    return { kind: "malformed", reason: "The gate returned no STATUS: line.", text };
  }

  const distinct = [...new Set(statuses.map((value) => value.toUpperCase()))];
  if (distinct.length > 1) {
    return {
      kind: "malformed",
      reason: `The gate returned contradictory statuses: ${distinct.join(", ")}.`,
      text,
    };
  }

  const value = statuses[statuses.length - 1] ?? "";
  const status = value.toUpperCase();
  if (!isGateStatus(status)) {
    return {
      kind: "malformed",
      reason: `The gate returned an unrecognized status: ${value || "(empty)"}.`,
      text,
    };
  }

  switch (status) {
    case "COMPLETE":
      return { kind: "complete", status, reason };
    case "INCOMPLETE":
      return { kind: "incomplete", status, reason };
    case "BLOCKED":
      return { kind: "blocked", status, reason };
  }
}

function isGateStatus(value: string): value is GateStatus {
  return (RECOGNIZED_STATUSES as readonly string[]).includes(value);
}

function cleanMarkdown(value: string): string {
  return value
    .trim()
    .replace(/^[`~*_]+/, "")
    .replace(/[`~*_]+$/, "")
    .trim();
}
