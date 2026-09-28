import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openCatalogStore,
  openSessionStore,
  SessionHandleStore,
} from "@openomni/ledger";
import { Effect } from "effect";
import { SessionEntity } from "../../src/cluster/session-entity";
import {
  readChain,
  runCluster,
  sessionFileFor,
} from "../helpers/cluster-runtime";
import { runAgent } from "../helpers/executor";

const dir = mkdtempSync(join(tmpdir(), "w52-session-entity-coverage-"));
const sessionsDir = join(dir, "sessions");
mkdirSync(sessionsDir, { recursive: true });
const catalogFile = join(dir, "catalog.sqlite");
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
  const catalog = openCatalogStore(catalogFile);
  const store = openSessionStore(sessionFileFor(sessionsDir, sessionId));
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
  const catalog = openCatalogStore(catalogFile);
  try {
    expect(catalog.sessionIndex(sessionId)?.fence).toBe(3);
  } finally {
    catalog.close();
  }
});
