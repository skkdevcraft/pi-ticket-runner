# pi-ticket-runner — Extension Specification

> Status: settled via grilling. Supersedes `docs/idea.md` (now a pointer stub).
> Revision: inline session frames replace the live widget (§11). See `docs/adr/0001-inline-session-frames.md`.
> Repo conventions: see `AGENTS.md`, `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`.

## 1. Overview

**pi-ticket-runner** is a Pi extension that executes a folder of tickets sequentially, running each ticket to completion in its own fresh, persistent Pi session.

The main session retains only ticket inventory, progress, and execution status. Implementation details remain in the individual ticket sessions, preventing context window overflow and context quality degradation across long multi-ticket implementations.

**Positioning:** not a general-purpose sub-agent framework, not a ticket generator, and not a ticket-management system.

pi-ticket-runner consumes a folder of local Markdown tickets produced by the installed Matt Pocock skills and executes them sequentially using the `/skill:implement` workflow.

The Matt Pocock skills remain responsible for ticket generation, implementation methodology, and ticket-tracker conventions.

The extension is responsible only for:

- Discovering tickets in a user-supplied folder.
- Reading their ordering and execution status.
- Executing executable tickets sequentially.
- Managing persistent child sessions.
- Displaying live execution progress as inline session frames.
- Stopping when execution fails, is interrupted, or fails the completion gate.

**Core principle:** ticket files are the single persistent source of truth for status. The extension maintains no run log, completion database, or execution-history file.

**Central question:** the extension asks exactly one question of every ticket — *can `/skill:implement` be invoked for it right now?* A ticket whose `Status:` is not in `runnableStatuses` is not executable and is skipped. The extension does not model "completed" as a vocabulary; "not runnable" is the only non-executable state it understands.

---

## 2. Goals

1. **Automatic sequential execution** — execute tickets one at a time, without manual session management.

2. **Automatic starting position** — start from the first runnable ticket, automatically skipping every non-runnable ticket. No selection dialog or confirmation.

3. **Context isolation** — every ticket receives a fresh `AgentSession`. The main session does not accumulate implementation details from child sessions.

4. **Persistent ticket sessions** — every ticket session is saved using Pi's standard persistent session mechanism and remains available through `/resume`. No custom session naming is performed.

5. **Skill-driven implementation** — execute each ticket through the installed `/skill:implement <ticket-reference>` workflow.

6. **Completion gate** — after implementation finishes, send one follow-up prompt to the same child session to determine whether the ticket is complete and whether execution can continue.

7. **Ticket-file status persistence** — the child session records completion in the existing ticket file using the project's ticket-tracker conventions. No separate run state is persisted.

8. **Live TUI visibility** — render every ticket session as an inline, collapsible session frame in the main Pi transcript, with the active frame updating live.

9. **Interruptible execution** — allow the user to stop the active child session and the entire sequential run.

10. **Dependency-respecting execution** — execute tickets in the numeric order produced by the `to-tickets` skill.

11. **Transparent progress** — show remaining runnable tickets, the current ticket, and the next ticket in the main TUI.

---

## 3. Non-Goals

- Parallel ticket execution.
- Building a general-purpose sub-agent framework.
- Generating tickets or specifications.
- Supporting remote trackers such as GitHub, Linear, or Jira in v1.
- Defining a new ticket file format.
- Implementing a general-purpose Markdown ticket parser.
- Parsing `Blocked by:` relationships or resolving dependency graphs.
- Detecting cycles or computing dependency frontiers.
- Distinguishing completed, wontfix, human-owned, and triage-pending tickets from one another.
- Reimplementing the `implement` skill.
- Independently verifying every ticket acceptance criterion.
- Maintaining a separate run log, completion database, or execution-history file.
- Automatically resuming an interrupted child session.
- Custom naming or renaming of Pi sessions.
- Binding `Esc` to child-session cancellation.
- Git worktree isolation or automatic rollback.
- Custom tool sandboxing or permission management.
- Patching Pi's private TUI internals to group native tool and assistant components.
- Per-frame click targets or independent expansion controls in v1.

---

## 4. Input: Local Ticket Folder

### 4.1 Responsibility Boundary

The extension accepts a folder containing local Markdown tickets produced by the `to-tickets` skill. The expected convention is:

```text
.scratch/<feature>/issues/
    01-database-schema.md
    02-api-endpoints.md
    03-repository-layer.md
    04-integration-tests.md
```

The folder path is supplied explicitly by the user on every invocation. The extension does not discover ticket folders automatically and does not infer `issues/` from a feature directory. A missing or ambiguous path is an error, not a prompt.

Remote tracker integrations are outside the scope of v1.

### 4.2 Required Prerequisites

The project must have:

- Matt Pocock skills installed, including `to-tickets` and `implement`.
- `setup-matt-pocock-skills` completed.
- Local Markdown tracking configured for the project.
- A ticket folder produced using the skills' local ticket conventions.
- A Pi SDK environment capable of creating persistent child sessions.

At execution time the extension verifies that the `implement` skill is discoverable through `pi.getCommands()` (a command named `skill:implement` with `source: "skill"`).

This check is mandatory because Pi's skill expansion is silent on failure: `_expandSkillCommand` returns the original text when no such skill exists, which would send `/skill:implement …` to the model as a plain user message. The extension must never allow that fallback.

If required skills or tracker configuration are missing, the extension stops and reports a descriptive error.

### 4.3 Ticket Discovery

The extension reads the supplied directory and identifies files matching:

```text
<NN>-<slug>.md
```

Where:

- `NN` is one or more digits forming a positive integer.
- `slug` is a nonempty ticket name.
- The filename provides the ticket's execution order.
- The file path provides the reference passed to the implementation skill.

The extension:

1. Resolves the folder path relative to the project working directory.
2. Verifies that the directory exists and is readable.
3. Reads ticket files directly within that directory, without recursive scanning.
4. Extracts the numeric prefix from each recognized filename.
5. Sorts tickets by ascending numeric identifier.
6. Rejects duplicate numeric identifiers (`01-a.md` and `1-b.md` are duplicates).
7. Reads each ticket's status and title.

Unrelated files that do not match the ticket naming pattern are ignored.

If no valid ticket files are found, the extension reports an error.

### 4.4 Ticket Ordering

The `to-tickets` skill creates local tickets in dependency order, with blockers appearing before the tickets they block. pi-ticket-runner relies on this convention.

Execution order is therefore determined exclusively by the numeric filename prefix. The extension does not parse `Blocked by:` lines and does not construct a dependency graph. This is an intentional v1 simplification: the runner assumes tickets were generated and ordered correctly by the skills.

### 4.5 Execution Status

**Ticket files are the sole persistent source of execution status.**

A ticket file has exactly one status line near the top, in either form:

```text
Status: ready-for-agent
```

```text
**Status:** ready-for-agent
```

Values are normalized for comparison by trimming whitespace and lowercasing.

The extension recognizes exactly two classes:

| Class | Values | Behavior |
|---|---|---|
| Executable | any value in `runnableStatuses` (default: `["ready-for-agent"]`) | Eligible to run |
| Not executable | every other value (`resolved`, `ready-for-human`, `needs-triage`, `needs-info`, `wontfix`, `blocked`, `claimed`, unknown, …) | Skipped and reported; never executed |

There is no completion vocabulary, no `completedStatuses` list, and no "unrecognized status" error. A ticket is either runnable now or it is not.

The following are **malformed ticket files** and stop the run before any session is created:

- No `Status:` line.
- More than one `Status:` line.
- An empty status value.

The extension must not guess the status of a malformed file.

The `implement` workflow and the completion gate remain responsible for changing a ticket's status away from the runnable set.

### 4.6 Single Source of Truth

On every `list`, `status`, or `start` invocation, the extension re-reads ticket statuses from disk. It must not rely on completion information cached from a previous run.

After each ticket finishes, the extension re-reads that ticket's status before deciding whether to advance.

No separate execution-state persistence is required.

### 4.7 Ticket Title

The display title comes from the file's first level-one heading, stripped of its number:

```markdown
# 03: Repository Layer
```

→ `Repository Layer`

If no heading is found, the filename slug is used (`repository-layer`). Reading the title costs nothing because the status read already reads the file.

---

## 5. Commands

### 5.1 `/ticket-runner list <ticket-folder>`

Displays the tickets in the supplied folder without executing anything, in numeric order, with a marker for status class and the next ticket:

```text
🎫 Tickets: .scratch/auth/issues

01-database-schema      resolved           skip
02-api-endpoints        resolved           skip
03-repository-layer     ready-for-agent    NEXT ▶
04-integration-tests    ready-for-human    skip

Executable: 1 of 4
Next: 03 Repository Layer
```

If no ticket is runnable:

```text
🎫 Tickets: .scratch/auth/issues

01-database-schema      resolved           skip
02-api-endpoints        resolved           skip
03-repository-layer     resolved           skip

Executable: 0 of 3
Nothing to run.
```

This command:

- Is read-only.
- Creates no Pi sessions.
- Does not invoke the implementation skill.
- Does not modify ticket statuses.
- Displays no selection dialog.
- Fails with a descriptive error on malformed tickets (missing or duplicate status lines).

### 5.2 `/ticket-runner start <ticket-folder> [--allow-dirty]`

Immediately begins sequential execution of every runnable ticket in numeric order.

Behavior:

1. Read and validate the ticket folder.
2. Sort tickets numerically.
3. Read their current statuses.
4. Acquire the repository execution lock (§10.3).
5. Run preflight checks (§10.2).
6. Iterate tickets in numeric order, skipping every non-runnable ticket.
7. Start the first runnable ticket immediately.
8. Continue through subsequent runnable tickets in numeric order.
9. Stop when no runnable tickets remain, an error occurs, the completion gate fails, or the user interrupts.

No TUI selection dialog or confirmation is displayed.

If no ticket is runnable, report:

```text
✅ Nothing to run — no ticket in .scratch/auth/issues is ready-for-agent.
```

No child sessions are created and no lock is held beyond the check.

`--allow-dirty` suppresses only the pre-existing-unrelated-changes refusal in §10.2. It does not weaken any other check.

### 5.3 `/ticket-runner status`

Displays the state of the currently active run.

```text
🎫 Ticket runner active

Folder: .scratch/auth/issues
Position: 03 Repository Layer
Executable remaining: 2 of 5
Session: <session file>
```

When no run is active:

- If a ticket folder was used earlier in this process, re-read it and print the full `list` output followed by `No run active.`
- Otherwise, print `No run active.`

The `status` command never creates sessions and never modifies ticket files.

### 5.4 `/ticket-runner stop`

Stops the active run.

The command must:

1. Set the run's cancellation flag.
2. Abort the current child session and await the abort.
3. Prevent the scheduler from starting another ticket.
4. Remove the child event subscription and dispose the child session.
5. Settle the active session frame as `stopped`; it remains in the transcript.
6. Update the footer.
7. Release the execution lock.
8. Unblock main-session input.
9. Report the interruption in the main session.

```text
⏹ Execution interrupted at 03 Repository Layer.
Executable remaining: 2 of 5.
Remaining tickets not started.
```

The child session remains persisted by Pi. The extension does not automatically restart or continue the interrupted ticket.

---

## 6. Execution Model

### 6.1 Sequential Execution Loop

```text
read ticket folder
validate ticket files (names, duplicates, statuses)
sort tickets numerically

check required skill is discoverable
acquire repository execution lock
run preflight checks (git state, dirty tree policy)

for each ticket in numeric order:

    re-read ticket status from disk

    if status is not in runnableStatuses:
        record as skipped, continue

    if cancellation requested:
        stop

    verify branch and HEAD are unchanged since preflight
    verify skill:implement is still discoverable

    create fresh persistent AgentSession
    subscribe to child events
    append the session frame and start live updates

    invoke /skill:implement <ticket-reference>
    await the complete agent run, counting turn_end events

    if turn limit exceeded:
        abort child, stop run

    if interrupted or session error:
        stop run

    send completion gate prompt
    await the complete gate response

    if interrupted or session error:
        stop run

    parse completion gate result

    if result is not COMPLETE:
        dispose child, stop run, report reason

    re-read ticket status from disk

    if status is still in runnableStatuses:
        dispose child, stop run
        report "reported COMPLETE but ticket file remains ready-for-agent"

    settle the session frame as done
    dispose child, remove subscription
    update the footer to the next ticket
    continue to next ticket

release repository execution lock
settle any active frame and clear the footer
report final progress
```

The extension never executes more than one ticket session at the same time.

### 6.2 Fresh Session per Ticket

Every ticket runs in a new `AgentSession`. The child session:

- Starts with a fresh conversation context.
- Uses the main project's working directory.
- Discovers project instructions and installed skills.
- Uses the main session's current model and thinking level (§13.3).
- Uses the normal coding tools available in the configured Pi environment.
- Does not inherit prior child-session conversations.
- Does not inherit the main session's implementation history.
- Is persistent on disk.

Sessions share the project filesystem and Git working tree, but not conversation context. This is **context isolation**, not filesystem sandboxing.

### 6.3 Persistent Sessions

Each child session must use Pi's standard persistent session mechanism: the persistent `SessionManager` created by `createAgentSession()` by default.

Do not use `SessionManager.inMemory()`.

No custom session naming is performed. The session is stored in Pi's normal session storage and remains discoverable through `/resume`; its first user message is the `/skill:implement …` invocation, which identifies it in the picker.

Session files remain available after successful completion, gate rejection, session errors, user interruption, and extension shutdown. Disposing a child session must not delete its persisted history.

### 6.4 Skill Invocation

Each ticket is implemented by explicitly invoking the installed `implement` skill:

```typescript
await childSession.prompt(`/skill:implement ${ticket.reference}`);
```

`prompt()` expands skill commands by default (`expandPromptTemplates: true`), loading the skill body and appending the ticket reference as the user request.

The ticket reference is the ticket file path relative to the project root:

```text
/skill:implement .scratch/auth/issues/03-repository-layer.md
```

A full path is used rather than an identifier because multiple feature folders contain identically numbered tickets.

The extension must:

- Verify `skill:implement` is discoverable before prompting (§4.2).
- Use Pi's supported skill-expansion mechanism; never hand-inline the skill body.
- Preserve the skill's own methodology and its use of supporting skills and tools.
- Never replace a failed skill invocation with a generic coding prompt.

The `implement` skill owns the implementation workflow, including tests, typechecking, code review, and committing to the current branch.

### 6.5 Waiting for Completion

The extension waits for the implementation `prompt()` to resolve before sending the completion-gate prompt. `prompt()` resolves after the accepted run finishes, including automatic retries.

`agent_end` alone is not a completion signal; `agent_settled` marks the point where Pi will not continue automatically. The extension uses the settled `prompt()` promise, not raw `agent_end`.

The completion gate must never run while the implementation prompt is still active.

### 6.6 Child Resource Loading

The child must discover the required Matt Pocock skills, project instructions, and the other extensions the implementation workflow needs.

The extension must prevent the ticket-runner from loading inside its own children. Do not disable extensions indiscriminately: construct a `DefaultResourceLoader` for the child and filter this extension out by name with `extensionsOverride`, preserving every other configured extension.

---

## 7. Completion Gate

### 7.1 Purpose

After the implementation skill finishes, the extension sends one follow-up prompt to the same child session. The gate produces the only signal that the implementation actually finished, and it moves the ticket out of the runnable state.

It is deliberately minimal: **one prompt, one answer, one decision.** The extension does not parse acceptance criteria or run a separate verification agent.

### 7.2 Completion Gate Prompt

```text
Review your implementation of <ticket-reference>.

Determine whether the ticket is fully implemented
according to its acceptance criteria.

Confirm that all required verification has passed,
including the tests, typechecking, code review,
and commit steps required by the implement skill.

If the ticket is fully complete:

1. Update the ticket's Status line so it is no longer
   any of: <runnableStatuses, comma separated>.
   This repository's completed value is `resolved`.
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

Do not claim COMPLETE if any required condition is unmet.
```

The runnable list is interpolated from configuration, so the gate prompt stays correct when a project overrides `runnableStatuses`.

### 7.3 Gate Result Parsing

The extension reads the final assistant message of the gate response and takes the **last** line matching, case-insensitively:

```text
optional markdown emphasis / code fence, "STATUS:", one of COMPLETE | INCOMPLETE | BLOCKED
```

Accepted forms include:

```text
STATUS: COMPLETE
**STATUS: COMPLETE**
STATUS: INCOMPLETE
```

Missing, contradictory, or unrecognized values are **not** success: the extension stops and reports the raw final message. Formatting tolerance is deliberate; vocabulary tolerance is not.

`COMPLETE` continues the run. `INCOMPLETE`, `BLOCKED`, and malformed answers stop it.

### 7.4 Persisted Status Verification

After a `COMPLETE` response, the extension re-reads the ticket file from disk. Execution continues only when the status is **no longer in `runnableStatuses`**.

The extension does not write the status itself and does not fall back to marking the ticket complete.

If the gate reports `COMPLETE` and the file remains runnable:

```text
⏹ Ticket 03-repository-layer reported COMPLETE,
but its ticket file is still ready-for-agent.

Execution stopped.
Executable remaining: 2 of 5.
```

Because the predicate is "not runnable", a gate that writes `needs-info` also advances the run. This is accepted: the extension's only concern is invocability, and a human reviewing the run sees the status in the summary.

### 7.5 Limitations

The completion gate is an agent self-assessment, not independent verification. The extension trusts that self-assessment plus the persisted status change. This is an intentional v1 tradeoff.

---

## 8. Failure and Interruption Handling

### 8.1 Outcome Rules

| Outcome | Behavior |
|---|---|
| Implementation succeeds, gate reports `COMPLETE`, status is no longer runnable | Continue |
| Gate reports `INCOMPLETE` | Stop |
| Gate reports `BLOCKED` | Stop |
| Gate answer is malformed or ambiguous | Stop |
| Gate reports `COMPLETE`, status is still runnable | Stop |
| Child session errors | Stop |
| Turn limit reached | Abort child and stop |
| User interrupts | Abort child and stop |
| Ticket status missing, duplicated, or empty | Stop before creating any session |
| Branch or HEAD changed during the run | Stop |
| No runnable tickets | Finish successfully |

There is no `continue-on-failure` mode in v1.

### 8.2 Interrupt Handling

The guaranteed cancellation mechanism is `/ticket-runner stop` (§5.4).

When cancellation is requested:

1. Mark the active run as cancellation-requested in memory.
2. Abort the child with `session.abort()` and await it.
3. Stop the sequential loop.
4. Unsubscribe and dispose the child.
5. Preserve the child session file.
6. Settle the active session frame as `stopped`, update the footer.
7. Release the execution lock.
8. Report the interruption.

The extension must not continue to the next ticket, retry the interrupted ticket, mark it complete, delete the session file, or roll back filesystem changes.

### 8.3 Keyboard Interrupt

No keyboard shortcut is bound to child cancellation in v1. `Esc` remains the main session's own escape handler and is never hijacked, because binding it to a different session would override a core key for no added capability.

The running frame advertises only `/ticket-runner stop`.

### 8.4 Cancellation Race Safety

The scheduler maintains an in-memory cancellation flag, checked before every new ticket and after every awaited operation that could have raced with a stop. Cancellation takes precedence over launching the next ticket.

Only one controller decides a ticket's final runtime outcome. Event callbacks never start tickets.

### 8.5 Interrupted Ticket Status

The extension does not write an `interrupted` state into the ticket file. An interrupted ticket that remains runnable is eligible on the next `start`.

The user may inspect the previous child session through `/resume`. Automatic continuation of that exact session is outside v1.

---

## 9. Restart and Progress Recovery

### 9.1 No Run Log

The extension does not persist an execution-history file, `run-log.json`, or an independent completion database.

### 9.2 Reconstructing Progress

Every `list`, `status`, or `start` invocation reconstructs progress by reading ticket files. The first runnable ticket is selected automatically; every non-runnable ticket is skipped.

Progress therefore survives Pi restarts, crashes, and reboots with no extra state.

### 9.3 Restart Example

```text
01-database-schema.md       resolved
02-api-endpoints.md         resolved
03-repository-layer.md      ready-for-agent
04-integration-tests.md     ready-for-human
05-documentation.md         ready-for-agent
```

`/ticket-runner start .scratch/auth/issues` runs `03`, then skips `04`, then runs `05`.

### 9.4 Recovery Limitation

If execution stops halfway through a ticket, starting the runner again creates a fresh session for that ticket. It does not resume the earlier child session. Partially modified files remain in the working directory. The user may inspect or resume the previous session through Pi's session picker.

---

## 10. Git and Working Directory Safety

### 10.1 Shared Working Directory

All ticket sessions operate on the same project working directory. Filesystem changes remain visible to subsequent tickets. This is intentional.

### 10.2 Preflight Checks

Run once, immediately after acquiring the lock and before any session is created:

- The target ticket folder exists, is readable, and contains at least one valid ticket.
- Ticket ordering is valid (no duplicate numeric identifiers).
- Every ticket has exactly one non-empty `Status:` line.
- `skill:implement` is discoverable.
- The working directory is a Git repository.
- The current branch and `HEAD` are recorded.
- The working tree has no changes **outside the supplied ticket folder**.

The last check is skipped with `--allow-dirty`. Changes **inside** the ticket folder are always allowed, because freshly generated local tickets may be uncommitted and the gate's status update lands after the implementation commit.

On refusal, report the offending paths and stop without creating a session. The extension never switches branches, stashes, or discards changes.

### 10.3 Mid-Run Git Check

Before each ticket, verify that the current branch and `HEAD` are unchanged from the recorded values. If either moved — for example because the user or another process switched branches — stop the run and report it. Uncommitted changes inside the ticket folder are not an error.

### 10.4 Execution Lock

Only one ticket-runner instance may execute against a repository at a time.

- Path: `.pi/ticket-runner.lock` (gitignored; add `.pi/*.lock` to `.gitignore`).
- Content: `{ "pid": number, "cwd": string, "startedAt": ISO-8601, "ticketFolder": string }`.
- Acquired with an exclusive create (`flag: "wx"`).
- Released on success, failure, interruption, and `session_shutdown`.

A pre-existing lock is never silently replaced:

- PID alive → refuse to start, naming the live PID.
- PID dead or older than `staleLockHours` → refuse to start and report the stale lock with the exact `rm .pi/ticket-runner.lock` recovery instruction.

The lock is temporary coordination state, not a run log.

### 10.5 Failed or Interrupted Changes

A failed or interrupted ticket is not reverted. The extension reports that the working tree may contain partial work. Subsequent tickets are not started. The user decides whether to inspect, resume, commit, or revert.

---

## 11. Live TUI Visibility

The extension renders progress in two places: the footer and one inline **session frame** per child session. It installs no persistent widget above the editor.

### 11.1 Footer Progress

While a run is active, use `ctx.ui.setStatus("ticket-runner", …)`:

```text
🎫 2 left · 03-repository-layer
```

- The number is the count of tickets still in `runnableStatuses`, decremented only after the gate and the persisted-status check both pass.
- Labels never claim a ticket is "completed"; the extension only knows what is still runnable.

On finish: `🎫 done · 0 left`. On failure or interruption: `🎫 stopped · 2 left`. Cleared on teardown.

### 11.2 Session Frames

A **session frame** is a durable, TUI-only custom entry. Register it with `pi.registerEntryRenderer("ticket-runner-frame", …)` and append its summary with `pi.appendEntry("ticket-runner-frame", summary)`. A frame never enters the main agent's LLM context and is read-only. The public-API choice is recorded in `docs/adr/0001-inline-session-frames.md`.

Exactly one frame is visible per child session. A frame is created when the child session is created and settles when the child is disposed. Skipped tickets and failures before child creation produce no frame.

Collapsed:

```text
┌──────────────────────────────────────────────────────────────────────┐
│ ▸ ● 03 Repository Layer · Running                                    │
│   3 turns • 2 tools • 0 errors • 12s • gpt-5 • /ticket-runner stop   │
│   (ctrl+o to expand)                                                 │
└──────────────────────────────────────────────────────────────────────┘
```

Expanded:

```text
┌──────────────────────────────────────────────────────────────────────┐
│ ▾ ● 03 Repository Layer · Running                                    │
│   Session 1a2b3c · 3 turns • 2 tools • 0 errors • 12s • gpt-5        │
├──────────────────────────────────────────────────────────────────────┤
│ Skill: implement · .scratch/auth/issues/03-repository-layer.md       │
│ Writing the repository layer…                                        │
│ Tool: write src/repository.ts — success                              │
│ …                                                                    │
└──────────────────────────────────────────────────────────────────────┘
```

Frame requirements:

- **Border.** Draw a literal border with `┌ ─ ┐ │ ├ ┤ └ ┘` in `theme.fg("borderMuted", …)`. Do not use a background box.
- **Toggle glyph.** `▸` collapsed, `▾` expanded.
- **Status dot.** `●`, coloured by status: `running` and `verifying` use `warning`, `done` uses `success`, `stopped` uses `warning`, `failed` uses `error`.
- **Header.** `<glyph> ● <NN> <title> · <Status>`.
- **Meta.** `<N> turns • <N> tools • <N> errors • <elapsed> • <model> (ctrl+o)`. While the child is running, append `• /ticket-runner stop`. Expanded frames prepend `Session <short-id> · ` to the meta line.
- **Status words.** `running`, `verifying`, `done`, `stopped`, `failed`. Display labels capitalize the first letter. `verifying` is the completion-gate phase of the same frame; it never creates a second frame.
- **`done` meaning.** The gate returned `COMPLETE` and the persisted ticket status is no longer runnable. `done` does not claim the ticket is complete in the abstract.
- **`stopped` meaning.** Gate rejection, malformed gate answer, unchanged ticket status, turn limit, or user interrupt on an active child frame.
- **`failed` meaning.** A child-session error. Deliberate stops are never `failed`.
- **Terminal width.** Frame lines are truncated to the available width. The border uses the full available width.

#### Expansion

`Ctrl+O` is the single expansion control. It toggles all session frames between collapsed and expanded, matching Pi's native `app.tools.expand` behaviour. A new frame starts collapsed unless the global expansion state is currently expanded. Expansion state is not persisted across reload.

There is no compact intermediate child layer and no per-frame click target in v1. `Ctrl+O` goes directly from the collapsed summary to the full child transcript.

The active frame updates live while the child runs. Assistant text streams, tool rows appear as they start and finish, and status/counts update. Completed frames are static.

#### Expanded transcript

The expanded frame renders the child session transcript as read-only rows:

- The initial user turn appears as one compact line: `Skill: implement · <ticket-reference>`.
- The completion-gate user turn appears as one compact line: `Gate: verify completion · <ticket-reference>`.
- Assistant text is rendered in full with `Markdown`.
- Each tool call is rendered as a `Tool: <name> <compact-args>` row, followed by its full result text.
- Edit diffs are rendered with `renderDiff`; write results show their full content.
- Tool errors and failed results are shown in the error colour.

Excluded from the frame: the system prompt, the expanded `implement` skill body, and thinking blocks. They remain available through `/resume`.

The expanded transcript is capped at **1,000 lines or 128 KB** per frame, whichever comes first. When either limit is reached, append:

```text
… truncated · open the child session in /resume for the full transcript
```

The cap is display-only. The complete transcript remains in the child session file. Do not instantiate Pi's native interactive `AssistantMessageComponent` or `ToolExecutionComponent` inside the frame; render with `Markdown`, `Text`, and `renderDiff`.

#### Persistence

Each frame has a stable `frameId`. Append a small summary entry when the frame is created and again when it settles. The summary contains only:

```typescript
{
  frameId: string;
  ticketId: string;
  ticketTitle: string;
  childSessionFile: string | undefined;
  model: string | undefined;
  status: "running" | "verifying" | "done" | "stopped" | "failed";
  turns: number;
  tools: number;
  errors: number;
  startedAt: string;
  endedAt?: string;
}
```

The summary never contains transcript content. On session start, scan `ticket-runner-frame` entries and render only the latest entry for each `frameId`; renderers for superseded entries return no content, so exactly one frame is visible per child session.

The expanded transcript is loaded on demand from `childSessionFile` using the public `SessionManager.open()` API, or from the live child session's entries while it is running. Cache it only while expanded; drop the cache on collapse and teardown. If the file is missing or unreadable, render:

```text
Transcript unavailable · <reason>
```

If the child session has no messages yet, render `Transcript not yet available.`

Session frames and expanded transcripts are TUI-only. They are never sent to the model.

### 11.3 Event Subscription

```typescript
const unsubscribe = session.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        // append to the active assistant row and update the frame
      }
      break;
    case "tool_execution_start":
      // add a running tool row
      break;
    case "tool_execution_end":
      // settle the tool row and record its result/error
      break;
    case "turn_end":
      // increment the per-ticket turn counter
      break;
    case "agent_settled":
      // mark the phase settled
      break;
  }
});
```

The subscription is removed before the session is disposed.

### 11.4 Rendering Performance

Live frame updates are throttled to `liveFrameUpdateIntervalMs` (default 150 ms). Only the bounded expanded view is materialised, and only while at least one frame is expanded. The complete transcript remains in the child session file.

Never copy a full child transcript into the parent's LLM context or into the persisted frame summary.

### 11.5 Frame Settlement and Cleanup

- Normal completion: settle the frame as `done`, update the footer, keep the frame in the transcript.
- Stop or failure: settle the frame as `stopped` or `failed`, update the footer, keep the frame in the transcript.
- Shutdown or reload mid-run: settle the active frame as `stopped` before disposing the child.
- Teardown: clear the footer and drop expanded-transcript caches. Never delete session frames or child session files.

---

## 12. Main-Session Interaction

### 12.1 Progress Updates

Progress is delivered with `pi.sendMessage({ customType: "ticket-runner", content, display: true }, { triggerTurn: false })`, so it is visible in the transcript and in the main agent's context but never starts a turn.

After each ticket:

```text
✅ 02 API Endpoints — status now `resolved`.
Next: 03 Repository Layer (2 left).
```

Gate rejection:

```text
⏹ 03 Repository Layer is incomplete.
Reason: integration tests are failing.
Execution stopped · 2 left.
```

Interruption:

```text
⏹ Execution interrupted at 03 Repository Layer · 2 left.
Remaining tickets not started.
```

Completion:

```text
✅ Run finished · 0 tickets ready-for-agent.
Ran: 03, 05. Skipped: 04 (ready-for-human).
```

Session frames and their expanded transcripts are TUI-only custom entries. They are never sent to the model.

Never injected into LLM context: child transcripts, long tool output, diffs, implementation summaries, or ticket bodies.

### 12.2 Main-Session Input While Running

The main session is idle during a child run, so it is otherwise fully usable — and another agent editing the same tree would race the child.

While a run is active, `pi.on("input")` returns `{ action: "handled" }` for ordinary prompts and notifies:

```text
A ticket run is active (03 Repository Layer).
Run +/ticket-runner stop+ before prompting the main session.
```

Extension commands bypass the `input` handler, so `/ticket-runner stop`, `/ticket-runner status`, `/ticket-runner list`, and other extension commands keep working. Messages injected by the runner use custom messages and are unaffected.

---

## 13. Pi Integration

### 13.1 SDK Requirements

Implement against the pinned Pi SDK `@earendil-works/pi-coding-agent` (currently 1.5.0) and use its TypeScript declarations as the authoritative source for signatures. Do not combine examples from incompatible releases.

### 13.2 Extension APIs

| API | Responsibility |
|---|---|
| `pi.registerCommand()` | Register `/ticket-runner` with `list`, `start`, `status`, `stop` |
| `pi.registerCommand().getArgumentCompletions` | Complete folder paths |
| `pi.on("input")` | Block main-session prompts during a run (§12.2) |
| `pi.on("session_shutdown")` | Abort child, release lock, clear UI |
| `ctx.ui.setStatus()` | Footer progress |
| `pi.appendEntry()` | Append a session-frame summary |
| `pi.registerEntryRenderer()` | Render inline session frames and expanded transcripts |
| `SessionManager.open()` | Read a child transcript on demand for expansion |
| `ctx.ui.notify()` | Failure and interruption notices |
| `pi.sendMessage()` | Concise progress in the transcript |
| `pi.getCommands()` | Verify `skill:implement` discoverability |

No LLM-callable `run_tickets` tool is registered in v1. Execution is user-commanded only.

### 13.3 Child Session Creation

```typescript
const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir: getAgentDir(),
  extensionsOverride: (base) => ({
    ...base,
    extensions: base.extensions.filter((ext) => ext.name !== "ticket-runner"),
  }),
});

const { session } = await createAgentSession({
  cwd,
  model: ctx.model,              // inherit the main session's model
  thinkingLevel: ctx.thinkingLevel,
  resourceLoader,                // persistent SessionManager by default
});
```

| Setting | Behavior |
|---|---|
| `cwd` | Main project's working directory |
| `model` | Main session's current model |
| `thinkingLevel` | Main session's current thinking level |
| `sessionManager` | Default persistent manager; never `inMemory()` |
| `resourceLoader` | Standard discovery, minus this extension |
| `tools` | Defaults; do not restrict the implementation workflow |
| Session name | Default Pi behavior; no naming |

The exact factory configuration must be re-verified against the pinned SDK.

### 13.4 Lifecycle Safety

Cleanup runs on stop, extension reload, `session_shutdown`, and unrecoverable error, in this order:

1. Set the cancellation flag.
2. Abort active child work and await it.
3. Remove event subscriptions.
4. Settle the active session frame as `stopped`.
5. Dispose the child session (never deleting the session file).
6. Clear the footer and expanded-transcript caches.
7. Release the execution lock.

---

## 14. Configuration

Configuration is loaded from `~/.pi/agent/ticket-runner.json` and `.pi/ticket-runner.json`; project values override global values. Missing files are not an error. Unknown keys are ignored with a warning; invalid values stop the command with a descriptive error.

| Setting | Default | Description |
|---|---|---|
| `runnableStatuses` | `["ready-for-agent"]` | Status values eligible for execution; every other value is skipped |
| `maxTurnsPerTicket` | `50` | Maximum child `turn_end` events during the implementation prompt |
| `liveFrameUpdateIntervalMs` | `150` | Minimum interval between live session-frame renders |
| `expandedTranscriptMaxLines` | `1000` | Maximum lines rendered in one expanded child transcript |
| `expandedTranscriptMaxBytes` | `131072` | Maximum UTF-8 bytes rendered in one expanded child transcript |
| `staleLockHours` | `12` | Age after which an unreadable-PID lock is reported as stale |

```json
{
  "runnableStatuses": ["ready-for-agent"],
  "maxTurnsPerTicket": 50,
  "liveFrameUpdateIntervalMs": 150,
  "expandedTranscriptMaxLines": 1000,
  "expandedTranscriptMaxBytes": 131072,
  "staleLockHours": 12
}
```

`liveWidgetUpdateIntervalMs` is accepted as a deprecated alias for `liveFrameUpdateIntervalMs`; when both are present, `liveFrameUpdateIntervalMs` wins.

### 14.1 Turn Limit Behavior

Turns are counted from the child's `turn_end` events during the implementation prompt only; the completion gate is excluded and gets its own single prompt. Counting includes retried and recovered turns, so the cap errs early.

When the limit is reached:

- Abort the child session.
- Do not send the completion gate.
- Stop the sequential run.
- Report `⏹ 03 Repository Layer hit the 50-turn limit. Execution stopped · 2 left.`

Reaching the turn limit is never treated as success.

---

## 15. Edge Cases

| Case | Required behavior |
|---|---|
| Matt Pocock skills missing | Report error and setup instructions |
| `skill:implement` not discoverable | Stop before creating a session |
| Ticket folder does not exist | Report error |
| No ticket files | Report "No tickets found" |
| Duplicate numeric ticket IDs | Report error |
| No `Status:` line, or multiple | Malformed ticket → stop before any session |
| Empty status value | Malformed ticket → stop |
| Status outside `runnableStatuses` | Skip, list the reason |
| All tickets non-runnable | Report "Nothing to run"; create no sessions |
| Some tickets non-runnable | Skip them automatically; run the rest |
| First ticket runnable | Execute it immediately |
| Ticket implementation errors | Stop, preserve session and changes |
| Gate reports `INCOMPLETE` | Stop |
| Gate reports `BLOCKED` | Stop |
| Gate answer malformed | Stop |
| Gate reports `COMPLETE` but status still runnable | Stop |
| Turn limit reached | Abort child, stop |
| User interrupts | Abort child, stop |
| Pi closes mid-ticket | Preserve session and ticket statuses |
| Runner started again | Re-read tickets; start from the first runnable |
| Second runner in same repo | Refuse via lock; report stale locks explicitly |
| User prompts main session mid-run | Blocked with a stop-command hint |
| Branch or `HEAD` changes mid-run | Stop; no frame is created for the unstarted ticket |
| Unrelated dirty tree at start | Refuse unless `--allow-dirty` |
| Failed ticket leaves code changes | Preserve; never auto-revert |
| Session picker opened | Child sessions remain available through Pi's persistence |
| Ticket skipped | No session frame is created |
| Failure before child session creation | No session frame is created |
| Expanded transcript exceeds the cap | Truncate with the footer; the full transcript stays in the child session file |
| `Ctrl+O` with multiple frames | All frames toggle; each expanded transcript is capped independently |
| Child session file missing or unreadable | Render `Transcript unavailable · <reason>`; never crash |
| Pi reloads mid-ticket | The active frame settles as `stopped`; the latest frame per child is restored |
| Same ticket run twice | Two frames; expanded headers distinguish them by session ID |

---

## 16. Acceptance Tests

### 16.1 Ticket Discovery

- Discovers numbered Markdown tickets and ignores unrelated files.
- Sorts numerically; `01-a.md` and `1-b.md` count as duplicates.
- Reports missing, unreadable, and empty folders.

### 16.2 Status

- Reads `Status:` and `**Status:**` forms, trims, lowercases.
- `ready-for-agent` is runnable; `resolved`, `ready-for-human`, `wontfix`, and unknown values are skipped.
- A missing, duplicated, or empty status stops the run.
- Statuses are re-read on every command and after each ticket.
- No run log or completion database is written.

### 16.3 Start Behavior

Given `01 resolved`, `02 resolved`, `03 ready-for-agent`, `04 ready-for-human`, `05 ready-for-agent`, `start` runs `03` then `05`, and no selection dialog or confirmation is shown.

### 16.4 Sequential Execution

- One session at a time.
- A fresh, persistent session per ticket.
- Numeric order.
- Non-runnable tickets skipped.
- The next ticket starts only after the previous ticket passes the gate.

### 16.5 Completion Gate

- `COMPLETE` + status no longer runnable → advance.
- `COMPLETE` + status still runnable → stop.
- `INCOMPLETE` → stop.
- `BLOCKED` → stop.
- Fenced or bolded `STATUS:` is parsed; unknown values stop.
- Session errors stop.

### 16.6 Interruption

- `/ticket-runner stop` aborts the child and stops the loop.
- The session file is retained; the active frame settles as `stopped`; the footer is cleared; the lock is released.
- No ticket is falsely advanced.

### 16.7 Session Persistence

- Every child session is persisted and appears in the session picker.
- Sessions survive completion, interruption, and disposal.

### 16.8 TUI

- Footer shows remaining-runnable counts.
- Every child session produces exactly one inline frame; skipped tickets and pre-session failures produce none.
- Collapsed frames show the ticket identity, status, turns, tools, errors, elapsed time, model, `(ctrl+o)`, and the stop hint while running.
- `Ctrl+O` toggles all frames; new frames inherit the global state; expansion state is not persisted.
- The active expanded frame updates live; completed frames are static.
- Expanded transcripts include assistant text, tool calls/results/diffs, and compact ticket/gate prompts; they exclude the system prompt, expanded skill body, and thinking.
- Expanded transcripts respect the line/byte cap and show the truncation footer.
- Gate phase appears as `verifying` on the same frame.
- Session frames survive reload; the latest entry per frame is rendered.
- Frames and expanded transcripts never enter LLM context.
- The footer clears on teardown; frames remain.

### 16.9 Restart

After restarting Pi, `start` resumes at the first runnable ticket with no persisted run state.

### 16.10 Repository Safety

- The lock prevents two runners.
- Stale locks are reported, never auto-deleted.
- Unrelated dirty trees are refused; `--allow-dirty` overrides.
- A branch or `HEAD` change mid-run stops the run.
- Interrupted work is preserved, never reverted.

### 16.11 Test Seam

Core logic is tested through a `TicketSession` port:

```typescript
interface TicketSession {
  readonly sessionFile: string | undefined;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: ChildEvent) => void): () => void;
  getLastAssistantText(): string | undefined;
  getTranscript(): readonly TranscriptEntry[];
  dispose(): void;
}
```

`TranscriptEntry` is a read-only projection of one child message: a compact user turn, assistant text, a tool call/result, or an error. It is not the raw Pi session entry.

- Pure units (discovery, ordering, status parsing, gate parsing, config, lock) tested directly.
- The loop, cancellation races, turn limits, and cleanup tested against a fake `TicketSession`.
- Frame and transcript rendering tested as pure functions over fixture `TranscriptEntry` values.
- TUI tested by asserting frame view-model/render output and footer payloads, not widget payloads.
- One opt-in integration test (env-gated) drives a real session against a scratch repo.

---

## 17. Future Considerations (v2+)

- Resume an interrupted ticket in its original session.
- Support GitHub, Linear, and other remote trackers.
- Honor `Blocked by:` edges and compute the frontier.
- Distinguish completed, wontfix, and human-owned tickets in progress reporting.
- Git worktree isolation.
- Parallel ticket execution.
- Combined plan-and-run workflows.
- Cost and token-usage reporting.
- Independent acceptance-criteria verification.
- Automatic repair retries.
- Optional `Esc` binding.
- Per-frame click targets and independent expansion controls.
- Transcript search and filtering inside expanded frames.
- Native Pi component fidelity for expanded tool rows.

---

## 18. Naming, Distribution, and Layout

**Package name:** `pi-ticket-runner` · **License:** MIT

```json
{
  "name": "pi-ticket-runner",
  "version": "0.1.0",
  "description": "A Pi extension that runs Matt Pocock-skill tickets one by one, each in its own fresh session — so your main context never overflows.",
  "keywords": ["pi-package"],
  "license": "MIT",
  "pi": { "extensions": ["./index.ts"] },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "1.5.0",
    "typescript": "^5"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --test tests/"
  }
}
```

- Host-provided Pi packages stay in `peerDependencies` with `"*"` and are never bundled.
- Pi loads `.ts` extensions directly; there is no bundler and no build step.
- Tests use `node:test` on Node 26; no test framework dependency.

```text
pi-ticket-runner/
├── index.ts                 # registration, command parsing, extension wiring
├── src/
│   ├── tickets.ts           # discovery, ordering, titles
│   ├── status.ts            # status parsing and classification
│   ├── config.ts            # config loading and validation
│   ├── lock.ts              # repository execution lock
│   ├── git.ts               # preflight and branch/HEAD checks
│   ├── sessions.ts          # TicketSession port + SDK adapter
│   ├── transcript.ts        # child transcript projection for frames
│   ├── live-view.ts         # frame lifecycle and event-to-frame state
│   ├── gate.ts              # prompt construction and result parsing
│   ├── runner.ts            # sequential loop and cancellation
│   └── ui.ts                # footer, session frame, and transcript rendering
├── tests/
│   ├── tickets.test.ts
│   ├── status.test.ts
│   ├── gate.test.ts
│   ├── lock.test.ts
│   ├── runner.test.ts       # fake TicketSession
│   ├── live-view.test.ts    # frame lifecycle and view model
│   ├── transcript.test.ts   # transcript projection and rendering
│   └── integration.test.ts  # env-gated, real session
├── .gitignore               # .pi/*.lock
├── README.md
└── LICENSE
```

The implementation favors minimal code and clear responsibility boundaries over abstraction for its own sake.

---

## 19. Final Design Principles

1. **Ticket files are the truth.** No duplicate persisted state.
2. **One question per ticket: can it be implemented now?** Runnable or not; no completion vocabulary.
3. **Always start automatically.** No ticket-selection dialog or confirmation.
4. **Numeric order.** The `to-tickets` skill already sequenced the work.
5. **One ticket, one fresh session.** No conversation-context sharing.
6. **Use the existing skills.** Invoke `implement`; never reimplement it.
7. **One completion gate.** Continue only after an explicit `COMPLETE` and a persisted status change.
8. **Stop conservatively.** Malformed tickets, errors, gate failures, locks, and branch changes stop the run.
9. **Persist sessions, not orchestration history.** Pi stores transcripts; ticket files store status.
10. **Keep the parent context small.** Progress lines only.
11. **One agent per tree.** Block main-session prompts while a run is active.
12. **Frames are TUI-only.** Expanded transcripts never enter the model context.
13. **Use public Pi seams.** Never patch private TUI internals to group native components.

---

## Appendix A — Settled Decisions

| # | Decision |
|---|---|
| 1 | Implement the full spec (§1–19); no scope cut. |
| 2 | Executable = `Status:` in `runnableStatuses` (default `["ready-for-agent"]`); every other value is not executable. |
| 3 | Non-runnable tickets are **skipped**, never fatal. Only malformed status lines stop the run. |
| 4 | Ordering is the numeric filename prefix; `Blocked by:` is never parsed. |
| 5 | Children are in-process `createAgentSession()` sessions with the persistent `SessionManager` and the main session's model/thinking level. |
| 6 | One gate prompt per ticket; the gate moves the status out of the runnable set; the runner re-reads and never writes status itself. |
| 7 | Explicit folder argument on every invocation; four subcommands; no auto-discovery. |
| 8 | Git preflight runs once at start (with `--allow-dirty`); branch/`HEAD` are re-checked per ticket. |
| 9 | Lock file at `.pi/ticket-runner.lock`; stale locks reported, never auto-deleted. |
| 10 | Main-session prompts are blocked during a run via the `input` handler; extension commands still work. |
| 11 | No `Esc` binding; the running frame advertises only `/ticket-runner stop`. |
| 12 | The editor widget is removed. Each child session renders one inline session frame, updated live at 150 ms and settled on completion. |
| 13 | Turns counted from `turn_end` during implementation only; default cap 50; breach aborts and stops. |
| 14 | Gate parsing tolerates emphasis and fences, not vocabulary. |
| 15 | Titles come from the H1 heading, falling back to the filename slug. |
| 16 | `peerDependencies: "*"`, `node:test`, `tsc --noEmit`, no bundler. |
| 17 | Progress via `pi.sendMessage(..., { triggerTurn: false })`. |
| 18 | `TicketSession` port as the test seam, plus one env-gated integration test. |
| 19 | This spec lives at `.scratch/pi-ticket-runner/spec.md`; tickets follow via `/to-tickets`. |
| 20 | One session frame per child session; no run-level frame and no nested frames. |
| 21 | Frames use public `pi.appendEntry()` + `pi.registerEntryRenderer()` only; no private Pi TUI patching. |
| 22 | `Ctrl+O` is one-layer: collapsed summary to full child transcript, with no compact intermediate child layer. |
| 23 | Expanded transcripts include assistant text, tool calls/results/diffs, and compact ticket/gate prompts; exclude the system prompt, expanded skill body, and thinking. |
| 24 | Each expanded transcript is capped at 1,000 lines or 128 KB, with a truncation footer pointing to `/resume`. |
| 25 | Frame statuses are `running`, `verifying`, `done`, `stopped`, `failed`; `done` requires a `COMPLETE` gate and a non-runnable persisted status. |
| 26 | `Ctrl+O` toggles all frames; new frames inherit the global state; expansion state is not persisted. |
| 27 | Each frame persists only a small summary entry; the expanded transcript is read lazily from the child session file and never enters LLM context. |
| 28 | No per-frame click targets or independent expansion controls in v1. |

## Appendix B — Next Step

Run `/to-tickets` against this file to produce `.scratch/pi-ticket-runner/issues/NN-*.md`, then `/ticket-runner start .scratch/pi-ticket-runner/issues` to implement the extension with its own extension. Ticketing must happen before the runner exists, so the first run is by hand.
