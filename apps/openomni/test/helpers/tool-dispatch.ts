import { spyOn } from "bun:test";
import type { Tool } from "@openomni/protocol";
import type { DelegationOrigin } from "../../src/delegation/admission";
import { createTools, type CatalogPorts } from "../../src/tools/core/catalog";
import { createDispatcher } from "../../src/tools/core/dispatch";

const RESIDENT: DelegationOrigin = { role: "resident", depth: 0, sessionId: "test" };
let nextCallId = 0;

export function dispatchModelTool(
  name: string,
  ports: CatalogPorts,
  origin: DelegationOrigin = RESIDENT,
  now?: () => number,
) {
  const persistentDispatcher =
    now === undefined
      ? createDispatcher(createTools(ports, origin), origin.sessionId)
      : undefined;
  return async (input: unknown) => {
    const clock = now === undefined ? undefined : spyOn(Date, "now").mockImplementation(now);
    try {
      const dispatcher =
        persistentDispatcher ?? createDispatcher(createTools(ports, origin), origin.sessionId);
      return await dispatcher.execute({
        id: `test-tool-call-${nextCallId++}`,
        tool: name,
        input,
      } as Tool.Call);
    } finally {
      clock?.mockRestore();
    }
  };
}

export function modelToolOutput(
  name: string,
  ports: CatalogPorts,
  origin: DelegationOrigin = RESIDENT,
  now?: () => number,
) {
  const dispatch = dispatchModelTool(name, ports, origin, now);
  return async (input: unknown): Promise<string> => String((await dispatch(input)).output);
}
