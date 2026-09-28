import { SqliteClient } from "@effect/sql-sqlite-bun";
import {
  deadlineDelivery,
  decideRequestTransition,
  type SessionHandle,
  type SessionRunner,
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
import {
  createActorRegistry,
  createChannelGrantStore,
  createChannelInstanceStore,
  createPersonStore,
  createSecretStore,
  openCatalogStore,
  openSessionStore,
  SessionHandleStore,
  type LedgerHandles,
} from "@openomni/ledger";
import type { LedgerSession, ObservationSink, SessionTransition } from "@openomni/protocol";
import { Context, Duration, Effect, Layer } from "effect";
import { SingleRunner } from "effect/cluster";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BunCrypto } from "./cluster-crypto";

/** Timer ack vocabulary (agent `SessionTimerOutcome`, structurally identical). */
type SessionTimerOutcome = "applied" | "noop";

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

/** Per-session ledger file path — the one place the layout is spelled. */
export function sessionFilePath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, `${sessionId}.sqlite`);
}

type CatalogHandle = LedgerHandles["catalog"];
type SessionStoreHandle = ReturnType<LedgerHandles["openSession"]>;
export type SessionKernel = ReturnType<typeof SessionHandleStore.createSessionKernel>;

export interface AppLedgerOptions {
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

export function createAppLedger(options: AppLedgerOptions = {}): AppLedgerPlane {
  const sessionsDir = options.sessionsDir;
  if (sessionsDir !== undefined) mkdirSync(sessionsDir, { recursive: true });
  const catalog = openCatalogStore(options.catalogPath ?? ":memory:", options.observationSink);
  const memo = new Map<string, { store: SessionStoreHandle; kernel: SessionKernel }>();
  function opened(sessionId: string) {
    let entry = memo.get(sessionId);
    if (entry === undefined) {
      const store = openSessionStore(
        sessionsDir === undefined ? ":memory:" : sessionFilePath(sessionsDir, sessionId),
        options.observationSink,
      );
      entry = { store, kernel: SessionHandleStore.createSessionKernel(store, catalog) };
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
          : openSessionStore(sessionFilePath(sessionsDir, sessionId), options.observationSink),
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
export function appLedgerLayer(options: AppLedgerOptions = {}): Layer.Layer<AppLedger> {
  return Layer.effect(
    AppLedger,
    Effect.acquireRelease(
      Effect.sync(() => createAppLedger(options)),
      (plane) => Effect.sync(() => plane.close()),
    ),
  );
}

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
 * `Deadline` fold body: an open request expires through the pure request
 * authority under the activation's own fence — never a second fence adoption,
 * which would stale the very activation delivering the wake.
 */
function commitRequestDeadline(
  context: SessionEntityTimerContext,
  requestId: string,
  domainRevisions?: (request: SessionTransition.Request) => Readonly<Record<string, number>>,
): Effect.Effect<SessionTimerOutcome> {
  const { kernel, authority } = context;
  return Effect.gen(function* () {
    const row = kernel.row(authority.sessionId);
    const request = kernel.requestById(requestId);
    const inputId = `${requestId}:deadline`;
    const inputRecord = kernel.requestInputById(authority.sessionId, inputId);
    const invocation = kernel.actionById(requestId);
    const decision = decideRequestTransition(
      {
        version: 1,
        sessionId: authority.sessionId,
        inputId,
        at: context.now,
        expectedRevision: row.revision,
        authority: { owner: authority.owner, fence: authority.fence },
        payload: { kind: "request.timeout", requestId },
      },
      {
        row,
        ...(inputRecord === undefined ? {} : { inputRecord }),
        ...(invocation === undefined ? {} : { invocation }),
        ...(request === undefined ? {} : { request }),
        requests: kernel.requestRows(authority.sessionId),
        ...(request === undefined || domainRevisions === undefined
          ? {}
          : { domainRevisions: domainRevisions(request) }),
      },
    );
    if (decision.actions.length === 0) return "noop" as const;
    yield* kernel.commitRequestTransition({
      sessionId: authority.sessionId,
      owner: authority.owner,
      fence: authority.fence,
      now: context.now,
      expectedRevision: row.revision,
      actions: [...decision.actions],
      state: row.state,
      ...(decision.requestCount === undefined ? {} : { requestCount: decision.requestCount }),
    });
    return "applied" as const;
  }).pipe(Effect.orDie);
}

/** Watch-plane fold bodies, injected by the composition that owns the watch sources. */
export interface SessionTimerHooks {
  readonly requestDomainRevisions?: (
    request: SessionTransition.Request,
  ) => Readonly<Record<string, number>>;
  readonly watchFired?: (
    context: SessionEntityTimerContext,
    payload: {
      readonly watchId: string;
      readonly epoch: number;
      readonly sourceKey: string;
      readonly batch: string;
    },
  ) => Effect.Effect<SessionTimerOutcome>;
  readonly watchTimeout?: (
    context: SessionEntityTimerContext,
    payload: { readonly watchId: string; readonly epoch: number; readonly fireAt: number },
  ) => Effect.Effect<SessionTimerOutcome>;
}

/**
 * Chain-guarded timer folds (plan F2/D5): a persisted DeliverAt message is
 * never cancelled; a superseded delivery consults the chain and acks `noop`.
 * A watch wake without a composed watch plane acks `noop` — fail-closed.
 */
export function sessionTimerPort(hooks: SessionTimerHooks = {}): SessionEntityPorts["timers"] {
  return {
    retryScheduled: (context, payload) =>
      Effect.sync(() =>
        retryDelivery(chainReads(context), payload.alarmId).op === "run"
          ? ("applied" as const)
          : ("noop" as const),
      ),
    deadline: (context, payload) =>
      Effect.suspend(() =>
        deadlineDelivery(chainReads(context), payload.requestId).op === "run"
          ? commitRequestDeadline(context, payload.requestId, hooks.requestDomainRevisions)
          : Effect.succeed("noop" as const),
      ),
    watchFired: (context, payload) =>
      Effect.suspend(() =>
        watchFiredDelivery(chainReads(context), payload.sourceKey).op === "run" &&
        hooks.watchFired !== undefined
          ? hooks.watchFired(context, payload)
          : Effect.succeed("noop" as const),
      ),
    watchTimeout: (context, payload) =>
      Effect.suspend(() =>
        watchTimeoutDelivery(chainReads(context), payload).op === "run" &&
        hooks.watchTimeout !== undefined
          ? hooks.watchTimeout(context, payload)
          : Effect.succeed("noop" as const),
      ),
  };
}

/**
 * Late-bound entity ports (plan §1): the entity layer is composed before the
 * Resident exists, so the composition root hands the layer this slot and
 * binds the real ports once boot resolves them. Unbound use dies typed —
 * an entity activation before composition finished is a wiring defect.
 */
export interface SessionEntityPortsSlot {
  readonly ports: SessionEntityPorts;
  bind(ports: SessionEntityPorts): void;
}

export function createSessionEntityPortsSlot(): SessionEntityPortsSlot {
  let bound: SessionEntityPorts | undefined;
  const resolve = (): SessionEntityPorts => {
    if (bound === undefined) throw new Error("session entity ports are not bound yet");
    return bound;
  };
  return {
    bind: (ports) => {
      if (bound !== undefined) throw new Error("session entity ports are already bound");
      bound = ports;
    },
    ports: {
      runTurn: (input) => Effect.suspend(() => resolve().runTurn(input)),
      timers: {
        retryScheduled: (context, payload) =>
          Effect.suspend(() => resolve().timers.retryScheduled(context, payload)),
        deadline: (context, payload) =>
          Effect.suspend(() => resolve().timers.deadline(context, payload)),
        watchFired: (context, payload) =>
          Effect.suspend(() => resolve().timers.watchFired(context, payload)),
        watchTimeout: (context, payload) =>
          Effect.suspend(() => resolve().timers.watchTimeout(context, payload)),
      },
      requestDomainRevisions: (request) => resolve().requestDomainRevisions?.(request) ?? {},
    },
  };
}

export interface SessionEntityRuntimeOptions {
  /** Writer identity stamped into `lease_owner` (audit only; the fence authorizes). */
  readonly owner: string;
  readonly clock?: () => number;
  /** Turn execution + timer ports; the turn port is composition-owned (plan §1). */
  readonly ports: SessionEntityPorts;
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
        clock: options.clock ?? (() => Date.now()),
        catalog: plane.catalog,
        openSession: plane.handles.openSession,
        ports: options.ports,
      };
    }),
  );
  return SessionEntityLive.pipe(Layer.provide(env));
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
export { requestAuthorityKernel } from "@openomni/agent";
