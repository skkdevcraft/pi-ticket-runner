# 07: Ship-ready package with integration test and README

**What to build:** The extension is installable and documented as a Pi package, and one opt-in integration test proves the real child-session path against a scratch repository. The package metadata, peer dependency, scripts, ignore rules, and README match the settled distribution decisions, and the complete typecheck and test suite pass.

**Blocked by:** 06 (Live TUI progress and main-session input guard)

**Status:** ready-for-agent

- [ ] Package metadata declares the Pi extension entry point, the `pi-package` keyword, the MIT license, and the Pi SDK as a host-provided peer dependency rather than a bundled dependency.
- [ ] Typecheck and test scripts run without a build step or additional test framework.
- [ ] The repository ignores the execution lock while keeping the lock location documented.
- [ ] An environment-gated integration test drives a real persistent child session against a scratch repository, verifies the implementation prompt and completion gate path, and is skipped by default when its enabling environment variable is absent.
- [ ] The README documents installation, the four commands, configuration keys and defaults, prerequisites, dirty-tree and stale-lock recovery, and the fact that ticket files remain the only persisted run state.
- [ ] The full test suite, including the new integration test when enabled, and typechecking pass.
- [ ] No run log, completion database, or execution-history file is introduced.
