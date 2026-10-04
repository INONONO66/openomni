import { AppInvariantError } from "../invariant";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Core } from "@openomni/agent";
type SessionHandle = Core.SessionHandle;
type SessionRunner = Core.SessionRunner;
const SessionEntityContext = Core.SessionEntityContext;
const createSessionEntityLayer = Core.createSessionEntityLayer;
type SessionEntityPorts = Core.SessionEntityPorts;
type AlarmDrainConfig = Core.AlarmDrainConfig;
const openCatalogStore = Core.openCatalogStore;
const openSessionStore = Core.openSessionStore;
type LedgerHandles = Core.LedgerHandles;
type ObservationFailurePort = Core.ObservationFailurePort;
type ObservationPublishFailure = Core.ObservationPublishFailure;
import { createActorRegistry, createChannelGrantStore, createChannelInstanceStore, createPersonStore, createSecretStore } from "@openomni/channels";
import type { LedgerSession, ObservationSink } from "@openomni/protocol";
import { Context, Deferred, Duration, Effect, Exit, Layer } from "effect";
import { SingleRunner } from "effect/cluster";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BunCrypto } from "./cluster-crypto";

/** effect/cluster's entity reaper never scans more frequently than five seconds. */
const ENTITY_REAPER_INTERVAL_MS = 5_000;

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
      entityMaxIdleTime: Duration.millis(
        Math.max(options.entityIdleMs, ENTITY_REAPER_INTERVAL_MS),
      ),
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

/** Per-session ledger file path — the one place the layout is spelled. */
export function sessionFilePath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, `${sessionId}.sqlite`);
}

type CatalogHandle = LedgerHandles["catalog"];
type SessionStoreHandle = ReturnType<LedgerHandles["openSession"]>;
export type SessionKernel = ReturnType<typeof Core.SessionHandleStore.createSessionKernel>;

export interface AppLedgerOptions {
  /** Injected wall clock (#1245): the ledger plane never reads ambient time. */
  readonly now: () => number;
  /** Catalog SQLite file; absent = an in-memory catalog (hermetic tests). */
  readonly catalogPath?: string;
  /**
   * Directory of per-session ledger files. Absent, session stores are
   * memoized in-memory handles shared between the plane and the entity —
   * hermetic, but a passivated in-memory activation loses its file, which is
   * exactly what in-memory means.
   */
  readonly sessionsDir?: string;
  readonly observationSink?: ObservationSink;
  /** Where a post-commit observation publish failure is reported; absent = the app incident log. */
  readonly onObservationFailure?: ObservationFailurePort;
}

/**
 * A publish that failed after its write committed is an incident for the
 * composition root's log, never a write failure: the receipt already left.
 */
function reportObservationPublishFailure(failure: ObservationPublishFailure): void {
  console.error(`ledger observation publish failed: ${failure.actionId}`, failure.cause);
}

/** Catalog-backed durable stores the app composes tools and boot over. */
interface AppCatalogStores {
  readonly actors: ReturnType<typeof createActorRegistry>;
  readonly persons: ReturnType<typeof createPersonStore>;
  readonly instances: ReturnType<typeof createChannelInstanceStore>;
  readonly secrets: ReturnType<typeof createSecretStore>;
  readonly channelGrants: ReturnType<typeof createChannelGrantStore>;
}

/**
 * The app's ledger plane (W5.2 F1): one catalog handle, memoized per-session
 * kernels for composition reads/commits, fresh per-activation store handles
 * for the entity, and the catalog-backed store plane. Built once at the
 * composition root and threaded explicitly — no module-level state.
 */
export interface AppLedgerPlane {
  readonly catalog: CatalogHandle;
  /** `LedgerWrites` shape: the shared catalog plus the entity's session opener. */
  readonly handles: LedgerHandles;
  /** Memoized handle-scoped kernel for one session (plane-owned lifetime). */
  openKernel(sessionId: string): SessionKernel;
  /** The memoized session store backing `openKernel` (decision-fact adapter access). */
  sessionStore(sessionId: string): SessionStoreHandle;
  /** Durable sessions this process can open: session files merged with opened handles. */
  listSessions(): LedgerSession.Row[];
  readonly stores: AppCatalogStores;
  close(): void;
}

export function createAppLedger(options: AppLedgerOptions): AppLedgerPlane {
  const sessionsDir = options.sessionsDir;
  if (sessionsDir !== undefined) mkdirSync(sessionsDir, { recursive: true });
  const catalog = openCatalogStore(options.catalogPath ?? ":memory:", {
    now: options.now,
    ...(options.observationSink === undefined ? {} : { observationSink: options.observationSink }),
  });
  const onObservationFailure = options.onObservationFailure ?? reportObservationPublishFailure;
  const memo = new Map<string, { store: SessionStoreHandle; kernel: SessionKernel }>();
  function opened(sessionId: string) {
    let entry = memo.get(sessionId);
    if (entry === undefined) {
      const store = openSessionStore(
        sessionsDir === undefined ? ":memory:" : sessionFilePath(sessionsDir, sessionId),
        {
          now: options.now,
          onObservationFailure,
          ...(options.observationSink === undefined ? {} : { observationSink: options.observationSink }),
        },
      );
      entry = { store, kernel: Core.SessionHandleStore.createSessionKernel(store, catalog) };
      memo.set(sessionId, entry);
    }
    return entry;
  }
  function sessionIds(): string[] {
    const ids = new Set(memo.keys());
    if (sessionsDir !== undefined && existsSync(sessionsDir)) {
      for (const file of readdirSync(sessionsDir)) {
        if (file.endsWith(".sqlite")) ids.add(file.slice(0, -".sqlite".length));
      }
    }
    return [...ids];
  }
  return {
    catalog,
    handles: {
      catalog,
      // File mode: the entity owns fresh handles it may close on passivation.
      // In-memory mode there is only one store per session — shared.
      openSession: (sessionId) =>
        sessionsDir === undefined
          ? opened(sessionId).store
          : openSessionStore(
              sessionFilePath(sessionsDir, sessionId),
              {
                now: options.now,
                onObservationFailure,
                ...(options.observationSink === undefined ? {} : { observationSink: options.observationSink }),
              },
            ),
    },
    openKernel: (sessionId) => opened(sessionId).kernel,
    sessionStore: (sessionId) => opened(sessionId).store,
    listSessions: () =>
      sessionIds().flatMap((id) => {
        try {
          return [opened(id).kernel.row(id)];
        } catch {
          return [];
        }
      }),
    stores: {
      actors: createActorRegistry(catalog),
      persons: createPersonStore(catalog),
      instances: createChannelInstanceStore(catalog),
      secrets: createSecretStore(catalog),
      channelGrants: createChannelGrantStore(catalog),
    },
    close: () => {
      for (const entry of memo.values()) entry.store.close();
      memo.clear();
      catalog.close();
    },
  };
}

export class AppLedger extends Context.Service<AppLedger, AppLedgerPlane>()(
  "@openomni/openomni/AppLedger",
) {}

/** Scoped plane layer: the composition root owns open and close. */
export function appLedgerLayer(options: AppLedgerOptions): Layer.Layer<AppLedger> {
  return Layer.effect(
    AppLedger,
    Effect.acquireRelease(
      Effect.sync(() => createAppLedger(options)),
      (plane) => Effect.sync(() => plane.close()),
    ),
  );
}

/**
 * Late-bound entity ports (plan §1): the entity layer is composed before the
 * Resident exists, so the composition root hands the layer this slot and
 * binds the real ports once boot resolves them. An activation awaits `ready`
 * before its first port call (the cluster host redelivers a crashed
 * process's persisted messages as soon as it starts, before boot reaches the
 * binding); unbound use outside an activation dies typed — a wiring defect.
 */
export interface SessionEntityPortsSlot {
  readonly ports: SessionEntityPorts;
  bind(ports: SessionEntityPorts): void;
}

export function createSessionEntityPortsSlot(): SessionEntityPortsSlot {
  let bound: SessionEntityPorts | undefined;
  const ready = Deferred.makeUnsafe<void>();
  const resolve = (): SessionEntityPorts => {
    if (bound === undefined) throw new AppInvariantError("session entity ports are not bound yet");
    return bound;
  };
  return {
    bind: (ports) => {
      if (bound !== undefined) throw new AppInvariantError("session entity ports are already bound");
      bound = ports;
      Deferred.doneUnsafe(ready, Exit.succeed(undefined));
    },
    ports: {
      ready: Deferred.await(ready),
      runTurn: (input) => Effect.suspend(() => resolve().runTurn(input)),
      onRequestReady: (sessionId) => bound?.onRequestReady?.(sessionId),
      requestDomainRevisions: (request) => resolve().requestDomainRevisions?.(request) ?? {},
      sendAlarm: (sessionId, occurrence) =>
        Effect.suspend(() => resolve().sendAlarm?.(sessionId, occurrence) ?? Effect.void),
      // #1254 S4: capability + keep-alive observation delegate late like the
      // turn port — purposes resolve against whatever boot bound (none = []).
      alarmCapability: {
        get purposes(): readonly string[] {
          return bound?.alarmCapability?.purposes ?? [];
        },
        wake: (fired, ctx) =>
          Effect.suspend(() => {
            const capability = resolve().alarmCapability;
            if (capability === undefined)
              return Effect.die(new AppInvariantError("alarm capability wake without a bound capability"));
            return capability.wake(fired, ctx);
          }),
      },
      onKeepAlive: (enabled) => bound?.onKeepAlive?.(enabled),
    },
  };
}

// ─── #1254 S3: boot alarm rescan ───

type AlarmSweepConfig = Core.AlarmSweepConfig;

/** One empty rescan wake (#1254 S3): entity-internal, appends no fact. */
export interface RescanOccurrence {
  readonly sessionId: string;
  readonly occurrence: {
    readonly occurrenceId: string;
    readonly purpose: "rescan";
    readonly alarmId: string;
    readonly armSeq: number;
    readonly sourceKey: "rescan";
    readonly payload: string;
    readonly fireAt: number;
  };
}

const DAY_MS = 86_400_000;

/**
 * Boot alarm rescan targets (#1254 S3): `sweep.full` rescans every session;
 * otherwise every `has_armed` session plus sessions idle for at least
 * `sweep.idleDays`. The occurrence is keyed `sessionId:rescan:<bootId>` so a
 * second boot is a new wake while one boot's duplicates fold in the cluster.
 */
export function rescanOccurrences(input: {
  readonly armedSessionIds: readonly string[];
  readonly sessions: readonly { readonly id: string; readonly lastActivityAt: number }[];
  readonly sweep: AlarmSweepConfig;
  readonly bootId: string;
  readonly now: number;
}): readonly RescanOccurrence[] {
  const targets = new Set<string>(input.armedSessionIds);
  for (const session of input.sessions) {
    if (input.sweep.full || input.now - session.lastActivityAt >= input.sweep.idleDays * DAY_MS) {
      targets.add(session.id);
    }
  }
  return [...targets].sort().map((sessionId) => ({
    sessionId,
    occurrence: {
      occurrenceId: `${sessionId}:rescan:${input.bootId}`,
      purpose: "rescan" as const,
      alarmId: `${sessionId}:rescan`,
      armSeq: 0,
      sourceKey: "rescan" as const,
      payload: "{}",
      fireAt: input.now,
    },
  }));
}

export interface SessionEntityRuntimeOptions {
  /** Writer identity stamped into `lease_owner` (audit only; the fence authorizes). */
  readonly owner: string;
  readonly clock: () => number;
  /** Turn execution + alarm ports; the turn port is composition-owned (plan §1). */
  readonly ports: SessionEntityPorts;
  /** D3 loop consumption values (#1254 S4), resolved by `resolveAlarmDrain`. */
  readonly drain: AlarmDrainConfig;
}

/**
 * The Session entity over the app's ledger plane: activations open store
 * handles through the plane and rotate fences through its shared catalog.
 */
export function sessionEntityLayer(options: SessionEntityRuntimeOptions) {
  const env = Layer.effect(
    SessionEntityContext,
    Effect.gen(function* () {
      const plane = yield* AppLedger;
      return {
        owner: options.owner,
        clock: options.clock,
        catalog: plane.catalog,
        openSession: plane.handles.openSession,
        ports: options.ports,
      };
    }),
  );
  return createSessionEntityLayer(options.drain).pipe(Layer.provide(env));
}

type SessionRunnerInput = Parameters<SessionRunner>[0];

/**
 * The composition's window into one live entity turn (W5.2 plan §1): the
 * entity runs turns inside its delivering RPC, so mid-turn interaction
 * (approval answers, durable interrupts) cannot ride a second RPC on the
 * serialized mailbox. The wrapped runner publishes the turn's approval gate
 * and boundary drain here for exactly the turn's lifetime.
 */
interface LiveTurnEntry {
  approvals: SessionHandle["approvals"] | undefined;
  readonly boundary: SessionRunnerInput["boundary"];
  /** The turn's own commit/transition port - request transitions ride the turn's fence. */
  readonly ledger: SessionRunnerInput["ledger"];
}

export interface SessionLivePlane {
  get(sessionId: string): LiveTurnEntry | undefined;
  /** Sessions with a turn currently running in this process (shutdown join set). */
  ids(): readonly string[];
  /** Publishes the turn's live surfaces for the runner's lifetime; nested turns keep the outermost entry. */
  wrapRunner(sessionId: string, runner: SessionRunner): SessionRunner;
}

export function createSessionLivePlane(): SessionLivePlane {
  const entries = new Map<string, LiveTurnEntry>();
  return {
    get: (sessionId) => entries.get(sessionId),
    ids: () => [...entries.keys()],
    wrapRunner: (sessionId, runner) => (input) =>
      Effect.suspend(() => {
        const entry: LiveTurnEntry = { approvals: undefined, boundary: input.boundary, ledger: input.ledger };
        entries.set(sessionId, entry);
        return runner({
          ...input,
          bindApprovals: (approvals) => {
            entry.approvals = approvals;
            input.bindApprovals?.(approvals);
          },
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (entries.get(sessionId) === entry) entries.delete(sessionId);
            }),
          ),
        );
      }),
  };
}

/**
 * Out-of-turn request authority over a possibly-live activation (W5.2 F5):
 * `createSessionRequests` adopts a fresh fence when no registry handle exists,
 * which would steal a running entity turn's authority and kill its wave. The
 * borrowing kernel view lives with the request authority in the agent package
 * so the decision seam and its regression tests share one implementation.
 */
export const requestAuthorityKernel = Core.requestAuthorityKernel;
