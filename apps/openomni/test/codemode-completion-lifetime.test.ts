import { expect, test } from "bun:test";
import { createDispatcher, createExecutor, currentExecutor } from "@openomni/agent";
import { createCodemode } from "@openomni/codemode";
import { attachMachineDaemon, createMachineHost } from "@openomni/machines";
import { compilePolicySnapshot, SEEDED_POLICY_ROWS } from "@openomni/policy";
import { LedgerAction, type Machine, type PlainObject } from "@openomni/protocol";
import { z } from "zod";
import { composeCodemode } from "../src/composition/codemode";
import { createTools } from "../src/tools/core/catalog";
import { cellDaemonOptions } from "./helpers/cell-daemon";
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
    const executor = createExecutor({
      policy: compilePolicySnapshot({
        generation: 1,
        mandatory: [],
        rows: SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })),
      }),
      ledger: {
        async commit(append) {
          const action = LedgerAction.Node.parse({ ...append, ordinal: actions.length + 1 });
          actions.push(action);
          return { action, revision: action.ordinal };
        },
      },
      observations: { publish: () => undefined },
      identity: { sessionId: origin.sessionId, role: origin.role, parentActionId: null },
      clock: () => 1,
      entropy: () => `${origin.sessionId}-${++nextId}`,
    });
    const path = socketPath();
    let cells: ReturnType<typeof composeCodemode>;
    const host = await createMachineHost({
      socketPath: path,
      enrollment: (machineId) => ({
        machineId,
        name: "completion-test",
        allowedCapabilities: ["kernel.py"],
        enrolledAt: 0,
      }),
      events: { publish: () => undefined },
      now: () => 1,
      callTool: async (call) => {
        try {
          const result = await cells.callTool(call);
          completed.resolve({ result });
          return result;
        } catch (error) {
          completed.resolve({ error: String(error) });
          throw error;
        }
      },
    });
    suite.defer(() => host.close());
    const daemon = await attachMachineDaemon({
      ...cellDaemonOptions(path, "completion-test"),
      runner: createCodemode().runner,
    });
    suite.defer(() => daemon.close());
    expect(daemon.attachment.status).toBe("attached");
    cells = composeCodemode(host);
    suite.defer(() => cells.close());
    let calls = 0;
    const definitions = createTools(
      {
        cells,
        llm: async () => {
          expect(currentExecutor()).toBe(executor);
          calls += 1;
          entered.resolve();
          await release.promise;
          return "late";
        },
      },
      origin,
    );
    cells.bindTools(origin.sessionId, definitions);
    const dispatcher = createDispatcher(definitions, { executor });
    let nextCall = 0;
    const execute = (operation: PlainObject) =>
      bounded(
        dispatcher.execute(
          { id: `eval-${++nextCall}`, tool: "eval", input: { operation } },
          { sessionId: origin.sessionId, turnId: "completion-turn" },
        ),
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
      // The one-second wait is eval's public background-run boundary, not a polling delay.
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
