# 04: Repository execution lock and git safety

**What to build:** A run is exclusive to one repository and refuses to proceed from a working tree that another agent could race. `start` acquires a repository execution lock before preflight and releases it on every exit path, refuses live or stale locks without silently replacing them, runs git preflight with the dirty-tree policy, and re-checks branch and HEAD before every ticket.

**Blocked by:** 03 (Sequential run across all runnable tickets)

**Status:** ready-for-agent

- [ ] The execution lock is acquired with an exclusive create at the repository lock location and records the PID, working directory, start time, and ticket folder.
- [ ] A pre-existing lock with a live PID refuses the run and names the live PID.
- [ ] A lock whose PID is dead or unreadable is reported as stale with the exact removal instruction and is never auto-deleted.
- [ ] The lock is released on success, failure, interruption, and extension shutdown.
- [ ] Preflight verifies the working directory is a Git repository and records the current branch and HEAD before any session is created.
- [ ] Preflight refuses changes outside the supplied ticket folder, naming the offending paths, while changes inside the ticket folder are always allowed.
- [ ] `--allow-dirty` suppresses only the unrelated-changes refusal and weakens no other check.
- [ ] Before each ticket the runner verifies branch and HEAD are unchanged since preflight; a change stops the run before the next session is created.
- [ ] The runner never switches branches, stashes changes, discards work, or reverts a failed or interrupted ticket.
- [ ] Lock acquisition, live-lock refusal, stale-lock reporting, release, dirty-tree policy, and branch/HEAD checks are covered by tests.
