import { expect, it } from "bun:test";
import { Storage, SessionHandleStore } from "@openomni/ledger";
import {
  session,
  closeSessions,
  type SessionRuntime,
  type SessionHandle,
} from "../src/session-handle";
import { collector } from "../src/observation/bus";
import { seedPolicy } from "./helpers/seed-policy";
import { bounded } from "./helpers/bounded";

async function withSession(
  authorizeConfigure: NonNullable<SessionRuntime["authorizeConfigure"]>,
  test: (handle: SessionHandle) => Promise<void>,
) {
  let sequence = 0;
  const runtime: SessionRuntime = {
    observations: collector(),
    clock: () => 1000,
    entropy: () => `configuration-${++sequence}`,
    processId: "configuration",
    scheduleHeartbeat: () => () => undefined,
    authorizeConfigure,
  };
  Storage.initialize({ dbPath: ":memory:" });
  seedPolicy();
  try {
    await test(
      session(
        {
          id: "configuration-session",
          role: "resident",
          runner: async () => ({ kind: "result", text: "done" }),
        },
        runtime,
      ),
    );
  } finally {
    await closeSessions(runtime);
    Storage.reset();
  }
}

it("does not record a denied configuration", async () => {
  await withSession(
    async () => false,
    async (handle) => {
      const before = SessionHandleStore.tree(handle.id);
      await expect(handle.system.blocks.set([])).rejects.toMatchObject({
        data: { code: "denied" },
      });
      expect(SessionHandleStore.tree(handle.id)).toEqual(before);
    },
  );
});

it("rejects configuration whose authorization outlives its captured generation", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let authorizations = 0;
  await withSession(
    async () => {
      authorizations += 1;
      if (authorizations === 1) {
        entered.resolve();
        await release.promise;
      }
      return true;
    },
    async (handle) => {
      const first = handle.system.blocks
        .set([{ id: "first", source: "test", content: "first" }])
        .catch((error: Error) => error);
      await bounded(entered.promise);
      try {
        const receipt = await handle.system.blocks.set([
          { id: "second", source: "test", content: "second" },
        ]);
        release.resolve();
        expect(await bounded(first)).toMatchObject({ data: { code: "stale" } });
        expect(
          SessionHandleStore.latestGeneration(SessionHandleStore.tree(handle.id)).generation,
        ).toBe(receipt.generation);
      } finally {
        release.resolve();
      }
    },
  );
});
