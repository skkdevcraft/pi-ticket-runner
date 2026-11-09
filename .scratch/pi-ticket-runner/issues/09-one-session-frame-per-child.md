# 09: One inline session frame per child session

**What to build:** The editor widget is removed and replaced by one durable, collapsible session frame per created child session. A frame appears once the child session exists, renders a bordered collapsed summary with ticket identity, status, and metadata, persists only a small summary at creation and settlement, and settles as `done`, `stopped`, or `failed` on every exit path. Skipped tickets and failures before child creation produce no frame, and between tickets only the footer names the next ticket.

Because the pinned Pi SDK has no update-in-place or removal API for custom entries, a frame's creation entry renders from the in-memory live model while that model exists, and the settled summary entry becomes the rendered one after reload. This keeps exactly one frame visible in both situations; the settled entry stays hidden while the live model is presenting the frame.

**Blocked by:** 08 (Frame configuration prefactor)

**Status:** resolved

- [x] Exactly one inline session frame is visible per created child session, both while the process is running and after a reload; superseded summary entries render no content after reload.
- [x] A frame is created only after the child session exists, so skipped tickets, Git stops, lock refusals, and session-creation failures produce no frame; no run-level or next-ticket frame is created.
- [x] The collapsed frame draws a literal border in the muted border colour, a collapsed/expanded toggle glyph, a status dot coloured per status, and a header of the form ticket number, title, and status word.
- [x] The meta line shows turns, tools, errors, elapsed time, model, and the expand hint; while the child is running it also advertises only `/ticket-runner stop`. Expanded frames use the same meta with the session short id prepended.
- [x] Frame lines are truncated to the available terminal width and the border spans the full available width.
- [x] A small summary entry is appended at frame creation and again at settlement. It contains only frame identity, ticket identity, child session file, model, status, counters, and timestamps — never transcript content.
- [x] Settlement is correct on every path: `done` only after a `COMPLETE` gate and a persisted status outside the runnable set; `stopped` for gate rejection, malformed gate answer, unchanged ticket status, turn limit, interruption, and shutdown/reload mid-run; `failed` only for a child-session error.
- [x] The editor widget is no longer installed anywhere; the footer remains the only run-level progress surface, shows the next ticket between tickets, and clears on teardown while frames remain.
- [x] The child event subscription is removed before disposal, and frame settlement happens before or during child disposal so a reload never leaves the active frame reporting `running`.
- [x] Tests cover frame rendering as pure view-model output, the full settlement matrix against a fake child session, the no-frame paths, and the in-session versus after-reload visibility rule.
