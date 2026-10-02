/**
 * W5.2 L2.4 — test cluster runtime hosting the REAL Session entity (plan §3
 * L2.1 `src/session/entity.ts`) on a SingleRunner: sql message/runner
 * storage plus the ledger catalog schema in one catalog file, per-session
 * ledger files under `sessionsDir`. Every Effect here is executed through the
 * allowlisted `runAgent` helper so the runner-site ratchet does not grow.
 *
 * The wire contract is `src/session/messages.ts`: `Prompt`/`Interrupt`/
 * `Resume` payloads are `{ messageId, content, origin }` (origin = canonical
 * JSON of the protocol origin value) acked with `ChainAppendReceipt`
 * `{ ordinal, actionHash, deduped }`; `Deadline` is `{ requestId, deadlineAt }`
 * (DeliverAt = deadlineAt) acked with `TimerReceipt { outcome }`.
 *
 * The composition seam is `SessionEntityContext` (`SessionEntityEnv`): this
 * file supplies the catalog handle, the per-session store opener and a
 * minimal REAL turn port — chain-committed turn intent/resume + delivery
 * records around a pluggable `TestTurnRunner`, then the chain-committed
 * terminal — so entity tests exercise the durable protocol without the full
 * executor (which reaches the entity plane in wave 3).
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A throwaway cluster home: sessions dir plus catalog file under one temp root. */
export function clusterTempDir(prefix: string): {
  readonly dir: string;
  readonly sessionsDir: string;
  readonly catalogFile: string;
} {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  return { dir, sessionsDir, catalogFile: join(dir, "catalog.sqlite") };
}

import { Database } from "bun:sqlite";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { L0Write } from "../../src/store/session-file";
import * as SessionHandleStore from "../../src/store/fence";
import type { Inbox } from "@openomni/protocol";
import { Context, Crypto, Duration, Effect, Layer, type Scope } from "effect";
import { SingleRunner } from "effect/cluster";
import { openCatalogStore } from "../../src/store/catalog";
import { openSessionStore } from "../../src/store/session-file";
import {
  SessionEntity,
  SessionEntityContext,
  SessionEntityLive,
  type SessionEntityEnv,
} from "../../src/session/entity";

/** Integration-helper composition root: cluster fixtures run on the real wall clock. */
const wallClock = () => Date.now();
import {
  deadlineDelivery,
  retryDelivery,
  watchFiredDelivery,
  watchTimeoutDelivery,
  type AlarmChainReads,
} from "../../src/session/alarm";
import type {
  SessionEntityPorts,
  SessionEntityTimerContext,
  SessionEntityTurnInput,
} from "../../src/session/run";
import type { SessionError } from "../../src/kernel/failure";
import {
  deliveryActions,
  turnIntentAction,
  turnResumeAction,
  turnTerminalAction,
} from "../../src/session/commit";
import { runAgent } from "./executor";

export interface TestClusterOptions {
  readonly sessionsDir: string;
  readonly catalogFile: string;
  /** entityMaxIdleTime in ms (default 60s: passivation out of the way). */
  readonly idleMs?: number;
  /** Turn execution port; defaults to a runner resolving one text result. */
  readonly runner?: TestTurnRunner;
  /** Exercise the production post-boundary fork instead of running the body inline. */
  readonly detachTurns?: boolean;
}

/** What the test turn port hands the pluggable runner for one admitted turn. */
export interface TestTurnInput {
  readonly turnId: string;
  readonly resumeCount: number;
  readonly items: readonly Inbox.Row[];
}

interface TestTurnResult {
  readonly kind: "result" | "interrupted";
  readonly text: string;
}

export type TestTurnRunner = (input: TestTurnInput) => Effect.Effect<TestTurnResult, SessionError>;

/** A runner that resolves immediately with one text result. */
export function resolvedRunner(text: string): TestTurnRunner {
  return () => Effect.succeed({ kind: "result", text });
}

function runTurnBody(
  input: SessionEntityTurnInput,
  body: Effect.Effect<void, SessionError>,
  detachTurns: boolean,
): Effect.Effect<void, SessionError> {
  return detachTurns ? input.detach(body) : body;
}

/**
 * A runner that reports entry (the turn intent + delivery chain commit already
 * happened) and then never completes, keeping the envelope unacknowledged so
 * SIGKILL leaves an unprocessed mailbox row.
 */
export function blockingRunner(onEnter: (turnId: string) => void): TestTurnRunner {
  return (input) =>
    Effect.suspend(() => {
      onEnter(input.turnId);
      return Effect.never;
    });
}

/** The options handle send helpers resolve for on-demand session provisioning. */
class TestClusterEnv extends Context.Service<TestClusterEnv, TestClusterOptions>()(
  "@openomni/agent-test/TestClusterEnv",
) {}

/** Bun webcrypto-backed Crypto service (platform-bun is not a workspace dep). */
const BunTestCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => new Uint8Array(await crypto.subtle.digest(algorithm, data))),
  }),
);

/**
 * Minimal real turn port over the activation kernel: commits the turn
 * intent/resume plus the delivery records (state -> running), runs the
 * pluggable runner, then commits the terminal (state -> idle/interrupted).
 * Every commit rides the activation's catalog fence.
 */
function makeTurnPort(runner: TestTurnRunner, detachTurns = false): SessionEntityPorts["runTurn"] {
  return (input: SessionEntityTurnInput) =>
    Effect.gen(function* () {
      const { kernel, authority, decision, snapshot } = input;
      const { sessionId, owner, fence } = authority;
      const commit = (
        actions: Parameters<typeof kernel.commit>[0]["actions"],
        state: "running" | "idle" | "interrupted",
      ) =>
        kernel.commit({
          sessionId,
          owner,
          fence,
          now: Date.now(),
          expectedRevision: kernel.row(sessionId).revision,
          actions,
          state,
        });
      const seal = (
        turnId: string,
        resultId: string,
        parentId: string,
        resumeCount: number,
        result: TestTurnResult,
      ) =>
        commit(
          [
            turnTerminalAction({
              id: resultId,
              parentId,
              sessionId,
              turnId,
              result,
              resumeCount,
              boundaryActionId: null,
              at: Date.now(),
            }),
          ],
          result.kind === "result" ? "idle" : "interrupted",
        );

      if (decision.kind === "recover") {
        const open = decision.open;
        const body = Effect.gen(function* () {
          const result = yield* runner({
            turnId: open.turnId,
            resumeCount: open.resumeCount,
            items: [],
          });
          yield* seal(open.turnId, open.resultId, open.turnId, open.resumeCount, result);
        });
        yield* runTurnBody(input, body, detachTurns);
        return;
      }

      if (decision.kind === "resume") {
        const terminal = snapshot.terminal;
        if (terminal === undefined) return yield* Effect.die("resume decision without a terminal");
        const turnId = terminal.effect.turnId;
        const resumeCount = terminal.effect.resumeCount + 1;
        const item = decision.item;
        const resumeId = `${item.id}:resume`;
        const resultId = `${resumeId}:result`;
        yield* commit(
          [
            turnResumeAction({
              id: resumeId,
              parentId: turnId,
              sessionId,
              turnId,
              resultId,
              generation: kernel.latestGenerationFor(sessionId),
              resumeCount,
              boundaryActionId: null,
              at: Date.now(),
            }),
            ...deliveryActions([item], { kind: "turn", turnId }, "before_llm", resumeId),
          ],
          "running",
        );
        const body = Effect.gen(function* () {
          const result = yield* runner({ turnId, resumeCount, items: [item] });
          yield* seal(turnId, resultId, resumeId, resumeCount, result);
        });
        yield* runTurnBody(input, body, detachTurns);
        return;
      }

      // start: the head of the pending backlog is the admitted prompt.
      const item = snapshot.pending[0];
      if (item === undefined) return yield* Effect.die("start decision without a pending item");
      const turnId = `${item.id}:turn`;
      const resultId = `${turnId}:result`;
      yield* commit(
        [
          turnIntentAction({
            id: turnId,
            parentId: kernel.latestAction(sessionId)?.id ?? null,
            sessionId,
            resultId,
            inboxIds: [item.id],
            generation: kernel.latestGenerationFor(sessionId),
            resumeCount: 0,
            boundaryActionId: null,
            at: Date.now(),
          }),
          ...deliveryActions([item], { kind: "turn", turnId }, "before_llm", turnId),
        ],
        "running",
      );
      const body = Effect.gen(function* () {
        const result = yield* runner({ turnId, resumeCount: 0, items: [item] });
        yield* seal(turnId, resultId, turnId, 0, result);
      });
      yield* runTurnBody(input, body, detachTurns);
    }).pipe(Effect.orDie);
}

/** Chain-guarded timer folds straight from `src/session/alarm` (C2/F2). */
function makeTimerPort(): SessionEntityPorts["timers"] {
  const reads = (context: SessionEntityTimerContext): AlarmChainReads => ({
    actionById: context.kernel.actionById,
    requestById: context.kernel.requestById,
    resultFor: (intentId) => context.kernel.resultFor(context.authority.sessionId, intentId),
    operationChildrenPage: (parentId, cursor) =>
      context.kernel.operationChildrenPage(context.authority.sessionId, parentId, cursor),
  });
  const outcome = (disposition: { readonly op: "run" | "skip" }) =>
    disposition.op === "run" ? ("applied" as const) : ("noop" as const);
  return {
    retryScheduled: (context, payload) =>
      Effect.sync(() => outcome(retryDelivery(reads(context), payload.alarmId))),
    deadline: (context, payload) =>
      Effect.sync(() => outcome(deadlineDelivery(reads(context), payload.requestId))),
    watchFired: (context, payload) =>
      Effect.sync(() => outcome(watchFiredDelivery(reads(context), payload.sourceKey))),
    watchTimeout: (context, payload) =>
      Effect.sync(() => outcome(watchTimeoutDelivery(reads(context), payload))),
  };
}

/** The composition-owned entity environment, scoped to one test runtime. */
function entityEnvLayer(options: TestClusterOptions) {
  return Layer.effect(
    SessionEntityContext,
    Effect.acquireRelease(
      Effect.sync(
        (): SessionEntityEnv => ({
          owner: `test-runner-${process.pid}`,
          clock: () => Date.now(),
          catalog: openCatalogStore(options.catalogFile, { now: wallClock }),
          openSession: (sessionId) =>
            openSessionStore(sessionFileFor(options.sessionsDir, sessionId), { now: wallClock }),
          ports: {
            runTurn: makeTurnPort(options.runner ?? resolvedRunner("ok"), options.detachTurns),
            timers: makeTimerPort(),
          },
        }),
      ),
      (env) => Effect.sync(() => env.catalog.close()),
    ),
  );
}

/**
 * Single-node cluster host: SingleRunner with sql runner+message storage on
 * the catalog file. ShardingConfig is pinned explicitly (review R2 / plan D9):
 * never ambient `layerFromEnv` values in tests.
 */
function clusterHostLayer(options: TestClusterOptions) {
  return SingleRunner.layer({
    runnerStorage: "sql",
    shardingConfig: {
      entityMaxIdleTime: Duration.millis(options.idleMs ?? 60_000),
      entityMessagePollInterval: Duration.millis(100),
      entityReplyPollInterval: Duration.millis(100),
    },
  }).pipe(
    Layer.provide(SqliteClient.layer({ filename: options.catalogFile })),
    Layer.provide(BunTestCrypto),
  );
}

/** The real Session entity over the single-node host (plan §1 composition). */
export function makeTestClusterRuntime(options: TestClusterOptions) {
  return SessionEntityLive.pipe(
    Layer.provide(entityEnvLayer(options)),
    Layer.merge(Layer.succeed(TestClusterEnv, options)),
    Layer.provideMerge(clusterHostLayer(options)),
  );
}

/** Run one scoped program against a freshly built test cluster runtime. */
export function runCluster<A, E>(
  options: TestClusterOptions,
  program: Effect.Effect<
    A,
    E,
    Layer.Success<ReturnType<typeof makeTestClusterRuntime>> | Scope.Scope
  >,
): Promise<A> {
  return runAgent(Effect.scoped(program.pipe(Effect.provide(makeTestClusterRuntime(options)))));
}

/**
 * On-demand session provisioning (idle row + catalog index) with short-lived
 * store handles: entity activations refuse truly unknown sessions, so send
 * helpers materialize the target first. Memoized per session file.
 */
const provisioned = new Map<string, Promise<void>>();

function provisionSession(options: TestClusterOptions, sessionId: string): Effect.Effect<void> {
  const file = sessionFileFor(options.sessionsDir, sessionId);
  return Effect.promise(() => {
    let pending = provisioned.get(file);
    if (pending === undefined) {
      pending = runAgent(
        Effect.gen(function* () {
          const catalog = openCatalogStore(options.catalogFile, { now: wallClock });
          const store = openSessionStore(file, { now: wallClock });
          const kernel = SessionHandleStore.createSessionKernel(store, catalog);
          const exists = (() => {
            try {
              kernel.row(sessionId);
              return true;
            } catch {
              return false;
            }
          })();
          if (!exists) {
            yield* kernel.materialize({
              id: sessionId,
              parentId: null,
              role: "resident",
              tools: [],
              system: { preset: "", blocks: [] },
              policyGeneration: 1,
              actionId: `${sessionId}:materialize`,
              at: Date.now(),
            });
          }
          catalog.indexSession({
            id: sessionId,
            parentId: null,
            role: "resident",
            createdAt: Date.now(),
          });
          store.close();
          catalog.close();
        }),
      );
      provisioned.set(file, pending);
    }
    return pending;
  });
}

/** Canonical JSON of a protocol `Inbox.MessageOrigin` value (messages.ts C1). */
function testOrigin(sessionId: string, messageId: string): string {
  const origin: Inbox.MessageOrigin = {
    kind: "message",
    messageId,
    senderSessionId: sessionId,
    sourceActionId: messageId,
  };
  return JSON.stringify(origin);
}

export const sendPrompt = (sessionId: string, messageId: string, content: string) =>
  Effect.gen(function* () {
    yield* provisionSession(yield* TestClusterEnv, sessionId);
    const makeClient = yield* SessionEntity.client;
    return yield* makeClient(sessionId).Prompt({
      messageId,
      content,
      origin: testOrigin(sessionId, messageId),
    });
  });

export const sendResume = (sessionId: string, messageId: string, content: string) =>
  Effect.gen(function* () {
    yield* provisionSession(yield* TestClusterEnv, sessionId);
    const makeClient = yield* SessionEntity.client;
    return yield* makeClient(sessionId).Resume({
      messageId,
      content,
      origin: testOrigin(sessionId, messageId),
    });
  });

export const sendDeadline = (sessionId: string, requestId: string, deadlineAt: number) =>
  Effect.gen(function* () {
    yield* provisionSession(yield* TestClusterEnv, sessionId);
    const makeClient = yield* SessionEntity.client;
    return yield* makeClient(sessionId).Deadline({ requestId, deadlineAt });
  });

export function sessionFileFor(sessionsDir: string, sessionId: string): string {
  return `${sessionsDir}/${sessionId}.sqlite`;
}

export interface ChainRow {
  readonly id: string;
  readonly kind: string;
  readonly ordinal: number;
  readonly prev_hash: string;
  readonly action_hash: string;
}

function withReadonly<A>(file: string, read: (db: Database) => A): A {
  const db = new Database(file, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

export function readChain(file: string, sessionId: string): ChainRow[] {
  return withReadonly(file, (db) =>
    db
      .query<ChainRow, [string]>(
        "SELECT id, kind, ordinal, prev_hash, action_hash FROM action WHERE session_id = ? ORDER BY ordinal ASC",
      )
      .all(sessionId),
  );
}

interface RawActionRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly session_id: string;
  readonly kind: string;
  readonly intent: string;
  readonly effect: string;
  readonly revert: string | null;
  readonly irreversible: 0 | 1;
  readonly encoding_version: number;
  readonly ts: number;
  readonly ordinal: number;
  readonly prev_hash: string;
  readonly action_hash: string;
}

/** Recompute every action_hash and prev_hash link from raw rows; returns length. */
export function verifyChain(file: string, sessionId: string): number {
  return withReadonly(file, (db) => {
    const rows = db
      .query<RawActionRow, [string]>(
        "SELECT id, parent_id, session_id, kind, intent, effect, revert, irreversible, encoding_version, ts, ordinal, prev_hash, action_hash FROM action WHERE session_id = ? ORDER BY ordinal ASC",
      )
      .all(sessionId);
    let prev: string = L0Write.GENESIS_PREV_HASH;
    rows.forEach((row, index) => {
      if (row.ordinal !== index + 1) {
        throw new Error(`chain gap at index ${index}: ordinal ${row.ordinal}`);
      }
      if (row.prev_hash !== prev) {
        throw new Error(`prev_hash link broken at ordinal ${row.ordinal}`);
      }
      const { action_hash, ...rest } = row;
      const recomputed = L0Write.computeActionHash(rest);
      if (recomputed !== action_hash) {
        throw new Error(`action_hash mismatch at ordinal ${row.ordinal}`);
      }
      prev = action_hash;
    });
    return rows.length;
  });
}

export interface ClusterMessageRow {
  readonly entity_type: string;
  readonly entity_id: string;
  readonly tag: string;
  readonly processed: number;
  readonly deliver_at: number | null;
}

export function clusterMessages(catalogFile: string, entityType: string): ClusterMessageRow[] {
  return withReadonly(catalogFile, (db) =>
    db
      .query<ClusterMessageRow, [string]>(
        "SELECT entity_type, entity_id, tag, processed, deliver_at FROM cluster_messages WHERE entity_type = ? ORDER BY rowid ASC",
      )
      .all(entityType),
  );
}

/** Catalog `session_index.fence` — rotated by every entity activation (F5). */
export function sessionFence(catalogFile: string, sessionId: string): number | undefined {
  return (
    withReadonly(catalogFile, (db) =>
      db
        .query<{ fence: number }, [string]>("SELECT fence FROM session_index WHERE id = ?")
        .get(sessionId),
    )?.fence ?? undefined
  );
}

/**
 * Bounded DB/file observation poll — the one wait pattern W5.1 check2
 * sanctioned (review F8). Timeout is a failure guard, never a synchronizer.
 */
export async function waitUntil(
  label: string,
  check: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** True once the session file's WAL is gone: the activation finalizer closed it. */
export function sessionFileClosed(file: string): boolean {
  const wal = Bun.file(`${file}-wal`);
  return !(wal.size > 0);
}

/** Accumulate a child's stdout until `pattern` matches; bounded, no bare sleeps. */
export async function readUntil(
  stream: ReadableStream<Uint8Array>,
  pattern: RegExp,
  timeoutMs: number,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = "";
  const timer = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`timed out waiting for ${pattern}; got:\n${text}`)),
      timeoutMs,
    );
  });
  try {
    while (!pattern.test(text)) {
      const chunk = await Promise.race([reader.read(), timer]);
      if (chunk.done) throw new Error(`stream ended before ${pattern}; got:\n${text}`);
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text;
  } finally {
    reader.releaseLock();
  }
}
