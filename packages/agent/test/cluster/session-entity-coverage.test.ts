import { afterAll, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  CommitRefused,
  openCatalogStore,
  openSessionStore,
  SessionHandleStore,
  StorageUnavailable,
} from "@openomni/ledger";
import { Effect } from "effect";
import { SessionEntity } from "../../src/cluster/session-entity";
import {
  clusterTempDir,
  readChain,
  runCluster,
  sendPrompt,
  sessionFileFor,
} from "../helpers/cluster-runtime";
import { runAgent } from "../helpers/executor";

const { dir, sessionsDir, catalogFile } = clusterTempDir("w52-session-entity-coverage-");
const options = { sessionsDir, catalogFile };

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function origin(sessionId: string, messageId: string): string {
  return JSON.stringify({
    kind: "message",
    messageId,
    senderSessionId: sessionId,
    sourceActionId: messageId,
  });
}

async function materializeSession(
  sessionId: string,
  prepare?: (input: {
    readonly catalog: ReturnType<typeof openCatalogStore>;
    readonly kernel: SessionHandleStore.SessionKernel;
  }) => Promise<void>,
): Promise<void> {
  const catalog = openCatalogStore(catalogFile, { now: () => 1 });
  const store = openSessionStore(sessionFileFor(sessionsDir, sessionId), { now: () => 1 });
  const kernel = SessionHandleStore.createSessionKernel(store, catalog);
  try {
    await runAgent(kernel.materialize({
      id: sessionId,
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: 1,
      actionId: `${sessionId}:materialize`,
      at: 1,
    }));
    await prepare?.({ catalog, kernel });
  } finally {
    store.close();
    catalog.close();
  }
}

test("an unindexed session file self-heals before mailbox admission", async () => {
  const sessionId = "self-heal";
  await materializeSession(sessionId);

  const result = await runCluster(
    options,
    Effect.gen(function* () {
      const makeClient = yield* SessionEntity.client;
      const client = makeClient(sessionId);
      const prompt = yield* client.Prompt({
        messageId: "self-heal-prompt",
        content: "recover the catalog index",
        origin: origin(sessionId, "self-heal-prompt"),
      });
      yield* client.Interrupt({
        messageId: "self-heal-interrupt",
        content: "consume while idle",
        origin: origin(sessionId, "self-heal-interrupt"),
      });
      const cancellation = yield* client.RequestCancel({
        requestId: "missing-request",
        inputId: "self-heal-cancel",
        principal: JSON.stringify({
          kind: "owner",
          principalId: "owner",
          evidenceId: "self-heal-cancel",
        }),
      });
      return { prompt, cancellation };
    }),
  );

  expect(result.prompt.deduped).toBe(false);
  expect(result.cancellation.resolution).toBe("rejected");
  expect(
    readChain(sessionFileFor(sessionsDir, sessionId), sessionId).some(
      (row) => row.id === "self-heal-interrupt:delivery",
    ),
  ).toBe(true);
});

test("a stale activation yields until a later fence can adopt the session", async () => {
  const sessionId = "stale-fence";
  await materializeSession(sessionId, async ({ catalog, kernel }) => {
    catalog.indexSession({
      id: sessionId,
      parentId: null,
      role: "resident",
      createdAt: 1,
    });
    await runAgent(
      kernel.adoptFence({
        sessionId,
        owner: "later-activation",
        fence: 2,
      }),
    );
  });

  const reply = await runCluster(
    options,
    Effect.gen(function* () {
      const makeClient = yield* SessionEntity.client;
      return yield* makeClient(sessionId).Prompt({
        messageId: "stale-prompt",
        content: "must not enter a stale activation",
        origin: origin(sessionId, "stale-prompt"),
      });
    }),
  );

  expect(reply.deduped).toBe(false);
  const catalog = openCatalogStore(catalogFile, { now: () => 1 });
  try {
    expect(catalog.sessionIndex(sessionId)?.fence).toBe(3);
  } finally {
    catalog.close();
  }
});

test("a failed detached turn re-drains an acknowledged prompt", async () => {
  const sessionId = "failed-detached-turn";
  const entered = Promise.withResolvers<void>();
  const fail = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  let calls = 0;
  await runCluster(
    {
      ...options,
      detachTurns: true,
      runner: () =>
        Effect.gen(function* () {
          calls += 1;
          if (calls === 1) {
            entered.resolve();
            yield* Effect.promise(() => fail.promise);
            return yield* Effect.fail(new StorageUnavailable({ capability: "actions" }));
          }
          if (calls === 3) delivered.resolve();
          return { kind: "result" as const, text: "delivered" };
        }),
    },
    Effect.gen(function* () {
      yield* sendPrompt(sessionId, "failed-first", "first");
      yield* Effect.promise(() => entered.promise);
      yield* sendPrompt(sessionId, "failed-backlog", "second");
      fail.resolve();
      yield* Effect.promise(() => delivered.promise).pipe(Effect.timeout("10 seconds"));
    }),
  );
  const chain = readChain(sessionFileFor(sessionsDir, sessionId), sessionId);
  expect(chain.some((row) => row.id === "failed-backlog:delivery")).toBe(true);
  expect(calls).toBe(3);
}, 60_000);

test("a received prompt retries exactly one revision refusal", async () => {
  const sessionId = "received-revision-race";
  const create = SessionHandleStore.createSessionKernel;
  let commits = 0;
  const spy = spyOn(SessionHandleStore, "createSessionKernel").mockImplementation((store, catalog) => {
    const kernel = create(store, catalog);
    return new Proxy(kernel, {
      get(target, property, receiver) {
        if (property !== "commit") return Reflect.get(target, property, receiver);
        const commit: typeof kernel.commit = (input) => {
          if (input.actions[0]?.id !== "received-race") return target.commit(input);
          commits += 1;
          if (commits === 1) {
            const row = target.row(input.sessionId);
            return Effect.fail(new CommitRefused({
              sessionId: input.sessionId, reason: "revision",
              expectedRevision: input.expectedRevision, currentRevision: row.revision + 1,
              fence: input.fence, currentFence: row.leaseFence,
            }));
          }
          return target.commit(input);
        };
        return commit;
      },
    });
  });
  try {
    const receipt = await runCluster(options, sendPrompt(sessionId, "received-race", "retry"));
    expect(receipt.deduped).toBe(false);
    expect(commits).toBe(2);
    expect(readChain(sessionFileFor(sessionsDir, sessionId), sessionId).filter((row) => row.id === "received-race")).toHaveLength(1);
  } finally {
    spy.mockRestore();
  }
});
