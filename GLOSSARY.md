# pi-ticket-runner

Vocabulary for the Pi extension that runs local Markdown tickets sequentially, each in its own fresh child session.

## Language

**Ticket**:
A local Markdown file whose `Status:` line determines whether the runner may execute it.
_Avoid_: issue (when referring to the runnable unit), task

**Runnable ticket**:
A ticket whose `Status:` is in `runnableStatuses` and may be passed to `/skill:implement` now.
_Avoid_: ready ticket

**Child session**:
The fresh, persistent Pi `AgentSession` created to implement one ticket.
_Avoid_: sub-agent, sub-session, worker session

**Ticket run**:
One invocation of `/ticket-runner start`; it may span several child sessions.
_Avoid_: batch, job

**Session frame**:
The inline, bordered, collapsible transcript row that represents one child session.
_Avoid_: widget, card, block

**Collapsed summary**:
The header and meta lines that remain visible when a session frame is closed.
_Avoid_: preview, header

**Expanded transcript**:
The bounded, read-only view of a child session's messages shown when a session frame is open.
_Avoid_: child log, sub-transcript

**Settled**:
The point at which a child session will not continue automatically and its frame stops live updates.
_Avoid_: completed (for the child session), finished

**Completion gate**:
The single follow-up prompt that asks the child session whether the ticket is complete and moves its status out of the runnable set.
_Avoid_: verifier, review step

**Done**:
The session-frame status meaning the gate returned `COMPLETE` and the persisted ticket status is no longer runnable.
_Avoid_: completed, success

**Stopped**:
The session-frame status for a deliberate stop on an active child frame: gate rejection, malformed gate answer, unchanged ticket status, turn limit, or user interrupt.
_Avoid_: failed, cancelled

**Failed**:
The session-frame status for a child-session error.
_Avoid_: stopped, crashed
