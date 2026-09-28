# W5.2 #1197 adversarial review brief (parent-authored)
Branch kernel/1197-session-entity-20260928 vs origin/main 5b925d12. PR #1239. Plan: .omo/plans/w52-session-entity.md. Receipts: .omo/reports/kernel-campaign-w52/.
Parent-measured: full bun test 4636/0 (521 files), check-types 0, lint 0 errors, lint:tools 0, topology/deps/cycles/dead-exports/tsconfig 0, check-effect-boundaries exit 0 (allowlist 54->48), §5(a) grep 0, crash matrix 27 rows.
Findings the reviewer must judge (not yet adjudicated):
1. check-deps perimeter allowlist grew by six ledger factory names (createActorRegistry, createBlacklistStore, createChannelGrantStore, createReplyGrantStore, createSurfaceKeyStore, createDecisionFactPort, createEgressBudgetStore) — is this the correct boundary or a leak of storage acquisition into channels?
2. `localInboxCommit` borrow-when-running fence steal (double adoption bump 1->2) — is the fence semantics still fail-closed for a genuinely stale writer?
3. New `settle` entity-port + detach-at-boundary interrupt; `createSessionTurn.runTurn` generation capture; index.ts stop() ordering.
4. Detached-body failures now logged loudly — is logging the correct terminal behavior or should they fail the activation?
5. Deleted tests (5 ledger, 6 session-handle, alarm-boot, monitor-message-controls, message-admission-crash fixture, native-message-fixture helper, alarm.ts helper) — equivalent coverage on the entity plane?
6. Protocol retains Inbox.Commit / Alarm.Watch* schemas as wire vocabulary; 16 pre-existing protocol `unknown` sites carried to #1113.
7. Cluster entity reaper resolution >=5s; ConfigProvider.fromEnv() snapshots env at module load; L2.4 readUntil timer nit; session-handle teardown swallows thrown expect during 30s close grace; turnId:"noop" delivery drift; ForeignFailure double-wrap in corrupted-catalog boot; cluster-runtime pre-hooks watch fail-closed noop.
8. Owner stop conditions: any wire/DTO shape change visible to desktop or channels; any ratchet growth.
