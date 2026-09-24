import { Effect } from "effect";
import { runnerTestLayer, catalogLayer } from "../../../../packages/agent/test/helpers/service-layers";
import { acquireSyncEffect } from "./effect";
import { runEffect } from "./effect";
import { spyOn } from "bun:test";
import type { PlainObject } from "@openomni/protocol";
import type { CatalogOrigin } from "../../src/tools/core/catalog";
import { createTools, type CatalogPorts } from "../../src/tools/core/catalog";
import { createTurnDispatcher } from "@openomni/agent";
import { fixtureLedger, executorServices } from "./executor";

const RESIDENT: CatalogOrigin = { role: "resident", sessionId: "test" };
let nextCallId = 0;
export function dispatchModelTool(
  name: string,
  ports: CatalogPorts,
  origin: CatalogOrigin = RESIDENT,
  now?: () => number,
) {
  const definitions = now === undefined ? createTools(ports, origin) : undefined;
  const acquire = (catalog: ReturnType<typeof createTools>) => acquireSyncEffect(createTurnDispatcher({
    sessionId: origin.sessionId, role: origin.role, actionId: "fixture-turn", ledger: fixtureLedger,
  }, {}).pipe(Effect.provide(catalogLayer(catalog)), Effect.provide(executorServices), Effect.provide(runnerTestLayer)));
  const persistentDispatcher = definitions === undefined ? undefined : acquire(definitions);
  return async (input: PlainObject) => {
    const clock = now === undefined ? undefined : spyOn(Date, "now").mockImplementation(now);
    try {
      const currentDefinitions = definitions ?? createTools(ports, origin);
      const dispatcher = persistentDispatcher ?? acquire(currentDefinitions);
      return await runEffect(dispatcher.execute(
        { id: `test-tool-call-${nextCallId++}`, tool: name, input },
        { sessionId: origin.sessionId, turnId: `test-turn-${nextCallId}` },
      ));
    } finally {
      clock?.mockRestore();
    }
  };
}

export function modelToolOutput(
  name: string,
  ports: CatalogPorts,
  origin: CatalogOrigin = RESIDENT,
  now?: () => number,
) {
  const dispatch = dispatchModelTool(name, ports, origin, now);
  return async (input: PlainObject): Promise<string> => String((await dispatch(input)).output);
}
