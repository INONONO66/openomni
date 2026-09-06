import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage, SessionHandleStore } from "@openomni/ledger";
import { SEEDED_POLICY_ROWS } from "@openomni/policy";
import { SessionTurn } from "@openomni/protocol";
import {
  session,
  closeSessions,
  sweepSessions,
  type SessionRuntime,
  type SessionRunnerInput,
} from "../src/session-handle";
import { createSessionChatRunner } from "../src/session-chat-runner";
import { createTurnDispatcher } from "../src/tool-dispatcher";
import { createAssistantMessage } from "../src/core/message-factory";

for (const mode of ["interrupted", "crash-open"] as const) {
  test(`reopened SQLite ${mode} chooses the correct IDs and generation with no stale-fence writes`, () =>
    Storage.withIsolation(async () => {
      const directory = mkdtempSync(join(tmpdir(), "937-resume-"));
      const dbPath = join(directory, "chat.sqlite");
      let runtime: SessionRuntime = {
        observations: { publish: () => undefined },
        clock: () => 1000,
      };
      const entered = Promise.withResolvers<void>();
      const inputs: SessionRunnerInput[] = [];
      let opening = mode === "interrupted";
      const runner = createSessionChatRunner({
        prepare(input) {
          inputs.push(input);
          return {
            traceContext: { traceId: "trace", sessionId: input.sessionId, runId: input.resultId },
            config: {
              events: { publish: () => undefined },
              executor: createTurnDispatcher([], input, runtime).executor,
              model: { provider: "test", id: "test" },
              llm: {
                resolveModel: async () => ({ id: "test", name: "test", providerID: "test" }),
                run: async (_request, sink) => {
                  if (opening) {
                    opening = false;
                    const abort = new Promise<never>((_resolve, reject) =>
                      input.signal.addEventListener(
                        "abort",
                        () => reject(new DOMException("interrupted", "AbortError")),
                        { once: true },
                      ),
                    );
                    entered.resolve();
                    return abort;
                  }
                  sink.onMessage(createAssistantMessage("recovered", "", input.sessionId));
                  return { type: "stop" };
                },
              },
            },
          };
        },
      });
      try {
        Storage.initialize({ dbPath });
        for (const row of SEEDED_POLICY_ROWS)
          Storage.get().policies?.append({ ...row, generation: 1 });
        let originalTurn = "crashed-turn";
        let originalResult = "crashed-result";
        if (mode === "interrupted") {
          const handle = session({ id: "resume", role: "resident", runner }, runtime);
          const first = handle.prompt("original");
          await entered.promise;
          await handle.interrupt();
          expect((await first)?.kind).toBe("interrupted");
          const captured = inputs[0];
          if (captured === undefined) throw new Error("missing first invocation");
          originalTurn = captured.turnId;
          originalResult = captured.resultId;
          await handle.system.blocks.set([
            { id: "new", source: "fixture", content: "generation two" },
          ]);
          SessionHandleStore.commitInbox({
            id: "resume-request",
            sessionId: "resume",
            kind: "resume",
            content: "",
            createdAt: 1001,
            origin: { encodingVersion: 1, value: { source: "fixture" } },
            parentActionId: originalResult,
          });
        } else {
          SessionHandleStore.materialize({
            id: "resume",
            role: "resident",
            parentId: null,
            tools: [],
            system: { preset: "", blocks: [] },
            policyGeneration: 1,
            actionId: "initial",
            at: 1,
          });
          const generation = SessionHandleStore.latestGeneration(SessionHandleStore.tree("resume"));
          const lease = SessionHandleStore.acquireLease({
            sessionId: "resume",
            owner: "crashed",
            expectedFence: 0,
            now: 1,
            expiresAt: 10,
          });
          if (!lease.ok) throw new Error("missing fixture lease");
          const newer = SessionHandleStore.generationSnapshot({
            generation: 2,
            revertTo: 1,
            tools: [],
            system: {
              preset: "",
              blocks: [{ id: "new", source: "fixture", content: "generation two" }],
            },
            policyGeneration: 1,
          });
          const commit = SessionHandleStore.commit({
            sessionId: "resume",
            owner: "crashed",
            fence: lease.fence,
            now: 2,
            expectedRevision: SessionHandleStore.row("resume").revision,
            consumeInboxIds: [],
            releaseLease: false,
            state: "running",
            generation: { toolsGeneration: 2, systemHash: newer.systemHash, policyGeneration: 1 },
            actions: [
              {
                id: originalTurn,
                sessionId: "resume",
                parentId: "initial",
                kind: "turn",
                intent: {
                  encodingVersion: 1,
                  value: SessionTurn.Intent.parse({
                    phase: "intent",
                    resultId: originalResult,
                    inboxIds: [],
                    resumeCount: 0,
                    boundaryActionId: "initial",
                    toolsGeneration: 1,
                    toolsHash: generation.toolsHash,
                    systemHash: generation.systemHash,
                    policyGeneration: 1,
                  }),
                },
                effect: { encodingVersion: 1, value: { phase: "pending" } },
                irreversible: true,
                ts: 2,
              },
              SessionHandleStore.configureAction({
                id: "newer",
                sessionId: "resume",
                parentId: originalTurn,
                operation: "system.blocks.set",
                snapshot: newer,
                at: 3,
              }),
            ],
          });
          expect(commit.ok).toBe(true);
        }
        const immutable = SessionHandleStore.tree("resume");
        await closeSessions(runtime);
        Storage.reset();
        Storage.initialize({ dbPath });
        runtime = { observations: { publish: () => undefined }, clock: () => 2000 };
        await sweepSessions(() => runner, runtime);
        const recovered = inputs.at(-1);
        if (recovered === undefined) throw new Error("missing recovered invocation");
        expect(recovered.toolsGeneration).toBe(mode === "crash-open" ? 1 : 2);
        if (mode === "crash-open") {
          expect(recovered.turnId).toBe(originalTurn);
          expect(recovered.resultId).toBe(originalResult);
        } else {
          expect(recovered.turnId).not.toBe(originalTurn);
          expect(recovered.resultId).not.toBe(originalResult);
        }
        const tree = SessionHandleStore.tree("resume");
        expect(tree.slice(0, immutable.length)).toEqual(immutable);
        expect(
          tree.filter(
            (action) => SessionHandleStore.turnTerminal(action)?.turnId === recovered.turnId,
          ),
        ).toHaveLength(1);
        const stale = SessionHandleStore.commit({
          sessionId: "resume",
          owner: "crashed",
          fence: 1,
          now: 2000,
          expectedRevision: SessionHandleStore.row("resume").revision,
          actions: [],
          consumeInboxIds: [],
          state: "running",
          releaseLease: false,
        });
        expect(stale).toMatchObject({ ok: false, reason: "stale" });
        expect(SessionHandleStore.tree("resume")).toEqual(tree);
      } finally {
        await closeSessions(runtime);
        Storage.reset();
        rmSync(directory, { recursive: true, force: true });
      }
    }));
}
