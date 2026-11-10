# pi-ticket-runner

A [Pi](https://pi.dev) extension that runs a folder of local Markdown tickets **one at a time, each in a fresh persistent session**, so a long multi-ticket implementation never overflows your main context.

The main session keeps only the ticket inventory, progress, and status. Implementation details stay in the individual ticket sessions, which remain available through `/resume`.

---

## What a run looks like

Every ticket gets exactly one collapsible frame in the main transcript. Collapsed, it is a two-line summary that updates live:

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ▸ ● 03 Repository layer · Running                                                                            │
│   12 turns • 34 tools • 0 errors • 42.1%/200k • 24m 40s • claude-sonnet-4-5 • (ctrl+o) • /ticket-runner stop │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

When the ticket settles, the status word and the counters freeze and the `stop` hint disappears:

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ▸ ● 03 Repository layer · Done                                                                               │
│   18 turns • 61 tools • 0 errors • 42.1%/200k • 31m 42s • claude-sonnet-4-5 • (ctrl+o)                       │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Reading the header line: `▸`/`▾` shows whether the frame is collapsed or expanded, `●` is coloured by status (`Running`, `Verifying`, `Done`, `Stopped`, `Failed`), then the ticket number, its title, and the status word.

Reading the meta line, left to right: turns, tool calls, errors, context usage (the child's estimated tokens as a share of its model window, `?/200k` while unknown, coloured `warning` above 70% and `error` above 90%), elapsed time, model, and `(ctrl+o)`. Only a live frame appends `/ticket-runner stop`.

Press `Ctrl+O` to expand every frame to its child transcript and again to collapse. Expanded frames also show the `Session <id>` prefix and a separating rule above the transcript. Frames are TUI-only and never enter the main session's model context.

---

## What it does

- Discovers numbered Markdown tickets in a folder you supply.
- Runs every ticket whose `Status:` is runnable (default: `ready-for-agent`), in numeric order.
- Skips every non-runnable ticket automatically — no selection dialog, no confirmation.
- Invokes the installed `/skill:implement <ticket-file>` skill in a **fresh, persistent Pi session per ticket**.
- Sends one completion-gate prompt after implementation, then advances only if the gate says `COMPLETE` **and** the ticket file's status has actually changed.
- Renders each ticket session as an inline, collapsible **session frame** in the transcript, plus a footer status.
- Stops conservatively on errors, failed gates, turn limits, interrupts, or mid-run Git changes.

**Not** a general sub-agent framework, ticket generator, or ticket tracker. Ticket generation and implementation methodology stay with the [Matt Pocock skills](https://github.com/mattpocock/skills).

### Relationship to the `implement-spec` skill

This extension is designed as a replacement for the `implement-spec` skill, which relies on configured sub-agents to implement a spec. `pi-ticket-runner` implements a **folder of tickets**, each in its own separate session, **without** needing an installed or configured sub-agent extension — Pi's own session API is enough.

---

## Requirements

- **Pi** `>= 1.5.0` — this extension is built against `@earendil-works/pi-coding-agent` `1.5.0`.
- **Node.js** `>= 22.19.0` (Pi's own requirement).
- **Matt Pocock skills** installed, including `to-tickets` and `implement`, with `setup-matt-pocock-skills` completed and local Markdown tracking configured for the project.
- A **Git repository** as the working directory. The runner checks the working tree and refuses unrelated uncommitted changes unless you pass `--allow-dirty`.

The runner verifies that `/skill:implement` is discoverable before creating any session. If it is missing, the run stops with an error instead of silently sending a plain prompt.

---

## Install from Git

The recommended install pulls the package straight from GitHub through Pi's package manager:

```bash
pi install git:github.com/skkdevcraft/pi-ticket-runner
```

### Install for the current project only

```bash
pi install --local git:github.com/skkdevcraft/pi-ticket-runner
```

This writes the package declaration to `.pi/settings.json` instead of your personal `~/.pi/agent/settings.json`. Project packages load after project trust is granted.

### Try it without adding it to settings

```bash
pi -e git:github.com/skkdevcraft/pi-ticket-runner
```

### Verify, update, remove

```bash
pi list                                                     # confirm it is configured
pi update --extensions                                      # update installed packages
pi remove git:github.com/skkdevcraft/pi-ticket-runner       # uninstall
```

Restart Pi or run `/reload` after installing. Then check that the command is available:

```text
/ticket-runner list .scratch/<feature>/issues
```

### Install from a local clone (development)

```bash
git clone https://github.com/skkdevcraft/pi-ticket-runner.git
cd pi-ticket-runner
npm install
pi install ./pi-ticket-runner   # or: pi -e ./pi-ticket-runner
```

Pi loads `.ts` extensions directly — there is no build step and no bundler.

---

## Usage

All commands are user-invoked from the Pi prompt. The ticket folder is always required for `list` and `start`.

### `/ticket-runner list <ticket-folder>`

Read-only preview: tickets in numeric order, their status, and which one runs next.

```text
🎫 Tickets: .scratch/auth/issues

01-database-schema      resolved           skip
02-api-endpoints        resolved           skip
03-repository-layer     ready-for-agent    NEXT ▶
04-integration-tests    ready-for-human    skip

Executable: 1 of 4
Next: 03 Repository Layer
```

Creates no sessions, changes no files, and fails on malformed tickets.

### `/ticket-runner start <ticket-folder> [--allow-dirty]`

Runs every runnable ticket in numeric order, starting immediately. Skips non-runnable tickets without asking.

```text
/ticket-runner start .scratch/auth/issues
```

Use `--allow-dirty` only when the working tree already contains unrelated changes that you want the run to leave alone. It suppresses that single preflight refusal; every other safety check still applies.

If nothing is runnable, the command reports it and creates no sessions.

### `/ticket-runner status`

Shows the active run (folder, current ticket, how many runnable tickets remain, and the child session file), or a full `list` view plus `No run active.` when idle.

### `/ticket-runner stop`

The guaranteed way to interrupt a run. It aborts the active child session, stops the loop, settles the active session frame as `stopped`, and releases the repository lock. The child session file is preserved and remains visible in `/resume`. Nothing is rolled back.

`Esc` is deliberately **not** bound: it stays the main session's own key handler.

While a run is active, ordinary prompts to the main session are blocked (run `/ticket-runner stop` first). Extension commands such as `status`, `list`, and `stop` keep working.

### Session frames

Each child session appears in the main transcript as one bordered, collapsible frame (see [What a run looks like](#what-a-run-looks-like)). Context usage is sampled at message and tool boundaries rather than on every live repaint, and the last known value is kept once the frame settles. Expand or collapse all frames with `Ctrl+O`; the active frame updates live while expanded. Expanded transcripts are capped at 1,000 lines or 128 KB per frame, with the full history always available in `/resume`.

---

## Ticket format

Tickets are plain Markdown files named `<NN>-<slug>.md` inside the folder you pass:

```text
.scratch/auth/issues/
├── 01-database-schema.md
├── 02-api-endpoints.md
├── 03-repository-layer.md
└── 04-integration-tests.md
```

- `NN` is one or more digits and determines execution order. Duplicate numbers are an error (`01-a.md` and `1-b.md` collide).
- Files that do not match the pattern are ignored. Subdirectories are not scanned.
- The display title is the first `# ` heading with its number stripped, falling back to the filename slug.

Each ticket must contain **exactly one** status line, in either form:

```markdown
Status: ready-for-agent
```

```markdown
**Status:** ready-for-agent
```

Only statuses listed in `runnableStatuses` (default `["ready-for-agent"]`) are executed. Everything else — `resolved`, `ready-for-human`, `needs-triage`, `wontfix`, unknown values, and so on — is skipped and reported. A missing, duplicated, or empty status line is a malformed ticket and stops the run before any session is created.

The completion gate asks the child session to move the status out of the runnable set (this repo's completed value is `resolved`). The runner re-reads the file and never writes the status itself.

---

## How a run works

1. Read and validate the ticket folder (names, ordering, status lines).
2. Verify `/skill:implement` is discoverable.
3. Acquire `.pi/ticket-runner.lock` and run Git preflight checks.
4. For each ticket in numeric order:
   - Re-read its status from disk and skip it if it is not runnable.
   - Verify the branch and `HEAD` have not moved.
   - Create a fresh persistent `AgentSession` with the main session's model, thinking level, project instructions, and skills (this extension is filtered out of its children).
   - Invoke `/skill:implement <ticket-file>`.
   - Send one completion-gate prompt to the same session.
   - Continue only on `STATUS: COMPLETE` and a persisted status that is no longer runnable.
5. Release the lock and report what ran, what was skipped, and what remains.

Every child session is durable and appears in Pi's session picker. Re-running `start` after a stop or restart resumes at the first ticket whose status is still runnable; it does **not** continue a previous child session.

---

## Configuration

Configuration is read from:

1. `~/.pi/agent/ticket-runner.json` (global)
2. `.pi/ticket-runner.json` (project, overrides globally per key)

Missing files are fine. Unknown keys produce a warning; invalid values stop the command.

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

| Setting | Default | Meaning |
|---|---|---|
| `runnableStatuses` | `["ready-for-agent"]` | Status values eligible for execution; everything else is skipped |
| `maxTurnsPerTicket` | `50` | Maximum child `turn_end` events during implementation; exceeding it aborts and stops |
| `liveFrameUpdateIntervalMs` | `150` | Minimum interval between live session-frame renders |
| `expandedTranscriptMaxLines` | `1000` | Maximum lines rendered in one expanded child transcript |
| `expandedTranscriptMaxBytes` | `131072` | Maximum UTF-8 bytes rendered in one expanded child transcript |
| `staleLockHours` | `12` | Age after which an unreadable-PID lock is reported as stale |

`liveWidgetUpdateIntervalMs` is accepted as a deprecated alias for `liveFrameUpdateIntervalMs`; when both keys are present across the global and project files, `liveFrameUpdateIntervalMs` wins.

---

## Safety model

- **One runner per repository.** `.pi/ticket-runner.lock` is acquired with an exclusive create. Add `.pi/*.lock` to your `.gitignore`. Existing locks are never silently replaced; a stale lock is reported with the exact recovery command (`rm .pi/ticket-runner.lock`).
- **Git preflight.** Refuses a dirty working tree outside the ticket folder unless `--allow-dirty` is passed. Changes inside the ticket folder are always allowed.
- **Mid-run check.** If the branch or `HEAD` changes between tickets, the run stops.
- **No rollback.** Failed or interrupted work is preserved. The runner never stashes, resets, or switches branches.
- **No status guessing.** Malformed tickets stop the run instead of being repaired.
- **Conservative stopping.** A gate answer of `INCOMPLETE`, `BLOCKED`, malformed output, a still-runnable status after `COMPLETE`, a session error, the turn limit, or an interrupt all stop the run. There is no continue-on-failure mode.

---

## Development

```bash
npm install
npm test            # node --test
npm run typecheck   # tsc --noEmit
```

The core loop is testable without an LLM through the `TicketSession` port in [`src/sessions.ts`](src/sessions.ts).

See [`AGENTS.md`](AGENTS.md) for repo conventions and [`docs/agents/`](docs/agents) for the issue tracker, triage labels, and domain-doc rules.

---

## License

[MIT](LICENSE) © Stoyan Krastev
