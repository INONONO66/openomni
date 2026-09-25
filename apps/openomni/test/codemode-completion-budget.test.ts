import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { createTurnDispatcher } from "@openomni/agent";
import { createCodemode, type CodeError } from "@openomni/codemode";
import { attachMachineDaemon, createMachineHost, ForeignFailure as MachineFailure } from "@openomni/machines";
import { LedgerAction, type Machine } from "@openomni/protocol";
import { catalogLayer, executorLayer, runnerTestLayer } from "../../../packages/agent/test/helpers/service-layers";
import { fixtureHashes } from "../../../packages/agent/test/helpers/compiled-policy";
import { composeCodemode } from "../src/composition/codemode";
import { catalogDefinitions } from "../src/tools/core/catalog";
import { cellPorts } from "./helpers/cell-ports";
import { cellDaemonOptions } from "./helpers/cell-daemon";
import { acquireEffect, acquireSyncEffect, runEffect } from "./helpers/scoped-effect";
import { seededPolicy } from "./helpers/executor";
import { residentSuite } from "./helpers/resident-suite";
import { socketPath } from "./helpers/socket-path";
import { testToolPorts } from "./helpers/tool-ports";

const suite = residentSuite();

test("two cells in one turn each own a full completion budget", async () => {
  const path = socketPath();
  let cells: Effect.Effect.Success<ReturnType<typeof composeCodemode>>;
  const cellCalls = new Map<string, number>();
  const host = await acquireEffect(createMachineHost({
    socketPath: path,
    enrollment: (machineId: string) => ({ machineId, name: "budget", allowedCapabilities: ["kernel.py"], enrolledAt: 0 }),
    events: { publish: () => undefined }, now: () => 1,
    callTool: (call: Machine.ToolCall) => Effect.suspend(() => {
      cellCalls.set(call.cellId, (cellCalls.get(call.cellId) ?? 0) + 1);
      return cells.callTool(call).pipe(
        Effect.mapError((error: CodeError) => new MachineFailure({ operation: "code.tool", cause: String(error) })),
      );
    }),
  }));
  suite.defer(() => runEffect(host.close()));
  const daemon = await acquireEffect(attachMachineDaemon({
    ...cellDaemonOptions(path, "budget"), runner: acquireSyncEffect(createCodemode()).runner,
  }));
  suite.defer(() => runEffect(daemon.close()));
  expect(daemon.attachment.status).toBe("attached");
  cells = acquireSyncEffect(composeCodemode(host));
  suite.defer(() => runEffect(cells.close()));
  let completions = 0;
  const definitions = catalogDefinitions({ ...testToolPorts, cells: cellPorts(cells), llm: async () => {
    completions += 1;
    return "answer";
  } });
  const actions: LedgerAction.Node[] = [];
  let sequence = 0;
  const runnerServices = acquireSyncEffect(Layer.build(runnerTestLayer));
  const dispatcher = acquireSyncEffect(createTurnDispatcher({
    sessionId: "budget-session", role: "resident", actionId: "one-turn",
    ledger: { commit: (append: LedgerAction.Append) => {
      const ordinal = actions.length + 1;
      const action = LedgerAction.Node.parse({ ...append, ordinal, ...fixtureHashes(ordinal) });
      actions.push(action);
      return Effect.succeed({ action, revision: ordinal });
    } },
  }, {}).pipe(
    Effect.provide(catalogLayer(definitions)),
    Effect.provide(executorLayer({ policy: seededPolicy, observations: { publish: () => undefined }, clock: () => 1, entropy: () => `budget-${++sequence}` })),
    Effect.provide(runnerServices),
  ));
  const code = [
    "answers = [completion(str(i)) for i in range(32)]",
    "refused = False",
    "try:",
    "    completion('over-budget')",
    "except Exception:",
    "    refused = True",
    "(len(answers), refused)",
  ].join("\n");
  for (const index of [1, 2]) {
    const result = await runEffect(dispatcher.execute({
      id: `cell-${index}`, tool: "eval", input: { operation: { op: "run", code, timeout: 15 } },
    }, { sessionId: "budget-session", turnId: "one-turn" }));
    expect(result.isError, result.output).toBeUndefined();
    expect(result.output).toBe("(32, True)");
    expect(completions).toBe(index * 32);
  }
  expect([...cellCalls.values()]).toEqual([33, 33]);
}, 15_000);
