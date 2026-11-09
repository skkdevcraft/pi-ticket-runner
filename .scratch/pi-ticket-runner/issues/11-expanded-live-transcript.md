# 11: Expand a session frame into its child transcript

**What to build:** `Ctrl+O` expands every session frame from its collapsed summary into a read-only, bounded child transcript, following Pi's native global expansion state. The expanded view renders the implementation and gate prompts as compact lines, assistant text in full Markdown, tool calls with their full results, edit diffs, write content, and tool errors, while excluding the system prompt, expanded skill body, and thinking blocks. The live expanded frame updates as the child runs; settled frames stay static. Content is capped at the configured line and byte limits with a truncation footer.

**Blocked by:** 10 (Live frame updates while the child runs)

**Status:** ready-for-agent

- [ ] `Ctrl+O` toggles all frames between collapsed and expanded using Pi's native expansion state; a new frame starts expanded when the global state is expanded; expansion state is not persisted across reload.
- [ ] The expanded frame keeps the border and header, adds a separating rule, prepends the session short id to the meta line, and remains read-only.
- [ ] The initial implementation prompt renders as one compact `Skill: implement · <ticket-reference>` line, and the completion-gate prompt renders as one compact `Gate: verify completion · <ticket-reference>` line.
- [ ] Assistant text is rendered with Markdown; each tool call renders as a compact tool row followed by its full result text; edit results render as diffs; write results show their full content; tool errors and failed results use the error colour.
- [ ] The system prompt, the expanded `implement` skill body, and thinking blocks are excluded from the frame but remain available through `/resume`.
- [ ] The transcript is projected from the child session into a read-only projection of compact user turns, assistant text, tool calls and results, and errors. The `TicketSession` port exposes this projection, and the SDK adapter implements it from the child session's entries.
- [ ] The expanded transcript respects both configured caps, whichever is reached first, and appends the truncation footer pointing the user to the child session in `/resume`; the complete transcript remains in the child session.
- [ ] The active expanded frame updates live while the child runs; settled frames are static. No native interactive assistant-message or tool-execution components are instantiated inside the frame.
- [ ] Frame rendering is a pure function of the transcript projection and view model, covered by fixture-based tests for prompt compaction, assistant text, tools, diffs, write content, errors, exclusions, caps, and the truncation footer.
