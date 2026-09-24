import { testExecutor, runAgentSync } from "../../helpers/executor";
import { executorLayer, catalogLayer } from "../../helpers/service-layers";
import { expect, test } from "bun:test";
import { compilePolicySnapshot, KERNEL_POLICY_REGISTRY, SEEDED_POLICY_ROWS } from "@openomni/policy";
import { SessionHandleStore } from "@openomni/ledger";
import { PlainObjectSchema } from "@openomni/protocol";
import { Cause, Effect, Fiber } from "effect";
import { createNamedPolicyRegistry } from "@openomni/policy";
import { requestLedger, crashAfterRequestOpen, failure } from "../../helpers/effect-g1";
import { z } from "zod";
import { createExecutor, createDispatcher, defineTool } from "../../../src/index";
import { isolated } from "../../helpers/isolated";

test("approval recovery executes recorded admitted bytes without transforming again", () => isolated(Effect.scoped(Effect.gen(function* () {
  const recorded = yield* requestLedger();
  let transformations = 0;
  const executed: string[] = [];
  const registry = createNamedPolicyRegistry({ ...KERNEL_POLICY_REGISTRY, transformers: [
    ...KERNEL_POLICY_REGISTRY.transformers,
    { name: "demo/normalize", apply: () => { transformations += 1; return { text: `admitted-${transformations}` }; } },
  ] });
  const policy = compilePolicySnapshot({ registry, generation: 1, rows: [
    ...SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })),
    { name: "normalize", kind: "tool", phase: "pre", generation: 1, priority: 1,
      match: { encodingVersion: 1, value: { op: "write" } },
      verdict: { encodingVersion: 1, value: { type: "transform", ref: "demo/normalize" } } },
  ] });
  const definition = defineTool({ name: "write", description: "Write", category: "mutation",
    input: z.object({ text: z.string() }), output: z.string(), visibility: { model: ["resident"], cell: ["resident"] },
    execute: async ({ text }) => { executed.push(text); return text; }, render: (_input, output) => output,
  }, () => ({ required: true, domainRevisions: {} }));
  const providers = executorLayer({ ...recorded, policy, observations: { publish: () => undefined } });
  const crashed = yield* createExecutor({ ...crashAfterRequestOpen(recorded, "crash"), identity: recorded.identity }).pipe(Effect.provide(providers));
  const initial = yield* createDispatcher({ executor: crashed }).pipe(Effect.provide(catalogLayer([definition])));
  const context = { sessionId: recorded.identity.sessionId, turnId: recorded.identity.turnId };
  expect(yield* failure(initial.execute({ id: "write-call", tool: "write", input: { text: "original" } }, context)))
    .toMatchObject({ _tag: "ForeignFailure", operation: "crash" });
  expect(executed).toEqual([]);
  expect(transformations).toBe(1);
  const ready = Promise.withResolvers<void>();
  const recovered = yield* createExecutor({ ...recorded, ledger: { ...recorded.ledger, actions: () => {
    if ((recovered.approvals?.pending().length ?? 0) > 0) ready.resolve();
    return recorded.ledger.actions?.() ?? [];
  } }, authorizeApproval: () => Effect.succeed({ kind: "owner", principalId: "owner", evidenceId: "proof" }) }).pipe(Effect.provide(providers));
  const dispatcher = yield* createDispatcher({ executor: recovered }).pipe(Effect.provide(catalogLayer([definition])));
  const recovering = yield* Effect.forkScoped(recovered.recover().pipe(
    Effect.andThen(() => dispatcher.recover(recorded.ledger.actions?.() ?? [], context)),
    Effect.tapErrorCause((cause) => Effect.sync(() => ready.reject(Cause.squash(cause)))),
  ));
  yield* Effect.promise(() => ready.promise).pipe(Effect.timeout("5 seconds"));
  const approvals = recovered.approvals;
  if (approvals === undefined) throw new Error("approvals missing");
  const request = approvals.pending()[0];
  if (request === undefined) throw new Error("approval missing");
  expect(request.durable.parsedInput).toEqual({ text: "original" });
  yield* approvals.answer({ request, decision: "approve", credential: "proof" });
  yield* Fiber.join(recovering);
  expect(transformations).toBe(1);
  expect(executed).toEqual(["admitted-1"]);
}))), 15000);

for (const door of ["model", "cell", "wave"] as const) {
  for (const replacement of ["admitted", null]) {
    test(`${door} executes and renders only schema-valid admitted input (${replacement})`, () => isolated(Effect.gen(function* () {
      const id = `pre-${door}-${replacement}`;
      const materialized = yield* SessionHandleStore.materialize({
        id, parentId: null, role: "resident", tools: [], system: { preset: "", blocks: [] },
        policyGeneration: 1, actionId: `${id}:configure`, at: 100,
      });
      const lease = yield* SessionHandleStore.acquireLease({
        sessionId: id, owner: id, expectedFence: materialized.row.leaseFence, now: 100, expiresAt: 10000,
      });
      let sequence = 0;
      const executed: string[] = [];
      const rendered: string[] = [];
      const definition = defineTool({
        name: "echo", description: "Echo input", category: "query",
        input: z.object({ text: z.string() }), output: z.string(),
        visibility: { model: ["resident"], cell: ["resident"] },
        execute: async ({ text }) => { executed.push(text); return text; },
        render: ({ text }, output) => { rendered.push(text); return output; },
      });
      const executor = testExecutor({
        identity: { sessionId: id, role: "resident", parentActionId: `${id}:configure` },
        clock: () => 100, entropy: () => `${id}:${++sequence}`, observations: { publish: () => undefined },
        policy: compilePolicySnapshot({
          registry: KERNEL_POLICY_REGISTRY, generation: 1, rows: [...SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })), {
            name: "redact-input", kind: "tool", phase: "pre", generation: 1, priority: 1,
            match: { encodingVersion: 1, value: { op: "echo" } },
            verdict: { encodingVersion: 1, value: { type: "transform", ref: "kernel/redact", config: { paths: ["text"], replacement } } },
          }],
        }),
        ledger: {
          actions: () => SessionHandleStore.tree(id),
          commit: (action) => SessionHandleStore.commit({
            sessionId: id, owner: id, fence: lease.fence, now: 100,
            expectedRevision: SessionHandleStore.row(id).revision,
            actions: [action], consumeInboxIds: [], state: "running", releaseLease: false,
          }).pipe(Effect.map((result) => {
            const receipt = result.receipts[0];
            if (receipt === undefined) throw new Error("missing receipt");
            return receipt;
          })),
        },
      });
      const dispatcher = runAgentSync(createDispatcher({ executor }).pipe(Effect.provide(catalogLayer([definition]))));
      const call = { id: "call", tool: "echo", input: { text: "original" } };
      const context = { sessionId: id, turnId: "turn" };
      const result = yield* (door === "wave" ? dispatcher.executeWave([call], context).pipe(Effect.map((results) => results[0]))
        : door === "cell" ? dispatcher.executeCell(call, context) : dispatcher.execute(call, context));
      expect(executed).toEqual(replacement === null ? [] : [replacement]);
      expect(rendered).toEqual(replacement === null || door === "cell" ? [] : [replacement]);
      expect(result).toMatchObject(replacement === null ? { isError: true, errorKind: "invalid_input" } : { output: replacement });
      const actions = SessionHandleStore.tree(id);
      const intent = actions.find((action) => action.kind === "tool" && PlainObjectSchema.parse(action.intent.value).phase === "intent");
      expect(intent?.intent.value).toMatchObject({ value: { text: replacement }, originalArgs: { text: "original" } });
      const decision = actions.find((action) => action.kind === "policy.decision");
      expect(decision?.intent.value).toMatchObject({ transforms: [{ ruleId: "redact-input", ref: "kernel/redact" }], ref: "kernel/redact" });
    })));
  }
}
