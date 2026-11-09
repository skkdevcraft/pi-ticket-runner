# 01: Ticket inventory and read-only listing

**What to build:** `/ticket-runner list <ticket-folder>` works end-to-end. The package loads as a Pi extension, loads configuration from the global and project locations, resolves the supplied folder relative to the project working directory, discovers ticket files, sorts them numerically, parses each ticket's status and title, and renders the inventory without creating any sessions. This is the first complete path through the extension: command wiring, configuration, ticket reading, and TUI output.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `/ticket-runner list <folder>` is available once the extension loads and reads tickets only from the supplied folder, without recursive scanning.
- [ ] Ticket files matching `<NN>-<slug>.md` are discovered; unrelated files are ignored; missing, unreadable, and ticket-less folders produce descriptive errors.
- [ ] Tickets are sorted by ascending numeric prefix; duplicate numeric identifiers such as `01-a.md` and `1-b.md` are rejected.
- [ ] A single `Status:` or `**Status:**` line is read, trimmed, and lowercased; missing, duplicated, or empty status lines are malformed and stop the command before any session exists.
- [ ] Statuses in `runnableStatuses` are marked executable; every other value is marked `skip`; an unknown status is not an error.
- [ ] The display title comes from the first level-one heading with its number stripped, falling back to the filename slug.
- [ ] The list output shows each ticket in numeric order with its status class and a `NEXT ▶` marker on the first runnable ticket, followed by the executable count and `Nothing to run.` when none are runnable.
- [ ] Configuration loads from the global and project paths with project values overriding global values; missing files are allowed, unknown keys warn, and invalid values stop the command with a descriptive error.
- [ ] The command is read-only: it creates no child sessions, invokes no skill, and modifies no ticket status.
- [ ] Discovery, ordering, title, status-parsing, and configuration behaviour are covered by tests, and typechecking passes.
