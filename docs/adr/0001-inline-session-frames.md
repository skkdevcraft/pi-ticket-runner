# Inline session frames use public Pi extension APIs

## Status

accepted

## Context

The live child-session view was a six-line widget above the editor. It could not be expanded, kept no history in the transcript, and mixed live progress with the run footer. pi-visor demonstrates a better shape — bounded, collapsible transcript frames — but implements it by patching Pi's private chat container and native tool/assistant components. This extension targets public SDK seams and must not depend on those internals.

## Decision

Replace the widget with one inline session frame per child session, built as a TUI-only custom entry via `pi.appendEntry()` and `pi.registerEntryRenderer()`. Each frame persists only a small summary; the expanded transcript is read on demand from the child session file. `Ctrl+O` toggles all frames between the collapsed summary and the full child transcript, with a per-frame display cap.

## Consequences

- Frames are read-only renderings of child messages, not native tool rows. They cannot participate in Pi's native tool grouping or mouse routing.
- Expanded transcripts are lazy, bounded, and never enter the parent's LLM context.
- Live updates use an in-memory view model plus a settled summary entry; there is no public update-in-place API for custom entries. Repaints are requested by re-publishing the unchanged footer status, and each cached frame component reads the live view model on every render.
- Live repaints are throttled by `liveFrameUpdateIntervalMs`; a settled frame paints once and then ignores child events.
- A future move to native component grouping would require reopening this decision and accepting private Pi seams.
