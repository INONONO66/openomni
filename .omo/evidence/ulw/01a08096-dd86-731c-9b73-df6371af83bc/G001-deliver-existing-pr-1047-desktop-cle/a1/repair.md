# Desktop cleanup repair

Baseline was captured before edits at `19afa02d`.

## Corrections

- Restored `useChatEndpoint`, `useShellLifecycle`, `historyControls`, and stable `onShellCommand` callback boundaries in `apps/desktop/src/renderer/app.tsx`, retaining `useSessionChats` and `desktopBridge`.
- Migrated `activePlace`, `tabTitle`, and `historyMenuEntries` ownership to selectors and updated all desktop references; removed duplicate store implementations.
- Cached `attentionKind` in ranked attention entries and reused it for grouping without changing ordering.
- Removed unused idle boundary exports and implementation plus its dead-only tests; `Boundary` and `Held` remain.

## Verification logs

- `logs/baseline-desktop-test.log` and `logs/baseline-ui-test.log`: baseline tests passed.
- `logs/desktop-test-final.log`: desktop tests passed.
- `logs/ui-test.log`: UI tests passed.
- `logs/check-types-final.log`: desktop type checks passed.
- `logs/ultracite-final.log`: ultracite check passed.
- `logs/build.log`: desktop build passed.
- `logs/topology-final.log`: diff check passed.

LSP diagnostics were run on all changed source files and reported no diagnostics.
