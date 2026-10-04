/**
 * #1254 S4 — keepAlive/passivation boundary against the REAL Session entity:
 *
 *  - a live detached turn holds the cluster keep-alive latch (observed through
 *    the `onKeepAlive` port) and releases it when the turn ends;
 *  - an activation closing with unconsumed input arms the reserved `resume`
 *    purpose (alarmId `<sessionId>:resume`, at = close + idleMs) into the
 *    durable armed index;
 *  - the closing activation itself persists the resume occurrence through the
 *    cluster's discard door (DeliverAt = close + idleMs): the NEXT runtime
 *    delivers it with no new send, recovers the open turn and consumes the
 *    leftover backlog;
 *  - a close with nothing pending arms nothing.
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Effect } from "effect";
import { openCatalogStore } from "../../src/core/store/catalog";
import { openSessionStore } from "../../src/core/store/session-file";
import * as SessionHandleStore from "../../src/core/store/fence";
import {
  blockingRunner,
  clusterTempDir,
  readChain,
  resolvedRunner,
  runCluster,
  sendPrompt,
  sessionFileFor,
  waitUntil,
} from "../helpers/cluster-runtime";

const { dir, sessionsDir, catalogFile } = clusterTempDir("w52-passivation-");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sessionId = "passivation-resume";

/** Short-lived kernel over the on-disk session: post-close assertions. */
async function withKernel<A>(read: (kernel: SessionHandleStore.SessionKernel) => A): Promise<A> {
  const catalog = openCatalogStore(catalogFile, { now: () => Date.now() });
  const store = openSessionStore(sessionFileFor(sessionsDir, sessionId), { now: () => Date.now() });
  try {
    return read(SessionHandleStore.createSessionKernel(store, catalog));
  } finally {
    store.close();
    catalog.close();
  }
}

test("passivation arms resume for unconsumed input; the resume wake continues the session", async () => {
  const keepAliveToggles: boolean[] = [];
  const turnsEntered: string[] = [];
  const closedAround = Date.now();

  // ── Activation 1: p1's turn detaches and blocks; p2 arrives while the turn
  // is live, so the close leaves one pending row behind.
  await runCluster(
    {
      sessionsDir,
      catalogFile,
      detachTurns: true,
      // Short idle budget: the resume occurrence (DeliverAt = close + idleMs)
      // comes due quickly under the second runtime.
      idleMs: 1_000,
      runner: blockingRunner((turnId) => turnsEntered.push(turnId)),
      onKeepAlive: (enabled) => keepAliveToggles.push(enabled),
    },
    Effect.gen(function* () {
      const first = yield* sendPrompt(sessionId, "p1", "start the long turn");
      expect(first.existed).toBe(false);
      yield* Effect.promise(() => waitUntil("turn entered", () => turnsEntered.length === 1));
      const second = yield* sendPrompt(sessionId, "p2", "arrives during the live turn");
      expect(second.existed).toBe(false);
    }),
  );

  // The live turn held the latch; the close released it.
  expect(keepAliveToggles).toEqual([true, false]);

  // The close committed the resume arm and indexed it durably.
  const armed = await withKernel((kernel) => kernel.armedAlarms());
  const resume = armed.find((row) => row.alarmId === `${sessionId}:resume`);
  if (resume === undefined) throw new Error(`no resume arm in ${JSON.stringify(armed)}`);
  expect(resume.purpose).toBe("resume");
  // at = close instant + idleMs: strictly after the first send's instant.
  expect(resume.fireAt).toBeGreaterThan(closedAround);
  const armRows = readChain(sessionFileFor(sessionsDir, sessionId), sessionId).filter((row) =>
    row.id.startsWith(`${sessionId}:resume:arm:`),
  );
  expect(armRows).toHaveLength(1);

  // ── Activation 2: the closing activation already PERSISTED the resume
  // occurrence (discard door, DeliverAt = close + idleMs); the next runtime
  // delivers it with no new send, recovers p1's open turn and starts p2's.
  await runCluster(
    { sessionsDir, catalogFile, runner: resolvedRunner("resumed") },
    Effect.promise(() =>
      waitUntil("resume occurrence delivered", () =>
        readChain(sessionFileFor(sessionsDir, sessionId), sessionId).some(
          (row) => row.id === `${resume.occurrenceId}:delivered`,
        ),
      ),
    ),
  );

  const chain = readChain(sessionFileFor(sessionsDir, sessionId), sessionId);
  expect(chain.find((row) => row.id === `${resume.occurrenceId}:delivered`)?.kind).toBe("alarm");
  // p1's interrupted turn sealed and p2's follow-up turn ran to its result.
  expect(chain.some((row) => row.id === "p2:turn:result")).toBe(true);

  // The delivered wake retired the resume row from the durable index, and the
  // second close (empty backlog) armed nothing new.
  const after = await withKernel((kernel) => kernel.armedAlarms());
  expect(after.find((row) => row.alarmId === `${sessionId}:resume`)).toBeUndefined();
  const armRowsAfter = readChain(sessionFileFor(sessionsDir, sessionId), sessionId).filter((row) =>
    row.id.startsWith(`${sessionId}:resume:arm:`),
  );
  expect(armRowsAfter).toHaveLength(1);
});
