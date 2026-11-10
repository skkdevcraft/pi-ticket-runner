# 13: Show context usage in a session frame's collapsed summary

**What to build:** Both lines of a session frame's collapsed summary gain the child session's **context usage** — estimated context tokens as a percentage of the child's model context window, formatted like Pi's own footer (`42.1%/200k`, `?/200k` when unknown). An active frame keeps the number current as the child works and time passes; a settled frame and a reloaded frame keep the last known number. The segment is omitted when the child's model has no context window, and it is colour-coded with Pi's 70/90 thresholds.

**Blocked by:** none

**Status:** resolved

- [ ] The collapsed summary's meta line shows context usage between the `errors` counter and the elapsed time: `12 turns • 8 tools • 0 errors • 42.1%/200k • 3m 07s • <model> • (ctrl+o)`.
- [ ] The percentage uses one decimal and the window is abbreviated with the same `k`/`M` convention Pi's footer uses (`200k`, `1M`).
- [ ] When the child session's token count is unknown (for example immediately after a compaction and before the next response), the segment renders `?/200k` rather than disappearing, so the line keeps its shape.
- [ ] When the child's model reports no context window, the segment is omitted entirely and the meta line is otherwise unchanged.
- [ ] The number is sampled when the frame is created and whenever the child's context can change — an assistant message ending, a tool execution ending, the completion gate starting, and settlement — and is not recomputed on every live repaint.
- [ ] A failing context-usage read leaves the last known value in place, never raises a frame error, and never increments the `errors` counter.
- [ ] The context usage segment is coloured with Pi's thresholds: `warning` above 70%, `error` above 90%, otherwise dim like the rest of the meta line.
- [ ] A settled frame retains the last known context usage in its persisted summary, so the number survives teardown and reload.
- [ ] A persisted summary written before this change, or written by a model without a context window, still renders; a malformed context-usage value is rejected without discarding the rest of the summary.
- [ ] A frame's context usage never enters the main session's model context, and no token counts or window sizes are stored beyond what the meta line displays.
- [ ] Tests cover formatting, position, the unknown-token state, the omitted state, both colour thresholds, narrow-width truncation, the sampling points, failure handling, settlement persistence, and reload of an older summary entry.
- [ ] README's session-frames paragraph lists context usage among the fields of a collapsed summary.

---

## Problem Statement

The runner exists so that a long multi-ticket implementation never overflows a context window: every ticket gets a fresh child session, and the main session only accumulates ticket inventory and progress. But the session frame — the only surface that describes a child session — says nothing about how much context that child consumed. Turns, tools, errors, elapsed time, and model are all visible; the quantity the design exists to control is not.

The reader is left guessing at exactly the question they care about: did this ticket's implementation come close to the child's context limit, or did the fresh-session-per-ticket design keep it comfortably small? Today answering that means leaving the transcript, resuming the child session, and reading its own footer. That is a context switch away from the very run being watched, and it is impossible for a frame that has already settled — the child session is disposed by then.

## Solution

Every session frame shows its child session's context usage in the collapsed summary, in Pi's own vocabulary and format:

```text
┌──────────────────────────────────────────────────────────────────────┐
│ ▸ ● 03 Add context usage · Done                                      │
│   12 turns • 8 tools • 0 errors • 42.1%/200k • 3m 07s • sonnet • (ctrl+o) │
└──────────────────────────────────────────────────────────────────────┘
```

An active frame keeps the number current as turns and time pass. A settled frame keeps the last known number, and a frame restored after a reload shows it too, so the run's context story stays readable next to the ticket it belongs to. When the count is momentarily unknown the segment reads `?/200k`; when the model has no context window it is omitted. Thresholds mirror the main footer, so a child approaching its limit is visible at a glance without reading the number.

## User Stories

1. As a maintainer watching a ticket run, I want each session frame to show its child's context usage, so that I can see how much of the child's context window a ticket consumed.
2. As a maintainer watching a ticket run, I want the context usage to stay visible in the collapsed summary, so that I do not have to expand the frame to judge context pressure.
3. As a maintainer watching a ticket run, I want the live frame's context usage to update as the child works, so that I can tell whether a ticket is heading for its context limit before it gets there.
4. As a maintainer watching a ticket run, I want the context usage to update at assistant-message and tool boundaries, so that the number reflects real usage rather than a stream of provisional estimates.
5. As a maintainer watching a ticket run, I want the number to move with each turn, so that I can correlate a bloating context with the work the child is doing.
6. As a maintainer watching a ticket run, I want the number to keep updating while a ticket takes a long time, so that elapsed time and context growth can be read together.
7. As a maintainer watching a ticket run, I want the context usage expressed as a percentage of the child's own model window, so that tickets run on different models remain comparable at a glance.
8. As a maintainer watching a ticket run, I want the window size shown next to the percentage, so that I can interpret a percentage without remembering the model's limit.
9. As a maintainer watching a ticket run, I want the same formatting Pi's footer uses, so that I read one convention everywhere and learn nothing new.
10. As a maintainer watching a ticket run, I want a warning colour above 70% and an error colour above 90%, so that a child approaching its limit is visible without reading the number.
11. As a maintainer watching a ticket run, I want the context usage to look like the other counters when it is comfortable, so that the frame stays calm and only colour signals a problem.
12. As a maintainer watching a ticket run, I want `?/200k` when the count is momentarily unknown, so that the line keeps its shape and I know the number is unavailable rather than zero.
13. As a maintainer watching a ticket run, I want the segment omitted when the child's model has no context window, so that the frame never shows a meaningless percentage.
14. As a maintainer reading a finished ticket run, I want settled frames to keep their last known context usage, so that I can review a run after it ends.
15. As a maintainer reading a finished ticket run, I want context usage to survive `/resume`, so that the run's context story is still legible in a later session.
16. As a maintainer reading a finished ticket run, I want frames recorded before this change to render without it, so that old transcripts never break.
17. As a maintainer reading a finished ticket run, I want a malformed recorded value to be ignored rather than fatal, so that one bad entry cannot hide a frame.
18. As a maintainer comparing tickets in one run, I want the same field present in every frame of a model, so that I can scan the column quickly.
19. As a maintainer investigating a child session later, I want the frame to keep pointing at the child session file, so that I can resume it for detail after seeing the usage summary.
20. As a maintainer on a narrow terminal, I want the meta line to truncate predictably, so that the frame border never breaks.
21. As a maintainer on a narrow terminal, I want context usage to survive truncation when the higher-value counters fit, so that the metric I added is not the first thing cut.
22. As a maintainer watching a ticket run, I want a failed context-usage read to be silent, so that a display probe never turns a healthy child frame into an error.
23. As a maintainer watching a ticket run, I want context usage never counted as a child error, so that the `errors` counter keeps meaning what it says.
24. As a maintainer watching a ticket run, I want the sampling to be cheap, so that a live frame never competes with the child session's own work.
25. As a maintainer watching a ticket run, I want the context usage to appear from the frame's first paint, so that the meta line does not change shape mid-run.
26. As a maintainer, I want context usage to remain a display-only value, so that no token counts leak into the main session's model context.
27. As a maintainer, I want the field limited to what the collapsed summary shows, so that the persisted frame summary stays a small counters-and-identity record.
28. As a maintainer, I want the metric named "context usage" consistently in code, docs, and glossary, so that it is never confused with billing token totals or cost.
29. As a maintainer, I want the feature documented in the README's session-frames section, so that readers know the field exists.
30. As a maintainer, I want the colour thresholds to match Pi's footer exactly, so that a warning in a frame and a warning in the footer mean the same thing.

## Implementation Decisions

**The child-session port carries the value.** The existing child-session port — the single seam the runner uses to talk to a child session — gains a read-only context-usage accessor returning the SDK's context-usage shape (`tokens: number | null`, `contextWindow: number`, `percent: number | null`) or undefined. The real adapter delegates straight to the SDK session's own accessor, so nothing is recomputed here and the SDK's compaction handling is inherited.

**The frame-child descriptor exposes it optionally.** The descriptor a frame receives when it is created already carries an optional transcript reader; it gains an optional context-usage reader in the same style. Optionality is what keeps a frame renderable from a persisted summary that has no usage recorded, and what keeps existing test fakes compiling unchanged.

**Context usage is sampled at boundaries, not on every repaint.** The live frame holds the latest snapshot and refreshes it at: frame creation, assistant-message end, tool-execution end, completion-gate start, and settlement. The SDK's accessor rebuilds the session projection on each call, and the frame repaints on a throttle several times a second while the child streams; refreshing on every repaint would spend O(session) work per paint to display a number that only changes meaningfully when a response or tool result lands. Refreshing at creation is deliberate: the frame never gains a segment mid-life, so the meta line does not reflow.

**A failing read is not an error.** The refresh is wrapped, keeps the previous snapshot on failure, and does not touch the frame's error counter. This is a display probe, not child work.

**The persisted summary gains one optional nested value.** The frame summary gains an optional context-usage object containing `percent` (number or null) and `contextWindow` (number), absent when the child's model has no context window. Nesting makes the three states structural rather than an invariant across two fields: absent (no window to be a percentage of), present with a null percent (count momentarily unknown), present with a number. The reader validates the object as a unit and rejects a malformed value without discarding the rest of the summary, so entries written before this change still render. Token counts are not persisted; the collapsed summary does not show them, and the summary stays a small counters-and-identity record.

**Settlement snapshots the value before disposal.** The runner already settles a frame before disposing its child session on every exit path, so sampling at settlement yields a current value and the summary carries it into teardown and reload.

**The pure renderer gains one tone and one segment.** The frame tone vocabulary gains a `warning` tone alongside the existing error tone, mapped in the single place that paints tones with a Pi theme. The meta line is rendered as several segments instead of one dim string; the context-usage segment sits between the `errors` counter and the elapsed time, is coloured `error` above 90%, `warning` above 70%, and is otherwise dim like its neighbours. Formatting and token abbreviation are local helpers: the SDK's footer formatter is not part of its public surface, and one decimal is chosen to match the convention readers already know from Pi.

**View and summary shapes carry the value.** The frame view exposes the current snapshot; the summary-to-view conversion passes the persisted value through, so a live frame, a settled frame, and a reloaded frame render the same segment from the same shape.

**Vocabulary.** "Context usage" is added to the glossary as the child session's estimated context tokens as a percentage of its model's context window; "context size", "context percent", and "token usage" are recorded as avoided terms. No ADR is recorded: the decision is reversible, unsurprising to a future reader, and involved no competing alternative worth preserving.

## Testing Decisions

A good test here asserts what a reader of the frame sees, not how the frame got there. For rendering, that means passing a view model plus a width to the pure frame renderer and asserting the collapsed summary's flattened text and each segment's tone — never inspecting private helpers or intermediate strings. For the live frame, it means driving child events through the same seam the runner uses and asserting the rendered meta line before and after, not asserting that some internal field changed. For persistence, it means writing a summary through the real append path and rendering it back from the persisted entry, so the round trip — not the serializer — is under test.

The accessor on the child-session port is still covered, but indirectly: the fakes used by the runner tests expose a settable context-usage value, and the frame tests assert the resulting line, which is the same arrangement already used for the transcript reader.

**Modules under test**

- The pure frame renderer, for format, position, the unknown-token state, the omitted state, both colour thresholds, and narrow-width truncation.
- The live frame and its controller, for the sampling points, the retain-last-value-on-failure behaviour, the untouched error counter, and the settlement snapshot.
- The persisted-summary reader and the summary-to-view conversion, for round trip, tolerance of an entry written before this change, and rejection of a malformed nested value.
- The runner, for exposing the accessor to the frame it starts.
- The SDK adapter is not unit tested; it is one delegation and the pinned SDK is the contract.

**Prior art**

The existing render tests for session frames and for the settled-transcript path are the direct precedent: build a view (or a persisted entry plus a theme), render, assert flattened text and tones. The live-frame tests that drive fake child events through a fake clock are the precedent for the sampling and failure tests — including the pattern of asserting the painted result after advancing the clock, rather than asserting scheduler internals. The fake child session used by the runner tests is the precedent for the port accessor.

## Out of Scope

- Historical tracking of context usage: no per-turn series, no sparkline, no peak or high-water mark, and no markers inside the expanded transcript.
- Any display of billing token totals, cache statistics, or cost in a frame; context usage is not token accounting.
- Changes to the main session's footer, to Pi's own footer, or to how the main session reports its context.
- Compaction control: the feature reports context usage, it never triggers, prevents, or tunes compaction, and it does not surface post-compaction boundaries beyond the `?/200k` unknown state.
- Configuration knobs: no new setting for enabling, disabling, formatting, or thresholding context usage.
- Context usage for a child session that has already been disposed outside a frame's lifetime, and any attempt to recover usage from a child session file after reload.
- Changes to the completion gate, ticket status handling, run locking, or Git safety.

## Further Notes

- The pinned SDK (`@earendil-works/pi-coding-agent` `1.5.0`) exports the context-usage type publicly and the session accessor returns it directly, including `null` percent right after compaction. Its footer's token abbreviation helper is internal, hence the local helper.
- The accessor rebuilds the session projection per call. Sampling at boundaries is what keeps that cost off the live repaint path; a future change to refresh on repaint would need a cache keyed on the session's entry count.
- The collapse-and-reload path renders from the persisted summary alone, so the nested value is the only thing that makes a restored frame show a number; it must stay optional for backward compatibility with entries written by earlier versions.
- Thresholds (70/90) and the one-decimal format are inherited conventions from Pi's footer, not new choices; if Pi changes them, the frame should follow.
