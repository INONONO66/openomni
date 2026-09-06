import { spyOn } from "bun:test";
import type { Tool } from "@openomni/protocol";
import type { CatalogOrigin } from "../../src/tools/core/catalog";
import { createTools, type CatalogPorts } from "../../src/tools/core/catalog";
import { createDispatcher } from "@openomni/agent";
import { executor } from "./executor";

const RESIDENT: CatalogOrigin = { role: "resident", depth: 0, sessionId: "test" };
let nextCallId = 0;
export function dispatchModelTool(
	name: string,
	ports: CatalogPorts,
	origin: CatalogOrigin = RESIDENT,
	now?: () => number,
) {
	const persistentDispatcher =
		now === undefined
			? createDispatcher(createTools(ports, origin), { executor })
			: undefined;
	return async (input: unknown) => {
		const clock = now === undefined ? undefined : spyOn(Date, "now").mockImplementation(now);
		try {
			const dispatcher =
				persistentDispatcher ??
				createDispatcher(createTools(ports, origin), { executor });
			return await dispatcher.execute(
				{
					id: `test-tool-call-${nextCallId++}`,
					tool: name,
					input,
				} as Tool.Call,
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
	return async (input: unknown): Promise<string> => String((await dispatch(input)).output);
}
