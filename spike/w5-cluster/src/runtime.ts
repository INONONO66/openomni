import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Duration, Layer } from "effect";
import { SingleRunner } from "effect/cluster";
import { BunCrypto } from "./crypto.ts";
import { SessionEntityLayer, SessionRoot } from "./session-entity.ts";

export interface RuntimeOptions {
  /** Directory for per-session ledger files (<root>/<sessionId>.sqlite). */
  readonly root: string;
  /** Sqlite file for the cluster_* catalog tables (mailbox, replies, runners). */
  readonly catalogFile: string;
}

/**
 * Single-node cluster runtime: SingleRunner (sql runner storage + sql message
 * storage on catalogFile) + Bun webcrypto + our Session entity. Short idle and
 * poll intervals so entity passivation is observable inside a test run.
 */
export function makeRuntime(options: RuntimeOptions) {
  const SqlLive = SqliteClient.layer({ filename: options.catalogFile });
  const ClusterLive = SingleRunner.layer({
    runnerStorage: "sql",
    shardingConfig: {
      entityMaxIdleTime: Duration.seconds(2),
      entityMessagePollInterval: Duration.millis(100),
    },
  }).pipe(Layer.provide(SqlLive), Layer.provide(BunCrypto));
  return SessionEntityLayer.pipe(
    Layer.provide(Layer.succeed(SessionRoot, options.root)),
    Layer.provideMerge(ClusterLive),
  );
}
