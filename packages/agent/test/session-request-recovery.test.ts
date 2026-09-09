import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage, SessionHandleStore } from "@openomni/ledger";
import type { LedgerAction, SessionTransition } from "@openomni/protocol";
import { z } from "zod";
import { createTurnDispatcher, defineTool, eraseTool } from "../src/tool-dispatcher";
import { createSessionRequests } from "../src/session-requests";
import { compiledPolicy } from "./helpers/compiled-policy";
import { requestLedger } from "./helpers/request-ledger";
import { bounded } from "./helpers/bounded";

let directory: string;
let dbPath: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "request-recovery-"));
  dbPath = join(directory, "ledger.sqlite");
  Storage.initialize({ dbPath });
});
afterEach(() => {
  Storage.reset();
  rmSync(directory, { recursive: true, force: true });
});
const proof = { kind: "owner", principalId: "owner", evidenceId: "authenticated" } as const;
function definitions(bodies: string[]) {
  return ["read", "write", "last"].map((name) =>
    eraseTool(
      defineTool(
        {
          name,
          category: "mutation",
          description: name,
          input: z.object({ text: z.string() }).strict(),
          output: z.object({ value: z.string() }).strict(),
          visibility: { model: ["resident"], cell: ["resident"] },
          ...(name === "last" ? { sequential: true as const } : {}),
          execute: async (input) => {
            bodies.push(`${name}:${input.text}`);
            return { value: input.text };
          },
          render: (_input, result) => result.value,
        },
        () => ({ required: name === "write", domainRevisions: {} }),
      ),
    ),
  );
}
const calls = ["read", "write", "last"].map((tool) => ({
  id: `call:${tool}`,
  tool,
  input: { text: `original:${tool}` },
}));
function dispatcher(
  recording: ReturnType<typeof requestLedger>,
  bodies: string[],
  ready?: () => void,
) {
  const result = createTurnDispatcher(
    definitions(bodies),
    {
      ...recording.identity,
      ledger: {
        ...recording.ledger,
        actions: () => {
          if ((result.executor.approvals?.pending().length ?? 0) > 0) ready?.();
          return recording.ledger.actions?.() ?? [];
        },
      },
      actionId: recording.identity.parentActionId,
      policy: compiledPolicy(),
    },
    {
      clock: recording.clock,
      entropy: recording.entropy,
      observations: { publish: () => undefined },
      authorizeApproval: async () => proof,
    },
  );
  return result;
}
function currentRequest(): SessionTransition.Request {
  const request = SessionHandleStore.requestRows()[0];
  if (request === undefined) throw new Error("missing durable request");
  return request;
}
function ownerAnswer(request: SessionTransition.Request): SessionTransition.Answer {
  return {
    inputId: "answer",
    requestId: request.requestId,
    sessionId: request.sessionId,
    receivedAt: 200,
    principal: proof,
    bindingDigest: request.bindingDigest,
    inputHash: request.inputHash,
    effectHash: request.effectHash,
    generation: request.generation,
    toolsHash: request.toolsHash,
    domainRevisions: request.domainRevisions,
    decision: "approve",
    allowedAction: "report_result",
    content: "approve",
  };
}
it("reopens SQLite and resumes the exact original wave without a model reconstruction", async () => {
  const bodies: string[] = [];
  const initial = requestLedger();
  const transition = initial.ledger.transition;
  if (transition === undefined) throw new Error("missing transition port");
  const crashed = dispatcher(
    {
      ...initial,
      ledger: {
        ...initial.ledger,
        async transition(payload, inputId, at) {
          const result = await transition(payload, inputId, at);
          if (payload.kind === "request.open")
            throw new Error("process lost after durable suspension");
          return result;
        },
      },
    },
    bodies,
  );
  await expect(
    crashed.executeWave(calls, { sessionId: initial.identity.sessionId, turnId: "turn" }),
  ).rejects.toThrow("process lost");
  const originalId = currentRequest().requestId;
  expect(bodies).toEqual([]);
  Storage.reset();
  Storage.initialize({ dbPath });
  const ready = Promise.withResolvers<void>();
  const recovered = dispatcher(requestLedger(), bodies, ready.resolve);
  const recovering = recovered.executor.recover?.();
  if (recovering === undefined) throw new Error("missing recovery");
  await bounded(ready.promise);
  const pending = recovered.executor.approvals?.pending()[0];
  if (pending === undefined) throw new Error("missing recovered approval");
  expect(pending.id).toBe(originalId);
  expect(pending.durable.parsedInput).toEqual({ text: "original:write" });
  await recovered.executor.approvals?.answer({
    request: pending,
    credential: "proof",
    decision: "approve",
  });
  await bounded(recovering);
  expect(bodies).toEqual(["read:original:read", "write:original:write", "last:original:last"]);
  await recovered.executor.recover?.();
  expect(bodies).toHaveLength(3);
  expect(
    SessionHandleStore.tree(initial.identity.sessionId).filter(
      (action) => action.id === `${originalId}:application`,
    ),
  ).toHaveLength(1);
});
it("a committed application claim prevents replay after result persistence fails", async () => {
  const bodies: string[] = [];
  const ready = Promise.withResolvers<void>();
  const initial = requestLedger();
  const commit = initial.ledger.commit;
  const crashed = dispatcher(
    {
      ...initial,
      ledger: {
        ...initial.ledger,
        async commit(action: LedgerAction.Append) {
          const effect = action.effect.value;
          if (
            action.kind === "tool" &&
            effect !== null &&
            typeof effect === "object" &&
            !Array.isArray(effect) &&
            effect.phase === "result"
          )
            throw new Error("process lost before result");
          return commit(action);
        },
      },
    },
    bodies,
    ready.resolve,
  );
  const running = crashed.executeWave(calls, {
    sessionId: initial.identity.sessionId,
    turnId: "turn",
  });
  const settled = Promise.allSettled([running]);
  await bounded(ready.promise);
  const pending = crashed.executor.approvals?.pending()[0];
  if (pending === undefined) throw new Error("missing approval");
  await crashed.executor.approvals?.answer({
    request: pending,
    credential: "proof",
    decision: "approve",
  });
  expect(await bounded(settled)).toMatchObject([
    { status: "rejected", reason: { message: "process lost before result" } },
  ]);
  expect(bodies).toHaveLength(3);
  Storage.reset();
  Storage.initialize({ dbPath });
  const recovered = dispatcher(requestLedger(), bodies);
  await bounded(recovered.executor.recover?.() ?? Promise.reject(new Error("missing recovery")));
  expect(bodies).toHaveLength(3);
  const effects = SessionHandleStore.tree(initial.identity.sessionId).map(
    (action) => action.effect.value,
  );
  expect(
    effects.filter(
      (effect) =>
        effect !== null &&
        typeof effect === "object" &&
        !Array.isArray(effect) &&
        effect.terminal === "outcome_unknown",
    ),
  ).toHaveLength(3);
});
it("a gateway answer cannot borrow another live owner's lease", async () => {
  const initial = requestLedger();
  const transition = initial.ledger.transition;
  if (transition === undefined) throw new Error("missing transition");
  const crashed = dispatcher(
    {
      ...initial,
      ledger: {
        ...initial.ledger,
        async transition(payload, inputId, at) {
          const result = await transition(payload, inputId, at);
          if (payload.kind === "request.open") throw new Error("lost");
          return result;
        },
      },
    },
    [],
  );
  await expect(
    crashed.executeWave(calls, { sessionId: initial.identity.sessionId, turnId: "turn" }),
  ).rejects.toThrow("lost");
  const request = currentRequest();
  const before = SessionHandleStore.row(request.sessionId);
  const gateway = createSessionRequests({
    clock: () => 200,
    observations: { publish: () => undefined },
  });
  await expect(gateway.answer(ownerAnswer(request))).rejects.toMatchObject({
    name: "SessionLeaseError",
    result: { reason: "held" },
  });
  expect(SessionHandleStore.row(request.sessionId)).toEqual(before);
  expect(currentRequest().state).toBe("open");
  const dormant = createSessionRequests({
    clock: () => 40_000,
    observations: { publish: () => undefined },
  });
  expect(await dormant.answer(ownerAnswer(request))).toBe("resolved");
  expect(currentRequest().state).toBe("resolved");
  expect(SessionHandleStore.row(request.sessionId).leaseOwner).toBeNull();
});
