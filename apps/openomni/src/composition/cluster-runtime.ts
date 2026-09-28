import { SqliteClient } from "@effect/sql-sqlite-bun";
import {
  deadlineDelivery,
  retryDelivery,
  SessionEntityContext,
  SessionEntityLive,
  watchFiredDelivery,
  watchTimeoutDelivery,
  type SessionEntityEnv,
  type SessionEntityPorts,
  type SessionEntityTimerContext,
  type TimerChainReads,
} from "@openomni/agent";
import { openCatalogStore, openSessionStore } from "@openomni/ledger";
import { Duration, Effect, Layer } from "effect";
import { SingleRunner } from "effect/cluster";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BunCrypto } from "./cluster-crypto";

/**
 * Cluster plane composition (W5.2 #1197 plan §1): a single-node SingleRunner
 * host over the catalog file plus the Session entity wired to per-session
 * ledger files. The cluster is host + mailbox + clock only; durability is the
 * ledger's hash chain.
 */

export interface ClusterHostOptions {
  /** Sqlite file holding the `cluster_*` runner/message tables. */
  readonly catalogPath: string;
  /** `entityMaxIdleTime` in milliseconds (config `entityIdleMs`). */
  readonly entityIdleMs: number;
}

/**
 * Single-node cluster host: SingleRunner with sql runner+message storage on
 * the catalog file and Bun webcrypto. ShardingConfig is pinned fully explicit
 * (review R2 / plan D9): ambient `SHARDING_*` env never configures this layer.
 */
export function clusterHostLayer(options: ClusterHostOptions) {
  return SingleRunner.layer({
    runnerStorage: "sql",
    shardingConfig: {
      entityMaxIdleTime: Duration.millis(options.entityIdleMs),
      entityMessagePollInterval: Duration.millis(100),
      entityReplyPollInterval: Duration.millis(100),
    },
  }).pipe(
    Layer.provide(SqliteClient.layer({ filename: options.catalogPath })),
    Layer.provide(BunCrypto),
  );
}

/** Services the cluster host contributes to the app runtime (entity client access). */
export type ClusterServices = Layer.Success<ReturnType<typeof clusterHostLayer>>;

function chainReads(context: SessionEntityTimerContext): TimerChainReads {
  const { kernel, authority } = context;
  return {
    actionById: kernel.actionById,
    requestById: kernel.requestById,
    resultFor: (intentId) => kernel.resultFor(authority.sessionId, intentId),
    operationChildrenPage: (parentId, cursor) =>
      kernel.operationChildrenPage(authority.sessionId, parentId, cursor),
  };
}

/**
 * Chain-guarded timer folds (plan F2/D5): a persisted DeliverAt message is
 * never cancelled; a superseded delivery consults the chain and acks `noop`.
 */
export function sessionTimerPort(): SessionEntityPorts["timers"] {
  const outcome = (disposition: { readonly op: "run" | "skip" }) =>
    disposition.op === "run" ? ("applied" as const) : ("noop" as const);
  return {
    retryScheduled: (context, payload) =>
      Effect.sync(() => outcome(retryDelivery(chainReads(context), payload.alarmId))),
    deadline: (context, payload) =>
      Effect.sync(() => outcome(deadlineDelivery(chainReads(context), payload.requestId))),
    watchFired: (context, payload) =>
      Effect.sync(() => outcome(watchFiredDelivery(chainReads(context), payload.sourceKey))),
    watchTimeout: (context, payload) =>
      Effect.sync(() => outcome(watchTimeoutDelivery(chainReads(context), payload))),
  };
}

export interface SessionEntityRuntimeOptions {
  /** Catalog file for `session_index` fence rotation (same file as the host's). */
  readonly catalogPath: string;
  /** Directory of per-session ledger files (`<sessionsDir>/<sessionId>.sqlite`). */
  readonly sessionsDir: string;
  /** Writer identity stamped into `lease_owner` (audit only; the fence authorizes). */
  readonly owner: string;
  readonly clock?: () => number;
  /** Turn execution + timer ports; the turn port is composition-owned (plan §1). */
  readonly ports: SessionEntityPorts;
}

/** Per-session ledger file path — the one place the layout is spelled. */
export function sessionFilePath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, `${sessionId}.sqlite`);
}

/**
 * The Session entity over one runner process's environment: activations open
 * per-session stores under `sessionsDir` and rotate fences through the shared
 * catalog handle, which lives exactly as long as the layer's scope.
 */
export function sessionEntityLayer(options: SessionEntityRuntimeOptions) {
  const env = Layer.effect(
    SessionEntityContext,
    Effect.acquireRelease(
      Effect.sync((): SessionEntityEnv => {
        mkdirSync(options.sessionsDir, { recursive: true });
        return {
          owner: options.owner,
          clock: options.clock ?? (() => Date.now()),
          catalog: openCatalogStore(options.catalogPath),
          openSession: (sessionId) =>
            openSessionStore(sessionFilePath(options.sessionsDir, sessionId)),
          ports: options.ports,
        };
      }),
      (context) => Effect.sync(() => context.catalog.close()),
    ),
  );
  return SessionEntityLive.pipe(Layer.provide(env));
}
