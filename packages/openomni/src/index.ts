// @openomni/openomni — Orchestration package

export * from "./plan/plan-agent.js";
export * from "./plan/hashline.js";
export * from "./plan/plan-store.js";
export * from "./plan/plan-tools.js";
export * from "./plan/structural-gate.js";
export * from "./plan/plan-pipeline.js";
export * from "./team/index.js";
export * from "./dag/index.js";
export { FileTaskStore, TaskStorage } from "./legacy/index.js";

/** @deprecated Legacy orchestration modules — CLI depends on these, do not delete */
export * as _DEPRECATED_legacy from "./legacy/index.js";
