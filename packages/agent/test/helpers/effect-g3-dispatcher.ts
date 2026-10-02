export { defineTool, currentExecutor } from "../../src/kernel/tool";
export type { Executor } from "../../src/kernel/gate/decide";
import {
  createDispatcher as rawDispatcher,
  createTurnDispatcher as rawTurnDispatcher,
} from "../../src/kernel/tool";
export const createDispatcher = rawDispatcher;
export const createTurnDispatcher = rawTurnDispatcher;
