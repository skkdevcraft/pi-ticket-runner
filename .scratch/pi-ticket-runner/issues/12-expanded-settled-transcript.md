# 12: Expand a settled frame from its child session file

**What to build:** After reload or teardown, expanding a settled session frame loads its child transcript on demand from the persisted child session file using the public session-opening API, caches it only while expanded, and drops the cache on collapse and teardown. Missing or unreadable session files degrade to a clear unavailable message, and an empty session reports that the transcript is not yet available. Summary data still renders without reading the transcript, and no transcript content enters the summary or the model context.

**Blocked by:** 11 (Expand a session frame into its child transcript)

**Status:** resolved

- [x] Expanding a settled frame after reload or teardown loads the transcript lazily from the child session file recorded in the frame summary; frames settle and restore without the original live child session.
- [x] A missing or unreadable child session file renders `Transcript unavailable · <reason>` and never crashes the frame or the extension.
- [x] A child session with no messages renders `Transcript not yet available.`
- [x] The loaded transcript is cached only while the frame is expanded; collapsing the frame, tearing down the run, or shutting down drops the cache, and expanding again reloads it.
- [x] Transcript content is never written into the persisted frame summary and never reaches the main agent's LLM context.
- [x] Tests cover loading from a fixture session file, missing and unreadable files, the empty-session state, and cache creation and drop across expand, collapse, and teardown.
