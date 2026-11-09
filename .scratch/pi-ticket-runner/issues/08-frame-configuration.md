# 08: Frame configuration prefactor

**What to build:** The configuration surface needed by session frames exists before any frame code lands. `liveFrameUpdateIntervalMs` replaces the widget interval setting, the deprecated `liveWidgetUpdateIntervalMs` remains accepted as an alias, and the two expanded-transcript caps are added. Existing code keeps working against the renamed setting, and configuration tests prove the alias precedence and validation.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Configuration exposes `liveFrameUpdateIntervalMs` (default 150), `expandedTranscriptMaxLines` (default 1000), and `expandedTranscriptMaxBytes` (default 131072), alongside the existing settings.
- [ ] `liveWidgetUpdateIntervalMs` is accepted as a deprecated alias for `liveFrameUpdateIntervalMs`; when both keys are present in the merged global and project configuration, the frame key wins regardless of which file supplied the alias.
- [ ] Invalid values for any frame or transcript setting stop the command with a descriptive error naming the key and file; unknown keys still produce warnings rather than errors.
- [ ] The live-view code and its tests use the renamed interval setting and compile without the widget terminology leaking into new configuration names.
- [ ] Configuration tests cover defaults, the deprecated alias, alias precedence, and invalid values for the new caps.
