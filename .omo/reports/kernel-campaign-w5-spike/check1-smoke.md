# Check 1 smoke: SingleRunner boots on sqlite (effect 4.0.0-rc.118)

- import path in rc.118: `effect/cluster` (NOT `effect/unstable/cluster` as #1196/#1197/docs say); `@effect/sql-sqlite-bun@4.0.0-rc.118` (peer `effect ^4.0.0-rc.118`).
- Crypto.Crypto must be provided; platform-bun is not a workspace dep, so the spike provides a Bun webcrypto layer (spike/w5-cluster/src/crypto.ts).
- `bun run src/smoke.ts /tmp/w5-spike-smoke.db` -> exit 0, `{"ok":true,"sharding":"object","storage":"object"}`
- tables created by SqlMessageStorage/SqlRunnerStorage on the sqlite dialect: cluster_locks cluster_messages cluster_migrations cluster_replies cluster_runners
