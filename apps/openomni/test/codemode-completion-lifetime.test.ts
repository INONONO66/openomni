import { testToolPorts } from "./helpers/tool-ports";
import { executorLayer, runnerTestLayer, catalogLayer } from "../../../packages/agent/test/helpers/service-layers";
import { Effect } from "effect";
import { acquireEffect, runEffect, acquireSyncEffect } from "./helpers/scoped-effect";
import { expect, test } from "bun:test";
import { createTurnDispatcher, currentExecutor } from "@openomni/agent";
import { createCodemode } from "@openomni/codemode";
import { attachMachineDaemon, createMachineHost } from "@openomni/machines";
import { LedgerAction, type Machine, type PlainObject } from "@openomni/protocol";
import { z } from "zod";
import { cellPorts } from "./helpers/cell-ports";
import { composeCodemode } from "../src/composition/codemode";
import { catalogDefinitions } from "../src/tools/core/catalog";
import { cellDaemonOptions } from "./helpers/cell-daemon";
import { fixtureHashes } from "../../../packages/agent/test/helpers/compiled-policy";
import { seededPolicy } from "./helpers/executor";
import { bounded } from "./helpers/protected-dispatch";
import { residentSuite } from "./helpers/resident-suite";
import { socketPath } from "./helpers/socket-path";

const suite = residentSuite();
const ActionPhase = z.object({ op: z.string(), phase: z.string() });

for (const stop of [false, true]) {
  test(`background completion settles under its captured executor after cell stop=${stop}`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<
      { result: Machine.ToolCallResult } | { error: string }
    >();
    const actions: LedgerAction.Node[] = [];
    let nextId = 0;
    const origin = { role: "resident", sessionId: `completion-${stop}` } as const;
    // Only storage IO is replaced: real policy, record construction and settlement execute.
    const ledger: Parameters<typeof createTurnDispatcher>[0]["ledger"] = {
        commit(append) {
          const ordinal = actions.length + 1;
          const action = LedgerAction.Node.parse({ ...append, ordinal, ...fixtureHashes(ordinal) });
          actions.push(action);
          return Effect.succeed({ action, revision: action.ordinal });
        },
      };
    const path = socketPath();
    let cells: Effect.Effect.Success<ReturnType<typeof composeCodemode>>;
    const host = await acquireEffect(createMachineHost({
      socketPath: path,
      enrollment: (machineId) => ({
        machineId,
        name: "completion-test",
        allowedCapabilities: ["kernel.py"],
        enrolledAt: 0,
      }),
      events: { publish: () => undefined },
      now: () => 1,
      callTool: (call) => Effect.promise(async () => {
        const result = await runEffect(cells.callTool(call)).catch((error: Error) => {
          completed.resolve({ error: String(error) });
          throw error;
        });
        completed.resolve({ result });
        return result;
      }),
    }));
    suite.defer(async () => { await runEffect(host.close()); });
    const daemon = await acquireEffect(attachMachineDaemon({
      ...cellDaemonOptions(path, "completion-test"),
      runner: acquireSyncEffect(createCodemode()).runner,
    }));
    suite.defer(async () => { await runEffect(daemon.close()); });
    expect(daemon.attachment.status).toBe("attached");
    cells = acquireSyncEffect(composeCodemode(host));
    suite.defer(async () => { await runEffect(cells.close()); });
    let calls = 0;
    const definitions = catalogDefinitions(
      { ...testToolPorts,
        cells: cellPorts(cells),
        llm: async () => {
          expect(currentExecutor().run).toBe(dispatcher.executor.run);
          calls += 1;
          entered.resolve();
          await release.promise;
          return "late";
        },
      },
    );
    const dispatcher = acquireSyncEffect(createTurnDispatcher({
      sessionId: origin.sessionId, role: origin.role, actionId: "completion-turn", ledger,
    }, {}).pipe(Effect.provide(catalogLayer(definitions)), Effect.provide(executorLayer({ policy: seededPolicy, observations: { publish: () => undefined }, clock: () => 1, entropy: () => `${origin.sessionId}-${++nextId}` })), Effect.provide(runnerTestLayer)));
    let nextCall = 0;
    const execute = (operation: PlainObject) =>
      bounded(
        runEffect(dispatcher.execute(
          { id: `eval-${++nextCall}`, tool: "eval", input: { operation } },
          { sessionId: origin.sessionId, turnId: "completion-turn" },
        )),
      );
    const toolActions = (op: string, phase: string) =>
      actions.filter((action) => {
        const intent = ActionPhase.safeParse(action.intent.value);
        return (
          action.kind === "tool" &&
          intent.success &&
          intent.data.op === op &&
          intent.data.phase === phase
        );
      });

    try {
      // The one-second wait is eval's public background-run boundary, not a polling delay;
      // the interpreter is warmed first so a cold start cannot stand in for that boundary.
      expect((await execute({ op: "run", code: "0", timeout: 15 })).output).toBe("0");
      const running = execute({
        op: "run",
        code: "print('started')\nanswer = completion('hold')\nanswer",
        timeout: 1,
      });
      await bounded(entered.promise);
      const started = await running;
      expect(started.isError).toBeUndefined();
      const cellId = /^cell (\S+) is still running; peek or stop it by cell_id\nstarted\n$/.exec(
        started.output,
      )?.[1];
      if (cellId === undefined) throw new Error(`expected running cell: ${started.output}`);
      expect(toolActions("completion", "intent")).toHaveLength(1);
      expect(toolActions("completion", "result")).toHaveLength(0);

      if (stop) {
        expect((await execute({ op: "stop", cell_id: cellId })).output).toBe(
          "the cell was stopped\nstarted\n",
        );
        expect((await execute({ op: "peek", cell_id: cellId })).isError).toBe(true);
      }
      // Before the fix the real completion RPC aborts when the outer eval wave returns.
      release.resolve();
      expect(await bounded(completed.promise)).toEqual({
        result: { status: "completed", value: "late" },
      });
      // Same-tenant execution is a barrier for the Python result/late-answer handling.
      expect((await execute({ op: "run", code: "6 * 7", timeout: 15 })).output).toBe("42");
      if (stop) {
        expect(
          (await execute({ op: "run", code: "'answer' in globals()", timeout: 15 })).output,
        ).toBe("False");
        expect((await execute({ op: "peek", cell_id: cellId })).isError).toBe(true);
      } else {
        expect((await execute({ op: "peek", cell_id: cellId })).output).toBe("'late'");
        expect((await execute({ op: "peek", cell_id: cellId })).isError).toBe(true);
      }
      const intents = toolActions("completion", "intent");
      const results = toolActions("completion", "result");
      expect(intents).toHaveLength(1);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        parentId: intents[0]?.id,
        sessionId: origin.sessionId,
        effect: { value: { terminal: "executed", result: { status: "success", output: "late" } } },
      });
      expect(
        actions
          .filter(
            (action) =>
              action.kind === "policy.decision" &&
              z.object({ op: z.literal("completion") }).safeParse(action.intent.value).success,
          )
          .map((action) => z.object({ hook: z.string() }).parse(action.intent.value).hook),
      ).toEqual(["tool.pre", "tool.post"]);
      expect(actions.every((action) => action.sessionId === origin.sessionId)).toBe(true);
      expect(calls).toBe(1);
    } finally {
      release.resolve();
    }
  }, 15_000);
}
