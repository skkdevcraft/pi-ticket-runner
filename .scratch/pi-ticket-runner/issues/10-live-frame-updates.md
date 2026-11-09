# 10: Live frame updates while the child runs

**What to build:** The active session frame updates live from child-session events. Status, turn count, tool count, error count, and elapsed time advance while the implementation prompt runs, and the completion gate switches the same frame to `verifying` without creating a second frame. Updates are throttled to the configured interval, completed frames stop updating, and no session entry is appended per update.

**Blocked by:** 09 (One inline session frame per child session)

**Status:** ready-for-agent

- [ ] Assistant text deltas, tool starts and ends, turn ends, and settled events feed an in-memory frame view model; the parent retains only the bounded live state the frame needs, never the full child transcript.
- [ ] The active frame's turns, tools, errors, and elapsed time update live; tool errors increment the error count and successful completion does not.
- [ ] The completion gate changes the painted status of the same frame to `verifying`; returning to the implementation phase or settling never creates an additional frame.
- [ ] Live frame updates are throttled to `liveFrameUpdateIntervalMs`; changes inside the interval are coalesced, and a settled or stopped frame stops accepting further live updates.
- [ ] Live repainting uses only public Pi seams: the renderer reads the live view model on each render, and repaint is driven through the existing footer status updates rather than private TUI internals or per-update session entries.
- [ ] The collapsed meta always reflects the live counts and status, including while the frame is expanded; completed frames are static and never keep repainting.
- [ ] Tests use a fake clock and fake child events to cover throttling, counter updates, the `verifying` transition on the same frame, and silence after settlement.
