import { spyOn } from "bun:test";
import type { PlainObject } from "@openomni/protocol";
import type { CatalogOrigin } from "../../src/tools/core/catalog";
import { createTools, type CatalogPorts } from "../../src/tools/core/catalog";
import { createDispatcher } from "@openomni/agent";
import { executor } from "./executor";

const RESIDENT: CatalogOrigin = { role: "resident", sessionId: "test" };
let nextCallId = 0;
export function dispatchModelTool(
  name: string,
  ports: CatalogPorts,
  origin: CatalogOrigin = RESIDENT,
  now?: () => number,
) {
  const definitions = now === undefined ? createTools(ports, origin) : undefined;
  if (definitions !== undefined) ports.cells?.bindTools(origin.sessionId, definitions);
  const persistentDispatcher =
    definitions === undefined ? undefined : createDispatcher(definitions, { executor });
  return async (input: PlainObject) => {
    const clock = now === undefined ? undefined : spyOn(Date, "now").mockImplementation(now);
    try {
      const currentDefinitions = definitions ?? createTools(ports, origin);
      if (definitions === undefined) ports.cells?.bindTools(origin.sessionId, currentDefinitions);
      const dispatcher =
        persistentDispatcher ?? createDispatcher(currentDefinitions, { executor });
      return await dispatcher.execute(
        { id: `test-tool-call-${nextCallId++}`, tool: name, input },
        { sessionId: origin.sessionId, turnId: `test-turn-${nextCallId}` },
      );
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
