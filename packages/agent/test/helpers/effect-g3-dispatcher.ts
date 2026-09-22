export { defineTool, currentExecutor } from "../../src/tool-dispatcher";
export type { Executor } from "../../src/executor-contract";
import { createDispatcher as rawDispatcher, createTurnDispatcher as rawTurnDispatcher } from "../../src/tool-dispatcher";
import { isolated } from "./isolated";
export const createDispatcher = rawDispatcher;
export const createTurnDispatcher = rawTurnDispatcher;
