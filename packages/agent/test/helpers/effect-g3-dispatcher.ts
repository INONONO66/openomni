export { defineTool, currentExecutor } from "../../src/core/tool";
export type { Executor } from "../../src/core/gate/decide";
import { createDispatcher as rawDispatcher, createTurnDispatcher as rawTurnDispatcher } from "../../src/plugins/tool";
export const createDispatcher = rawDispatcher;
export const createTurnDispatcher = rawTurnDispatcher;
