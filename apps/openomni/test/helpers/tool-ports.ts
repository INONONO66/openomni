import type { ToolPorts } from "../../src/tools/core/catalog";

/** Explicit absent-capability fixture; individual tests supply only the ports they exercise. */
export const testToolPorts: ToolPorts = {
  alarms: undefined,
  messages: undefined,
  machines: undefined,
  cells: undefined,
  llm: undefined,
  provisioning: undefined,
  clock: () => 0,
};
